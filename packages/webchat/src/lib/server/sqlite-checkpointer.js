// SQLite's WAL checkpoint, moved off the event loop.
//
// Every store the server opens is WAL with synchronous=NORMAL, so an ordinary commit appends frames to
// the -wal file and returns without an fsync. The one exception was the automatic checkpoint: the
// commit that pushes the log past 1000 pages copies every logged page back into the database file and
// fsyncs both, inline, on whatever thread made the commit. On this server that is the HTTP thread, and
// the database is events.sqlite (2 GB) or interaction.sqlite (5.7 GB). With the boot disk saturated
// that one commit took 1-3 s, and the [lag] log blamed whichever statement happened to cross the
// threshold: COMMIT on POST /api/interaction, INSERT INTO events, INSERT INTO event_fts, UPDATE
// conversations.
//
// So the HTTP thread never checkpoints. `walStore(db, path)` sets wal_autocheckpoint=0 on the
// server's connection and hands the file to one worker thread, which owns a second connection per
// file and runs PASSIVE checkpoints on a timer. PASSIVE never takes the writer lock and never waits
// on readers, so it cannot make the server's writer wait either; the fsyncs happen on the worker.
// journal_size_limit lets the writer shrink the -wal file when it rewinds it after a full checkpoint.
// If the worker dies it is restarted; while it is down the log only grows, nothing blocks.
//
// The worker is started from source text (eval) rather than a file, so the built server, which
// bundles this module into a chunk, has nothing extra to ship.

import { Worker } from 'node:worker_threads';

export const CHECKPOINT_INTERVAL_MS = Number(process.env.WEBCHAT_CHECKPOINT_MS || 2_000);
export const JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const conns = new Map();
const stats = {};
let timer = null;
function open(path) {
  if (conns.has(path)) return conns.get(path);
  let db = null;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 0');
  } catch (error) { stats[path] = { error: String(error.message || error) }; return null; }
  conns.set(path, db);
  return db;
}
function pass() {
  for (const path of conns.keys()) {
    const db = conns.get(path);
    const start = performance.now();
    try {
      const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() || {};
      const s = stats[path] || (stats[path] = { passes: 0, maxMs: 0, pages: 0 });
      const ms = performance.now() - start;
      s.passes += 1; s.lastMs = Math.round(ms); s.maxMs = Math.max(s.maxMs, Math.round(ms));
      s.log = row.log; s.checkpointed = row.checkpointed; s.pages += Math.max(0, row.checkpointed || 0); s.error = null;
    } catch (error) { (stats[path] || (stats[path] = { passes: 0, maxMs: 0, pages: 0 })).error = String(error.message || error); }
  }
}
function loop() { pass(); timer = setTimeout(loop, workerData.intervalMs); }
parentPort.on('message', (message) => {
  if (message.op === 'add') { open(message.path); }
  else if (message.op === 'remove') {
    const db = conns.get(message.path);
    conns.delete(message.path); delete stats[message.path];
    try { db?.close(); } catch {}
  }
  else if (message.op === 'pass') { pass(); parentPort.postMessage({ op: 'passed', id: message.id, stats }); }
  else if (message.op === 'stats') { parentPort.postMessage({ op: 'stats', id: message.id, stats }); }
  else if (message.op === 'stop') {
    clearTimeout(timer); pass();
    for (const db of conns.values()) { try { db.close(); } catch {} }
    parentPort.postMessage({ op: 'stopped', id: message.id, stats });
    parentPort.close();
  }
});
for (const path of workerData.paths) open(path);
timer = setTimeout(loop, workerData.intervalMs);
`;

/**
 * Start a checkpoint worker over `paths`. Returns { add(path), pass(), stats(), stop() }; pass,
 * stats and stop resolve with the per-file stats. The worker is unref'd: it never keeps a process
 * (a test, a CLI) alive.
 */
export function startCheckpointer(paths = [], { intervalMs = CHECKPOINT_INTERVAL_MS } = {}) {
  const files = new Set(paths);
  const users = new Map(paths.map((path) => [path, 1]));
  const waiting = new Map();
  let nextId = 1;
  let worker = null;
  let stopped = false;
  let restarts = 0;
  let lastStats = {};
  const spawnWorker = () => {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { paths: [...files], intervalMs } });
    worker.on('message', (message) => {
      if (message.stats) lastStats = message.stats;
      const done = waiting.get(message.id);
      if (done) { waiting.delete(message.id); done(message.stats); }
    });
    worker.on('error', (error) => { console.warn('[checkpointer] worker error:', error?.message || error); });
    worker.on('exit', () => {
      for (const done of waiting.values()) done(lastStats);
      waiting.clear();
      if (stopped) return;
      restarts += 1;
      // A crash loop must not become a hot loop: back off up to a minute.
      setTimeout(() => { if (!stopped) spawnWorker(); }, Math.min(60_000, 500 * 2 ** Math.min(restarts, 7))).unref();
    });
    // unref() last: Node re-refs a Worker when a 'message' listener is added after unref(), so the
    // unref that used to sit above the listener was undone and every process that opened a store kept
    // running forever after its work.
    worker.unref();
  };
  spawnWorker();
  const ask = (op) => new Promise((resolve) => {
    if (stopped && op !== 'stop') { resolve(lastStats); return; }
    const id = nextId++;
    waiting.set(id, resolve);
    try { worker.postMessage({ op, id }); } catch { waiting.delete(id); resolve(lastStats); }
  });
  return {
    add(path) {
      users.set(path, (users.get(path) || 0) + 1);
      if (files.has(path)) return;
      files.add(path); try { worker?.postMessage({ op: 'add', path }); } catch { /* respawn carries it */ }
    },
    // Counted: two connections to one file (the shared store and a CLI's, a reopen before the old
    // close) keep it checkpointed until the last one closes; with wal_autocheckpoint off, a file
    // nobody checkpoints grows its WAL without bound.
    remove(path) {
      const left = (users.get(path) || 0) - 1;
      if (left > 0) { users.set(path, left); return; }
      users.delete(path);
      if (!files.delete(path)) return;
      try { worker?.postMessage({ op: 'remove', path }); } catch { /* respawn leaves it out */ }
    },
    pass: () => ask('pass'),
    stats: () => ask('stats'),
    info: () => ({ files: [...files], restarts, stats: lastStats }),
    async stop() { const out = await ask('stop'); stopped = true; return out; }
  };
}

// The server's one checkpointer, shared by every store module (and by a hot-swapped second copy of
// this module, hence the global).
const G = (globalThis[Symbol.for('tophat.sqliteCheckpointer')] ||= { checkpointer: null });

/**
 * Configure the server's connection `db` to file `path` for WAL with checkpoints off the thread.
 * Call right after the journal_mode/synchronous pragmas. `:memory:` and empty paths are left alone.
 */
export function walStore(db, path) {
  if (!path || path === ':memory:' || String(path).startsWith('file::memory:')) return db;
  db.exec(`PRAGMA wal_autocheckpoint = 0; PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
  if (!G.checkpointer) G.checkpointer = startCheckpointer([path]);
  else G.checkpointer.add(path);
  return db;
}

/** The store that owned `path` has closed: the worker drops its connection to that file. Without this
 * the worker held every file ever opened until the process ended, kept checkpointing a database whose
 * owner was gone, and recreated its -wal/-shm beside a directory being removed.
 */
export function releaseWalStore(path) {
  if (!path || path === ':memory:' || String(path).startsWith('file::memory:')) return;
  G.checkpointer?.remove?.(path);
}

export const checkpointerInfo = () => G.checkpointer?.info() || null;
