// Warm readers of the memory store: long-lived `python3 -m rev5.cli serve` processes (rev5/cli.py serve), the store
// open read-only with mmap, answering `search` and `read` one JSON line at a time. Why: the memory leg of the unified
// search spawned a python process per query, which imported the store, opened it writable (schema checks) and started
// on a cold page cache; with the coverage count scanning all of raw_data the leg ran 2.8 to 4.7 s on live turns. A
// worker per store and interpreter, at most POOL_MAX busy at once; a request beyond that, a dead worker or
// TOPHAT_RUNNER_MEMORY_WORKER=0 falls back to the one-shot CLI. A request that times out kills its worker (a hung
// query must not hold the next one), and the next request starts a fresh one.
import { spawn } from 'node:child_process';

const POOL_MAX = 2;
const pools = new Map(); // key -> [worker]
// A reader that announced it could not start (the entity reader without its venv or spaCy model) is not restarted on
// every message: ten minutes before the next try, and calls in between answer the failure.
const failedAt = new Map(), RETRY_FAILED_MS = 10 * 60_000;
export const readerFailure = (store) => { const f = failedAt.get(keyOf(store)); return f && Date.now() - f.at < RETRY_FAILED_MS ? f : null; };

// store.args: extra serve flags (['--entities']: the entity lookup reader, rev5/entity_lookup.py, which builds spaCy and
// its index before answering and prints one {"id": null, "ready"} line when it can; until then it is not ready and a
// call answers store.notReady() at once rather than queueing behind a multi-second start).
const keyOf = (store) => `${store.python}\0${store.db}\0${store.cwd}\0${(store.args || []).join(' ')}`;
function startWorker(store, env) {
  const child = spawn(store.python, [store.cli, '--db', store.db, ...(store.args || []), 'serve'], { cwd: store.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const w = { child, busy: 0, dead: false, pending: new Map(), seq: 0, buf: '', err: '', ready: !store.announcesReady, readyError: null };
  const idle = () => { if (!w.pending.size) { child.unref(); child.stdout.unref?.(); child.stderr.unref?.(); child.stdin.unref?.(); } };
  w.hold = () => { child.ref(); child.stdout.ref?.(); child.stderr.ref?.(); child.stdin.ref?.(); };
  w.idle = idle;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    w.buf += chunk;
    let nl;
    while ((nl = w.buf.indexOf('\n')) !== -1) {
      const line = w.buf.slice(0, nl); w.buf = w.buf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === null && 'ready' in msg) { w.ready = Boolean(msg.ready); w.readyError = msg.error || null; if (!w.ready) { w.dead = true; failedAt.set(keyOf(store), { at: Date.now(), why: w.readyError }); try { child.kill(); } catch { /* gone */ } } continue; }
      const p = w.pending.get(msg.id);
      if (!p) continue;
      w.pending.delete(msg.id); clearTimeout(p.timer); w.busy -= 1; idle();
      const r = msg.result;
      p.done(r && typeof r === 'object' ? { ...r, ok: r.ok !== false && (msg.code === 0 || msg.code === 2) } : { ok: false, reason: 'failed', detail: 'the warm reader printed no result' });
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { w.err = (w.err + c).slice(-2000); });
  const die = (why) => {
    if (w.dead) return;
    w.dead = true;
    for (const p of w.pending.values()) { clearTimeout(p.timer); p.fallback(why); }
    w.pending.clear();
  };
  child.on('error', (e) => die(`spawn: ${e.code || e.message}`));
  child.on('exit', (code, signal) => die(`warm reader exited (${signal || code})${w.err ? `: ${w.err.slice(-300)}` : ''}`));
  child.stdin.on('error', () => die('stdin closed'));
  idle();
  return w;
}

function pick(key, store, env) {
  let pool = pools.get(key);
  if (!pool) pools.set(key, pool = []);
  for (let i = pool.length - 1; i >= 0; i -= 1) if (pool[i].dead) pool.splice(i, 1);
  const free = pool.find((w) => w.busy === 0);
  if (free) return free;
  if (pool.length < POOL_MAX) { const w = startWorker(store, env); pool.push(w); return w; }
  return null;
}

/**
 * Ask a warm reader. Resolves to the CLI's answer object, or to `fallback()`'s when no worker can take it (pool busy,
 * a worker that died before answering): the caller's one-shot path, so a broken worker costs latency, never an answer.
 */
export function warmMemoryCall({ store, env, command, payload, timeoutMs, fallback, keepOnTimeout = false }) {
  const key = keyOf(store);
  if (store.announcesReady && readerFailure(store)) return Promise.resolve(store.notReady ? store.notReady({ readyError: readerFailure(store).why, failed: true }) : fallback());
  const w = pick(key, store, env);
  if (!w) return fallback();
  if (!w.ready) return Promise.resolve(store.notReady ? store.notReady(w) : fallback());
  return new Promise((resolve) => {
    const id = ++w.seq;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (!w.pending.has(id)) return;
      if (keepOnTimeout) {
        // a bounded lookup (the entity leg, ~150 ms): the caller goes on without it, the worker stays warm, and the late
        // answer only frees its slot
        const p = w.pending.get(id); p.done = () => {}; p.fallback = () => {};
        resolve({ ok: false, reason: 'timeout', detail: `memory ${command} did not answer within ${timeoutMs} ms` });
        return;
      }
      w.pending.delete(id); w.busy -= 1;
      // gone for every later request now, before its exit event: the next one starts a fresh worker
      w.dead = true;
      for (const p of w.pending.values()) { clearTimeout(p.timer); p.fallback(); }
      w.pending.clear();
      try { w.child.kill('SIGKILL'); } catch { /* gone */ }
      resolve({ ok: false, reason: 'timeout', detail: `memory ${command} did not answer within ${timeoutMs} ms` });
    }, timeoutMs) : null;
    w.pending.set(id, { timer, done: resolve, fallback: () => { resolve(fallback()); } });
    w.busy += 1; w.hold();
    try { w.child.stdin.write(`${JSON.stringify({ id, command, request: payload ?? {} })}\n`); } catch (e) { w.pending.delete(id); w.busy -= 1; clearTimeout(timer); resolve(fallback()); }
  });
}

/** Start a reader now so the first prefetch does not pay the python start and the open. */
export function warmMemory({ store, env }) {
  const key = keyOf(store);
  const pool = pools.get(key) || [];
  if (pool.some((w) => !w.dead)) return;
  pick(key, store, env);
}

/** Tests: end every worker. */
export function stopMemoryWorkers() {
  for (const pool of pools.values()) for (const w of pool) { try { w.child.stdin.end(); w.child.kill(); } catch { /* gone */ } }
  pools.clear();
  failedAt.clear();
}
