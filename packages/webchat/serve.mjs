

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installProcessGuards } from './src/lib/server/process-guards.js';
import { MAX_BYTES } from './src/lib/server/uploads.js';
import { startThreadpoolWatch } from './src/lib/server/threadpool-watch.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(here, process.env.WEBCHAT_BUILD_OUT || 'build');

const explicitOut = process.env.WEBCHAT_BUILD_OUT
  ? path.resolve(here, process.env.WEBCHAT_BUILD_OUT)
  : null;

const POINTER = process.env.WEBCHAT_BUILD_POINTER || 'build-current';

function currentOut(fallback = root) {
  if (explicitOut) {
    if (fs.existsSync(path.join(explicitOut, 'handler.js'))) return explicitOut;
    console.warn(`[serve] WEBCHAT_BUILD_OUT names ${explicitOut}, which has no handler.js`);
  }
  try {
    const named = fs.readFileSync(path.join(here, POINTER), 'utf8').trim();
    if (named) {
      const resolved = path.resolve(here, named);
      if (fs.existsSync(path.join(resolved, 'handler.js'))) return resolved;
      console.warn(`[serve] ${POINTER} names ${named}, which has no handler.js; ignoring it`);
    }
  } catch {  }
  return fallback;
}

async function loadHandler(dir) {
  const loaded = await import(pathToFileURL(path.join(dir, 'handler.js')).href);
  if (typeof loaded.handler !== 'function') throw new Error(`${dir}/handler.js exported no handler`);
  return loaded.handler;
}

let out = currentOut();
let clientDir = path.join(out, 'client');

process.env.WEBCHAT_BUILD_ID = path.basename(out);

// A build carries the rev 5 runtime it was tested with under `runtime/`; the
// direct provider spawns from there rather than from the mutable checkout.
function nameRuntime(dir) {
  const runtime = path.join(dir, 'runtime');
  if (fs.existsSync(path.join(runtime, 'rev5', 'pull.mjs'))) process.env.TOPHAT_RUNNER_RUNTIME_DIR = runtime;
}
nameRuntime(out);

// The one positive sign that this process exists to serve. src/lib/server/app.js reads it (and
// checks it against this pid) before it reaps, resumes or revives anything, because the module
// graph it boots is also imported by `vite build` -- and, since SvelteKit 2.70, by a worker
// thread of that build, where argv says nothing. Set before the handler is loaded, because
// loading the handler is what boots the app.
process.env.WEBCHAT_SERVER_BOOT = String(process.pid);
// Direct-runner children are spawned under this relay so they outlive a restart (src/lib/server/app.js
// relayConfig). It is a published server file beside this one, so it is always the deployed copy.
const relayScript = path.join(here, 'scripts', 'relay.mjs');
if (!process.env.WEBCHAT_RELAY_SCRIPT && fs.existsSync(relayScript)) process.env.WEBCHAT_RELAY_SCRIPT = relayScript;

if (!('BODY_SIZE_LIMIT' in process.env)) {
  process.env.BODY_SIZE_LIMIT = String(MAX_BYTES + 1024 * 1024);
}

let handler = await loadHandler(out);

console.log(`[serve] serving ${path.relative(here, out) || out}${explicitOut ? ' (WEBCHAT_BUILD_OUT)' : ` (${POINTER})`}`);

let reloading = false;
process.on('SIGHUP', async () => {
  if (reloading) return;
  reloading = true;
  
  
  const next = currentOut(out);
  if (next === out) {
    console.warn(`[serve] reload asked for, but ${POINTER} names nothing new that loads; still serving ${path.basename(out)}`);
    reloading = false;
    return;
  }
  try {
    const nextHandler = await loadHandler(next);
    handler = nextHandler;
    out = next;
    clientDir = path.join(next, 'client');
    process.env.WEBCHAT_BUILD_ID = path.basename(next);
    nameRuntime(next);
    console.log(`[serve] reloaded ${path.basename(next)} without restarting; children untouched`);
  } catch (error) {
    console.error(`[serve] reload of ${next} failed, still serving ${path.basename(out)}:`, error?.message || error);
  } finally {
    reloading = false;
  }
});


function env(name, fallback) {
  return name in process.env ? process.env[name] : fallback;
}

// Loopback unless HOST says otherwise: every launcher (runtime/launch.mjs, deploy.sh, tophat start) sets HOST, and a bare
// `node serve.mjs` must not put the app and its agent on every interface.
const host = env('HOST', '127.0.0.1');
const port = env('PORT', '3000');
const shutdownTimeout = parseInt(env('SHUTDOWN_TIMEOUT', '30'), 10);

const IMMUTABLE_PREFIX = '/_app/immutable/';

const POOL_DIR = path.resolve(here, process.env.WEBCHAT_ASSET_POOL || 'assets-pool');

