import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { MODEL_FAST, MODEL_BEST } from '../src/tripo.js';

const PASSWORD = 'secreto-de-prueba';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeTripo(overrides = {}) {
  return {
    uploadImage: async () => 'file-token',
    createImageToModelTask: async () => 'task-1',
    getTask: async () => ({ status: 'running' }),
    downloadModel: async () => Buffer.from('GLB-BYTES'),
    ...overrides,
  };
}

async function startApp({ tripo, minPollIntervalMs = 0 } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-web-'));
  const app = createApp({ tripo: tripo ?? fakeTripo(), dataDir, password: PASSWORD, minPollIntervalMs });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // The SPA shell is built by `npm run build`; provide a stand-in when tests run without it.
  const distDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>', { flag: 'wx' }).catch(() => {});
  const close = () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  const loginResponse = await login(base);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  return { base, dataDir, cookie, close };
}

async function login(base, password = PASSWORD) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return response;
}

const post = (base, photo, { quality, cookie } = {}) => {
  const form = new FormData();
  if (photo) form.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');
  if (quality) form.append('quality', quality);
  return fetch(`${base}/api/jobs`, { method: 'POST', body: form, headers: cookie ? { Cookie: cookie } : {} });
};

const status = async (base, id, cookie) =>
  (await fetch(`${base}/api/jobs/${id}`, { headers: { Cookie: cookie } })).json();

const readBody = async response => ({ status: response.status, headers: response.headers, body: await response.json().catch(() => null) });

test('health endpoint is unauthenticated', async () => {
  const { base, close } = await startApp();
  try {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await close();
  }
});

test('the SPA shell is public and unknown GETs fall back to it', async () => {
  const { base, close } = await startApp();
  try {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /id="root"/);
    const fallback = await fetch(`${base}/cualquier-ruta`);
    assert.equal(fallback.status, 200);
    assert.match(await fallback.text(), /id="root"/);
  } finally {
    await close();
  }
});

test('API routes require the session cookie', async () => {
  const { base, close } = await startApp();
  try {
    assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
    assert.equal((await fetch(`${base}/api/jobs/abc`)).status, 401);
    const bad = await fetch(`${base}/api/jobs`, { headers: { Cookie: 'foto3d_session=no' } });
    assert.equal(bad.status, 401);
  } finally {
    await close();
  }
});

test('login rejects a wrong password and accepts the right one', async () => {
  const { base, close } = await startApp();
  try {
    const wrong = await login(base, 'mala');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);

    const good = await login(base);
    assert.equal(good.status, 200);
    const cookie = good.headers.get('set-cookie');
    assert.match(cookie, /foto3d_session=[0-9a-f]{64}/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=/);
  } finally {
    await close();
  }
});

test('logout clears the session cookie', async () => {
  const { base, close } = await startApp();
  try {
    const response = await fetch(`${base}/api/logout`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /foto3d_session=;/);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    await close();
  }
});

test('non-image uploads are rejected by magic bytes', async () => {
  const { base, cookie, close } = await startApp();
  try {
    const response = await readBody(await post(base, Buffer.from('this is not an image'), { cookie }));
    assert.equal(response.status, 415);
    assert.match(response.body.error, /JPEG|PNG/);
  } finally {
    await close();
  }
});

test('missing photo returns 400', async () => {
  const { base, cookie, close } = await startApp();
  try {
    const response = await readBody(await post(base, null, { cookie }));
    assert.equal(response.status, 400);
  } finally {
    await close();
  }
});

test('oversized photos return 413', async () => {
  const { base, cookie, close } = await startApp();
  try {
    const response = await readBody(await post(base, Buffer.alloc(21 * 1024 * 1024), { cookie }));
    assert.equal(response.status, 413);
  } finally {
    await close();
  }
});

test('a second job while one is generating or improving is rejected with 409', async () => {
  const { base, cookie, close } = await startApp();
  try {
    const first = await readBody(await post(base, JPEG, { cookie }));
    assert.equal(first.status, 202);
    const second = await readBody(await post(base, JPEG, { cookie }));
    assert.equal(second.status, 409);
  } finally {
    await close();
  }
});

