

import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { webchatStorePath } from './paths.js';

export const UPLOAD_ROOT = process.env.WEBCHAT_UPLOADS || webchatStorePath('uploads');

// The single-request limit: what /api/upload takes in one body, buffered. The composer no longer
// sends anything through it (it chunks every file, see CHUNK_BYTES below), so this only governs
// older clients and scripts. serve.mjs sets BODY_SIZE_LIMIT from it, which also caps one chunk.
export const MAX_BYTES = 64 * 1024 * 1024;

// Chunked uploads: Cloudflare in front of the tunnel refuses any request body over 100 MB on this
// plan, so one big POST can never work whatever the server allows. The client sends CHUNK_BYTES
// slices, each well under both that and BODY_SIZE_LIMIT; the server streams each one to
// `<path>.partial` and renames it onto the reserved path when the last byte lands, so the reserved
// path still either does not exist or holds the whole file.
export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
export const PARTIAL_SUFFIX = '.partial';
export const FAILED_SUFFIX = '.failed';
const STALE_PARTIAL_MS = 7 * 24 * 3600 * 1000;

export class UploadError extends Error {
  constructor(message, { status, kind, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UploadError';
    this.status = status;
    this.kind = kind;
  }
}

export function transportRejection(error) {
  for (let node = error, depth = 0; node && depth < 5; node = node.cause, depth += 1) {
    if (node.status === 413) return String(node.message || 'the request body was too large');
    if (/BODY_SIZE_LIMIT|exceeds limit of|Payload Too Large/iu.test(String(node.message || ''))) {
      return String(node.message);
    }
  }
  return null;
}

export function safeName(name) {
  const cleaned = String(name || 'file')
    .replace(/[/\\]/gu, '-')
    .replace(/[^\w.\- ]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'file';
}

export async function reserveUpload({ name, at = new Date() }) {
  sweepStalePartials().catch(() => {});
  const day = at.toISOString().slice(0, 10);
  const dir = join(UPLOAD_ROOT, day);
  await mkdir(dir, { recursive: true });
  return { path: join(dir, `${randomBytes(4).toString('hex')}-${safeName(name)}`), name: safeName(name) };
}

export function withinUploadRoot(path) {
  const target = resolve(String(path || ''));
  const root = resolve(UPLOAD_ROOT);
  return target === root || target.startsWith(root + sep);
}

export async function saveUpload({ name, bytes, at = new Date(), path = null }) {
  if (bytes.length > MAX_BYTES) {
    throw new UploadError(
      `${safeName(name)} is ${Math.round(bytes.length / 1048576)} MB, over the ${MAX_BYTES / 1048576} MB limit`,
      { status: 413, kind: 'too-large' }
    );
  }
  let target = path;
  if (target && !withinUploadRoot(target)) {
    throw new UploadError('That upload path is outside the upload directory', { status: 400, kind: 'rejected-path' });
  }
  if (!target) {
    const day = at.toISOString().slice(0, 10);
    target = join(UPLOAD_ROOT, day, `${randomBytes(4).toString('hex')}-${safeName(name)}`);
  }
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const temp = `${target}.part-${randomBytes(4).toString('hex')}`;
  
  
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temp, bytes);
    await rename(temp, target);
  } catch (cause) {
    
    
    
    
    await rm(temp, { force: true }).catch(() => {  });
    throw new UploadError(
      `Could not write ${safeName(name)} to ${dirname(target)}: ${cause.code || cause.message}`,
      { status: 500, kind: 'filesystem', cause }
    );
  }
  return { path: target, name: safeName(name), size: bytes.length };
}


const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

// A reserved path the client may write chunks to: inside the root, and not itself one of our
// side files, so a chunk can never land on another upload's partial or failure marker.
function chunkTarget(path) {
  const target = resolve(String(path || ''));
  if (!path || !withinUploadRoot(target) || target === resolve(UPLOAD_ROOT)) {
    throw new UploadError('That upload path is outside the upload directory', { status: 400, kind: 'rejected-path' });
  }
  if (target.endsWith(PARTIAL_SUFFIX) || target.endsWith(FAILED_SUFFIX) || /\.part-[0-9a-f]+$/u.test(target)) {
    throw new UploadError('That upload path names a temporary file', { status: 400, kind: 'rejected-path' });
  }
  return target;
}

