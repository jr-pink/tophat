// Observation storage for the interaction stream.
//
// Every open tab posts a batch here on its own heartbeat, so this is the hottest write path in the
// server and it runs on the one thread that also serves every chat stream.
//
// History, because each step is why the next exists:
//    the store was still a 5.7 GB SQLite file on the disk the chat store shares, with a 14-day DELETE
//    retention and WAL checkpoints; a saturated boot disk still made every commit and delete slow, and
//    the 1.49 M-row table was 64 % free pages.
//    Telemetry is a lossy, aggregated, separate class of data that never
//    shares a commit path with chat. It is now one NDJSON file per UTC day (telemetry-log.js), appended
//    by the one worker thread, with a bounded drop-oldest queue in front of it and retention by deleting
//    whole day files.
//
// What a POST does now: validate, push onto the bounded queue, answer. `acknowledged` means "accepted for
// writing", not "on disk": the batch reaches the day file within WEBCHAT_TELEMETRY_FLUSH_MS (500 ms) and is
// fsynced within WEBCHAT_TELEMETRY_FSYNC_MS (2 s). A crash of the whole process can lose that last half
// second; the queue dropping its oldest rows under sustained pressure is counted in /api/health
// (`telemetry.interaction.dropped`). Idempotency is unchanged: a retry of the same `session:seq` id is
// ignored by the writer when it is in today's or yesterday's file and by every reader otherwise (first copy
// wins, the way INSERT OR IGNORE did).
//
// Line format, one per observation: `<received ISO>\t<id as a JSON string>\t<observation JSON>\n`. The id
// and timestamp sit outside the JSON so dedupe and day selection never parse a body.
//
// stage 2 stopped SQLite writes. The shadow is off by default now and only runs with
// WEBCHAT_INTERACTION_SQLITE_SHADOW=1 (kept for the tests of the migration check). The old file is archived
// under webchat/archive/telemetry-sqlite-20261106/.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { webchatStorePath } from './paths.js';
import { defineService, stopService } from './offload.js';
import { BoundedQueue, DayWriter, Flusher, dayOf, dirStats, listDayFiles, pruneDayFiles, scanLines } from './telemetry-log.js';

const num = (name, fallback) => { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== '' ? v : fallback; };

export const RETENTION_DAYS = num('WEBCHAT_INTERACTION_RETENTION_DAYS', 14);

/** The legacy SQLite file: the migration source and, in stage 1, the shadow-write target. */
export function interactionPath() {
  if (process.env.WEBCHAT_INTERACTION_DB) return process.env.WEBCHAT_INTERACTION_DB;
  if (process.env.WEBCHAT_DB) return join(dirname(process.env.WEBCHAT_DB), 'interaction.sqlite');
  return webchatStorePath('interaction.sqlite');
}

/** Where the day files live: `interaction/` beside the legacy file unless WEBCHAT_INTERACTION_DIR says otherwise. */
export function interactionDir() {
  if (process.env.WEBCHAT_INTERACTION_DIR) return process.env.WEBCHAT_INTERACTION_DIR;
  return join(dirname(interactionPath()), 'interaction');
}

const shadowPathFor = (dir) => (process.env.WEBCHAT_INTERACTION_DB || join(dirname(dir), 'interaction.sqlite'));
const shadowOn = () => process.env.WEBCHAT_INTERACTION_SQLITE_SHADOW === '1';

export function validateObservations(rows) {
  encode(rows);
  return rows;
}

function encode(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new Error('expected 1–500 observations');
  const bodies = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.schema !== 1 || typeof row.session !== 'string' || row.session.length > 120
      || !Number.isSafeInteger(row.seq) || row.seq < 0 || row.id !== `${row.session}:${row.seq}`
      || typeof row.type !== 'string' || row.type.length > 80 || !Number.isFinite(row.mono)
      || typeof row.conversation !== 'string' || row.conversation.length > 120) throw new Error('invalid observation');
    const body = JSON.stringify(row);
    if (body.length > 200_000) throw new Error('invalid observation');
    if (row.type === 'viewport' && (!Array.isArray(row.blocks) || row.blocks.some(b => !b || typeof b.id !== 'string' || !Number.isFinite(b.area) || b.area < 0))) throw new Error('invalid observation viewport');
    bodies.push(body);
  }
  return bodies;
}

export const formatObservationLine = (received, id, body) => `${received}\t${JSON.stringify(id)}\t${body}\n`;

/** `{ received, id, body }` of a stored line (a Buffer or string), or null when it is torn or malformed. */
export function parseObservationLine(line) {
  let text = typeof line === 'string' ? line : line.toString('utf8');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const a = text.indexOf('\t');
  const b = a < 0 ? -1 : text.indexOf('\t', a + 1);
  if (a < 0 || b < 0) return null;
  try {
    const id = JSON.parse(text.slice(a + 1, b));
    if (typeof id !== 'string') return null;
    return { received: text.slice(0, a), id, body: text.slice(b + 1) };
  } catch { return null; }
}

