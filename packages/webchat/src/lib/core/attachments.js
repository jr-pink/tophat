import { isIncognito } from './incognito.js';
import { uiApp } from '../client/ui-app.js';
import { drafts } from './drafts-state.js';


export function pendingAttachment(file) {
  return { key: `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`, name: file.name, size: file.size, state: 'queued', path: null, error: null, loaded: 0, total: file.size || 0 };
}

export function stillTransferring(attachment) {
  return attachment?.state === 'queued' || attachment?.state === 'uploading';
}

export function uploadPercent(attachment) {
  const total = Number(attachment?.total) || 0;
  if (!total) return null;
  const loaded = Math.max(0, Math.min(total, Number(attachment?.loaded) || 0));
  return Math.floor((loaded / total) * 100);
}

export async function reservePaths(names, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/upload/reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ names })
  });
  if (!response.ok) throw new Error(`could not reserve an upload path (${response.status})`);
  const body = await response.json();
  return body.files || [];
}

// Every file goes up in chunks. One whole-file POST could not carry a 149 MB PDF: Cloudflare in
// front of the tunnel refuses request bodies over 100 MB, and the server buffered the body against
// a 64 MB limit. A chunk is CHUNK_BYTES, far under both; the server appends it to `<path>.partial`
// and renames that onto the reserved path when the last byte lands.
export const CHUNK_BYTES = 8 * 1024 * 1024;
export const RETRY = Object.freeze({ attempts: 8, baseMs: 1000, maxMs: 30_000 });
// When another copy of this upload (a reloaded page, a second tab) has taken the path over, how
// often to look at the server's count, and how long it may stand still before this copy takes over.
export const WATCH = Object.freeze({ everyMs: 2000, stallMs: 20_000 });
const CHUNK_TIMEOUT_MS = 300_000;

