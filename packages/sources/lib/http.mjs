// One guarded outbound request.
// - The deadline is a plain setTimeout on an AbortController: AbortSignal.timeout
//   is unref'd and never fires when the request is the only pending work.
// - Retries only for repeatable requests (GET/HEAD/OPTIONS, or retryUnsafe):
//   a retried POST sends somebody a second message. 429/5xx honour retry-after.
// - 200 is not proof of content: bodies are read under a byte cap and a stall
//   bound separate from the request deadline.
// - Every error names a laundered URL: query keys kept, values, userinfo and
//   fragment dropped.
// `allowStatus` lists exactly the non-2xx statuses the caller has a branch for.
// Never: put a raw URL or an unbounded body into an error message.

export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_STALL_MS = 20000;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RETRIES = 3;
export const DEFAULT_BACKOFF_MS = 500;
export const ERROR_BODY_BYTES = 8 * 1024;
export const ERROR_BODY_QUOTE = 400;
export const MAX_RETRY_AFTER_MS = 3600_000;
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);

export const TRANSPORT_CODES = ['network-timeout', 'dns-unresolved', 'connection-refused', 'tls-failed', 'redirect-refused', 'network-unavailable'];

/** One opaque code per way a request can fail; undici keeps the real reason on `cause`. */
export function transportCode(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'network-timeout';
  const cause = error?.cause?.code ?? error?.code ?? '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(cause)) return 'dns-unresolved';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(cause)) return 'connection-refused';
  if (typeof cause === 'string' && (cause.startsWith('ERR_TLS') || cause.startsWith('CERT_') || cause.startsWith('DEPTH_'))) return 'tls-failed';
  if (/redirect/i.test(error?.message ?? '')) return 'redirect-refused';
  return 'network-unavailable';
}

export function safeUrl(url) {
  const text = String(url ?? '');
  try {
    const parsed = new URL(text);
    const keys = [...new Set(parsed.searchParams.keys())];
    const base = `${parsed.origin}${parsed.pathname}`;
    return keys.length ? `${base}?${keys.map((k) => `${k}=<redacted>`).join('&')}` : base;
  } catch {
    return text.replace(/\?\S*/u, '?<redacted>');
  }
}

export const redactUrls = (text) => String(text ?? '').replace(/https?:\/\/[^\s"'<>)\]}]+/gu, (m) => safeUrl(m));

/** A deadline that fires; always call clear(), a ref'd timer holds the process open. */
export function deadline(ms, what = 'request') {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error(`${what} exceeded ${ms}ms`);
    error.name = 'TimeoutError';
    controller.abort(error);
  }, ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function withStall(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => { const e = new Error(`${label} delivered nothing for ${ms}ms`); e.name = 'StallError'; reject(e); }, ms);
    }),
  ]);
}

export const transient = (status) => status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);

/** retry-after in ms (seconds or HTTP date), or null when absent, unparseable or over an hour. */
export function retryAfterMs(header) {
  if (header === null || header === undefined || header === '') return null;
  const seconds = Number(String(header).trim());
  if (Number.isFinite(seconds)) return seconds >= 0 && seconds * 1000 <= MAX_RETRY_AFTER_MS ? seconds * 1000 : null;
  const at = Date.parse(String(header));
  if (!Number.isFinite(at)) return null;
  const delta = at - Date.now();
  return delta > 0 && delta <= MAX_RETRY_AFTER_MS ? delta : null;
}

