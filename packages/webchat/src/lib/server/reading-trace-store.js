// Where the reading trace is kept: daily append-only files (telemetry-log.js), not SQLite. It is
// behavioural telemetry about the owner rather than content, and it should be droppable without touching a
// single saved article or note.
//
// It was one sqlite file beside the reader's (reading-trace.sqlite, upserting one row per (session, surface,
// ref, sub, block, line)).
//
// A record is now appended as a DELTA line (the samples of one batch for one line box), and a read folds
// the lines back into the old row shape, the same way the upsert did: `ms` adds up, `passes` takes the
// maximum, `words`, `lines`, `last_at`, `width` and `height` take the latest line, `first_at` and `device`
// the first. A line imported from the old table is a full aggregate; it folds the same way, which is what
// makes the migration additive and checkable (folded files == the table).
//
// One writer (this module's worker thread), a bounded drop-oldest queue in front of it, day files deleted
// whole past WEBCHAT_READING_TRACE_RETENTION_DAYS (default 60). A retried POST adds its `ms` twice, as the
// upsert did; the trace has no ids to dedupe on.
//
// stage 2 stopped SQLite writes. The shadow runs only with WEBCHAT_READING_TRACE_SQLITE_SHADOW=1. The old
// file is archived under webchat/archive/telemetry-sqlite-20261106/.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { webchatStorePath } from './paths.js';
import { defineService } from './offload.js';
import { BoundedQueue, DayWriter, Flusher, dayOf, dirStats, listDayFiles, pruneDayFiles, scanLines } from './telemetry-log.js';

const num = (name, fallback) => { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== '' ? v : fallback; };

export const READING_TRACE_RETENTION_DAYS = num('WEBCHAT_READING_TRACE_RETENTION_DAYS', 60);
export const readingTraceDir = () => process.env.WEBCHAT_READING_TRACE_DIR || webchatStorePath('reading-trace');
export const readingTraceDbPath = () => process.env.WEBCHAT_READING_TRACE_DB || webchatStorePath('reading-trace.sqlite');
const shadowOn = () => process.env.WEBCHAT_READING_TRACE_SQLITE_SHADOW === '1';

const FIELDS = ['session', 'surface', 'ref', 'sub', 'block', 'line', 'lines', 'words', 'ms', 'passes', 'first_at', 'last_at', 'width', 'height', 'device'];
export const keyOf = (r) => `${r.session}\u0001${r.surface}\u0001${r.ref}\u0001${r.sub}\u0001${r.block}\u0001${r.line}`;

/** Fold delta/aggregate lines (in file order) into one row per key, the way the old upsert did. */
export function foldInto(map, r) {
  const k = keyOf(r);
  const cur = map.get(k);
  if (!cur) { map.set(k, { ...r }); return; }
  cur.ms += r.ms;
  cur.passes = Math.max(cur.passes, r.passes);
  cur.words = r.words; cur.lines = r.lines; cur.last_at = r.last_at; cur.width = r.width; cur.height = r.height;
}

export function parseTraceLine(line) {
  try {
    const r = JSON.parse(typeof line === 'string' ? line : line.toString('utf8'));
    if (!r || typeof r !== 'object' || typeof r.session !== 'string' || typeof r.block !== 'string') return null;
    return r;
  } catch { return null; }
}

/** The folded table of every day file in `dir` (optionally only those on or after `sinceDay`). */
export function foldDir(dir, { sinceDay = null } = {}) {
  const map = new Map();
  for (const f of listDayFiles(dir)) {
    if (sinceDay && f.day < sinceDay) continue;
    scanLines(f.path, (line) => { const r = parseTraceLine(line); if (r) foldInto(map, r); });
  }
  return map;
}

export function queryRows(map, { surface = null, ref = null, since = null, limit = 5000 } = {}) {
  const rows = [];
  for (const r of map.values()) {
    if (surface && r.surface !== surface) continue;
    if (ref && r.ref !== ref) continue;
    if (since && r.last_at < since) continue;
    rows.push(r);
  }
  rows.sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));
  return rows.slice(0, Number(limit));
}