function checkTotal(total, name) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new UploadError('The upload did not say how large the file is', { status: 400, kind: 'bad-request' });
  }
  if (total > MAX_FILE_BYTES) {
    throw new UploadError(`${name} is ${mb(total)}, over the ${mb(MAX_FILE_BYTES)} limit for one file`, { status: 413, kind: 'too-large' });
  }
}

async function sizeOf(path) {
  try { return (await stat(path)).size; } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest('hex');
}

// One writer per path at a time. Chunk PUTs for one file arrive in order from one client, but a
// retry can overlap the request it replaces (the client gave up waiting, the server had not), and
// two writers interleaving on one partial is the corruption this serializes away.
const locks = new Map();
function withLock(key, work) {
  const before = locks.get(key) || Promise.resolve();
  const run = before.catch(() => {}).then(work);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

// The newest PUT for a path wins. The lock above made a replacement chunk wait for the request it
// replaces, and a request whose page is gone (a reload, a tab iOS suspended) is only torn down
// when Cloudflare gives up on it, about 100 s later. A newer PUT now aborts the writer in front of
// it, which stops at the next read with everything it wrote kept, and answers 409 `superseded`.
const writers = new Map();

function superseded(received) {
  const error = new UploadError('A newer upload of this file took over', { status: 409, kind: 'superseded' });
  error.received = received;
  return error;
}

// The request body, read until it ends or `signal` aborts. An abort ends the iteration at once,
// even while a read is waiting on a stalled socket, and destroys the stream so it is not read again.
async function* readUntil(body, signal) {
  const source = body || [];
  const iterator = source[Symbol.asyncIterator] ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  const STOP = Symbol('stop');
  let release = null;
  const stop = new Promise((resolve) => {
    release = () => resolve(STOP);
    signal.addEventListener('abort', release, { once: true });
  });
  try {
    for (;;) {
      if (signal.aborted) return;
      const next = await Promise.race([iterator.next(), stop]);
      if (next === STOP || next.done) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', release);
    if (signal.aborted) {
      try { source.destroy?.(); } catch { /* already gone */ }
      Promise.resolve().then(() => iterator.return?.()).catch(() => {});
    }
  }
}

// How much of a chunked upload the server holds: what a resuming client asks before sending, so an
// interrupted upload continues from the last byte that reached the disk instead of from zero.
export async function chunkStatus({ path }) {
  const target = chunkTarget(path);
  const whole = await sizeOf(target);
  if (whole !== null) return { path: target, received: whole, complete: true, size: whole };
  const failed = await sizeOf(target + FAILED_SUFFIX);
  const partial = await sizeOf(target + PARTIAL_SUFFIX);
  return { path: target, received: partial || 0, complete: false, failed: failed !== null };
}

// Write one chunk at `offset` and, when the file is then `total` bytes long, move it onto the
// reserved path. Idempotent: a chunk sent twice writes the same bytes to the same place, and a
// final chunk replayed after the rename finds the whole file already there and reports it again.
// A chunk that would leave a gap is refused with the offset the server actually holds (409), which
// is how a client that lost track resynchronises. `body` is any async iterable of byte arrays (the
// request stream); nothing is buffered beyond one network read.
export async function writeChunk({ path, offset, total, body, name = null }) {
  const target = chunkTarget(path);
  const label = safeName(name || basename(target));
  checkTotal(total, label);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) {
    throw new UploadError(`Chunk offset ${offset} is outside a ${total}-byte file`, { status: 400, kind: 'bad-request' });
  }
  const mine = new AbortController();
  const before = writers.get(target);
  if (before) {
    console.warn(`[webchat] chunk PUT at ${offset} for ${label} supersedes one at ${before.offset} that has run ${Math.round((Date.now() - before.at) / 1000)}s`);
    before.controller.abort();
  }
  const entry = { controller: mine, offset, at: Date.now() };
  writers.set(target, entry);
  try {
    return await withLock(target, () => writeLocked({ target, label, offset, total, body, signal: mine.signal }));
  } finally {
    if (writers.get(target) === entry) writers.delete(target);
  }
}

async function writeLocked({ target, label, offset, total, body, signal }) {
  {
    const whole = await sizeOf(target);
    if (whole !== null) {
      if (whole === total) {
        for await (const _ of body || []) { /* drain a replayed chunk */ }
        return { path: target, name: label, received: whole, complete: true, size: whole, sha256: await sha256File(target) };
      }
      const error = new UploadError(`${label} already exists at that path with a different size`, { status: 409, kind: 'conflict' });
      error.received = whole;
      throw error;
    }
    const partial = target + PARTIAL_SUFFIX;
    const held = (await sizeOf(partial)) || 0;
    // Superseded while it waited for the lock: it never wrote, and the newer one will.
    if (signal.aborted) throw superseded(held);
    if (offset > held) {
      const error = new UploadError(`Chunk at ${offset} would leave a gap; the server holds ${held} bytes`, { status: 409, kind: 'gap' });
      error.received = held;
      throw error;
    }
    await rm(target + FAILED_SUFFIX, { force: true }).catch(() => {});
    let handle;
    let position = offset;
    try {
      await mkdir(dirname(target), { recursive: true });
      // offset <= held, so a partial with bytes in it is opened in place and anything else starts empty.
      handle = await open(partial, held ? 'r+' : 'w');
      for await (const block of readUntil(body, signal)) {
        const bytes = block instanceof Uint8Array ? block : Buffer.from(block);
        if (position + bytes.length > total) {
          throw new UploadError(`The chunk runs past the declared ${total}-byte size`, { status: 400, kind: 'bad-request' });
        }
        if (position - offset + bytes.length > MAX_CHUNK_BYTES) {
          throw new UploadError(`One chunk may carry at most ${mb(MAX_CHUNK_BYTES)}`, { status: 413, kind: 'too-large' });
        }
        let written = 0;
        while (written < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, position);
          written += bytesWritten;
          position += bytesWritten;
        }
      }
      const received = Math.max(held, position);
      if (received < total) {
        await handle.close();
        handle = null;
        if (signal.aborted) throw superseded(received);
        return { path: target, name: label, received, complete: false };
      }
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(partial, target);
    } catch (cause) {
      await handle?.close().catch(() => {});
      if (cause instanceof UploadError) throw cause;
      throw new UploadError(`Could not write ${label} to ${dirname(target)}: ${cause.code || cause.message}`, { status: 500, kind: 'filesystem', cause });
    }
    return { path: target, name: label, received: total, complete: true, size: total, sha256: await sha256File(target) };
  }
}

