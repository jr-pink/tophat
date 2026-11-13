// Uploads for a chat that runs on a peer host.
//
// The composer uploads a file to THIS host's upload directory (uploads.js) and writes its absolute path into the message. A chat
// hosted on a peer is answered by that peer's agent, which cannot read this host's disk: the path was dead there. remote-runtime.js
// now carries every upload a message names to the host before the message, and writes the host's own path into the text the host sees;
// this file is both ends of that transfer.
//
//   sender   findUploadPaths / rewritePaths / pushFile: which paths a text names, the text with host paths, one file moved in
//            chunks over the host's machine surface (/api/agent op `upload`), resumable, verified by size and sha256.
//   host     receiveUpload: the op's handler, the same reserve / chunk / rename machinery the browser path uses (uploads.js), so a
//            file either is whole at its path or is not there.

import { open, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { chunkStatus, reserveUpload, sha256File, writeChunk } from './uploads.js';

export const PUSH_CHUNK_BYTES = 4 * 1024 * 1024; // base64 in JSON: about 5.5 MB a request, far under the 64 MB body limit
export const UPLOAD_TIMEOUT_MS = 120_000;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const exists = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * The upload paths a text names, in order: [{ path, start, end, state }]. A name may hold spaces and the text may continue after
 * it, so each match is cut back at spaces and trailing punctuation to the longest form that exists on disk. state: `ready` (the
 * whole file is there), `partial` (still arriving), `failed` (the client gave up), `absent` (nothing yet: not started, or never).
 */
export function findUploadPaths(text, root) {
  const out = [];
  const re = new RegExp(`${escapeRegex(String(root).replace(/\/+$/u, ''))}/\\d{4}-\\d{2}-\\d{2}/[0-9a-f]{8}-[\\w.\\- ]{1,80}`, 'gu');
  for (const m of String(text ?? '').matchAll(re)) {
    const whole = m[0].replace(/\s+$/u, '');
    const ends = [whole.length];
    for (let i = whole.length - 1; i > 0; i -= 1) if (whole[i] === ' ') ends.push(i);
    const forms = [];
    for (const end of ends) {
      forms.push(whole.slice(0, end));
      const bare = whole.slice(0, end).replace(/[.,;:)\]]+$/u, '');
      if (bare.length < end) forms.push(bare);
    }
    let pick = null;
    for (const form of forms) {
      if (exists(form)) pick = { path: form, state: 'ready' };
      else if (exists(`${form}.partial`)) pick = { path: form, state: 'partial' };
      else if (exists(`${form}.failed`)) pick = { path: form, state: 'failed' };
      if (pick) break;
    }
    if (!pick) pick = { path: forms.find((f) => f.length > 0) || whole, state: 'absent' };
    out.push({ ...pick, start: m.index, end: m.index + pick.path.length });
  }
  return out;
}

/** `text` with each found path replaced by `map(path)` (or left alone when it returns null). */
export function rewritePaths(text, found, map) {
  let out = String(text ?? '');
  for (const f of [...found].sort((a, b) => b.start - a.start)) {
    const to = map(f.path);
    if (to != null) out = out.slice(0, f.start) + to + out.slice(f.end);
  }
  return out;
}

/** Literal replacement of every key in `pairs` ({ local: host }) wherever it stands in `text`, longest key first. */
export function replacePaths(text, pairs) {
  let out = String(text ?? '');
  for (const key of Object.keys(pairs).sort((a, b) => b.length - a.length)) out = out.split(key).join(pairs[key]);
  return out;
}

/**
 * Moves one local file onto the host and returns its host path. `call(body, { timeoutMs })` is one /api/agent call answered with
 * JSON (a RemoteError on refusal or outage). `cache` is { [localPath]: { remote, size, sha256 } }, persisted by the caller through
 * `persist()`: a file already whole on the host is checked and reused, a half-sent one resumes where the host says it is.
 * Throws an Error with `.verify` when the bytes that arrived are not the bytes that left.
 */
export async function pushFile({ call, local, cache, persist = () => {}, chunkBytes = PUSH_CHUNK_BYTES, name = null }) {
  const size = (await stat(local)).size;
  const sha256 = await sha256File(local);
  const label = name || local.split('/').pop();
  let entry = cache[local];
  if (entry && (entry.size !== size || entry.sha256 !== sha256)) entry = null; // the file changed since it was last sent
  let remote = entry?.remote || null;
  let received = 0;
  const resync = async () => {
    if (!remote) { received = 0; return false; }
    const st = await call({ op: 'upload', status: true, path: remote }, { timeoutMs: 30_000 });
    if (st.complete) {
      if (st.size === size && st.sha256 === sha256) return true;
      remote = null; received = 0; delete cache[local]; // a different file sits there: start a new one
      return false;
    }
    received = Number(st.received) || 0;
    return false;
  };
  if (await resync()) { cache[local] = { remote, size, sha256 }; persist(); return remote; }

  const handle = await open(local, 'r');
  try {
    let answer = null, regress = 0;
    for (;;) {
      const length = Math.min(chunkBytes, size - received);
      const buffer = Buffer.alloc(length);
      if (length) await handle.read(buffer, 0, length, received);
      try {
        answer = await call({ op: 'upload', name: label, path: remote || undefined, offset: received, total: size, data: buffer.toString('base64') }, { timeoutMs: UPLOAD_TIMEOUT_MS });
      } catch (cause) {
        // Out of step with the host (a retry overlapped, the host held a different count): ask where it is, a few times.
        if (cause.status === 409 && regress < 3) {
          regress += 1;
          if (await resync()) { cache[local] = { remote, size, sha256 }; persist(); return remote; }
          continue;
        }
        throw cause;
      }
      if (!remote) remote = answer.path;
      cache[local] = { remote, size, sha256 }; persist();
      received = Number(answer.received) || 0;
      if (answer.complete && received >= size) break;
    }
    if (answer.size !== size || answer.sha256 !== sha256) {
      delete cache[local]; persist();
      throw Object.assign(new Error(`${label} did not arrive intact (${answer.size ?? '?'} of ${size} bytes, checksum ${answer.sha256 === sha256 ? 'matches' : 'differs'})`), { verify: true });
    }
    return remote;
  } finally { await handle.close().catch(() => {}); }
}

/**
 * The host's end, behind /api/agent op `upload`: { name, path?, offset, total, data (base64) } writes one chunk (the first chunk
 * with no path reserves one in this host's upload directory); { status: true, path } says what is held. A whole file answers
 * with its size and sha256.
 */
export async function receiveUpload(body) {
  if (body.status) {
    const st = await chunkStatus({ path: body.path });
    return st.complete ? { ...st, sha256: await sha256File(st.path) } : st;
  }
  const total = Number(body.total);
  const offset = Number(body.offset);
  const path = body.path || (await reserveUpload({ name: String(body.name || 'file') })).path;
  const bytes = Buffer.from(String(body.data || ''), 'base64');
  return writeChunk({ path, offset, total, name: body.name || null, body: bytes.length ? [bytes] : [] });
}
