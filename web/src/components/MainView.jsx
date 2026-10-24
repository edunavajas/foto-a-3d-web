import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { readJson } from '../api.js';
import { Button } from './ui/button/button';
import { Card } from './ui/card/card';
import { Progress } from './ui/progress/progress';
import SegmentedControl from './ui/segmented-control/segmented-control';
import { FileDropzone } from './ui/file-dropzone/file-dropzone';
import PointcloudCanvas from './PointcloudCanvas.jsx';

// model-viewer (three.js) is heavy; load it only when a model exists.
const ModelViewer = lazy(() => import('./ModelViewer.jsx'));

const DROPZONE_MESSAGES = {
  filesLabel: 'Archivos',
  uploading: 'Subiendo',
  uploaded: 'Subida',
  failed: 'Error',
  uploadFailed: 'No se pudo subir la foto.',
  remove: name => `Quitar ${name}`,
  removeShort: 'Quitar',
  retry: name => `Reintentar ${name}`,
  retryShort: 'Reintentar',
  typeError: name => `${name} no es un tipo de archivo admitido.`,
  typeErrorSome: 'Algunos archivos no se añadieron porque su tipo no está admitido.',
  limitError: max => `Puedes añadir hasta ${max} archivo${max === 1 ? '' : 's'}.`,
  sizeError: max => `El archivo supera ${max}`,
  added: count => `${count} archivo${count === 1 ? '' : 's'} añadido${count === 1 ? '' : 's'}.`,
  removed: name => `${name} eliminado`,
  uploadedAnnouncement: name => `${name} subida completada`,
  failedAnnouncement: (name, message) => `${name} falló. ${message}`,
  retrying: name => `Reintentando ${name}`,
};

const QUALITY_OPTIONS = [
  { value: 'fast', label: 'Rápido' },
  { value: 'best', label: 'Máxima calidad' },
];

const QUALITY_HINT = {
  fast: 'Modelo low-poly listo en segundos.',
  best: 'Modelo rápido al instante y luego se mejora a máxima fidelidad. Tarda minutos.',
};

export default function MainView({ onLogout, onExpired, notify }) {
  const [quality, setQuality] = useState('fast');
  const [photo, setPhoto] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const pollRef = useRef(null);

  const status = job?.status;
  const busy = submitting || status === 'generating' || status === 'improving';
  const hasModel = Boolean(job?.modelUrl);
  // Cache-bust when the model version changes, like the original UI did.
  const modelSrc = job?.modelUrl
    ? `${job.modelUrl}${job.modelUrl.includes('?') ? '&' : '?'}v=${job.modelVersion ?? 1}`
    : null;

  // Upload + create the job.
  async function submit(event) {
    event.preventDefault();
    if (!photo || busy) return;
    setSubmitting(true);
    setError('');
    setJob(null);
    setElapsed(0);
    try {
      const form = new FormData();
      form.append('photo', photo);
      form.append('quality', quality);
      const created = await readJson(await fetch('/api/jobs', { method: 'POST', body: form }));
      setJob(created);
    } catch (caught) {
      setError(caught.message);
      notify('No se pudo generar', caught.message);
      setSubmitting(false);
    }
  }

  // Poll the job until it is ready or errors. A 401 ends the session (cookie expired).
  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'error') return undefined;
    let stopped = false;
    pollRef.current = setInterval(async () => {
      try {
        const next = await readJson(await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { cache: 'no-store' }));
        if (stopped) return;
        setJob(next);
        if (next.status === 'error') {
          setError(next.error || 'La generación falló.');
          notify('Error al generar', next.error || 'La generación falló.');
        }
      } catch (caught) {
        if (caught.status === 401 && !stopped) onExpired();
        // Transient failures: keep polling, the next tick retries.
      }
    }, 2000);
    return () => { stopped = true; clearInterval(pollRef.current); };
  }, [job, notify, onExpired]);

  // Elapsed seconds drive an honest estimate (1-3 min) for the progress bar.
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => setElapsed(seconds => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const progressValue = status === 'error' ? 0 : busy ? Math.min(92, (elapsed / 180) * 100) : 100;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-10 pt-5">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Foto a 3D</h1>
        <Button variant="ghost" size="sm" onClick={onLogout}>Salir</Button>
      </header>

      <form onSubmit={submit} className="mt-5 grid gap-5">
        <div className="grid gap-2">
          <SegmentedControl
            options={QUALITY_OPTIONS}
            value={quality}
            onValueChange={setQuality}
            label="Calidad del modelo"
          />
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{QUALITY_HINT[quality]}</p>
        </div>

        <FileDropzone
          accept="image/*"
          capture="environment"
          multiple={false}
          maxFiles={1}
          maxSize={20 * 1024 * 1024}
          label="Elige una foto"
          description="Toca para hacer una foto o elige una de tu dispositivo."
          note="JPEG, PNG, WebP o BMP · hasta 20 MB"
          dropLabel="Suelta la foto aquí"
          messages={DROPZONE_MESSAGES}
          onFilesChange={files => setPhoto(files[0] ?? null)}
        />

        {error && (
          <p role="alert" className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>
        )}

        <Button type="submit" size="lg" loading={busy} disabled={!photo}>
          Generar modelo
        </Button>
      </form>

      <AnimatePresence>
        {job && (
          <motion.section
            className="mt-6"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: .24, ease: [.16, 1, .3, 1] }}
            aria-live="polite"
          >
            {busy && (
              <div className="mb-4 grid gap-3">
                <Progress value={progressValue} label={status === 'improving' ? 'Mejorando a máxima calidad…' : 'Generando modelo… puede tardar 1-3 minutos'} showValue />
                {status === 'generating' && !hasModel && <PointcloudCanvas photo={photo} />}
              </div>
            )}

            {hasModel && (
              <Card
                title={status === 'improving' ? 'Modelo rápido listo' : 'Tu modelo 3D'}
                description={status === 'improving'
                  ? 'Mejorando a máxima calidad… el modelo mejorará aquí en cuanto esté listo.'
                  : 'Arrastra para girarlo. Pellizca para hacer zoom.'}
                media={(
                  <Suspense fallback={null}>
                    <ModelViewer
                      src={modelSrc}
                      alt="Tu modelo 3D generado"
                      className="w-full"
                    />
                  </Suspense>
                )}
                action={(
                  <a
                    href={modelSrc}
                    download="modelo.glb"
                    style={{ textDecoration: 'none' }}
                  >
                    <Button variant="secondary" size="sm">Descargar GLB</Button>
                  </a>
                )}
              >
                {status === 'improving' && (
                  <p className="mt-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-strong)' }}>
                    <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden="true" />
                    Mejorando a máxima calidad…
                  </p>
                )}
              </Card>
            )}

            {status === 'error' && (
              <Card title="No se pudo generar el modelo" description={job.error ?? 'Inténtalo de nuevo con otra foto.'} />
            )}
          </motion.section>
        )}
      </AnimatePresence>
    </main>
  );
}