export function querySessions(map, { limit = 50 } = {}) {
  const groups = new Map();
  for (const r of map.values()) {
    const k = `${r.session}\u0001${r.surface}\u0001${r.ref}`;
    let g = groups.get(k);
    if (!g) { g = { session: r.session, surface: r.surface, ref: r.ref, started: r.first_at, ended: r.last_at, ms: 0, words: 0, rows_n: 0, rereads: 0 }; groups.set(k, g); }
    if (r.first_at < g.started) g.started = r.first_at;
    if (r.last_at > g.ended) g.ended = r.last_at;
    g.ms += r.ms; g.words += r.words; g.rows_n += 1; if (r.passes > 1) g.rereads += 1;
  }
  return [...groups.values()].sort((a, b) => (a.ended < b.ended ? 1 : a.ended > b.ended ? -1 : 0)).slice(0, Number(limit));
}

// ---------------------------------------------------------------- worker side

const shadows = new Map();
function shadowUpsert(path, lines) {
  let s = shadows.get(path);
  if (!s) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try { chmodSync(path, 0o600); } catch { /* ignore */ }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000');
    db.exec(`CREATE TABLE IF NOT EXISTS lines (session TEXT NOT NULL, surface TEXT NOT NULL, ref TEXT NOT NULL, sub TEXT NOT NULL DEFAULT '', block TEXT NOT NULL, line INTEGER NOT NULL, lines INTEGER NOT NULL DEFAULT 1, words REAL NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, passes INTEGER NOT NULL DEFAULT 1, first_at TEXT NOT NULL, last_at TEXT NOT NULL, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '', PRIMARY KEY (session, surface, ref, sub, block, line));
      CREATE INDEX IF NOT EXISTS lines_by_ref ON lines(surface, ref, last_at); CREATE INDEX IF NOT EXISTS lines_by_time ON lines(last_at);`);
    s = {
      db,
      upsert: db.prepare(`INSERT INTO lines (session, surface, ref, sub, block, line, lines, words, ms, passes, first_at, last_at, width, height, device) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(session, surface, ref, sub, block, line) DO UPDATE SET ms = ms + excluded.ms, passes = MAX(passes, excluded.passes), words = excluded.words, lines = excluded.lines, last_at = excluded.last_at, width = excluded.width, height = excluded.height`)
    };
    shadows.set(path, s);
  }
  s.db.exec('BEGIN IMMEDIATE');
  try { for (const r of lines) s.upsert.run(...FIELDS.map((f) => r[f])); s.db.exec('COMMIT'); }
  catch (error) { try { s.db.exec('ROLLBACK'); } catch { /* gone */ } throw error; }
}

const writers = new Map();
function writerFor(dir) {
  let w = writers.get(dir);
  if (!w) {
    w = new DayWriter({
      dir, fsyncMs: num('WEBCHAT_TELEMETRY_FSYNC_MS', 2000), maxDayBytes: num('WEBCHAT_READING_TRACE_MAX_DAY_BYTES', 512 * 1024 ** 2),
      onRoll: () => { pruneDayFiles(dir, { days: num('WEBCHAT_READING_TRACE_RETENTION_DAYS', READING_TRACE_RETENTION_DAYS) }); }
    });
    writers.set(dir, w);
  }
  return w;
}

let cache = null;
const call = defineService(import.meta.url, 'reading-trace', {
  append: (items, dir, shadowPath) => {
    const w = writerFor(dir);
    const byDay = new Map();
    for (const it of items) byDay.set(dayOf(it.at), (byDay.get(dayOf(it.at)) || '') + it.line + '\n');
    let written = 0, capped = 0;
    for (const [day, text] of byDay) { const r = w.append(day, text); written += r.written; if (r.capped) capped += 1; }
    cache = null;
    let shadow = null;
    if (shadowOn()) { try { shadowUpsert(shadowPath, items.map((i) => i.row)); shadow = 'ok'; } catch (error) { shadow = String(error?.message || error); } }
    return { written, capped, shadow };
  },
  query: (kind, options, dir) => {
    const now = Date.now();
    if (!cache || cache.dir !== dir || now - cache.at > 10_000) cache = { dir, at: now, map: foldDir(dir) };
    return kind === 'sessions' ? querySessions(cache.map, options) : queryRows(cache.map, options);
  },
  prune: (options, dir) => pruneDayFiles(dir, options),
  close: (dir) => {
    for (const [key, w] of [...writers]) if (!dir || key === dir) { w.closeFile(); writers.delete(key); }
    for (const [key, s] of [...shadows]) { try { s.db.close(); } catch { /* gone */ } shadows.delete(key); }
    cache = null;
  }
});

