// The server has one thread. Anything that holds it (a spawnSync, a big synchronous sqlite read, a
// multi-megabyte JSON.parse) stops every chat stream, every tab and /api/health for exactly as long
// as it runs.
//
// This module is the instrument and the permanent guard:
//   * a timer that notices when it fires late and writes one JSON line per stall over STALL_MS,
//     naming the requests in flight and every synchronous operation that ran during the stall;
//   * wrappers on the synchronous primitives that can hold the thread (child_process *Sync,
//     fs.readFileSync, node:sqlite statements, JSON.parse/stringify) that remember any call over
//     its own threshold with the command / sql / path and the route it ran under;
//   * monitorEventLoopDelay, for the p99 and max of the loop over the process's life.
// Nothing here changes behaviour: the wrappers call straight through. `lagReport()` is what
// /api/lag serves.

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

export const STALL_MS = Number(process.env.WEBCHAT_STALL_MS || 100);
const TICK_MS = 10;
const OP_MS = { spawn: 15, sqlite: 25, read: 25, json: 25, fs: 25, gc: 50 };
const KEEP_OPS = 200;
const KEEP_STALLS = 200;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

// A hot swap loads a second copy of this module into the same process; the wrappers it installs
// patch process-wide objects, so the state they report into is shared too (one guard, one timer).
const G = (globalThis[Symbol.for('tophat.lagGuard')] ||= { context: new AsyncLocalStorage(), inflight: new Map(), nextRequest: 1, state: null, wrapped: false });
const context = G.context;
const inflight = G.inflight;

/** Run `fn` as request `label`: the guard names it when it is in flight during a stall. */
export function withRoute(label, fn) {
  const id = G.nextRequest++;
  const entry = { id, label, at: Date.now() };
  inflight.set(id, entry);
  return context.run(entry, () => {
    const done = () => inflight.delete(id);
    let result;
    try { result = fn(); } catch (error) { done(); throw error; }
    if (result && typeof result.then === 'function') return result.finally(done);
    done();
    return result;
  });
}