export class UploadFailure extends Error {
  constructor(message, { status = 0, kind = 'error', transient = false } = {}) {
    super(message);
    this.name = 'UploadFailure';
    this.status = status;
    this.kind = kind;
    this.transient = transient;
  }
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB`;

// What a failed answer means. A status of 0 (the connection itself died), a 408/429, or a 5xx from
// something other than our route is the moment, so the chunk is tried again; anything else is the
// server's verdict on this file and is said once, in the server's words when it gave some.
function classify({ status, body, text }) {
  const reason = body?.error || null;
  if (status === 0) return new UploadFailure(reason || 'the connection dropped', { status, kind: 'network', transient: true });
  if (status === 409 && body?.kind === 'superseded') {
    return Object.assign(new UploadFailure(reason || 'another upload of this file took over', { status, kind: 'superseded', transient: true }), { received: Number(body.received) || 0 });
  }
  if (status === 409 && Number.isSafeInteger(body?.received)) {
    return Object.assign(new UploadFailure(reason || 'out of step with the server', { status, kind: 'gap', transient: true }), { received: body.received });
  }
  if (status === 413) {
    return new UploadFailure(reason || 'a chunk was refused as too large (413) before it reached the server', { status, kind: 'too-large' });
  }
  if (status === 401) return new UploadFailure('signed out (401); sign in again and re-attach the file', { status, kind: 'signed-out' });
  // A 500 in the route's own JSON (an errno from the disk) is a verdict; a 5xx without it is a
  // proxy or a restarting server, and so is a 502-504 whatever it carries.
  const ours = status >= 500 && status < 502 && body?.kind && body.kind !== 'error';
  if (!ours && (status >= 500 || status === 408 || status === 429)) {
    const html = /^\s*</u.test(String(text || ''));
    return new UploadFailure(reason || `the server answered ${status}${html ? ' (an error page, likely the tunnel)' : ''}`, { status, kind: 'server', transient: true });
  }
  return new UploadFailure(reason || `upload failed (${status})`, { status, kind: body?.kind || 'rejected' });
}

function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// One HTTP exchange, never throwing for a status: XHR when progress is wanted (fetch has no upload
// progress), fetch otherwise. A connection that dies resolves as status 0.
export function defaultTransport({ fetchImpl = fetch, xhrImpl = null } = {}) {
  const XHR = xhrImpl || (typeof XMLHttpRequest === 'undefined' ? null : XMLHttpRequest);
  return ({ method, url, body = null, headers = {}, onprogress = null }) => {
    if (onprogress && XHR && method === 'PUT') {
      return new Promise((resolve) => {
        const xhr = new XHR();
        xhr.open(method, url);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader?.(name, value);
        xhr.timeout = CHUNK_TIMEOUT_MS;
        if (xhr.upload) xhr.upload.onprogress = (event) => { if (event.lengthComputable) onprogress(event.loaded); };
        const done = (status, why = null) => {
          const text = xhr.responseText || '';
          const parsed = parse(text);
          resolve({ status, body: parsed || (why ? { error: why } : null), text });
        };
        xhr.onload = () => done(xhr.status);
        xhr.onerror = () => done(0, 'the connection dropped');
        xhr.ontimeout = () => done(0, 'the connection timed out');
        xhr.onabort = () => done(0, 'cancelled');
        xhr.send(body);
      });
    }
    return Promise.resolve()
      .then(() => fetchImpl(url, { method, body, headers }))
      .then(async (response) => {
        const text = typeof response.text === 'function' ? await response.text().catch(() => '')
          : JSON.stringify(await response.json?.().catch(() => null) ?? null);
        return { status: response.status ?? (response.ok ? 200 : 500), body: parse(text), text };
      }, (cause) => ({ status: 0, body: { error: `the connection dropped (${cause?.message || cause})` }, text: '' }));
  };
}

const chunkUrl = (path, extra = {}) => {
  const query = new URLSearchParams({ path, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) });
  return `/api/upload/chunk?${query}`;
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves at once when the browser thinks it is online, otherwise at the next `online` event. An
// offline phone is not a failed upload: it resumes where it stopped when the network comes back.
function untilOnline() {
  if (typeof navigator === 'undefined' || navigator.onLine !== false || typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => window.addEventListener('online', () => resolve(), { once: true }));
}

// Upload `file` to `path` (reserved first if not given), resuming from whatever the server already
// holds. Chunk PUTs are idempotent (an offset and the bytes that belong there), so a retry after a
// lost answer is harmless, and a 409 hands back the offset the server really has. Resolves with
// {path, name, size, sha256}; rejects with an UploadFailure whose message says why, in words he can
// act on. `journal` (see client/upload-journal.js) persists progress so a reload resumes.
export async function uploadFile(file, {
  path = null, fetchImpl = fetch, xhrImpl = null, transport = null, onprogress = null,
  chunkBytes = CHUNK_BYTES, retry = RETRY, watch = WATCH, sleep = defaultSleep, waitOnline = untilOnline,
  journal = null, onstatus = null
} = {}) {
  const send = transport || defaultTransport({ fetchImpl, xhrImpl });
  const name = file.name || 'pasted';
  const size = Number(file.size) || 0;
  if (!path) {
    const reserved = await reservePaths([name], { fetchImpl }).catch((cause) => {
      throw new UploadFailure(`could not reserve an upload path: ${cause.message}`, { kind: 'reserve' });
    });
    path = reserved[0]?.path;
    if (!path) throw new UploadFailure('could not reserve an upload path', { kind: 'reserve' });
  }
  const report = (loaded) => onprogress?.({ loaded: Math.min(size, loaded), total: size });
  let attempts = 0;
  const backoff = async (error) => {
    attempts += 1;
    if (attempts > retry.attempts) {
      throw new UploadFailure(`${error.message}; gave up after ${retry.attempts} retries with ${mb(received)} of ${mb(size)} sent`, { status: error.status, kind: error.kind });
    }
    onstatus?.({ retrying: attempts, reason: error.message });
    await waitOnline();
    await sleep(Math.min(retry.maxMs, retry.baseMs * 2 ** (attempts - 1)));
  };

  let received = 0;
  // Where the server is: zero for a fresh reservation, more for an upload a reload interrupted.
  for (;;) {
    const answer = await send({ method: 'GET', url: chunkUrl(path) });
    if (answer.status >= 200 && answer.status < 300 && answer.body) {
      if (answer.body.complete && answer.body.size === size) {
        await journal?.done(path);
        report(size);
        return { path, name, size, sha256: answer.body.sha256 || null };
      }
      if (answer.body.complete) {
        throw new UploadFailure(`a different ${mb(answer.body.size)} file already sits at ${path}`, { kind: 'conflict' });
      }
      received = Math.min(size, Number(answer.body.received) || 0);
      break;
    }
    const error = classify(answer);
    if (!error.transient) throw error;
    await backoff(error);
  }
  report(received);

  for (;;) {
    const end = Math.min(size, received + chunkBytes);
    const offset = received;
    const answer = await send({
      method: 'PUT',
      url: chunkUrl(path, { offset, total: size, name }),
      body: file.slice(offset, end),
      headers: { 'content-type': 'application/octet-stream' },
      onprogress: onprogress ? (loaded) => report(offset + loaded) : null
    });
    if (answer.status >= 200 && answer.status < 300 && answer.body && Number.isSafeInteger(answer.body.received)) {
      received = answer.body.received;
      attempts = 0;
      report(received);
      if (answer.body.complete) {
        await journal?.done(path);
        return { path: answer.body.path || path, name, size: answer.body.size ?? size, sha256: answer.body.sha256 || null };
      }
      await journal?.progress(path, received);
      continue;
    }
    const error = answer.status >= 200 && answer.status < 300
      ? new UploadFailure('the server answered without saying how much it holds', { status: answer.status, kind: 'server', transient: true })
      : classify(answer);
    if (!error.transient) throw error;
    if (error.kind === 'gap') { received = error.received; await backoff(error); continue; }
    if (error.kind === 'superseded') {
      // A newer PUT for this path (this file resumed by a reloaded page or another tab) took over.
      // Fighting it would make each copy abort the other, so watch the server's count instead:
      // done when the file lands, and this copy resumes only if the other one stops moving.
      let last = Number(error.received) || 0;
      let still = 0;
      for (;;) {
        await sleep(watch.everyMs);
        const look = await send({ method: 'GET', url: chunkUrl(path) });
        if (look.status >= 200 && look.status < 300 && look.body) {
          if (look.body.complete && look.body.size === size) {
            await journal?.done(path);
            report(size);
            return { path, name, size, sha256: look.body.sha256 || null };
          }
          const now = Math.min(size, Number(look.body.received) || 0);
          if (now > last) { last = now; still = 0; report(now); continue; }
        }
        still += watch.everyMs;
        if (still >= watch.stallMs) break;
      }
      received = last;
      attempts = 0;
      continue;
    }
    await backoff(error);
    // Ask rather than assume: the lost answer may have been to a chunk that landed.
    const status = await send({ method: 'GET', url: chunkUrl(path) });
    if (status.status >= 200 && status.status < 300 && status.body) {
      if (status.body.complete && status.body.size === size) {
        await journal?.done(path);
        report(size);
        return { path, name, size, sha256: status.body.sha256 || null };
      }
      received = Math.min(size, Number(status.body.received) || 0);
    }
  }
}

// The client gave up: leave `<path>.failed` on the server saying why, so a model told the file was
// still uploading learns it is not coming, and steer the chat's running turn if there is one.
export async function reportUploadFailure({ path, name, reason, conversationId = null }, { fetchImpl = fetch } = {}) {
  if (!path) return null;
  try {
    const response = await fetchImpl(chunkUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason, name, conversation_id: conversationId })
    });
    return response.ok ? await response.json().catch(() => null) : null;
  } catch { return null; }
}

export function describeAttachments(attachments) {
  const named = (attachments || []).filter((a) => a.path && a.state !== 'failed');
  if (!named.length) return '';
  return `\n\nAttached ${named.length === 1 ? 'file' : 'files'}:\n${named.map((a) => `- ${a.path}`).join('\n')}`;
}

export function withAttachments(text, attachments) {
  return `${text}${describeAttachments(attachments)}`;
}

export function filesFromPaste(event) {
  return [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

// Drafts live in the kit's declared `draft` family (core/drafts-state.js): one record per chat, hydrated synchronously.
// An incognito chat's draft lives in this tab's memory only (core/incognito.js): never storage.
const incognitoDrafts = new Map();

export function readDraft(key) {
  if (!key) return '';
  if (isIncognito(key)) return incognitoDrafts.get(key) || '';
  try { return drafts.use(uiApp(), key).get().text; } catch { return ''; }
}

export function writeDraft(key, text) {
  if (!key) return;
  if (isIncognito(key)) { if (text) incognitoDrafts.set(key, text); else incognitoDrafts.delete(key); return; }
  try { drafts.use(uiApp(), key).dispatch('text.set', { text: text || '' }); } catch { /* storage refused: the kit reports it */ }
}

export function draftKeys() {
  try {
    const app = uiApp();
    app.flush();
    return drafts.keys(globalThis.localStorage).filter((key) => readDraft(key));
  } catch { return []; }
}