// ---------------------------------------------------------------- worker side (the one writer)

const shadows = new Map();
function shadowInsert(path, entries) {
  let shadow = shadows.get(path);
  if (!shadow) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    try { chmodSync(path, 0o600); } catch { /* ignore */ }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, session TEXT NOT NULL, seq INTEGER NOT NULL, conversation TEXT, received TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS observation_conversation ON observations(conversation); CREATE INDEX IF NOT EXISTS observation_received ON observations(received);');
    shadow = { db, insert: db.prepare('INSERT OR IGNORE INTO observations VALUES (?, ?, ?, ?, ?, ?)') };
    shadows.set(path, shadow);
  }
  shadow.db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of entries) shadow.insert.run(e.id, e.s, e.q, e.c, e.r, e.b);
    shadow.db.exec('COMMIT');
  } catch (error) {
    try { shadow.db.exec('ROLLBACK'); } catch { /* gone */ }
    throw error;
  }
}

const SEEN_MAX = 500_000;
const writers = new Map();
function writerFor(dir) {
  let w = writers.get(dir);
  if (w) return w;
  const days = () => num('WEBCHAT_INTERACTION_RETENTION_DAYS', RETENTION_DAYS);
  w = {
    seen: new Map(),
    loaded: new Set(),
    writer: new DayWriter({
      dir, fsyncMs: num('WEBCHAT_TELEMETRY_FSYNC_MS', 2000), maxDayBytes: num('WEBCHAT_INTERACTION_MAX_DAY_BYTES', 1024 ** 3),
      onRoll: () => { pruneDayFiles(dir, { days: days() }); }
    })
  };
  writers.set(dir, w);
  return w;
}

function loadSeen(w, dir, day) {
  if (w.loaded.has(day)) return;
  w.loaded.add(day);
  for (const f of listDayFiles(dir)) {
    if (f.day !== day) continue;
    scanLines(f.path, (line) => { const p = parseObservationLine(line.subarray(0, Math.min(line.length, 400))); if (p) markSeen(w, p.id); });
  }
}
function markSeen(w, id) {
  w.seen.set(id, true);
  if (w.seen.size > SEEN_MAX) w.seen.delete(w.seen.keys().next().value);
}
const yesterdayOf = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function appendEntries(entries, dir) {
  // Test seam: a writer whose disk has stopped answering (a blocking fsync on a saturated boot disk).
  const stall = Number(process.env.WEBCHAT_TELEMETRY_TEST_STALL_MS || 0);
  if (stall > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stall);
  const w = writerFor(dir);
  const text = new Map();
  let duplicates = 0;
  for (const e of entries) {
    const day = dayOf(e.r);
    loadSeen(w, dir, day); loadSeen(w, dir, yesterdayOf(day));
    if (w.seen.has(e.id)) { duplicates += 1; continue; }
    markSeen(w, e.id);
    text.set(day, (text.get(day) || '') + formatObservationLine(e.r, e.id, e.b));
  }
  let written = 0, capped = 0;
  for (const [day, chunk] of text) {
    const r = w.writer.append(day, chunk);
    written += r.written; if (r.capped) capped += 1;
  }
  let shadow = null;
  if (shadowOn()) {
    try { shadowInsert(shadowPathFor(dir), entries); shadow = 'ok'; } catch (error) { shadow = String(error?.message || error); }
  }
  return { written, duplicates, capped, shadow };
}

const call = defineService(import.meta.url, 'interaction', {
  append: (entries, dir) => appendEntries(entries, dir),
  prune: (options, dir) => pruneDayFiles(dir, options),
  close: (dir) => {
    for (const [key, w] of [...writers]) if (!dir || key === dir) { w.writer.closeFile(); writers.delete(key); }
    for (const [key, s] of [...shadows]) if (!dir || key === shadowPathFor(dir)) { try { s.db.close(); } catch { /* gone */ } shadows.delete(key); }
  }
});

// ---------------------------------------------------------------- HTTP-thread side: validate, queue, answer

const STATE = Symbol.for('tophat.webchat.interaction-queue');
function stateFor(dir) {
  const all = (globalThis[STATE] ||= new Map());
  let s = all.get(dir);
  if (!s) {
    const queue = new BoundedQueue({ maxItems: num('WEBCHAT_TELEMETRY_QUEUE_ROWS', 20_000), maxBytes: num('WEBCHAT_TELEMETRY_QUEUE_BYTES', 32 * 1024 * 1024) });
    const flusher = new Flusher({
      queue, delayMs: num('WEBCHAT_TELEMETRY_FLUSH_MS', 500),
      send: async (entries) => {
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('interaction writer did not answer in 30 s')), 30_000); timer.unref?.(); });
        try {
          const result = await Promise.race([call('append', entries, dir), timeout]);
          s.duplicates += result.duplicates; s.capped += result.capped;
          if (result.shadow && result.shadow !== 'ok') { s.shadowErrors += 1; s.lastShadowError = result.shadow; }
          return result;
        } finally { clearTimeout(timer); }
      }
    });
    s = { queue, flusher, duplicates: 0, capped: 0, shadowErrors: 0, lastShadowError: null, files: null, filesAt: 0 };
    all.set(dir, s);
  }
  return s;
}

