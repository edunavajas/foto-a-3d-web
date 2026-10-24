import '@google/model-viewer';
import { useEffect, useRef } from 'react';

/** Bundled <model-viewer> custom element. React 19 passes unknown props as attributes. */
export default function ModelViewer({ src, alt, className }) {
  const ref = useRef(null);
  // The GLB URL is stable; model-viewer caches by src, so bust it upstream instead.
  useEffect(() => {
    ref.current?.dismissPoster?.();
  }, [src]);
  return (
    <model-viewer
      ref={ref}
      src={src}
      alt={alt}
      camera-controls
      auto-rotate
      touch-action="pan-y"
      shadow-intensity="1"
      exposure="1"
      className={className}
      style={{
        width: '100%',
        height: 'min(58vh, 32rem)',
        display: 'block',
        borderRadius: 'var(--radius-panel)',
        background: 'var(--surface-muted)',
      }}
    />
  );
}
