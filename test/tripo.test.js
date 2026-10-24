import test from 'node:test';
import assert from 'node:assert/strict';
import { TripoClient, TripoError, findModelUrl } from '../src/tripo.js';

const originalFetch = globalThis.fetch;
const BASE = 'https://openapi.tripo3d.ai';

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const client = () => new TripoClient({ apiKey: 'test-key', backoffMs: 1 });

// Replace global fetch with a scripted handler and restore it when the test ends.
function stubFetch(t, handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(url, init, calls.length);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return calls;
}

test('envelope success unwraps data and sends bearer auth', async t => {
  const calls = stubFetch(t, () => jsonResponse({ code: 0, data: { balance: 42 }, message: 'ok' }));
  assert.equal(await client().getBalance(), 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/v3/account/balance`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
});

test('error envelope becomes TripoError with the API message', async t => {
  stubFetch(t, () => jsonResponse({ code: 1003, data: null, message: 'invalid api key' }));
  await assert.rejects(client().getBalance(), error => {
    assert.ok(error instanceof TripoError);
    assert.equal(error.message, 'invalid api key');
    assert.equal(error.apiCode, 1003);
    return true;
  });
});

test('uploadImage posts multipart with the right field, mime and filename', async t => {
  const calls = stubFetch(t, () => jsonResponse({ code: 0, data: { file_token: 'tok-1' } }));
  const bytes = Buffer.from([1, 2, 3]);
  const token = await client().uploadImage(bytes, 'photo.jpg', 'image/jpeg');
  assert.equal(token, 'tok-1');
  assert.equal(calls[0].url, `${BASE}/v3/files`);
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.body instanceof FormData);
  const part = calls[0].init.body.get('file');
  assert.equal(part.type, 'image/jpeg');
  assert.equal(part.name, 'photo.jpg');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes);
});

test('createImageToModelTask posts the file token as input', async t => {
  const calls = stubFetch(t, () => jsonResponse({ code: 0, data: { task_id: 'task-9' } }));
  const taskId = await client().createImageToModelTask('tok-1');
  assert.equal(taskId, 'task-9');
  assert.equal(calls[0].url, `${BASE}/v3/generation/image-to-model`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { input: 'tok-1', model: 'v3.1-20260211' });
});

test('getTask hits the task endpoint and returns the task object', async t => {
  const task = { task_id: 'tk 1', status: 'running' };
  const calls = stubFetch(t, () => jsonResponse({ code: 0, data: task }));
  assert.deepEqual(await client().getTask('tk 1'), task);
  assert.equal(calls[0].url, `${BASE}/v3/tasks/tk%201`);
});

test('findModelUrl prefers /model/i fields and handles nested {url} objects', () => {
  assert.equal(findModelUrl({ output: { model: 'https://cdn/a.glb', rendered_image: 'https://cdn/b.png' } }), 'https://cdn/a.glb');
  assert.equal(findModelUrl({ output: { pbr_model: { url: 'https://cdn/m.glb?Expires=1' }, rendered_image: 'https://cdn/r.png' } }), 'https://cdn/m.glb?Expires=1');
  assert.equal(findModelUrl({ output: { rendered: 'https://cdn/a.png', other: 'https://cdn/b.glb' } }), 'https://cdn/b.glb');
  assert.equal(findModelUrl({ output: { rendered: 'https://cdn/a.png' } }), null);
  assert.equal(findModelUrl(undefined), null);
});

test('downloadModel fetches the selected .glb URL and returns its bytes', async t => {
  const calls = stubFetch(t, url => {
    assert.match(String(url), /\.glb$/);
    return new Response(Buffer.from('GLB-BYTES'), { status: 200 });
  });
  const task = { output: { model: 'https://cdn/a.glb', rendered_image: 'https://cdn/b.png' } };
  assert.deepEqual(await client().downloadModel(task), Buffer.from('GLB-BYTES'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cdn/a.glb');
});

test('task creation is NOT retried on 5xx (the task may already exist)', async t => {
  const calls = stubFetch(t, () => jsonResponse({ code: 1, data: null, message: 'boom' }, 500));
  await assert.rejects(client().createImageToModelTask('tok-1'), { message: 'boom' });
  assert.equal(calls.length, 1);
});

test('task creation IS retried on 429 (proves nothing was created)', async t => {
  const calls = stubFetch(t, (url, init, attempt) =>
    attempt === 1
      ? jsonResponse({ code: 1, data: null, message: 'rate limited' }, 429, { 'retry-after': '0' })
      : jsonResponse({ code: 0, data: { task_id: 'task-9' } }));
  assert.equal(await client().createImageToModelTask('tok-1'), 'task-9');
  assert.equal(calls.length, 2);
});

test('idempotent calls retry on 5xx and succeed', async t => {
  const calls = stubFetch(t, (url, init, attempt) =>
    attempt === 1
      ? jsonResponse({ code: 1, data: null, message: 'upstream hiccup' }, 503)
      : jsonResponse({ code: 0, data: { balance: 7 } }));
  assert.equal(await client().getBalance(), 7);
  assert.equal(calls.length, 2);
});

test('idempotent calls retry on network errors and succeed', async t => {
  const calls = stubFetch(t, (url, init, attempt) => {
    if (attempt === 1) throw new TypeError('fetch failed');
    return jsonResponse({ code: 0, data: { balance: 3 } });
  });
  assert.equal(await client().getBalance(), 3);
  assert.equal(calls.length, 2);
});

test('TripoClient refuses to start without an API key', () => {
  delete process.env.TRIPO_API_KEY;
  assert.throws(() => new TripoClient({}), TripoError);
});