/**
 * Accept a batch; resolves with the ids accepted. Validation runs first, so a malformed batch is refused
 * and nothing of it is queued. The disk is never awaited here.
 */
export async function saveObservations(rows, dir = interactionDir()) {
  const bodies = encode(rows);
  const s = stateFor(dir);
  const received = new Date().toISOString();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    s.queue.push({ r: received, id: row.id, s: row.session, q: row.seq, c: row.conversation, b: bodies[i] }, bodies[i].length + 96);
  }
  s.flusher.schedule();
  return rows.map(r => r.id);
}

/** Write everything queued, now (tests, shutdown, the migration check). */
export async function flushInteraction(dir = interactionDir(), options) {
  await stateFor(dir).flusher.flush(options);
}

/** Flush, then release the writer's files: shutdown, and tests that want the directory closed before they delete it. */
export async function closeInteraction(dir = null) {
  const all = globalThis[STATE];
  const dirs = dir ? [dir] : all ? [...all.keys()] : [];
  for (const d of dirs) { try { await flushInteraction(d, { timeoutMs: 5000 }); } catch { /* telemetry: give up */ } }
  try { await call('close', dir); } catch { /* worker already gone */ }
  if (all) for (const d of dirs) all.delete(d);
  if (!dir) await stopService('interaction');
}

/** What /api/health shows: queue depth, drops, last write, and the day files on disk. */
export function interactionStats(dir = interactionDir()) {
  const s = stateFor(dir);
  const now = Date.now();
  if (!s.files || now - s.filesAt > 30_000) { s.files = dirStats(dir); s.filesAt = now; }
  const f = s.flusher;
  return {
    dir, retentionDays: num('WEBCHAT_INTERACTION_RETENTION_DAYS', RETENTION_DAYS), sqliteShadow: shadowOn(),
    queued: s.queue.size, queuedBytes: s.queue.bytes, accepted: s.queue.accepted, dropped: s.queue.dropped, droppedBytes: s.queue.droppedBytes,
    written: f.written, flushes: f.flushes, duplicatesSkipped: s.duplicates, dayCapHits: s.capped,
    lastFlushAt: f.lastFlushAt, lastFlushMs: f.lastFlushMs, lastError: f.lastError, lastErrorAt: f.lastErrorAt,
    shadowErrors: s.shadowErrors, lastShadowError: s.lastShadowError, files: s.files
  };
}

/**
 * Retention: delete whole day files past the window. Cheap and bounded (a handful of unlinks), so there
 * is nothing to drain; the shape of the old drain's result is kept for app.js's timer, whose `removed`
 * now counts files.
 */
export async function drainObservations({ days = RETENTION_DAYS } = {}, dir = interactionDir()) {
  const r = await call('prune', { days }, dir);
  return { removed: r.removed, files: r.files, bytes: r.bytes, passes: 1, more: false };
}
export const pruneObservations = (options = {}, dir = interactionDir()) => drainObservations(options, dir);

// ---------------------------------------------------------------- readers (offline tools, tests)

/**
 * Observations oldest first (received, session, seq), duplicates by id dropped with the first copy kept.
 * Reads the day files synchronously on the calling thread: for tools and tests, never for a request.
 * `since` and `until` are received-time ISO bounds; `conversation` filters.
 */
export function readObservations({ conversation, limit = 100000, since, until } = {}, dir = interactionDir()) {
  const out = [];
  const seen = new Set();
  const needle = conversation ? `"conversation":${JSON.stringify(conversation)}` : null;
  const files = listDayFiles(dir).filter((f) => (!since || f.day >= dayOf(since)) && (!until || f.day <= dayOf(until)));
  const days = [...new Set(files.map((f) => f.day))];
  for (const day of days) {
    const rows = [];
    for (const f of files.filter((x) => x.day === day)) {
      scanLines(f.path, (line) => {
        const p = parseObservationLine(line);
        if (!p || seen.has(p.id)) return;
        if (since && p.received < since) return;
        if (until && p.received > until) return;
        if (needle && !p.body.includes(needle)) return;
        let row;
        try { row = JSON.parse(p.body); } catch { return; }
        if (conversation && row.conversation !== conversation) return;
        seen.add(p.id);
        rows.push({ ...row, receivedAt: p.received });
      });
    }
    rows.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.session < b.session ? -1 : a.session > b.session ? 1 : a.seq - b.seq));
    for (const row of rows) { out.push(row); if (out.length >= limit) return out; }
  }
  return out;
}