test('quality fast: P1 model, lifecycle generating -> ready, GLB served', async () => {
  let polls = 0;
  const created = [];
  const tripo = fakeTripo({
    createImageToModelTask: async (fileToken, model) => {
      created.push({ fileToken, model });
      return 'task-1';
    },
    getTask: async () => (++polls === 1
      ? { status: 'running' }
      : { status: 'success', output: { model: 'https://cdn/a.glb', rendered_image: 'https://cdn/b.png' } }),
    downloadModel: async () => Buffer.from('GLB-FAST'),
  });
  const { base, dataDir, cookie, close } = await startApp({ tripo });
  try {
    const createdJob = await readBody(await post(base, PNG, { cookie, quality: 'fast' }));
    const { id } = createdJob.body;
    assert.equal(createdJob.status, 202);

    const first = await status(base, id, cookie);
    assert.equal(first.status, 'generating');
    assert.equal(first.modelUrl, null);
    assert.equal(first.quality, 'fast');
    assert.equal(first.hasHq, false);

    const done = await status(base, id, cookie);
    assert.equal(done.status, 'ready');
    assert.equal(done.modelUrl, `/api/jobs/${id}/model`);
    assert.deepEqual(created, [{ fileToken: 'file-token', model: MODEL_FAST }]);

    const model = await fetch(`${base}/api/jobs/${id}/model`, { headers: { Cookie: cookie } });
    assert.equal(model.status, 200);
    assert.equal(model.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(await model.text(), 'GLB-FAST');

    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(stored[0].taskId, 'task-1');
    assert.equal(stored[0].quality, 'fast');
    assert.equal(stored[0].fileToken, 'file-token');
    assert.equal(stored[0].modelVersion, 1);
    assert.equal((await fs.readFile(path.join(dataDir, 'models', `${id}.glb`))).toString(), 'GLB-FAST');
  } finally {
    await close();
  }
});

test('quality best: P1 task, improving with reused file token, then HQ model', async () => {
  const created = [];
  let fastPolls = 0;
  let hqPolls = 0;
  const tripo = fakeTripo({
    createImageToModelTask: async (fileToken, model) => {
      created.push({ fileToken, model });
      return created.length === 1 ? 'task-fast' : 'task-hq';
    },
    getTask: async taskId => {
      if (taskId === 'task-fast') return ++fastPolls === 1 ? { status: 'running' } : { status: 'success', output: { model: 'https://cdn/fast.glb' } };
      return ++hqPolls === 1 ? { status: 'running' } : { status: 'success', output: { model: 'https://cdn/hq.glb' } };
    },
    downloadModel: async task => Buffer.from(String(task.output.model).includes('hq') ? 'GLB-HQ' : 'GLB-FAST'),
  });
  const { base, dataDir, cookie, close } = await startApp({ tripo });
  try {
    const { body: { id } } = await readBody(await post(base, PNG, { cookie, quality: 'best' }));

    const generating = await status(base, id, cookie);
    assert.equal(generating.status, 'generating');

    // First poll: fast task running. Second: fast success -> improvement task created.
    const improving = await status(base, id, cookie);
    assert.equal(improving.status, 'improving');
    assert.equal(improving.modelUrl, `/api/jobs/${id}/model`);
    assert.equal(improving.hasHq, false);

    // The HQ task reuses the uploaded photo token; no second upload.
    assert.deepEqual(created, [
      { fileToken: 'file-token', model: MODEL_FAST },
      { fileToken: 'file-token', model: MODEL_BEST },
    ]);

    const improvingPoll = await status(base, id, cookie);
    assert.equal(improvingPoll.status, 'improving');

    const done = await status(base, id, cookie);
    assert.equal(done.status, 'ready');
    assert.equal(done.hasHq, true);
    assert.equal(done.modelUrl, `/api/jobs/${id}/model?variant=hq`);

    // variant=hq serves the HQ bytes; without the variant, the fast model.
    const hq = await fetch(`${base}/api/jobs/${id}/model?variant=hq`, { headers: { Cookie: cookie } });
    assert.equal(await hq.text(), 'GLB-HQ');
    const fast = await fetch(`${base}/api/jobs/${id}/model`, { headers: { Cookie: cookie } });
    assert.equal(await fast.text(), 'GLB-FAST');

    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(stored[0].quality, 'best');
    assert.equal(stored[0].taskId, 'task-fast');
    assert.equal(stored[0].hqTaskId, 'task-hq');
    assert.equal(stored[0].modelVersion, 2);
    assert.equal(stored[0].hasHq, true);
    assert.equal((await fs.readFile(path.join(dataDir, 'models', `${id}-hq.glb`))).toString(), 'GLB-HQ');
  } finally {
    await close();
  }
});

test('quality best: a failed improvement keeps the fast model as ready', async () => {
  let fastPolls = 0;
  const tripo = fakeTripo({
    createImageToModelTask: async (fileToken, model) => (model === MODEL_BEST ? 'task-hq' : 'task-fast'),
    getTask: async taskId => {
      if (taskId === 'task-fast') return ++fastPolls === 1 ? { status: 'running' } : { status: 'success', output: { model: 'https://cdn/fast.glb' } };
      return { status: 'failed', message: 'hq failed upstream' };
    },
    downloadModel: async () => Buffer.from('GLB-FAST'),
  });
  const { base, cookie, close } = await startApp({ tripo });
  try {
    const { body: { id } } = await readBody(await post(base, PNG, { cookie, quality: 'best' }));
    await status(base, id, cookie); // fast running
    const improving = await status(base, id, cookie); // fast ready, improving
    assert.equal(improving.status, 'improving');

    const done = await status(base, id, cookie);
    assert.equal(done.status, 'ready');
    assert.equal(done.hasHq, false);
    assert.equal(done.modelUrl, `/api/jobs/${id}/model`);
    const model = await fetch(`${base}/api/jobs/${id}/model?variant=hq`, { headers: { Cookie: cookie } });
    assert.equal(await model.text(), 'GLB-FAST');
  } finally {
    await close();
  }
});

test('quality best: a failed improvement task creation keeps the fast model as ready', async () => {
  let fastPolls = 0;
  const tripo = fakeTripo({
    createImageToModelTask: async (fileToken, model) => {
      if (model === MODEL_BEST) throw new Error('insufficient credits');
      return 'task-fast';
    },
    getTask: async () => (++fastPolls === 1 ? { status: 'running' } : { status: 'success', output: { model: 'https://cdn/fast.glb' } }),
    downloadModel: async () => Buffer.from('GLB-FAST'),
  });
  const { base, cookie, close } = await startApp({ tripo });
  try {
    const { body: { id } } = await readBody(await post(base, PNG, { cookie, quality: 'best' }));
    await status(base, id, cookie); // fast task running
    const done = await status(base, id, cookie); // fast success, HQ task creation fails -> ready
    assert.equal(done.status, 'ready');
    assert.equal(done.hasHq, false);
    assert.equal(done.modelUrl, `/api/jobs/${id}/model`);
  } finally {
    await close();
  }
});

test('failed task becomes an error job with the API message', async () => {
  const tripo = fakeTripo({ getTask: async () => ({ status: 'failed', message: 'generation failed upstream' }) });
  const { base, cookie, close } = await startApp({ tripo });
  try {
    const { body: { id } } = await readBody(await post(base, JPEG, { cookie }));
    const job = await status(base, id, cookie);
    assert.equal(job.status, 'error');
    assert.equal(job.error, 'generation failed upstream');
  } finally {
    await close();
  }
});

test('model endpoint 404s for unknown or not-ready jobs', async () => {
  const { base, cookie, close } = await startApp();
  try {
    assert.equal((await fetch(`${base}/api/jobs/does-not-exist/model`, { headers: { Cookie: cookie } })).status, 404);
    const { body: { id } } = await readBody(await post(base, JPEG, { cookie }));
    assert.equal((await fetch(`${base}/api/jobs/${id}/model`, { headers: { Cookie: cookie } })).status, 404);
  } finally {
    await close();
  }
});

test('restart resumes generating jobs from jobs.json', async () => {
  const { base, dataDir, cookie, close } = await startApp(); // getTask stays 'running'
  const { body: { id } } = await readBody(await post(base, JPEG, { cookie }));
  await close();

  const tripo = fakeTripo({
    getTask: async () => ({ status: 'success', output: { model: 'https://cdn/a.glb' } }),
    downloadModel: async () => Buffer.from('GLB-AFTER-RESTART'),
  });
  const app = createApp({ tripo, dataDir, password: PASSWORD, minPollIntervalMs: 0 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const restartedBase = `http://127.0.0.1:${server.address().port}`;
    const loginResponse = await login(restartedBase);
    const restartedCookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const job = await status(restartedBase, id, restartedCookie);
    assert.equal(job.status, 'ready');
    const model = await fetch(`${restartedBase}/api/jobs/${id}/model`, { headers: { Cookie: restartedCookie } });
    assert.equal(await model.text(), 'GLB-AFTER-RESTART');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('restart resumes improving jobs via the stored hqTaskId', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-web-'));
  const id = 'job-improving';
  const job = {
    id,
    taskId: 'task-fast',
    hqTaskId: 'task-hq',
    fileToken: 'file-token',
    quality: 'best',
    status: 'improving',
    error: null,
    modelUrl: `/api/jobs/${id}/model`,
    modelVersion: 1,
    hasHq: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastPolledAt: 0,
  };
  await fs.mkdir(path.join(dataDir, 'models'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'models', `${id}.glb`), 'GLB-FAST');
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([job]));

  const tripo = fakeTripo({
    getTask: async taskId => {
      assert.equal(taskId, 'task-hq'); // improvement resumes from the stored task id
      return { status: 'success', output: { model: 'https://cdn/hq.glb' } };
    },
    downloadModel: async () => Buffer.from('GLB-HQ-RESTART'),
  });
  const app = createApp({ tripo, dataDir, password: PASSWORD, minPollIntervalMs: 0 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const restartedBase = `http://127.0.0.1:${server.address().port}`;
    const loginResponse = await login(restartedBase);
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const done = await status(restartedBase, id, cookie);
    assert.equal(done.status, 'ready');
    assert.equal(done.hasHq, true);
    assert.equal(done.modelUrl, `/api/jobs/${id}/model?variant=hq`);
    const hq = await fetch(`${restartedBase}/api/jobs/${id}/model?variant=hq`, { headers: { Cookie: cookie } });
    assert.equal(await hq.text(), 'GLB-HQ-RESTART');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('createApp refuses to start without WEB_PASSWORD', () => {
  delete process.env.WEB_PASSWORD;
  assert.throws(() => createApp({ tripo: fakeTripo(), dataDir: os.tmpdir() }), /WEB_PASSWORD/);
});
