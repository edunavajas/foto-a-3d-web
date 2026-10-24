import { useEffect, useRef } from 'react';

const ease = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Turn the photo into a point cloud: pixel colour and brightness become dot
// colour and depth, so the animation hints at the object being generated.
// Ported faithfully from the original vanilla app (foto-a-3d/public/app.js).
function sampleDots(photo) {
  const image = new Image();
  return new Promise(resolve => {
    image.onload = () => {
      const side = 80;
      const sample = Object.assign(document.createElement('canvas'), { width: side, height: side });
      const context = sample.getContext('2d', { willReadFrequently: true });
      const ratio = Math.min(side / image.width, side / image.height);
      const width = image.width * ratio;
      const height = image.height * ratio;
      context.drawImage(image, (side - width) / 2, (side - height) / 2, width, height);
      const { data } = context.getImageData(0, 0, side, side);
      const dots = [];
      for (let y = 0; y < side; y += 2) {
        for (let x = 0; x < side; x += 2) {
          const i = (y * side + x) * 4;
          if (data[i + 3] < 128) continue;
          // Scatter on a spherical shell so the start reads as a cloud, not noise.
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(Math.random() * 2 - 1);
          const radius = .9 + Math.random() * .4;
          dots.push({
            tx: (x / (side - 1)) * 2 - 1,
            ty: (y / (side - 1)) * 2 - 1,
            tz: (data[i] + data[i + 1] + data[i + 2]) / 765 - .5,
            color: `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`,
            sx: radius * Math.sin(phi) * Math.cos(theta),
            sy: radius * Math.sin(phi) * Math.sin(theta),
            sz: radius * Math.cos(phi)
          });
        }
      }
      resolve(dots);
    };
    image.onerror = () => resolve([]);
    image.src = URL.createObjectURL(photo);
  });
}

/** Square 512x512 bitmap, like the original #scan canvas; CSS keeps it contained. */
export default function PointcloudCanvas({ photo, className }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !photo) return;
    const context = canvas.getContext('2d');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = null;
    let dots = [];
    let cancelled = false;

    function draw(now) {
      const width = canvas.width;
      const height = canvas.height;
      context.clearRect(0, 0, width, height);
      if (!dots.length) return;
      const elapsed = now - start;
      const angle = (elapsed / 1000) * .5;
      // Dots fly in from the cloud for ~2s, then hold the silhouette and keep spinning.
      const mix = ease(Math.min(1, elapsed / 2000));
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (const dot of dots) {
        const x = dot.sx + (dot.tx - dot.sx) * mix;
        const y = dot.sy + (dot.ty - dot.sy) * mix;
        const z = dot.sz + (dot.tz - dot.sz) * mix;
        const rx = x * cos - z * sin;
        const rz = x * sin + z * cos;
        const scale = 3 / (3 + rz);
        const size = 3 * scale;
        context.globalAlpha = .3 + mix * .6;
        context.fillStyle = dot.color;
        context.fillRect(
          width / 2 + rx * width * .32 * scale - size / 2,
          height / 2 + y * width * .32 * scale - size / 2,
          size,
          size
        );
      }
      context.globalAlpha = 1;
    }

    function tick(now) {
      draw(now);
      frame = requestAnimationFrame(tick);
    }

    let start = 0;
    sampleDots(photo).then(sampled => {
      if (cancelled) return;
      dots = sampled;
      start = performance.now();
      if (!dots.length) return;
      if (reduced) {
        draw(start + 2000);
        return;
      }
      frame = requestAnimationFrame(tick);
    });

    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [photo]);

  return (
    <canvas
      ref={canvasRef}
      width="512"
      height="512"
      aria-hidden="true"
      className={`block w-full rounded-2xl border object-contain ${className ?? ''}`}
      style={{
        height: 'min(58vh, 32rem)',
        borderColor: 'var(--border)',
        background: 'var(--surface-muted)',
      }}
    />
  );
}