export class HttpError extends Error {
  constructor(message, { url, status, attempts, body, retryAfterMs: after = null, code = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.url = url === undefined ? undefined : safeUrl(url);
    this.status = status ?? null;
    this.attempts = attempts ?? 1;
    this.body = body ?? null;
    this.retryAfterMs = after;
    this.code = code;
  }
}

/** fetch with a deadline (headers only) and safe retries; resolves the Response, throws HttpError otherwise. */
export async function guardedFetch(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries, retryUnsafe = false, allowStatus = [],
  backoffMs = DEFAULT_BACKOFF_MS, fetchImpl = fetch, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), ...init } = {}) {
  const method = String(init.method ?? 'GET').toUpperCase();
  const attempts = Math.max(1, IDEMPOTENT.has(method) || retryUnsafe ? (retries ?? DEFAULT_RETRIES) : 1);
  const label = `${method} ${safeUrl(url)}`;
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    const clock = init.signal ? null : deadline(timeoutMs, label);
    try {
      response = await fetchImpl(url, { ...init, signal: init.signal ?? clock.signal });
      clock?.clear();
    } catch (error) {
      clock?.clear();
      const code = transportCode(error);
      last = new HttpError(code === 'network-timeout' ? `${label} timed out after ${timeoutMs}ms` : `${label} failed: ${redactUrls(error?.message ?? error)}`,
        { url, attempts: attempt, code });
      last.cause = error;
      if (attempt === attempts) throw last;
      await sleep(backoffMs * 2 ** (attempt - 1));
      continue;
    }
    if ((response.status >= 200 && response.status < 300) || allowStatus.includes(response.status)) return response;
    const after = retryAfterMs(response.headers?.get?.('retry-after')) ?? null;
    if (!transient(response.status) || attempt === attempts) {
      let body = null;
      try { body = redactUrls((await readPrefix(response, ERROR_BODY_BYTES)).slice(0, ERROR_BODY_QUOTE)); } catch { /* body gone; status still worth throwing */ }
      throw new HttpError(`${label} -> HTTP ${response.status}`, { url, status: response.status, attempts: attempt, body, retryAfterMs: after });
    }
    await sleep(after ?? backoffMs * 2 ** (attempt - 1));
  }
  /* c8 ignore next */
  throw last ?? new HttpError(`${label} exhausted ${attempts} attempts`, { url, attempts });
}

/** At most `maxBytes` of a body, for diagnostics; never throws on size. */
export async function readPrefix(response, maxBytes = ERROR_BODY_BYTES, { stallMs = DEFAULT_STALL_MS } = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) return String(await response.text()).slice(0, maxBytes);
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { value, done } = await withStall(reader.read(), stallMs, 'error body');
      if (done) break;
      if (!value?.length) continue;
      size += value.length;
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch { /* whatever arrived is still worth quoting */ }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/** A body under `maxBytes` (declared length refused up front, cap re-checked while reading) and a stall bound. */
export async function readCapped(response, maxBytes = DEFAULT_MAX_BYTES, url = '', { stallMs = DEFAULT_STALL_MS } = {}) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(`${safeUrl(url)} declared ${declared} bytes, over the ${maxBytes} cap`, { url, status: response.status ?? null });
  }
  const reader = response.body?.getReader?.();
  if (!reader) return await response.text();
  const chunks = [];
  let size = 0;
  for (;;) {
    let step;
    try { step = await withStall(reader.read(), stallMs, safeUrl(url) || 'body'); } catch (error) {
      await reader.cancel().catch(() => {});
      if (error.name !== 'StallError') throw error;
      throw new HttpError(`${safeUrl(url)} stopped delivering bytes after ${size} of them: ${redactUrls(error.message)}`,
        { url, status: response.status ?? null, code: 'network-timeout' });
    }
    if (step.done) break;
    const chunk = step.value;
    if (!chunk?.length) continue;
    size += chunk.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(`${safeUrl(url)} exceeded the ${maxBytes} byte cap`, { url, status: response.status ?? null });
    }
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A guarded request parsed as JSON under the size cap: {status, json}. */
export async function fetchJson(url, { maxBytes = DEFAULT_MAX_BYTES, stallMs = DEFAULT_STALL_MS, ...options } = {}) {
  const response = await guardedFetch(url, options);
  const text = await readCapped(response, maxBytes, url, { stallMs });
  try { return { status: response.status, json: JSON.parse(text) }; } catch {
    throw new HttpError(`${safeUrl(url)} answered HTTP ${response.status} with ${JSON.stringify(redactUrls(text.slice(0, 60)))}, which is not JSON`,
      { url, status: response.status, body: redactUrls(text.slice(0, ERROR_BODY_QUOTE)) });
  }
}
