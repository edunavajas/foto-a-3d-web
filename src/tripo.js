/**
 * Minimal Tripo V3 API client on top of global fetch (Node 20+).
 * Every response is an envelope {code, data, message}: success iff code === 0.
 * Task creation is never retried on network/5xx (the task may already exist
 * and credits get frozen); only a 429 rejection proves nothing was created.
 */
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'expired']);

/** Wire values for the image-to-model models (verified against the Tripo V3 API). */
export const MODEL_FAST = 'P1-20260311'; // low-poly, fast, cheaper
export const MODEL_BEST = 'v3.1-20260211'; // high fidelity, slower
/** Wire value for the rig step; marketing names like rig-v1.0 are rejected by the API. */
export const RIG_MODEL = 'v3.0-20260909';

export class TripoError extends Error {
  constructor(message, { httpStatus, apiCode, retryAfterMs } = {}) {
    super(message);
    this.name = 'TripoError';
    this.httpStatus = httpStatus;
    this.apiCode = apiCode;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isFailedStatus(status) {
  return FAILED_STATUSES.has(status);
}

/** Walk task.output (strings, {url} objects, arrays) for a .glb URL, preferring /model/i fields. */
export function findModelUrl(task) {
  const urls = [];
  const visit = (value, field) => {
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) urls.push({ field, url: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${field}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, field ? `${field}.${key}` : key);
    }
  };
  visit(task?.output, '');
  const glbs = urls.filter(({ url }) => {
    try {
      return new URL(url).pathname.toLowerCase().endsWith('.glb');
    } catch {
      return false;
    }
  });
  return (glbs.find(({ field }) => /model/i.test(field)) ?? glbs[0])?.url ?? null;
}

export class TripoClient {
  constructor({
    apiKey = process.env.TRIPO_API_KEY,
    baseUrl = 'https://openapi.tripo3d.ai',
    timeoutMs = 60_000,
    maxRetries = 2,
    backoffMs = 1000,
  } = {}) {
    if (!apiKey) throw new TripoError('TRIPO_API_KEY is not set');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.backoffMs = backoffMs;
  }

  async #send(method, path, init, { idempotent = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      let error;
      try {
        return await this.#sendOnce(method, path, init);
      } catch (caught) {
        error = caught;
      }
      const retryable = error.httpStatus === 429
        || (idempotent && (error.httpStatus === undefined || error.httpStatus >= 500));
      if (!retryable || attempt >= this.maxRetries) throw error;
      const delay = Math.min(Math.max(this.backoffMs * 2 ** attempt, error.retryAfterMs ?? 0), 60_000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  async #sendOnce(method, path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...init?.headers },
        body: init?.body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new TripoError(`network error: ${method} ${path}: ${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      envelope = null;
    }
    if (!response.ok || !envelope || envelope.code !== 0) {
      throw new TripoError(envelope?.message || `HTTP ${response.status} from ${path}`, {
        httpStatus: response.status,
        apiCode: envelope?.code,
        retryAfterMs: response.status === 429 ? retryHintMs(response.headers) : undefined,
      });
    }
    return envelope.data;
  }

  async uploadImage(buffer, filename, mime) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), filename);
    const data = await this.#send('POST', '/v3/files', { body: form });
    return data.file_token;
  }

  async createImageToModelTask(fileToken, model, options = {}) {
    if (!model) throw new TripoError('createImageToModelTask requires a model');
    const data = await this.#send(
      'POST',
      '/v3/generation/image-to-model',
      { body: JSON.stringify({ input: fileToken, model, ...options }), headers: { 'Content-Type': 'application/json' } },
      { idempotent: false },
    );
    return data.task_id;
  }

  /** Rig chain step: turns a finished model task into an animate_rig task (~25 credits). */
  async createRigTask(sourceTaskId) {
    if (!sourceTaskId) throw new TripoError('createRigTask requires a source task id');
    const data = await this.#send(
      'POST',
      '/v3/animations/rig',
      { body: JSON.stringify({ input: sourceTaskId, model: RIG_MODEL }), headers: { 'Content-Type': 'application/json' } },
      { idempotent: false },
    );
    return data.task_id;
  }

  async getTask(taskId) {
    return this.#send('GET', `/v3/tasks/${encodeURIComponent(taskId)}`);
  }

  async getBalance() {
    return (await this.#send('GET', '/v3/account/balance')).balance;
  }

  /** Output URLs expire in ~5 minutes — download immediately once the task is success. */
  async downloadModel(task) {
    const url = findModelUrl(task);
    if (!url) throw new TripoError('Task output contains no .glb model URL');
    const response = await fetch(url);
    if (!response.ok) throw new TripoError(`model download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

/** Retry-After is in seconds. */
function retryHintMs(headers) {
  const seconds = Number(headers?.get('retry-after') ?? Number.NaN);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
