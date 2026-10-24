import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { TripoClient, isFailedStatus, MODEL_FAST, MODEL_BEST } from './tripo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/bmp': '.bmp' };
const SESSION_COOKIE = 'foto3d_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds

function imageKind(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  return null;
}

/** Minimal cookie reader; enough for one session cookie, no dependency needed. */
function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Constant-time string comparison (pads both sides to the same length). */
function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Compare against itself to burn the same time, then fail.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/** Record a 0-100 Tripo progress value; absent/NaN keeps the previous one and it never goes backwards. */
function trackProgress(job, key, task) {
  const value = Number(task.progress);
  if (Number.isFinite(value)) job[key] = Math.max(job[key] ?? 0, Math.min(100, Math.max(0, value)));
}

/** Wire genParams for image-to-model: textured models get PBR + standard quality (CLI 3D-print preset). */
function textureParams(texture) {
  return texture ? { texture: true, pbr: true, texture_quality: 'standard' } : { texture: false, pbr: false };
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
  const distDir = path.join(root, 'dist');
  const jobs = new Map();
  // Stateless session token: derivable from the password alone, so it survives restarts.
  const sessionToken = crypto.createHmac('sha256', password).update('foto3d-session').digest('hex');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } });
  const app = express();
  let creating = false;

  async function persist() {
    await fs.mkdir(dataDir, { recursive: true });
    const temp = `${jobsFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify([...jobs.values()], null, 2));
    await fs.rename(temp, jobsFile);
  }

  async function writeModel(jobId, model, suffix = '') {
    await fs.mkdir(modelsDir, { recursive: true });
    const part = path.join(modelsDir, `${jobId}${suffix}.glb.part`);
    await fs.writeFile(part, model);
    await fs.rename(part, path.join(modelsDir, `${jobId}${suffix}.glb`));
  }

  async function refresh(job) {
    if ((job.status !== 'generating' && job.status !== 'improving' && job.status !== 'rigging') || Date.now() - job.lastPolledAt < minPollIntervalMs) return;
    job.lastPolledAt = Date.now();
    if (job.status === 'improving') return refreshImprovement(job);
    if (job.status === 'rigging') return refreshRig(job);

    let task;
    try {
      task = await tripo.getTask(job.taskId);
    } catch {
      return; // transient poll failure: stay generating, the next poll retries
    }
    trackProgress(job, 'progress', task);
    if (task.status === 'success') {
      try {
        const model = await tripo.downloadModel(task);
        await writeModel(job.id, model);
        job.modelVersion = 1;
        job.modelUrl = `/api/jobs/${job.id}/model`;
        job.error = null;
        if (job.quality === 'best') {
          try {
            // The uploaded photo's file token is reusable: no second upload.
            job.hqTaskId = await tripo.createImageToModelTask(job.fileToken, MODEL_BEST, textureParams(job.texture));
            job.status = 'improving';
          } catch (error) {
            // The fast model is already delivered; the upgrade is a bonus, not a failure.
            process.stderr.write(`Improvement task creation failed for job ${job.id}: ${error?.message || error}\n`);
            job.status = job.rig ? 'rigging' : 'ready';
          }
        } else {
          job.status = job.rig ? 'rigging' : 'ready';
        }
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

  /** Second phase of quality 'best': poll the HQ task; any failure keeps the fast model. */
  async function refreshImprovement(job) {
    let task;
    try {
      task = await tripo.getTask(job.hqTaskId);
    } catch {
      return;
    }
    trackProgress(job, 'hqProgress', task);
    if (task.status === 'success') {
      try {
        const model = await tripo.downloadModel(task);
        await writeModel(job.id, model, '-hq');
        job.modelVersion = 2;
        job.modelUrl = `/api/jobs/${job.id}/model?variant=hq`;
        job.hasHq = true;
      } catch (error) {
        process.stderr.write(`Improvement download failed for job ${job.id}: ${error?.message || error}\n`);
      }
      // Whatever the improvement did, the best current model is delivered; rigging follows.
      job.status = job.rig ? 'rigging' : 'ready';
    } else if (isFailedStatus(task.status)) {
      process.stderr.write(`Improvement task failed for job ${job.id}: ${task.status}\n`);
      job.status = job.rig ? 'rigging' : 'ready';
    }
    job.updatedAt = new Date().toISOString();
    await persist();
  }

  /** Third phase (rig=on): skeletonize the best current model; any failure keeps it unrigged. */
  async function refreshRig(job) {
    if (!job.rigTaskId) {
      // The rig input is the best current task: the HQ model when it exists, the fast one otherwise.
      const source = job.modelUrl?.includes('variant=hq') ? job.hqTaskId : job.taskId;
      try {
        job.rigTaskId = await tripo.createRigTask(source);
      } catch (error) {
        process.stderr.write(`Rig task creation failed for job ${job.id}: ${error?.message || error}\n`);
        job.status = 'ready';
        job.updatedAt = new Date().toISOString();
        await persist();
        return;
      }
    }
    let task;
    try {
      task = await tripo.getTask(job.rigTaskId);
    } catch {
      return;
    }
    trackProgress(job, 'rigProgress', task);
    if (task.status === 'success') {
      try {
        const model = await tripo.downloadModel(task);
        await writeModel(job.id, model, '-rigged');
        job.modelVersion += 1;
        job.modelUrl = `/api/jobs/${job.id}/model?variant=rigged`;
        job.hasRig = true;
        job.status = 'ready';
      } catch (error) {
        process.stderr.write(`Rig download failed for job ${job.id}: ${error?.message || error}\n`);
        job.status = 'ready';
      }
    } else if (isFailedStatus(task.status)) {
      process.stderr.write(`Rig task failed for job ${job.id}: ${task.status}\n`);
      job.status = 'ready';
    }
    job.updatedAt = new Date().toISOString();
    await persist();
  }

  app.disable('x-powered-by');

  // --- Public endpoints: health probe, login, logout, and the static SPA. ---
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.post('/api/login', express.json({ limit: '4kb' }), (req, res) => {
    if (!safeEqual(String(req.body?.password ?? ''), password)) {
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // Static SPA shell is public; the app itself discovers auth state via /api.
  app.use(express.static(distDir, { index: 'index.html' }));

  // --- Session gate: every other /api route requires the session cookie. ---
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (!safeEqual(readCookie(req, SESSION_COOKIE) ?? '', sessionToken)) {
      return res.status(401).json({ error: 'Sesión no válida. Inicia sesión de nuevo.' });
    }
    next();
  });

  // SPA fallback for client-side routes that are not API calls or assets.
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(distDir, 'index.html'));
    }
    next();
  });

  app.post('/api/jobs', upload.single('photo'), async (req, res, next) => {
    try {
      const busy = status => status === 'generating' || status === 'improving' || status === 'rigging';
      if (creating || [...jobs.values()].some(job => busy(job.status))) {
        return res.status(409).json({ error: 'Ya hay una generación en curso. Espera a que termine.' });
      }
      if (!req.file) return res.status(400).json({ error: 'Selecciona una foto primero.' });
      const mime = imageKind(req.file.buffer);
      if (!mime) return res.status(415).json({ error: 'Usa una imagen JPEG, PNG, WebP o BMP.' });
      const quality = req.body.quality === 'best' ? 'best' : 'fast';
      const textureField = req.body.texture ?? 'on';
      const rigField = req.body.rig ?? 'off';
      if (!['on', 'off'].includes(textureField) || !['on', 'off'].includes(rigField)) {
        return res.status(400).json({ error: 'Opciones de generación no válidas.' });
      }

      creating = true;
      try {
        const fileToken = await tripo.uploadImage(req.file.buffer, `photo${EXTENSIONS[mime]}`, mime);
        // The fast model always goes first; 'best' improves it afterwards.
        const taskId = await tripo.createImageToModelTask(fileToken, MODEL_FAST, textureParams(textureField === 'on'));
        const now = new Date().toISOString();
        const job = {
          id: crypto.randomUUID(),
          taskId,
          hqTaskId: null,
          rigTaskId: null,
          fileToken,
          quality,
          texture: textureField === 'on',
          rig: rigField === 'on',
          status: 'generating',
          error: null,
          modelUrl: null,
          modelVersion: 0,
          hasHq: false,
          hasRig: false,
          progress: null,
          rigProgress: null,
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
      res.json({
        id: job.id,
        status: job.status,
        error: job.error,
        modelUrl: job.modelUrl,
        quality: job.quality,
        hasHq: Boolean(job.hasHq),
        hasRig: Boolean(job.hasRig),
        progress: job.progress ?? null,
        ...(job.status === 'improving' ? { hqProgress: job.hqProgress ?? null } : {}),
        ...(job.status === 'rigging' ? { rigProgress: job.rigProgress ?? null } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/jobs/:id/model', async (req, res, next) => {
    try {
      const job = jobs.get(req.params.id);
      if (!job || !['ready', 'improving', 'rigging'].includes(job.status)) return res.sendStatus(404);
      // Rigged falls back to HQ then fast, so the viewer never 404s while a newer variant is missing.
      const suffixes = req.query.variant === 'hq' ? ['-hq', ''] : req.query.variant === 'rigged' ? ['-rigged', '-hq', ''] : [''];
      for (const suffix of suffixes) {
        const file = path.join(modelsDir, `${job.id}${suffix}.glb`);
        try {
          await fs.access(file);
          res.type('model/gltf-binary');
          return res.sendFile(file);
        } catch { /* try the next candidate */ }
      }
      res.sendStatus(404);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        .json({ error: 'La foto es demasiado grande o la subida no es válida.' });
    }
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: 'Cuerpo de la petición no válido.' });
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
    // Dual-stack listen: binds :: (with IPv4-mapped addresses) so both
    // 127.0.0.1 and ::1 localhost healthchecks connect.
    const server = app.listen(port, error => {
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
