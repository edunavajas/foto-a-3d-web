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

const post = (base, photo, { quality, texture, rig, cookie } = {}) => {
  const form = new FormData();
  if (photo) form.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');
  if (quality) form.append('quality', quality);
  if (texture !== undefined) form.append('texture', texture);
  if (rig !== undefined) form.append('rig', rig);
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
    createImageToModelTask: async (fileToken, model, options) => {
      created.push({ fileToken, model, options });
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
    assert.equal(first.hasRig, false);

    const done = await status(base, id, cookie);
    assert.equal(done.status, 'ready');
    assert.equal(done.modelUrl, `/api/jobs/${id}/model`);
    assert.equal(done.hasRig, false);
    // Textures are on by default: PBR + standard quality.
    assert.deepEqual(created, [{
      fileToken: 'file-token',
      model: MODEL_FAST,
      options: { texture: true, pbr: true, texture_quality: 'standard' },
    }]);

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
    createImageToModelTask: async (fileToken, model, options) => {
      created.push({ fileToken, model, options });
      return created.length === 1 ? 'task-fast' : 'task-hq';
    },
    getTask: async taskId => {
      if (taskId === 'task-fast') return ++fastPolls === 1 ? { status: 'running', progress: 37 } : { status: 'success', output: { model: 'https://cdn/fast.glb' } };
      return ++hqPolls === 1 ? { status: 'running', progress: 88 } : { status: 'success', output: { model: 'https://cdn/hq.glb' } };
    },
    downloadModel: async task => Buffer.from(String(task.output.model).includes('hq') ? 'GLB-HQ' : 'GLB-FAST'),
  });
  const { base, dataDir, cookie, close } = await startApp({ tripo });
  try {
    const { body: { id } } = await readBody(await post(base, PNG, { cookie, quality: 'best' }));

    const generating = await status(base, id, cookie);
    assert.equal(generating.status, 'generating');
    assert.equal(generating.progress, 37);

    // First poll: fast task running. Second: fast success -> improvement task created.
    const improving = await status(base, id, cookie);
    assert.equal(improving.status, 'improving');
    assert.equal(improving.modelUrl, `/api/jobs/${id}/model`);
    assert.equal(improving.hasHq, false);
    assert.equal(improving.hqProgress, null);

    // The HQ task reuses the uploaded photo token; no second upload. Same texture params.
    assert.deepEqual(created, [
      { fileToken: 'file-token', model: MODEL_FAST, options: { texture: true, pbr: true, texture_quality: 'standard' } },
      { fileToken: 'file-token', model: MODEL_BEST, options: { texture: true, pbr: true, texture_quality: 'standard' } },
    ]);

    const improvingPoll = await status(base, id, cookie);
    assert.equal(improvingPoll.status, 'improving');
    assert.equal(improvingPoll.hqProgress, 88);

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
    assert.equal(stored[0].progress, 37);
    assert.equal(stored[0].hqProgress, 88);
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

test('texture=off sends texture:false + pbr:false; texture=on sends PBR + standard quality', async () => {
  const created = [];
  let polls = 0;
  const tripo = fakeTripo({
    createImageToModelTask: async (fileToken, model, options) => {
      created.push(options);
      return 'task-1';
    },
    getTask: async () => (++polls % 2 === 1 ? { status: 'running' } : { status: 'success', output: { model: 'https://cdn/a.glb' } }),
    downloadModel: async () => Buffer.from('GLB'),
  });
  const { base, cookie, close } = await startApp({ tripo });
  try {
    const first = await readBody(await post(base, JPEG, { cookie, texture: 'off' }));
    await status(base, first.body.id, cookie); // running
    await status(base, first.body.id, cookie); // success -> ready (frees the single-slot queue)
    await readBody(await post(base, JPEG, { cookie, texture: 'on' }));
    assert.deepEqual(created, [
      { texture: false, pbr: false },
      { texture: true, pbr: true, texture_quality: 'standard' },
    ]);
  } finally {
    await close();
  }
});

test('fast + rig: rigging runs after ready with input=main taskId, then the rigged model', async () => {
  let mainPolls = 0;
  let rigPolls = 0;
  const rigSources = [];
  const tripo = fakeTripo({
    createRigTask: async input => {
      rigSources.push(input);
      return 'task-rig';
    },
    getTask: async taskId => {
      if (taskId === 'task-rig') return ++rigPolls === 1 ? { status: 'running', progress: 40 } : { status: 'success', output: { model: 'https://cdn/rigged.glb' } };
      return ++mainPolls === 1 ? { status: 'running' } : { status: 'success', output: { model: 'https://cdn/fast.glb' } };
    },
    downloadModel: async task => Buffer.from(String(task.output.model).includes('rigged') ? 'GLB-RIG' : 'GLB-FAST'),
  });
  const { base, dataDir, cookie, close } = await startApp({ tripo });
  try {
    const { body: { id } } = await readBody(await post(base, PNG, { cookie, rig: 'on' }));

    await status(base, id, cookie); // main running
    const rigging = await status(base, id, cookie); // main success -> rigging
    assert.equal(rigging.status, 'rigging');
    assert.equal(rigging.modelUrl, `/api/jobs/${id}/model`);
    assert.equal(rigging.hasRig, false);
    assert.equal(rigging.rigProgress, null);

    const polling = await status(base, id, cookie); // rig task created and polled
    assert.equal(polling.status, 'rigging');
    assert.equal(polling.rigProgress, 40);
    assert.deepEqual(rigSources, ['task-1']); // the rig input is the main task id

    const done = await status(base, id, cookie);
    assert.equal(done.status, 'ready');
    assert.equal(done.hasRig, true);
    assert.equal(done.modelUrl, `/api/jobs/${id}/model?variant=rigged`);

    const rigged = await fetch(`${base}/api/jobs/${id}/model?variant=rigged`, { headers: { Cookie: cookie } });
    assert.equal(await rigged.text(), 'GLB-RIG');
    const fast = await fetch(`${base}/api/jobs/${id}/model`, { headers: { Cookie: cookie } });
    assert.equal(await fast.text(), 'GLB-FAST');

    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(stored[0].rig, true);
    assert.equal(stored[0].hasRig, true);
    assert.equal(stored[0].rigTaskId, 'task-rig');
    assert.equal(stored[0].rigProgress, 40);
    assert.equal((await fs.readFile(path.join(dataDir, 'models', `${id}-rigged.glb`))).toString(), 'GLB-RIG');
  } finally {
    await close();
  }
});

test('best + rig: the rig input is the HQ task id', async () => {
  let fastPolls = 0;
  let hqPolls = 0;
  let rigPolls = 0;
  const rigSources = [];
  const tripo = fakeTripo({
    createImageToModelTask: async (fileToken, model) => (model === MODEL_BEST ? 'task-hq' : 'task-fast'),
    createRigTask: async input => {
      rigSources.push(input);
      return 'task-rig';
    },
    getTask: async taskId => {
      if (taskId === 'task-fast') return ++fastPolls === 1 ? { status: 'running' } : { status: 'success', output: { model: 'https://cdn/fast.glb' } };
      if (taskId === 'task-rig') return ++rigPolls === 1 ? { status: 'running' } : { status: 'success', output: { model: 'https://cdn/rigged.glb' } };
      return ++hqPolls === 1 ? { status: 'running' } : { status: 'success', output: { model: 'https://cdn/hq.glb' } };
    },
    downloadModel: async task => Buffer.from(String(task.output.model).includes('rigged') ? 'GLB-RIG' : String(task.output.model).includes('hq') ? 'GLB-HQ' : 'GLB-FAST'),
  });
  const { base, cookie, close } = await startApp({ tripo });
  try {
    const { body: { id } } = await readBody(await post(base, PNG, { cookie, quality: 'best', rig: 'on' }));
    await status(base, id, cookie); // fast running
    await status(base, id, cookie); // fast success -> improving
    await status(base, id, cookie); // hq running
    const rigging = await status(base, id, cookie); // hq success -> rigging
    assert.equal(rigging.status, 'rigging');
    assert.equal(rigging.modelUrl, `/api/jobs/${id}/model?variant=hq`);
    await status(base, id, cookie); // rig task created and polled
    const done = await status(base, id, cookie);
    assert.equal(done.status, 'ready');
    assert.equal(done.hasRig, true);
    assert.equal(done.modelUrl, `/api/jobs/${id}/model?variant=rigged`);
    assert.deepEqual(rigSources, ['task-hq']);
  } finally {
    await close();
  }
});

test('a failed rig task keeps the current model as ready without hasRig', async () => {
  let mainPolls = 0;
  const tripo = fakeTripo({
    createRigTask: async () => 'task-rig',
    getTask: async taskId => {
      if (taskId === 'task-rig') return { status: 'failed', message: 'rig failed upstream' };
      return ++mainPolls === 1 ? { status: 'running' } : { status: 'success', output: { model: 'https://cdn/fast.glb' } };
    },
    downloadModel: async () => Buffer.from('GLB-FAST'),
  });
  const { base, cookie, close } = await startApp({ tripo });
  try {
    const { body: { id } } = await readBody(await post(base, PNG, { cookie, rig: 'on' }));
    await status(base, id, cookie); // fast running
    const rigging = await status(base, id, cookie);
    assert.equal(rigging.status, 'rigging');
    const done = await status(base, id, cookie);
    assert.equal(done.status, 'ready');
    assert.equal(done.hasRig, false);
    assert.equal(done.modelUrl, `/api/jobs/${id}/model`);
    const model = await fetch(`${base}/api/jobs/${id}/model?variant=rigged`, { headers: { Cookie: cookie } });
    assert.equal(await model.text(), 'GLB-FAST'); // falls back to the fast model
  } finally {
    await close();
  }
});

test('invalid texture or rig values are rejected with 400', async () => {
  const { base, cookie, close } = await startApp();
  try {
    assert.equal((await readBody(await post(base, JPEG, { cookie, texture: 'yes' }))).status, 400);
    assert.equal((await readBody(await post(base, JPEG, { cookie, rig: 'maybe' }))).status, 400);
    assert.equal((await readBody(await post(base, JPEG, { cookie, texture: '1', rig: '0' }))).status, 400);
  } finally {
    await close();
  }
});

test('restart resumes rigging jobs from the stored rigTaskId', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-web-'));
  const id = 'job-rigging';
  const job = {
    id,
    taskId: 'task-fast',
    hqTaskId: null,
    rigTaskId: 'task-rig',
    fileToken: 'file-token',
    quality: 'fast',
    texture: true,
    rig: true,
    status: 'rigging',
    error: null,
    modelUrl: `/api/jobs/${id}/model`,
    modelVersion: 1,
    hasHq: false,
    hasRig: false,
    progress: 100,
    rigProgress: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastPolledAt: 0,
  };
  await fs.mkdir(path.join(dataDir, 'models'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'models', `${id}.glb`), 'GLB-FAST');
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([job]));

  let rigPolls = 0;
  const tripo = fakeTripo({
    getTask: async taskId => {
      assert.equal(taskId, 'task-rig'); // rigging resumes from the stored task id
      return ++rigPolls === 1 ? { status: 'running', progress: 55 } : { status: 'success', output: { model: 'https://cdn/rigged.glb' } };
    },
    downloadModel: async () => Buffer.from('GLB-RIG-RESTART'),
  });
  const app = createApp({ tripo, dataDir, password: PASSWORD, minPollIntervalMs: 0 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const restartedBase = `http://127.0.0.1:${server.address().port}`;
    const loginResponse = await login(restartedBase);
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const resumed = await status(restartedBase, id, cookie);
    assert.equal(resumed.status, 'rigging');
    assert.equal(resumed.rigProgress, 55);
    const done = await status(restartedBase, id, cookie);
    assert.equal(done.status, 'ready');
    assert.equal(done.hasRig, true);
    assert.equal(done.modelUrl, `/api/jobs/${id}/model?variant=rigged`);
    const rigged = await fetch(`${restartedBase}/api/jobs/${id}/model?variant=rigged`, { headers: { Cookie: cookie } });
    assert.equal(await rigged.text(), 'GLB-RIG-RESTART');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('restart resumes a rigging job that has no rigTaskId yet by creating it', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-web-'));
  const id = 'job-rig-pending';
  const job = {
    id,
    taskId: 'task-fast',
    hqTaskId: 'task-hq',
    rigTaskId: null,
    fileToken: 'file-token',
    quality: 'best',
    texture: true,
    rig: true,
    status: 'rigging',
    error: null,
    modelUrl: `/api/jobs/${id}/model?variant=hq`,
    modelVersion: 2,
    hasHq: true,
    hasRig: false,
    progress: 100,
    hqProgress: 100,
    rigProgress: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastPolledAt: 0,
  };
  await fs.mkdir(path.join(dataDir, 'models'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'models', `${id}.glb`), 'GLB-FAST');
  await fs.writeFile(path.join(dataDir, 'models', `${id}-hq.glb`), 'GLB-HQ');
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([job]));

  const rigSources = [];
  const tripo = fakeTripo({
    createRigTask: async input => {
      rigSources.push(input);
      return 'task-rig';
    },
    getTask: async () => ({ status: 'success', output: { model: 'https://cdn/rigged.glb' } }),
    downloadModel: async () => Buffer.from('GLB-RIG-RESTART'),
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
    assert.equal(done.hasRig, true);
    assert.deepEqual(rigSources, ['task-hq']); // the HQ model is the best current task
  } finally {
    await new Promise(resolve => server.close(resolve));
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

test('progress is clamped to 0-100 and kept when the API stops reporting it', async () => {
  let polls = 0;
  const tripo = fakeTripo({
    getTask: async () => (++polls === 1 ? { status: 'running', progress: 150 } : { status: 'running' }),
  });
  const { base, dataDir, cookie, close } = await startApp({ tripo });
  try {
    const { body: { id } } = await readBody(await post(base, JPEG, { cookie }));
    const first = await status(base, id, cookie);
    assert.equal(first.progress, 100);
    const second = await status(base, id, cookie);
    assert.equal(second.progress, 100); // absent progress keeps the previous value
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(stored[0].progress, 100);
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