const where = () => context.getStore()?.label || 'timer-or-boot';
const frames = () => String(new Error().stack || '').split('\n').slice(3, 9).map((line) => line.trim().replace(/^at /, '').replace(/file:\/\/.*\/build[^/]*\//, '')).join(' < ');

function remember(kind, detail, ms) {
  if (!G.state) return;
  G.state.ops.push({ at: Date.now(), kind, ms: Math.round(ms), route: where(), inflight: [...inflight.values()].map((entry) => entry.label).slice(0, 12), detail: String(detail).slice(0, 200), stack: frames() });
  if (G.state.ops.length > KEEP_OPS) G.state.ops.splice(0, G.state.ops.length - KEEP_OPS);
  const key = `${kind} ${String(detail).slice(0, 80)}`;
  const row = G.state.byOp.get(key) || { kind, detail: String(detail).slice(0, 80), count: 0, totalMs: 0, maxMs: 0, route: where() };
  row.count += 1; row.totalMs += ms; if (ms > row.maxMs) { row.maxMs = ms; row.route = where(); }
  G.state.byOp.set(key, row);
}

function timed(kind, describe, original) {
  const limit = OP_MS[kind];
  return function guarded(...args) {
    const start = performance.now();
    try { return original.apply(this, args); }
    finally {
      const ms = performance.now() - start;
      if (ms >= limit) { let detail = ''; try { detail = describe(args); } catch { detail = '?'; } remember(kind, detail, ms); }
    }
  };
}

function patch(target, name, kind, describe) {
  const original = target?.[name];
  if (typeof original !== 'function' || original.__lagGuarded) return;
  const wrapped = timed(kind, describe, original);
  wrapped.__lagGuarded = true;
  try { target[name] = wrapped; } catch { /* frozen: leave it */ }
}

function wrapPrimitives() {
  const require = createRequire(import.meta.url);
  const childProcess = require('node:child_process');
  const cmd = (args) => [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].join(' ');
  for (const name of ['spawnSync', 'execFileSync']) patch(childProcess, name, 'spawn', cmd);
  patch(childProcess, 'execSync', 'spawn', (args) => String(args[0]));
  const fs = require('node:fs');
  patch(fs, 'readFileSync', 'read', (args) => String(args[0]));
  // Every other synchronous fs call that can wait on the device.
  const target = (args) => (typeof args[0] === 'number' ? `fd ${args[0]}` : String(args[0]));
  for (const name of ['writeFileSync', 'appendFileSync', 'fsyncSync', 'fdatasyncSync', 'openSync', 'writeSync', 'closeSync',
    'statSync', 'lstatSync', 'fstatSync', 'existsSync', 'readdirSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'readSync']) {
    patch(fs, name, 'fs', (args) => `${name} ${target(args)}`);
  }
  try {
    const sqlite = require('node:sqlite');
    patch(sqlite.DatabaseSync?.prototype, 'exec', 'sqlite', (args) => String(args[0]));
    // A statement object does not carry its text through the wrapper, so name it from the source.
    const prepare = sqlite.DatabaseSync?.prototype?.prepare;
    if (prepare && !prepare.__lagGuarded) {
      const wrapped = function prepared(sql, ...rest) { const statement = prepare.call(this, sql, ...rest); try { Object.defineProperty(statement, '__sql', { value: String(sql) }); } catch {} return statement; };
      wrapped.__lagGuarded = true;
      sqlite.DatabaseSync.prototype.prepare = wrapped;
      for (const name of ['all', 'get', 'run']) {
        const original = sqlite.StatementSync.prototype[name];
        if (!original?.__lagGuarded2) {
          const withSql = function sqlTimed(...args) {
            const start = performance.now();
            try { return original.apply(this, args); }
            finally { const ms = performance.now() - start; if (ms >= OP_MS.sqlite) remember('sqlite', this.sourceSQL || this.__sql || 'statement', ms); }
          };
          withSql.__lagGuarded2 = true;
          sqlite.StatementSync.prototype[name] = withSql;
        }
      }
    }
  } catch { /* node:sqlite absent */ }
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  JSON.stringify = function guardedStringify(...args) {
    const start = performance.now();
    const out = stringify.apply(this, args);
    const ms = performance.now() - start;
    if (ms >= OP_MS.json) remember('json', `stringify ${out ? out.length : 0} chars`, ms);
    return out;
  };
  JSON.parse = function guardedParse(...args) {
    const start = performance.now();
    const out = parse.apply(this, args);
    const ms = performance.now() - start;
    if (ms >= OP_MS.json) remember('json', `parse ${String(args[0]).length} chars`, ms);
    return out;
  };
  syncBuiltinESMExports();
}

async function writeLine(path, line) {
  try {
    await mkdir(dirname(path), { recursive: true });
    try { if ((await stat(path)).size > LOG_MAX_BYTES) await rename(path, `${path}.1`); } catch { /* none yet */ }
    await appendFile(path, `${line}\n`);
  } catch { /* the log is a convenience */ }
}

/**
 * Start the guard once per process. `logPath` receives one JSON line per stall; `onStall` is for
 * tests. Returns the report function.
 */
export function installLagGuard({ logPath = null, stallMs = STALL_MS, onStall = null, wrap = true } = {}) {
  if (G.state) return lagReport;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  G.state = { ops: [], stalls: [], byOp: new Map(), byRoute: new Map(), histogram, since: Date.now(), stallMs };
  if (wrap && !G.wrapped) { wrapPrimitives(); G.wrapped = true; }
  // A garbage-collection pause holds the thread like any sync call; name it instead of leaving it to
  // "CPU work in JS". The entry arrives just after the pause, so it is recorded at the time it began.
  if (!G.gcObserver) {
    try {
      G.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < OP_MS.gc || !G.state) continue;
          const at = performance.timeOrigin + entry.startTime;
          const kinds = { 1: 'scavenge', 2: 'mark-sweep-compact', 4: 'incremental', 8: 'weak-callbacks' };
          G.state.ops.push({ at, kind: 'gc', ms: Math.round(entry.duration), route: 'gc', inflight: [], detail: `${kinds[entry.detail?.kind] || 'gc'} heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB`, stack: '' });
        }
      });
      G.gcObserver.observe({ entryTypes: ['gc'] });
    } catch { /* no gc entries on this runtime */ }
  }
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - last - TICK_MS;
    const began = Date.now() - (now - last);
    last = now;
    if (late < stallMs) return;
    const during = G.state.ops.filter((op) => op.at >= began - 5);
    const record = {
      at: new Date().toISOString(), stallMs: Math.round(late),
      inflight: during.length ? [...new Set(during.flatMap((op) => op.inflight || []))].slice(0, 12) : [...inflight.values()].map((entry) => `${entry.label} (${Date.now() - entry.at}ms old)`).slice(0, 12),
      syncOps: during.map(({ kind, ms, route, detail, stack }) => ({ kind, ms, route, detail, stack })).slice(-8),
      culprit: during.length ? `${during.at(-1).kind}: ${during.at(-1).detail}` : 'no instrumented primitive; CPU work in JS (see inflight)'
    };
    G.state.stalls.push(record);
    if (G.state.stalls.length > KEEP_STALLS) G.state.stalls.splice(0, G.state.stalls.length - KEEP_STALLS);
    const key = record.syncOps.length ? `${record.syncOps.at(-1).route} :: ${record.culprit}` : `${record.inflight[0] || 'idle'} :: ${record.culprit}`;
    const row = G.state.byRoute.get(key) || { key, count: 0, totalMs: 0, maxMs: 0 };
    row.count += 1; row.totalMs += record.stallMs; row.maxMs = Math.max(row.maxMs, record.stallMs);
    G.state.byRoute.set(key, row);
    console.warn(`[lag] event loop stalled ${record.stallMs}ms; in flight: ${record.inflight.slice(0, 4).join(', ') || 'nothing'}; ${record.culprit}`);
    if (logPath) writeLine(logPath, JSON.stringify(record));
    onStall?.(record);
  }, TICK_MS);
  timer.unref?.();
  return lagReport;
}

export function lagReport() {
  if (!G.state) return { installed: false };
  const h = G.state.histogram;
  const top = (map) => [...map.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 15).map((row) => ({ ...row, totalMs: Math.round(row.totalMs) }));
  return {
    installed: true, stallThresholdMs: G.state.stallMs, since: new Date(G.state.since).toISOString(),
    loop: { p50: Math.round(h.percentile(50) / 1e6), p99: Math.round(h.percentile(99) / 1e6), max: Math.round(h.max / 1e6), unit: 'ms' },
    stallCount: G.state.stalls.length, topStalls: top(G.state.byRoute), topSyncOps: top(G.state.byOp),
    recentStalls: G.state.stalls.slice(-10), recentOps: G.state.ops.slice(-15)
  };
}

export const resetLagGuardForTest = () => { if (G.state) { G.state.histogram.disable(); } G.state = null; };