// The client gave up on an upload. The reserved path never appears, so a model told the file was
// still uploading would wait forever; `<path>.failed` beside it says why, the partial is dropped.
export async function markFailed({ path, reason }) {
  const target = chunkTarget(path);
  return withLock(target, async () => {
    if ((await sizeOf(target)) !== null) return { path: target, failed: false, complete: true };
    await rm(target + PARTIAL_SUFFIX, { force: true }).catch(() => {});
    const text = `${String(reason || 'the upload failed').slice(0, 2000)}\n`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target + FAILED_SUFFIX, text);
    return { path: target, failed: true, marker: target + FAILED_SUFFIX };
  });
}

// Partials nobody came back for in a week. Run on reservation, not on a timer: an upload is the
// only thing that creates them.
export async function sweepStalePartials({ now = Date.now(), maxAgeMs = STALE_PARTIAL_MS } = {}) {
  let removed = 0;
  let days = [];
  try { days = await readdir(UPLOAD_ROOT, { withFileTypes: true }); } catch { return 0; }
  for (const day of days) {
    if (!day.isDirectory()) continue;
    const dir = join(UPLOAD_ROOT, day.name);
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(PARTIAL_SUFFIX)) continue;
      const full = join(dir, name);
      if (locks.has(full.slice(0, -PARTIAL_SUFFIX.length))) continue;
      try {
        if (now - (await stat(full)).mtimeMs > maxAgeMs) { await rm(full, { force: true }); removed += 1; }
      } catch { /* raced with a rename */ }
    }
  }
  return removed;
}