const MIME = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8'
};

function olderClientDirs() {
  let names;
  try { names = fs.readdirSync(here); } catch { return []; }
  return names
    .filter((n) => n === 'build' || n.startsWith('build.'))
    .map((n) => path.join(here, n, 'client'))
    .filter((dir) => dir !== clientDir && fs.existsSync(dir))
    .map((dir) => {
      let mtime = 0;
      try { mtime = fs.statSync(dir).mtimeMs; } catch {  }
      return { dir, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.dir);
}

function assetFallbackRoots() {
  const roots = olderClientDirs().map((dir) => ({ root: dir, label: path.basename(path.dirname(dir)) }));
  if (fs.existsSync(POOL_DIR)) roots.push({ root: POOL_DIR, label: path.basename(POOL_DIR) });
  return roots;
}


function serveHashedAssetFallback(pathname, req, res) {
  
  
  
  if (!pathname.startsWith(IMMUTABLE_PREFIX)) return false;

  const accept = String(req.headers['accept-encoding'] || '');
  const wantsBr = /(br|brotli)/i.test(accept);
  const wantsGz = accept.includes('gzip');

  for (const { root, label } of assetFallbackRoots()) {
    const base = path.join(root, pathname);
    
    
    const inside = path.relative(root, base);
    if (inside.startsWith('..') || path.isAbsolute(inside)) continue;

    let file = null;
    let encoding = null;
    if (wantsBr && fs.existsSync(`${base}.br`)) { file = `${base}.br`; encoding = 'br'; }
    else if (wantsGz && fs.existsSync(`${base}.gz`)) { file = `${base}.gz`; encoding = 'gzip'; }
    else if (fs.existsSync(base)) file = base;
    if (!file) continue;

    const headers = {
      'content-type': MIME[path.extname(base).toLowerCase()] || 'application/octet-stream',
      
      
      'cache-control': 'public, max-age=31536000, immutable',
      
      
      
      
      
      
      
      'x-served-from': label
    };
    if (encoding) headers['content-encoding'] = encoding;
    try {
      const stream = fs.createReadStream(file);
      
      
      
      stream.on('error', () => { try { res.destroy(); } catch {  } });
      res.writeHead(200, headers);
      stream.pipe(res);
      console.warn(`[serve] served ${pathname} from ${label}; a tab predates the last deploy`);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function guardMissingAsset(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return false;
  }
  
  
  if (pathname.includes('%')) {
    try { pathname = decodeURI(pathname); } catch {  }
  }
  if (!pathname.startsWith(IMMUTABLE_PREFIX)) return false;

  const base = path.join(clientDir, pathname);
  
  
  const inside = path.relative(clientDir, base);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found\n');
    return true;
  }

  const accept = String(req.headers['accept-encoding'] || '');
  const wantsBr = /(br|brotli)/i.test(accept);
  const wantsGz = accept.includes('gzip');

  const hasBr = wantsBr && fs.existsSync(`${base}.br`);
  const hasGz = wantsGz && fs.existsSync(`${base}.gz`);
  const hasBase = fs.existsSync(base);

  if (!hasBr && !hasGz && !hasBase) {
    
    
    if (serveHashedAssetFallback(pathname, req, res)) return true;
    console.warn(`[serve] 404 for missing immutable asset ${pathname}`);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found\n');
    return true;
  }

  if ((wantsBr && !hasBr) || (wantsGz && !hasGz)) {
    const kept = [];
    if (hasBr) kept.push('br');
    if (hasGz) kept.push('gzip');
    req.headers['accept-encoding'] = kept.join(', ');
  }

  return false;
}

function isMissingBuildAssetRead(err) {
  if (!err || err.code !== 'ENOENT' || err.syscall !== 'open') return false;
  if (typeof err.path !== 'string') return false;
  const rel = path.relative(clientDir, path.resolve(err.path));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

installProcessGuards({
  expected: [{
    name: 'missing-build-asset',
    
    
    match: isMissingBuildAssetRead,
    why: (err) => `survived a read of a deleted build asset: ${err.path}`,
  }],
});

// The one script that must never be cached anywhere. SvelteKit serves service-worker.js with no
// cache-control of its own, and Cloudflare then applies its default four-hour browser TTL to
// a.js response, so the edge and the browser both keep an old worker alive; an old worker
// answers every navigation out of its own cache, and a deploy is invisible however often he
// reloads.
const NO_CACHE = 'no-cache, no-store, must-revalidate';
const NEVER_CACHE = new Set(['/service-worker.js']);

function refuseCaching(req, res) {
  const pathname = String(req.url || '').split('?')[0];
  if (!NEVER_CACHE.has(pathname)) return;
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (status, ...rest) => {
    const last = rest[rest.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last)) last['cache-control'] = NO_CACHE;
    else res.setHeader('cache-control', NO_CACHE);
    return writeHead(status, ...rest);
  };
}

// The onboarding channel (src/routes/api/onboard) is posted to by plain curl from a device with no
// browser and no Origin header. SvelteKit refuses any form-typed POST/PUT/PATCH/DELETE (text/plain,
// urlencoded, multipart) without a same Origin before hooks or the route run, which is right for his session
// surfaces and wrong here, where the token in the path is the whole credential and the handler reads
// the body as text. So for that one path the content type is relabelled before kit sees it.
const FORM_TYPE = /^\s*(?:text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)/iu;
function relabelOnboardBody(req) {
  if (!String(req.url || '').startsWith('/api/onboard/')) return;
  if (FORM_TYPE.test(String(req.headers['content-type'] || ''))) req.headers['content-type'] = 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  if (guardMissingAsset(req, res)) return;
  refuseCaching(req, res);
  relabelOnboardBody(req);
  
  
  handler(req, res, () => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found\n');
  });
});


const keepAlive = env('KEEP_ALIVE_TIMEOUT');
if (keepAlive) server.keepAliveTimeout = parseInt(keepAlive, 10) * 1000;
const headersTimeout = env('HEADERS_TIMEOUT');
if (headersTimeout) server.headersTimeout = parseInt(headersTimeout, 10) * 1000;

// Whether this process is the one serving its port right now. Background timers that act on the
// owner's chats (the goal_wait sweeper in src/lib/server/retry-wakes.js) read it and stay quiet when
// it is false: a process that has closed its listener, or never got one, is not the server, and a
// wake it posted would run against a build directory that may already be pruned.
const LISTENING = Symbol.for('tophat.webchat.listening');
globalThis[LISTENING] = false;
server.on('close', () => { globalThis[LISTENING] = false; });
server.listen({ host, port: Number(port) }, () => {
  globalThis[LISTENING] = true;
  console.log(`Listening on http://${host}:${port}`);
});

// A SIGTERM must end the process. the loop never emptied (sqlite handles, timers, watchers), so a
// restarted server lived on with no port, ignoring the second SIGTERM because the shutdown latch was
// already set, and ran its timers against a pruned build for two days. Now: close the listener, give
// open requests shutdownTimeout seconds, exit shortly after the close completes (or reports it was
// already closed), hard-exit at shutdownTimeout + 5 whatever is open, and a second signal exits at
// once.
const EXIT_GRACE_MS = Number(process.env.WEBCHAT_EXIT_GRACE_MS || 3000);
let shutdownTimer;
function exitSoon(ms) { setTimeout(() => process.exit(0), ms).unref(); }
function gracefulShutdown(reason) {
  if (shutdownTimer) { process.exit(0); }
  globalThis[LISTENING] = false;
  server.closeIdleConnections();
  server.close((error) => {
    if (!error) clearTimeout(shutdownTimer);
    if (!error) process.emit('sveltekit:shutdown', reason);
    // `error` means the server was already closed; either way nothing is left to wait for.
    exitSoon(EXIT_GRACE_MS);
  });
  shutdownTimer = setTimeout(() => server.closeAllConnections(), shutdownTimeout * 1000);
  exitSoon((shutdownTimeout + 5) * 1000);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// A server started for a test, a benchmark or a private clone names its owner in WEBCHAT_PARENT_PID
// and leaves when that process is gone. reparented to launchd, each held about 1.1 GB until swap
// filled and macOS paused the GUI apps. The variable is consumed here, not inherited, so a relay or
// an agent shell this server spawns does not tie its own children to this owner.
const ownerPid = Number(process.env.WEBCHAT_PARENT_PID || 0);
delete process.env.WEBCHAT_PARENT_PID;
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
if (Number.isInteger(ownerPid) && ownerPid > 1) {
  const ownerWatch = setInterval(() => {
    if (ownerAlive(ownerPid)) return;
    clearInterval(ownerWatch);
    console.warn(`[serve] owner ${ownerPid} is gone; shutting down`);
    gracefulShutdown('owner-gone');
    // A clean close is not guaranteed to empty the event loop (timers, sqlite, watchers), and a
    // server whose owner is gone has no one left to kill it.
    setTimeout(() => process.exit(0), (shutdownTimeout + 5) * 1000).unref();
  }, Number(process.env.WEBCHAT_PARENT_POLL_MS || 2000));
  ownerWatch.unref();
}

// A wedged libuv threadpool is detected here and ends the process so launchd starts a clean one. Only
// the serving process watches: a test or clone server with an owner exits with its owner anyway.
if (!process.env.WEBCHAT_NO_THREADPOOL_WATCH) startThreadpoolWatch();
