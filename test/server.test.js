import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

const PASSWORD = 'secreto-de-prueba';
const AUTH = `Basic ${Buffer.from(`edu:${PASSWORD}`).toString('base64')}`;

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
  const close = () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return { base, dataDir, close };
}

const post = (base, photo, { type = 'image/jpeg', auth = AUTH } = {}) => {
  const form = new FormData();
  if (photo) form.append('photo', new Blob([photo], { type }), 'photo.jpg');
  return fetch(`${base}/api/jobs`, { method: 'POST', body: form, headers: auth ? { Authorization: auth } : {} });
};

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

test('everything else requires basic auth', async () => {
  const { base, close } = await startApp();
  try {
    for (const path of ['/', '/styles.css', '/api/jobs']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 401, path);
      assert.match(response.headers.get('www-authenticate') ?? '', /Basic/);
    }
    const wrong = await fetch(`${base}/`, { headers: { Authorization: `Basic ${Buffer.from('edu:mala').toString('base64')}` } });
    assert.equal(wrong.status, 401);
    const good = await fetch(`${base}/`, { headers: { Authorization: AUTH } });
    assert.equal(good.status, 200);
    assert.match(await good.text(), /Foto a 3D/);
    const vendor = await fetch(`${base}/vendor/model-viewer.min.js`, { headers: { Authorization: AUTH } });
    assert.equal(vendor.status, 200);
  } finally {
    await close();
  }
});

test('non-image uploads are rejected by magic bytes', async () => {
  const { base, close } = await startApp();
  try {
    const response = await readBody(await post(base, Buffer.from('this is not an image')));
    assert.equal(response.status, 415);
    assert.match(response.body.error, /JPEG|PNG/);
  } finally {
    await close();
  }
});

test('missing photo returns 400', async () => {
  const { base, close } = await startApp();
  try {
    const response = await readBody(await post(base, null));
    assert.equal(response.status, 400);
  } finally {
    await close();
  }
});

test('oversized photos return 413', async () => {
  const { base, close } = await startApp();
  try {
    const response = await readBody(await post(base, Buffer.alloc(21 * 1024 * 1024)));
    assert.equal(response.status, 413);
  } finally {
    await close();
  }
});

test('a second job while one is generating is rejected with 409', async () => {
  const { base, close } = await startApp();
  try {
    const first = await readBody(await post(base, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])));
    assert.equal(first.status, 202);
    assert.equal(first.body.status, 'generating');
    const second = await readBody(await post(base, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])));
    assert.equal(second.status, 409);
  } finally {
    await close();
  }
});

test('full lifecycle: generating -> ready, model served as GLB', async () => {
  let polls = 0;
  let downloadedTask;
  const tripo = fakeTripo({
    getTask: async () => (++polls === 1
      ? { status: 'running' }
      : { status: 'success', output: { model: 'https://cdn/a.glb', rendered_image: 'https://cdn/b.png' } }),
    downloadModel: async task => {
      downloadedTask = task;
      return Buffer.from('GLB-BYTES');
    },
  });
  const { base, dataDir, close } = await startApp({ tripo });
  try {
    const created = await readBody(await post(base, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    const { id } = created.body;
    assert.equal(created.status, 202);

    const first = await readBody(await fetch(`${base}/api/jobs/${id}`, { headers: { Authorization: AUTH } }));
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'generating');
    assert.equal(first.body.modelUrl, null);

    const done = await readBody(await fetch(`${base}/api/jobs/${id}`, { headers: { Authorization: AUTH } }));
    assert.equal(done.body.status, 'ready');
    assert.equal(done.body.modelUrl, `/api/jobs/${id}/model`);
    assert.equal(downloadedTask.status, 'success');

    const model = await fetch(`${base}/api/jobs/${id}/model`, { headers: { Authorization: AUTH } });
    assert.equal(model.status, 200);
    assert.equal(model.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(await model.text(), 'GLB-BYTES');

    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].taskId, 'task-1');
    assert.equal(stored[0].status, 'ready');
    assert.equal((await fs.readFile(path.join(dataDir, 'models', `${id}.glb`))).toString(), 'GLB-BYTES');
  } finally {
    await close();
  }
});

test('failed task becomes an error job with the API message', async () => {
  const tripo = fakeTripo({ getTask: async () => ({ status: 'failed', message: 'generation failed upstream' }) });
  const { base, close } = await startApp({ tripo });
  try {
    const { body: { id } } = await readBody(await post(base, Buffer.from([0xff, 0xd8, 0xff, 1])));
    const job = await readBody(await fetch(`${base}/api/jobs/${id}`, { headers: { Authorization: AUTH } }));
    assert.equal(job.body.status, 'error');
    assert.equal(job.body.error, 'generation failed upstream');
  } finally {
    await close();
  }
});

test('model endpoint 404s for unknown or not-ready jobs', async () => {
  const { base, close } = await startApp();
  try {
    assert.equal((await fetch(`${base}/api/jobs/does-not-exist/model`, { headers: { Authorization: AUTH } })).status, 404);
    const { body: { id } } = await readBody(await post(base, Buffer.from([0xff, 0xd8, 0xff, 1])));
    assert.equal((await fetch(`${base}/api/jobs/${id}/model`, { headers: { Authorization: AUTH } })).status, 404);
  } finally {
    await close();
  }
});

test('restart resumes stuck jobs from jobs.json (state lives on Tripo side)', async () => {
  const { base, dataDir, close } = await startApp(); // getTask stays 'running'
  const { body: { id } } = await readBody(await post(base, Buffer.from([0xff, 0xd8, 0xff, 1])));
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
    const job = await readBody(await fetch(`${restartedBase}/api/jobs/${id}`, { headers: { Authorization: AUTH } }));
    assert.equal(job.body.status, 'ready');
    const model = await fetch(`${restartedBase}/api/jobs/${id}/model`, { headers: { Authorization: AUTH } });
    assert.equal(await model.text(), 'GLB-AFTER-RESTART');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('createApp refuses to start without WEB_PASSWORD', () => {
  delete process.env.WEB_PASSWORD;
  assert.throws(() => createApp({ tripo: fakeTripo(), dataDir: os.tmpdir() }), /WEB_PASSWORD/);
});
