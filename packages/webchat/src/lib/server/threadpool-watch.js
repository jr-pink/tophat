// The libuv threadpool carries every async fs call (static assets, /api/file streams, fs.promises),
// dns.lookup, crypto.pbkdf2 and zlib. A fresh fs.open, crypto.pbkdf2 and a Worker's fs.stat all
// timed out. /api/health is synchronous sqlite and kept answering, so the deploy guard and the
// heartbeat saw a healthy server for 40 minutes while every /_app/immutable asset hung until
// Cloudflare's 524: new tabs and new chats could not load the bundle.
//
// A wedged pool does not come back by itself, and nothing in JS can unwedge it. So the server
// probes the pool on a timer with a trivial fs.stat; if PROBE_FAILS consecutive probes time out it
// logs and exits non-zero, and launchd (KeepAlive) starts a clean process. Conversations live under
// relay.mjs and survive the restart. A probe is a stat of one file: free on a healthy pool.
import fs from 'node:fs';

export const PROBE_EVERY_MS = 10_000;
export const PROBE_TIMEOUT_MS = 8_000;
export const PROBE_FAILS = 3;

const KEY = Symbol.for('tophat.webchat.threadpoolWatch');

/** One probe: resolves { ok, ms } within timeoutMs, whether or not the pool answers. */
export function probeThreadpool({ stat = fs.stat, path = process.execPath, timeoutMs = PROBE_TIMEOUT_MS, now = Date.now } = {}) {
  const started = now();
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, ms: now() - started }); } }, timeoutMs);
    timer.unref?.();
    try {
      stat(path, () => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: true, ms: now() - started }); } });
    } catch {
      if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, ms: now() - started }); }
    }
  });
}

/** Start the watch. onWedged runs once after `fails` consecutive timed-out probes. */
export function startThreadpoolWatch({ every = PROBE_EVERY_MS, fails = PROBE_FAILS, probe = () => probeThreadpool(),
  onWedged = defaultWedged, log = console } = {}) {
  try { globalThis[KEY]?.stop(); } catch { /* none */ }
  const state = { misses: 0, last: null, wedged: false };
  let busy = false;
  const tick = async () => {
    if (busy || state.wedged) return;
    busy = true;
    try {
      const result = await probe();
      state.last = { ...result, at: Date.now() };
      if (result.ok) { state.misses = 0; return; }
      state.misses += 1;
      log.warn(`[threadpool] probe timed out after ${result.ms}ms (${state.misses}/${fails})`);
      if (state.misses >= fails) { state.wedged = true; onWedged(state); }
    } finally { busy = false; }
  };
  const timer = setInterval(tick, every);
  timer.unref?.();
  const handle = { state, tick, stop() { clearInterval(timer); } };
  globalThis[KEY] = handle;
  return handle;
}

export function threadpoolState() {
  return globalThis[KEY]?.state || null;
}

function defaultWedged(state) {
  console.error(`[threadpool] libuv threadpool wedged: ${state.misses} consecutive fs probes timed out; exiting so launchd starts a clean server`);
  // Not process.exit(0): a non-zero code is a crash to launchd and to the deploy guard, which is what this is.
  setTimeout(() => process.exit(70), 100);
}
