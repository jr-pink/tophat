import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The live channel of a published quicklook artifact: /view/<ULID>/__live (server-sent events) and
// POST /view/<ULID>/__view. A published tool page runs in an opaque origin (INTERACTIVE_CSP has no
// allow-same-origin), so it cannot use cookies or storage; this is how it hears the owner's agent
// and reports what it shows, through files in its own artifact directory:
//
//   <artifact>/state.json  written by `docstore-kit push`      -> event `state` (the file's text)
//   <artifact>/view.json   written here from the page's POST    <- what the page currently shows
//   any other file         republished by `docstore-kit publish --into` -> event `code`
//                          (payload: every file's content hash; the page diffs it and swaps only
//                          what changed, see tools/docstore-kit/README.md)
//
// Every writer is single (the CLI writes state.json and the files, this module writes view.json) and
// every write is temp + rename in the same directory, so a reader sees a whole old or a whole new
// file. There is no lock and nothing in memory to lose: a reconnecting page is told the present.

export const VIEW_MAX_BYTES = 256 * 1024;
// Written by the live channel itself or by the publisher; none of them is "code".
const NOT_CODE = new Set(['state.json', 'view.json', 'SOURCE.json']);
const MAX_ENTRIES = 400;

// Content hashes, computed once per (path, mtime, size) by streaming, so a 50 MB file never blocks
// the event loop and an unchanged file is never read twice. The hash is the file's version in the
// page: a page keys what it downloaded by it, so a republish of identical bytes costs nothing.
const hashes = new Map();
function hashOf(abs, st) {
  const key = `${abs}\0${Math.floor(st.mtimeMs)}\0${st.size}`;
  let hit = hashes.get(key);
  if (!hit) {
    hit = new Promise((resolve) => {
      const h = createHash('sha1');
      createReadStream(abs).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex').slice(0, 16))).on('error', () => resolve(null));
    });
    if (hashes.size > 2000) hashes.clear();
    hashes.set(key, hit);
  }
  return hit;
}

/** name -> content hash for the artifact's files (recursive, dotfiles and the channel files skipped). */
export async function manifest(dir) {
  const found = [];
  const walk = (abs, rel, depth) => {
    let names;
    try { names = readdirSync(abs); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') || found.length >= MAX_ENTRIES) continue;
      const relName = rel ? `${rel}/${name}` : name;
      let st;
      try { st = statSync(join(abs, name)); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3) walk(join(abs, name), relName, depth + 1); continue; }
      if (!st.isFile() || (!rel && NOT_CODE.has(name))) continue;
      found.push([relName, join(abs, name), st]);
    }
  };
  walk(dir, '', 0);
  const hashed = await Promise.all(found.map(([, abs, st]) => hashOf(abs, st)));
  const out = {};
  found.forEach(([name], i) => { if (hashed[i]) out[name] = hashed[i]; });
  return out;
}

// Async: the stream reads state.json every pollMs for every connected page, and a pushed state can
// be megabytes (point clouds, meshes), so a synchronous read here held the server's one thread.
export async function readText(dir, name) {
  try { return await readFile(join(dir, name), 'utf8'); } catch { return null; }
}

const sse = (event, data) => `event: ${event}\ndata: ${String(data).replace(/\r?\n/gu, ' ')}\n\n`;

/**
 * The event stream for one artifact. Polls the directory (cheap: a stat per file) while a page is
 * connected; `code` fires once the manifest has been unchanged for `settleMs`, so a republish that
 * renames several files is one reload, not one per file.
 */
export function liveStream(dir, { pollMs = 400, settleMs = 500, pingMs = 20000 } = {}) {
  const encoder = new TextEncoder();
  let timers = [];
  let closed = false;
  const stop = () => { closed = true; for (const t of timers) clearInterval(t); timers = []; };
  return new ReadableStream({
    async start(controller) {
      const send = (text) => { if (closed) return; try { controller.enqueue(encoder.encode(text)); } catch { stop(); } };
      send('retry: 2000\n\n');
      let sent = await manifest(dir);
      let sentKey = JSON.stringify(sent);
      let pending = null;
      let pendingSince = 0;
      let state = await readText(dir, 'state.json');
      send(sse('hello', JSON.stringify({ files: sent, at: Date.now() })));
      if (state !== null) send(sse('state', state));
      let busy = false;
      timers.push(setInterval(async () => {
        if (busy || closed) return;
        busy = true;
        try {
          const now = Date.now();
          const next = await readText(dir, 'state.json');
          if (next !== null && next !== state) { state = next; send(sse('state', next)); }
          const files = await manifest(dir);
          const key = JSON.stringify(files);
          if (key === sentKey) { pending = null; return; }
          if (key !== pending) { pending = key; pendingSince = now; return; }
          if (now - pendingSince >= settleMs) {
            sent = files; sentKey = key; pending = null;
            send(sse('code', JSON.stringify({ files })));
          }
        } finally { busy = false; }
      }, pollMs));
      timers.push(setInterval(() => send(': ping\n\n'), pingMs));
    },
    cancel: stop
  });
}

/** Store the page's reported view: JSON only, size-capped, temp + rename. Returns an HTTP status. */
export function storeView(dir, text) {
  if (typeof text !== 'string' || !text.length) return 400;
  if (Buffer.byteLength(text) > VIEW_MAX_BYTES) return 413;
  try { JSON.parse(text); } catch { return 400; }
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.view.json.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, join(dir, 'view.json'));
  } catch { return 500; }
  return 204;
}

// The page is in an opaque origin, so its requests are cross-origin with Origin: null; `*` is the
// answer that works for it. Nothing here reads a cookie, and the ULID in the path is the credential.
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, range, last-event-id',
  'access-control-expose-headers': 'content-length, content-range, content-type',
  'access-control-max-age': '600'
};
