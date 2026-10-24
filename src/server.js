import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { TripoClient, isFailedStatus } from './tripo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/bmp': '.bmp' };

function imageKind(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  return null;
}

export function createApp({
  tripo = new TripoClient(),
  dataDir = process.env.DATA_DIR || path.join(root, 'data'),
  password = process.env.WEB_PASSWORD,
  minPollIntervalMs = 3000,
} = {}) {
  if (!password) throw new Error('WEB_PASSWORD is not set. Refusing to start with an unprotected endpoint.');

  const modelsDir = path.join(dataDir, 'models');
  const jobsFile = path.join(dataDir, 'jobs.json');
  const jobs = new Map();
  const expected = Buffer.from(`edu:${password}`);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } });
  const app = express();
  let creating = false;

  async function persist() {
    await fs.mkdir(dataDir, { recursive: true });
    const temp = `${jobsFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify([...jobs.values()], null, 2));
    await fs.rename(temp, jobsFile);
  }

  async function refresh(job) {
    if (job.status !== 'generating' || Date.now() - job.lastPolledAt < minPollIntervalMs) return;
    job.lastPolledAt = Date.now();
    let task;
    try {
      task = await tripo.getTask(job.taskId);
    } catch {
      return; // transient poll failure: stay generating, the next poll retries
    }
    if (task.status === 'success') {
      try {
        const model = await tripo.downloadModel(task);
        await fs.mkdir(modelsDir, { recursive: true });
        const part = path.join(modelsDir, `${job.id}.glb.part`);
        await fs.writeFile(part, model);
        await fs.rename(part, path.join(modelsDir, `${job.id}.glb`));
        job.status = 'ready';
        job.modelUrl = `/api/jobs/${job.id}/model`;
        job.error = null;
      } catch (error) {
        job.status = 'error';
        job.error = error?.message || 'No se pudo descargar el modelo.';
      }
    } else if (isFailedStatus(task.status)) {
      job.status = 'error';
      job.error = task.message || `La generación falló (${task.status}).`;
    }
    job.updatedAt = new Date().toISOString();
    await persist();
  }

  app.disable('x-powered-by');
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    const provided = scheme === 'Basic' ? Buffer.from(encoded ?? '', 'base64') : Buffer.alloc(0);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Foto a 3D"');
      return res.status(401).json({ error: 'Autenticación requerida.' });
    }
    next();
  });

  app.use(express.static(path.join(root, 'public'), { index: 'index.html' }));
  app.use('/vendor', express.static(path.join(root, 'node_modules/@google/model-viewer/dist')));

  app.post('/api/jobs', upload.single('photo'), async (req, res, next) => {
    try {
      if (creating || [...jobs.values()].some(job => job.status === 'generating')) {
        return res.status(409).json({ error: 'Ya hay una generación en curso. Espera a que termine.' });
      }
      if (!req.file) return res.status(400).json({ error: 'Selecciona una foto primero.' });
      const mime = imageKind(req.file.buffer);
      if (!mime) return res.status(415).json({ error: 'Usa una imagen JPEG, PNG, WebP o BMP.' });

      creating = true;
      try {
        const fileToken = await tripo.uploadImage(req.file.buffer, `photo${EXTENSIONS[mime]}`, mime);
        const taskId = await tripo.createImageToModelTask(fileToken);
        const now = new Date().toISOString();
        const job = {
          id: crypto.randomUUID(),
          taskId,
          status: 'generating',
          error: null,
          modelUrl: null,
          createdAt: now,
          updatedAt: now,
          lastPolledAt: Date.now(),
        };
        jobs.set(job.id, job);
        await persist();
        res.status(202).json({ id: job.id, status: job.status });
      } finally {
        creating = false;
      }
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/jobs/:id', async (req, res, next) => {
    try {
      const job = jobs.get(req.params.id);
      if (!job) return res.sendStatus(404);
      await refresh(job);
      res.json({ id: job.id, status: job.status, error: job.error, modelUrl: job.modelUrl });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/jobs/:id/model', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== 'ready') return res.sendStatus(404);
    res.type('model/gltf-binary');
    res.sendFile(path.join(modelsDir, `${job.id}.glb`));
  });

  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        .json({ error: 'La foto es demasiado grande o la subida no es válida.' });
    }
    if (error?.name === 'TripoError') {
      return res.status(502).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  });

  try {
    for (const job of JSON.parse(readFileSync(jobsFile, 'utf8'))) jobs.set(job.id, job);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not load ${jobsFile}: ${error.message}`);
  }

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  try {
    const app = createApp();
    const server = app.listen(port, '0.0.0.0', error => {
      if (error) {
        process.stderr.write(`Could not start foto-a-3d-web: ${error.code || 'listen error'}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`Foto a 3D: http://localhost:${server.address().port}\n`);
    });
  } catch (error) {
    process.stderr.write(`Cannot start foto-a-3d-web: ${error.message}\n`);
    process.exitCode = 1;
  }
}