// ---------------------------------------------------------------- HTTP-thread side

export function openReadingTrace({ dir = readingTraceDir(), shadowPath = readingTraceDbPath() } = {}) {
  const queue = new BoundedQueue({ maxItems: num('WEBCHAT_TELEMETRY_QUEUE_ROWS', 20_000), maxBytes: num('WEBCHAT_TELEMETRY_QUEUE_BYTES', 32 * 1024 * 1024) });
  const state = { capped: 0, shadowErrors: 0, lastShadowError: null, files: null, filesAt: 0 };
  const flusher = new Flusher({
    queue, delayMs: num('WEBCHAT_TELEMETRY_FLUSH_MS', 500),
    send: async (items) => {
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('reading-trace writer did not answer in 30 s')), 30_000); timer.unref?.(); });
      try {
        const result = await Promise.race([call('append', items, dir, shadowPath), timeout]);
        state.capped += result.capped;
        if (result.shadow && result.shadow !== 'ok') { state.shadowErrors += 1; state.lastShadowError = result.shadow; }
        return result;
      } finally { clearTimeout(timer); }
    }
  });
  return {
    dir,
    /** Queue the samples of one batch; returns how many rows were valid. Never waits for the disk. */
    record(rows = [], { session, surface, ref, device = '', width = 0, height = 0 } = {}) {
      let n = 0;
      const at = new Date().toISOString();
      for (const row of rows) {
        if (!row || !row.block) continue;
        const r = {
          session: String(session || ''), surface: String(surface || ''), ref: String(ref || ''), sub: String(row.sub || ''),
          block: String(row.block), line: Number(row.line || 0), lines: Number(row.lines || 1), words: Number(row.words || 0),
          ms: Math.max(0, Math.round(Number(row.ms || 0))), passes: Math.max(1, Number(row.passes || 1)),
          first_at: String(row.firstAt || at), last_at: String(row.lastAt || at),
          width: Number(width || 0), height: Number(height || 0), device: String(device || '')
        };
        const line = JSON.stringify(r);
        queue.push({ at, line, row: r }, line.length * 2 + 64);
        n += 1;
      }
      if (n) flusher.schedule();
      return n;
    },
    rows(options = {}) { return call('query', 'rows', options, dir); },
    sessions(options = {}) { return call('query', 'sessions', options, dir); },
    flush(options) { return flusher.flush(options); },
    stats() {
      const now = Date.now();
      if (!state.files || now - state.filesAt > 30_000) { state.files = dirStats(dir); state.filesAt = now; }
      return {
        dir, retentionDays: num('WEBCHAT_READING_TRACE_RETENTION_DAYS', READING_TRACE_RETENTION_DAYS), sqliteShadow: shadowOn(),
        queued: queue.size, queuedBytes: queue.bytes, accepted: queue.accepted, dropped: queue.dropped, droppedBytes: queue.droppedBytes,
        written: flusher.written, flushes: flusher.flushes, dayCapHits: state.capped,
        lastFlushAt: flusher.lastFlushAt, lastFlushMs: flusher.lastFlushMs, lastError: flusher.lastError, lastErrorAt: flusher.lastErrorAt,
        shadowErrors: state.shadowErrors, lastShadowError: state.lastShadowError, files: state.files
      };
    },
    prune(options = {}) { return call('prune', { days: READING_TRACE_RETENTION_DAYS, ...options }, dir); },
    async close() { try { await flusher.flush({ timeoutMs: 5000 }); } catch { /* telemetry */ } try { await call('close', dir); } catch { /* gone */ } }
  };
}

const HANDLE = Symbol.for('tophat.webchat.reading-trace');
export function readingTrace() {
  return (globalThis[HANDLE] ||= openReadingTrace());
}
export const readingTraceStats = () => readingTrace().stats();
