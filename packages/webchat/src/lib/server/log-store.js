// The log-first chat store: the same interface as store.js openStore(), a different truth.
//
// WRITES. append() allocates a cursor, folds the event into in-memory projections (the conversation
// row, the conversation's tail, the global live ring, run markers, owed messages), queues one record
// for the writer and notifies subscribers, all in memory. The one writer (chatlog-writer.js, a worker
// thread) appends the record to the conversation's log, fsyncs, and folds it into the derived SQLite
// index, in a small batch right behind the append. No request handler waits on a disk for a write.
//
// READS. Everything a handler reads for its own and recent writes comes from memory. History older
// than a conversation's cached tail, and search, read the derived index through a read-only SQLite
// connection (WAL: it never blocks the writer). The invariant that makes the merge exact: a
// conversation's tail holds EVERY committed event with a cursor at or above `tailFrom`; everything
// below it is already in the index. A read that needs older rows takes them from the index and the
// rest from the tail, de-duplicated by cursor.
//
// CURSORS. One sequence for every conversation (clients and rev5 hold these as resume points), handed
// out in memory. Fragments (assistant.delta, thinking.delta, tool.input_delta) take cursors too, so
// ordering and every client's `after` keep their meaning, but they are not logged: they live in the
// ring (for a reconnect mid-stream) and in a FragmentCommitter, which commits what has no committed
// form of its own (fragments.js). cursor.reserve is the durable promise that no cursor above it was
// ever given out; a restart resumes above it, so a cursor a client saw is never reused, though a
// fragment's cursor may be a gap in the log.
//
// ACKNOWLEDGEMENT. flush() resolves when every record appended before the call is durable in the log
// and indexed. Subscribers are told at append time (an SSE stream must see events in cursor order, so it
// cannot wait for a fsync), which means a process crash within one batch interval can lose an event a
// tab already saw; the log never holds an event that was not appended, and never loses one flush()
// acknowledged.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EVENT_KINDS, SCHEMA_HASH, CONTRACT_VERSION, normalizeSettings } from '../core/contract.js';
import { LogDir } from './chatlog.js';
import { ChatIndex, catchUp } from './chat-index.js';
import { LogWriter, callWriter } from './chatlog-writer.js';
import { searchService } from './chat-search.js';
import { FragmentCommitter, FRAGMENT_KINDS, TERMINAL_KINDS } from './fragments.js';
import { blankConversation, projectEvent, projectSet } from './conv-projection.js';
import { decodeConversation, decodeMove, discharges, expandIndex, owesAnswer, searchIndex } from './store-shared.js';
import { RESUME_CAP } from './store-shared.js';

export const RESERVE_BLOCK = 100_000;
const RING_EVENTS_DEFAULT = Number(process.env.WEBCHAT_RING_EVENTS || 60_000);
const RING_BYTES_DEFAULT = Number(process.env.WEBCHAT_RING_BYTES || 96 * 1024 * 1024);
const TAIL_MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
const TAIL_TOTAL_BYTES_DEFAULT = 192 * 1024 * 1024;
const TAIL_LOAD = 600;
const QUEUE_RECORDS_DEFAULT = Number(process.env.WEBCHAT_LOG_QUEUE_RECORDS || 50_000);
const QUEUE_BYTES_DEFAULT = Number(process.env.WEBCHAT_LOG_QUEUE_BYTES || 128 * 1024 * 1024);
const BATCH_MAX = 400;
const PROBE_EVERY_MS = 5_000;
const LAG_SAMPLES = 4096;

export const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ff_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'routing',
  conversation_id TEXT, title TEXT, reason TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS reading (
  conversation_id TEXT PRIMARY KEY, item_id TEXT, ratio REAL NOT NULL DEFAULT 0, device_id TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scope_moves (
  move_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, from_scope TEXT NOT NULL, to_scope TEXT NOT NULL, actor TEXT NOT NULL,
  account TEXT, state TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', events_count INTEGER, digest TEXT, reason TEXT,
  started_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS scope_moves_by_conversation ON scope_moves(conversation_id, started_at);
CREATE TABLE IF NOT EXISTS scope_rules (account TEXT PRIMARY KEY, prompt TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A conversation id as the log wants it: a non-empty string. The legacy store kept the id in a TEXT column, so a number
 * (the fire-and-forget id /api/inbound files an applied-action receipt under) was always stored as its text; that is
 * what String() gives. Anything else is not an id.
 */
export function asId(id) {
  if (typeof id === 'string' && id) return id;
  if (typeof id === 'number' || typeof id === 'bigint') return String(id);
  throw new TypeError(`a conversation id is a non-empty string (got ${id === null ? 'null' : typeof id})`);
}

const DISK_FULL = /ENOSPC|EDQUOT|SQLITE_FULL|database or disk is full|no space left/iu;
const byteSize = (text) => text.length;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export class QueueFullError extends Error {
  constructor(detail) { super(`chat log queue is full (${detail})`); this.code = 'CHATLOG_QUEUE_FULL'; }
}

/**
 * Open the log-first store.
 * @param {string} dir  the webchat state directory (the log lives in dir/chatlog, the index and the small state file beside it)
 * @param {object} [options] indexPath, statePath, transport ('worker' | 'inline'), probeEveryMs (0: none), now, log
 */
export function openLogStore(dir, options = {}) {
  const logRoot = options.logRoot || path.join(dir, 'chatlog');
  const indexPath = options.indexPath || path.join(dir, 'chat-index.sqlite');
  const statePath = options.statePath || path.join(dir, 'chat-state.sqlite');
  const now = options.now || (() => new Date().toISOString());
  const logger = options.log || console;
  fs.mkdirSync(dir, { recursive: true });
  const RING_MAX_EVENTS = options.ringEvents ?? RING_EVENTS_DEFAULT;
  const RING_MAX_BYTES = options.ringBytes ?? RING_BYTES_DEFAULT;
  const TAIL_MAX_BYTES = options.tailBytes ?? TAIL_MAX_BYTES_DEFAULT;
  const TAIL_TOTAL_BYTES = options.tailTotalBytes ?? TAIL_TOTAL_BYTES_DEFAULT;
  const QUEUE_MAX_RECORDS = options.queueMaxRecords ?? QUEUE_RECORDS_DEFAULT;
  const QUEUE_MAX_BYTES = options.queueMaxBytes ?? QUEUE_BYTES_DEFAULT;

  // ---- boot: the index is made a complete view of the log, then memory is loaded from it ------------------------
  const bootLog = new LogDir(logRoot);
  const bootIndex = new ChatIndex(indexPath);
  const caught = catchUp(bootIndex, bootLog);
  if (caught.corrupt.length) logger.error?.(`[chatlog] ${caught.corrupt.length} unreadable log line(s) at boot, first: ${JSON.stringify(caught.corrupt[0])}`);
  const indexedMax = bootIndex.maxCursor();
  const ingestedThrough = bootIndex.ingestedThrough();
  bootIndex.checkpoint('PASSIVE');
  bootIndex.close();
  bootLog.close();

  let reader = ChatIndex.openReadOnly(indexPath);
  const stateDb = new DatabaseSync(statePath);
  stateDb.exec('PRAGMA journal_mode = WAL');
  stateDb.exec('PRAGMA synchronous = NORMAL');
  stateDb.exec('PRAGMA busy_timeout = 5000');
  stateDb.exec(STATE_SCHEMA);

  // ---- cursors -----------------------------------------------------------------------------------------------------
  const reserveFile = path.join(logRoot, 'cursor.reserve');
  const readReserve = () => { try { return Number(fs.readFileSync(reserveFile, 'utf8').trim()) || 0; } catch { return 0; } };
  let reserved = readReserve();
  let head = Math.max(reserved, indexedMax, Number(options.baseCursor || 0));
  function reserve(upTo) {
    const tmp = `${reserveFile}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, String(upTo)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, reserveFile);
    reserved = upTo;
  }
  reserve(head + RESERVE_BLOCK);
  const allocate = () => { if (head + 1 > reserved) reserve(head + RESERVE_BLOCK); head += 1; return head; };

  // ---- in-memory projections ---------------------------------------------------------------------------------------
  const convs = new Map();       // id -> ConvState
  const applied = new Map();     // action id -> row
  const listeners = new Set();
  let enqueueSeq = 0;            // records handed to the queue
  let indexedSeq = 0;            // records the writer has made durable and indexed
  const decodedCache = new WeakMap();

  function newState(id, row, lastN = 0) {
    return { id, row, lastN, tail: [], tailBytes: 0, tailFrom: head + 1, complete: false, frags: [], runs: 0, ended: 0,
      lastDischarge: 0, owed: [], touched: 0 };
  }

  for (const r of reader.db.prepare('SELECT * FROM conversations').all()) convs.set(r.id, newState(r.id, { ...r }));
  for (const p of reader.db.prepare('SELECT conversation_id, n FROM log_pos').all()) {
    const st = convs.get(p.conversation_id) || (convs.set(p.conversation_id, newState(p.conversation_id, undefined)), convs.get(p.conversation_id));
    st.lastN = p.n;
  }
  for (const a of reader.db.prepare('SELECT * FROM applied_actions').all()) applied.set(a.action_id, a);
  for (const m of reader.db.prepare("SELECT conversation_id, COUNT(*) AS runs, MAX(CASE WHEN kind IN ('run.completed','run.cancelled','run.error') THEN cursor END) AS ended FROM events WHERE kind IN ('run.status','run.completed','run.cancelled','run.error') GROUP BY conversation_id").all()) {
    const st = convs.get(m.conversation_id); if (st) { st.runs = m.runs; st.ended = m.ended || 0; }
  }
  for (const e of reader.db.prepare("SELECT conversation_id, kind, cursor, content FROM events WHERE kind IN ('run.completed','run.error','run.cancelled') ORDER BY cursor").iterate()) {
    const st = convs.get(e.conversation_id); if (!st) continue;
    let content = {}; try { content = JSON.parse(e.content); } catch { /* unreadable: counts as a discharge only when plain */ }
    if (discharges(e.kind, content)) st.lastDischarge = e.cursor;
  }
  for (const e of reader.db.prepare("SELECT conversation_id, cursor, content FROM events WHERE kind = 'message.user' ORDER BY cursor").iterate()) {
    const st = convs.get(e.conversation_id); if (!st || e.cursor <= st.lastDischarge) continue;
    let content = {}; try { content = JSON.parse(e.content); } catch { /* skip */ }
    if (owesAnswer(content)) st.owed.push({ cursor: e.cursor, text: content.text, itemId: content.itemId });
  }

  const stateFor = (given) => {
    const id = asId(given);
    let st = convs.get(id);
    if (!st) { st = newState(id, undefined); st.complete = true; convs.set(id, st); }
    return st;
  };

  // ---- the ring: the newest events of every conversation, fragments included, in cursor order ----------------------
  let ring = [];
  let ringHead = 0;
  let ringBytes = 0;
  let ringFloor = 0;             // the ring is authoritative for every cursor above this; older cursors are read from the index
  for (const r of reader.db.prepare('SELECT * FROM events ORDER BY cursor DESC LIMIT 5000').all().reverse()) {
    const ev = rowToEvent(r);
    ring.push({ ev, eph: false, tok: null, bytes: r.content.length });
    ringBytes += r.content.length;
  }
  ringFloor = ring.length ? ring[0].ev.cursor - 1 : head;
  // Nothing newer than the index exists at boot, so the floor of an empty ring is the head.

  function ringInsert(entry) {
    const cursor = entry.ev.cursor;
    if (cursor <= ringFloor) return;        // older than the ring's reach: the index serves it
    let at = ring.length;
    while (at > ringHead && ring[at - 1].ev.cursor > cursor) at -= 1;
    if (at === ring.length) ring.push(entry); else ring.splice(at, 0, entry);
    ringBytes += entry.bytes;
    let evicted = false;
    while (ring.length - ringHead > RING_MAX_EVENTS || ringBytes > RING_MAX_BYTES) {
      const old = ring[ringHead++];
      ringBytes -= old.bytes;
      if (old.ev.cursor > ringFloor) ringFloor = old.ev.cursor;
      evicted = true;
    }
    if (evicted && ringHead > 4096) { ring = ring.slice(ringHead); ringHead = 0; }
  }

  function ringAfter(cursor) {
    // first index with ev.cursor > cursor
    let lo = ringHead; let hi = ring.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ring[mid].ev.cursor > cursor) hi = mid; else lo = mid + 1; }
    return lo;
  }

  // A fragment of a block that was committed as one coalesced event is skipped for a reader whose cursor
  // is before the block began (that reader is sent the coalesced event instead); a reader that already
  // holds the block's start gets the fragments, which is the live stream it was in the middle of.
  const wanted = (entry, after) => !(entry.eph && entry.tok?.committed && after < entry.tok.first);

  // ---- rows, events ------------------------------------------------------------------------------------------------
  function rowToEvent(record) {
    let content;
    try { content = JSON.parse(record.content); } catch (error) {
      logger.error?.(`[store] unreadable content at ${record.conversation_id}:${record.cursor} (kind ${record.kind}): ${error.message}`);
      content = { unreadable: true, kind: record.kind, bytes: String(record.content ?? '').length };
    }
    return {
      contract_version: CONTRACT_VERSION, schema_hash: SCHEMA_HASH, event_id: `${record.conversation_id}:${record.cursor}`,
      conversation_id: record.conversation_id, run_id: record.run_id, cursor: record.cursor, kind: record.kind, content, at: record.at
    };
  }

  const sql = (text, ...params) => reader.db.prepare(text).all(...params).map(rowToEvent);

  function view(st) {
    if (!st?.row) return null;
    let decoded = decodedCache.get(st.row);
    if (!decoded) { decoded = decodeConversation(st.row); decodedCache.set(st.row, decoded); }
    return decoded;
  }

  // ---- the queue to the writer -------------------------------------------------------------------------------------
  const queue = [];              // { record, seq, at, bytes } | { drop, id, reason, seq }
  let queuedRecords = 0;          // waiting to be sent
  let queuedBytes = 0;
  let unackedRecords = 0;         // waiting or in flight: what the bound is on
  let unackedBytes = 0;
  let inflight = null;           // { items, since }
  const waiters = [];            // { seq, resolve }
  const lagMs = [];              // enqueue -> durable and indexed, per record, recent
  const metrics = { acked: 0, batches: 0, failures: 0, restarts: 0, lastAckAt: Date.now(), lastError: null, queueFullRefusals: 0, maxQueueDepth: 0 };
  let closed = false;

  const writerOptions = { root: logRoot, indexPath, ...(options.writerOptions || {}) };
  let inlineWriter = null;
  const transport = typeof options.transport === 'function' ? options.transport : options.transport === 'inline'
    ? (op, ...args) => new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          inlineWriter ||= new LogWriter(writerOptions);
          if (op === 'append') resolve(inlineWriter.append(args[0]));
          else if (op === 'drop') resolve(inlineWriter.drop(args[0], args[1]));
          else if (op === 'probe') resolve(inlineWriter.probe(args[0]));
          else if (op === 'info') resolve(inlineWriter.info());
          else reject(new Error(`no op ${op}`));
        } catch (error) { reject(error); }
      });
    })
    : (op, ...args) => callWriter(op, ...args, writerOptions);

  function enqueue(item, bytes) {
    if (closed) throw new Error('chat log store is closed');
    if (unackedRecords >= QUEUE_MAX_RECORDS || unackedBytes + bytes > QUEUE_MAX_BYTES) {
      metrics.queueFullRefusals += 1;
      throw new QueueFullError(`${unackedRecords} records, ${unackedBytes} bytes`);
    }
    enqueueSeq += 1;
    item.seq = enqueueSeq; item.at = performance.now(); item.bytes = bytes;
    queue.push(item);
    queuedRecords += 1; queuedBytes += bytes;
    unackedRecords += 1; unackedBytes += bytes;
    if (unackedRecords > metrics.maxQueueDepth) metrics.maxQueueDepth = unackedRecords;
    kick();
    return item.seq;
  }

  function settle(upTo, items = []) {
    for (const item of items) { unackedRecords -= 1; unackedBytes -= item.bytes; }
    indexedSeq = Math.max(indexedSeq, upTo);
    while (waiters.length && waiters[0].seq <= indexedSeq) waiters.shift().resolve();
  }

  let retryTimer = null;
  function kick() {
    if (inflight || !queue.length || retryTimer || closed) return;
    const first = queue[0];
    if (first.drop) {
      const item = queue.shift(); queuedRecords -= 1;
      inflight = { items: [item], since: performance.now() };
      transport('drop', item.id, item.reason).then(() => { inflight = null; metrics.failingSince = null; metrics.diskFull = false; settle(item.seq, [item]); kick(); }, (error) => failed(error, [item], true));
      return;
    }
    const items = [];
    while (queue.length && !queue[0].drop && items.length < BATCH_MAX) items.push(queue.shift());
    queuedRecords -= items.length;
    for (const item of items) queuedBytes -= item.bytes;
    inflight = { items, since: performance.now() };
    transport('append', items.map((item) => item.record)).then((ack) => {
      const done = performance.now();
      inflight = null;
      metrics.acked += items.length; metrics.batches += 1; metrics.lastAckAt = Date.now(); metrics.lastAck = ack;
      metrics.failingSince = null; metrics.diskFull = false;
      if (ack?.rejected) { metrics.rejected = (metrics.rejected || 0) + ack.rejected; logger.error?.(`[chatlog] ${ack.rejected} record(s) could not be written and were set aside in chatlog/rejected.jsonl`); }
      for (const item of items) { lagMs.push(done - item.at); }
      if (lagMs.length > LAG_SAMPLES) lagMs.splice(0, lagMs.length - LAG_SAMPLES);
      settle(items[items.length - 1].seq, items);
      kick();
    }, (error) => failed(error, items, false));
  }

  let retryDelay = 50;
  function failed(error, items, isDrop) {
    metrics.failures += 1; metrics.lastError = String(error?.message || error); metrics.lastErrorCode = error?.code || null; metrics.lastErrorAt = Date.now();
    metrics.diskFull = DISK_FULL.test(`${metrics.lastError} ${metrics.lastErrorCode || ''}`);
    metrics.failingSince ??= Date.now();
    logger.error?.(`[chatlog] writer call failed (${metrics.lastError}); re-sending ${items.length} item(s) in ${retryDelay} ms`);
    // Put the batch back at the head, in order. Records are exactly-once on the writer side (n), so a re-send is safe.
    queue.unshift(...items);
    queuedRecords += items.length;
    if (!isDrop) for (const item of items) queuedBytes += item.bytes;
    inflight = null;
    retryTimer = setTimeout(() => { retryTimer = null; metrics.restarts += 1; kick(); }, retryDelay);
    retryTimer.unref?.();
    retryDelay = Math.min(retryDelay * 2, 2_000);
  }
  const resetBackoff = () => { retryDelay = 50; };

  function flush() {
    if (indexedSeq >= enqueueSeq) return Promise.resolve();
    return new Promise((resolve) => { waiters.push({ seq: enqueueSeq, resolve }); kick(); });
  }

  // ---- appending ---------------------------------------------------------------------------------------------------
  function makeEvent(conversationId, runId, cursor, kind, content, at) {
    return {
      contract_version: CONTRACT_VERSION, schema_hash: SCHEMA_HASH, event_id: `${conversationId}:${cursor}`,
      conversation_id: conversationId, run_id: runId, cursor, kind, content, at
    };
  }

  function touch(st) {
    st.touched = performance.now();
    convs.delete(st.id); convs.set(st.id, st);        // most recently used last
  }

  function pushTail(st, ev, seq, bytes) {
    // Sorted by cursor: a coalesced block commit carries the cursor of its first fragment.
    const entry = { ev, seq, bytes };
    let at = st.tail.length;
    while (at > 0 && st.tail[at - 1].ev.cursor > ev.cursor) at -= 1;
    if (at === st.tail.length) st.tail.push(entry); else st.tail.splice(at, 0, entry);
    st.tailBytes += bytes;
    trimTail(st, TAIL_MAX_BYTES);
  }

  let tailTotal = 0;
  function trimTail(st, cap) {
    // Only what the index already holds may leave memory.
    let dropped = 0;
    while (st.tailBytes > cap && st.tail.length > 1 && st.tail[0].seq <= indexedSeq) {
      const old = st.tail.shift();
      st.tailBytes -= old.bytes; dropped += old.bytes;
      st.tailFrom = Math.max(st.tailFrom, old.ev.cursor + 1);
      st.complete = false;
    }
    return dropped;
  }

  function trimAllTails() {
    let total = 0;
    for (const st of convs.values()) total += st.tailBytes;
    tailTotal = total;
    if (total <= TAIL_TOTAL_BYTES) return;
    for (const st of convs.values()) {                 // least recently used first (Map order)
      if (tailTotal <= TAIL_TOTAL_BYTES * 0.75) break;
      tailTotal -= trimTail(st, 0);
    }
  }

  function memoryFold(st, ev, bytes, seq, { persisted }) {
    if (persisted) {
      if (ev.kind === 'message.user' && owesAnswer(ev.content)) st.owed.push({ cursor: ev.cursor, text: ev.content.text, itemId: ev.content.itemId });
      if (ev.kind === 'run.status' || ev.kind === 'run.completed' || ev.kind === 'run.cancelled' || ev.kind === 'run.error') st.runs += 1;
      if (TERMINAL_KINDS.has(ev.kind)) {
        st.ended = Math.max(st.ended, ev.cursor);
        if (discharges(ev.kind, ev.content)) { st.lastDischarge = ev.cursor; st.owed = []; }
      }
    }
    if (st.row) st.row = projectEvent(st.row, ev);
  }

  /** Queue one event record; returns its sequence number in the conversation. */
  function queueRecord(st, ev, flags = {}) {
    if (typeof ev.conversation_id !== 'string' || !ev.conversation_id) throw new TypeError('an event needs a conversation id');
    const bytes = byteSize(JSON.stringify(ev.content)) + 160;
    st.lastN += 1;
    const record = { i: ev.conversation_id, n: st.lastN, c: ev.cursor, k: ev.kind, r: ev.run_id ?? null, t: ev.at, d: ev.content, ...flags };
    try { enqueue({ record }, bytes); } catch (error) { st.lastN -= 1; throw error; }
    return bytes;
  }

  const committer = new FragmentCommitter({
    commit: (convId, block) => {
      const st = stateFor(convId);
      const ev = makeEvent(convId, block.runId, block.cursor, block.kind, clone(block.content), block.at);
      // `co`: committed late, at its first fragment's cursor and time. The persisted row folds it (the
      // memory row already folded the fragments themselves).
      const bytes = queueRecord(st, ev, { co: 1, cl: block.last });
      pushTail(st, ev, enqueueSeq, bytes);
      ringInsert({ ev, eph: false, tok: null, bytes });
    },
    onError: (error, convId) => logger.error?.(`[chatlog] could not commit a coalesced ${convId} block: ${error?.message || error}`)
  });

  function notify(event) {
    for (const listener of listeners) {
      try { listener(event); } catch (cause) { logger.error?.(`[store] subscriber threw on ${event.kind} for ${event.conversation_id}:`, cause); }
    }
  }

  // `cursor` is given only by the shadow phase, where the legacy store assigned it and this store mirrors it.
  const useCursor = (given) => {
    if (given === undefined) return allocate();
    if (given > head) { if (given + 1 > reserved) reserve(given + RESERVE_BLOCK); head = given; }
    return given;
  };

  function appendEvent(conversationId, kind, content = {}, { runId = null, at = now(), cursor: given } = {}) {
    if (!EVENT_KINDS.includes(kind)) throw new TypeError(`Unsupported event kind: ${kind}`);
    conversationId = asId(conversationId);
    const body = clone(content);
    const st = stateFor(conversationId);
    touch(st);
    if (FRAGMENT_KINDS.has(kind)) {
      const cursor = useCursor(given);
      const ev = makeEvent(conversationId, runId, cursor, kind, body, at);
      if (st.row) st.row = projectEvent(st.row, ev);
      const block = committer.fragment(conversationId, ev);
      const bytes = byteSize(JSON.stringify(body)) + 160;
      const entry = { ev, eph: true, tok: block.token, bytes };
      ringInsert(entry);
      st.frags.push(entry);
      if (st.frags.length > 4000) st.frags = st.frags.filter((f) => !f.tok.closed);
      notify(ev);
      return ev;
    }
    committer.committed(conversationId, { kind, content: body });
    const cursor = useCursor(given);
    const ev = makeEvent(conversationId, runId, cursor, kind, body, at);
    const bytes = queueRecord(st, ev);
    memoryFold(st, ev, bytes, enqueueSeq, { persisted: true });
    pushTail(st, ev, enqueueSeq, bytes);
    ringInsert({ ev, eph: false, tok: null, bytes });
    if (st.frags.length) st.frags = st.frags.filter((f) => !f.tok.closed);
    notify(ev);
    return ev;
  }

  function queueControl(given, kind, data, at = now()) {
    const id = asId(given);
    const st = stateFor(id);
    st.lastN += 1;
    const record = { i: id, n: st.lastN, k: kind, t: at, d: data };
    try { enqueue({ record }, byteSize(JSON.stringify(data)) + 120); } catch (error) { st.lastN -= 1; throw error; }
  }

  // ---- reads: events -----------------------------------------------------------------------------------------------
  function openFragments(st, after, before) {
    return st.frags.filter((f) => !f.tok.closed && f.ev.cursor > after && f.ev.cursor < before).map((f) => f.ev);
  }

  /** Load the newest TAIL_LOAD events below the tail from the index (a cold conversation's first read). */
  function loadTail(st) {
    if (st.complete) return;
    const rows = reader.db.prepare('SELECT * FROM (SELECT * FROM events WHERE conversation_id = ? AND cursor < ? ORDER BY cursor DESC LIMIT ?) ORDER BY cursor')
      .all(st.id, st.tailFrom, TAIL_LOAD);
    const have = new Set(st.tail.map((e) => e.ev.cursor));
    const older = [];
    for (const r of rows) if (!have.has(r.cursor)) older.push({ ev: rowToEvent(r), seq: 0, bytes: r.content.length + 160 });
    st.tail = [...older, ...st.tail];
    for (const o of older) st.tailBytes += o.bytes;
    if (rows.length < TAIL_LOAD) { st.complete = true; st.tailFrom = 0; } else st.tailFrom = rows[0].cursor;
    trimAllTails();
  }

  function eventsOf(id, { after = 0, before = null, limit = 20000, newest = false } = {}) {
    const st = convs.get(id);
    const ceiling = before == null ? Number.MAX_SAFE_INTEGER : before;
    if (!st) return sqlRange(id, after, ceiling, limit, newest || before != null);
    touch(st);
    const tailEvents = () => st.tail.filter((e) => e.ev.cursor > after && e.ev.cursor < ceiling).map((e) => e.ev);
    const merge = (indexed, mem) => {
      const seen = new Set(); const out = [];
      for (const e of [...indexed, ...mem]) if (!seen.has(e.cursor)) { seen.add(e.cursor); out.push(e); }
      out.sort((a, b) => a.cursor - b.cursor);
      return out;
    };
    const frags = openFragments(st, after, ceiling);
    if (!newest && before == null) {
      let mem = tailEvents();
      let events;
      if (st.complete || after + 1 >= st.tailFrom) events = merge([], [...mem, ...frags]);
      else events = merge(sqlRange(id, after, Math.min(ceiling, st.tailFrom), limit, false), [...mem, ...frags]);
      return events.slice(0, limit);
    }
    let mem = merge([], [...tailEvents(), ...frags]);
    if (mem.length >= limit || st.complete || after + 1 >= st.tailFrom) return mem.slice(Math.max(0, mem.length - limit));
    const upper = Math.min(ceiling, st.tailFrom);
    const older = upper > after + 1 ? sqlRange(id, after, upper, limit - mem.length, true) : [];
    const events = merge(older, mem);
    return events.slice(Math.max(0, events.length - limit));
  }

  function sqlRange(id, after, ceiling, limit, newest) {
    if (!newest) {
      return sql('SELECT * FROM events WHERE conversation_id = ? AND cursor > ? AND cursor < ? ORDER BY cursor LIMIT ?', id, after, ceiling, limit);
    }
    return sql('SELECT * FROM (SELECT * FROM events WHERE conversation_id = ? AND cursor > ? AND cursor < ? ORDER BY cursor DESC LIMIT ?) ORDER BY cursor', id, after, ceiling, limit);
  }

  function sinceCursor(cursor, limit = 2000, upTo = Number.MAX_SAFE_INTEGER) {
    const out = [];
    if (cursor < ringFloor) {
      const stop = Math.min(ringFloor, upTo);
      for (const e of sql('SELECT * FROM events WHERE cursor > ? AND cursor <= ? ORDER BY cursor LIMIT ?', cursor, stop, limit)) out.push(e);
      if (out.length >= limit) return out;
    }
    for (let at = ringAfter(Math.max(cursor, ringFloor)); at < ring.length && out.length < limit; at += 1) {
      const entry = ring[at];
      if (entry.ev.cursor > upTo) break;
      if (wanted(entry, cursor)) out.push(entry.ev);
    }
    return out;
  }

  /** Newest `limit` events of the given kinds, from the index and the tail together. */
  function ofKinds(id, kinds, { limit, newest }) {
    const holes = kinds.map(() => '?').join(',');
    const indexed = newest
      ? sql(`SELECT * FROM (SELECT * FROM events WHERE conversation_id = ? AND kind IN (${holes}) ORDER BY cursor DESC LIMIT ?) ORDER BY cursor`, id, ...kinds, limit)
      : sql(`SELECT * FROM events WHERE conversation_id = ? AND kind IN (${holes}) ORDER BY cursor LIMIT ?`, id, ...kinds, limit);
    const st = convs.get(id);
    const fresh = st ? st.tail.filter((e) => kinds.includes(e.ev.kind)).map((e) => e.ev) : [];
    const seen = new Set(); const merged = [];
    for (const e of [...indexed, ...fresh]) if (!seen.has(e.cursor)) { seen.add(e.cursor); merged.push(e); }
    merged.sort((a, b) => a.cursor - b.cursor);
    return newest ? merged.slice(Math.max(0, merged.length - limit)) : merged.slice(0, limit);
  }

  // ---- the probe ---------------------------------------------------------------------------------------------------
  let lastProbe = null;
  let probing = null;
  async function probe() {
    if (probing) return probing;
    const started = performance.now();
    const startedWall = Date.now();
    probing = (async () => {
      const token = `${process.pid}-${startedWall}`;
      const result = { at: startedWall, ok: false };
      try {
        // 1. queue + writer thread + log fsync + index commit, on throwaway data.
        const writerSide = await transport('probe', token);
        result.queueAndWriteMs = +(performance.now() - started).toFixed(2);
        result.writer = { logMs: +writerSide.logMs.toFixed(2), indexMs: +writerSide.indexMs.toFixed(2), readMs: +writerSide.readMs.toFixed(2) };
        // 2. the read-only connection sees what the writer committed.
        const t = performance.now();
        const seen = reader.db.prepare("SELECT v FROM index_meta WHERE k = 'probe'").get()?.v;
        result.readerMs = +(performance.now() - t).toFixed(2);
        result.readerSees = seen === token;
        // 3. a stream round trip: a synthetic event through the subscriber path.
        const t2 = performance.now();
        let delivered = false;
        const hear = (event) => { if (event.kind === 'run.status' && event.conversation_id === '\u0000probe') delivered = true; };
        listeners.add(hear);
        notify(makeEvent('\u0000probe', null, 0, 'run.status', { state: 'idle' }, now()));
        listeners.delete(hear);
        result.streamMs = +(performance.now() - t2).toFixed(3);
        result.streamDelivered = delivered;
        result.ok = Boolean(writerSide.ok && result.readerSees && delivered);
      } catch (error) { result.error = String(error?.message || error); }
      result.ms = +(performance.now() - started).toFixed(2);
      lastProbe = result;
      return result;
    })().finally(() => { probing = null; });
    return probing;
  }

  // Start the writer thread now, while the rest of the server boots, so the first events do not wait for it to open.
  if (options.warm !== false && options.transport !== 'inline' && typeof options.transport !== 'function') setImmediate(() => { transport('info').catch(() => {}); });

  const probeEvery = options.probeEveryMs ?? PROBE_EVERY_MS;
  let probeTimer = null;
  if (probeEvery > 0) { setImmediate(() => probe().catch(() => {})); probeTimer = setInterval(() => { probe().catch(() => {}); }, probeEvery); probeTimer.unref?.(); }

  function health() {
    const sorted = [...lagMs].sort((a, b) => a - b);
    const t = performance.now();
    const oldestQueued = queue.length ? t - queue[0].at : 0;
    const inflightAge = inflight ? t - inflight.since : 0;
    const probeAge = lastProbe ? Date.now() - lastProbe.at : null;
    const stalled = inflightAge > 5_000 || oldestQueued > 5_000;
    const probeStale = probeEvery > 0 && probeAge != null && probeAge > probeEvery * 4 + 10_000;
    const probeOk = lastProbe ? lastProbe.ok : true;
    const failing = Boolean(retryTimer) || metrics.failingSince != null;
    const ok = !stalled && !probeStale && probeOk && unackedRecords < QUEUE_MAX_RECORDS * 0.5 && !failing;
    // Why it is not ok, in words, and whether restarting the server could possibly help. It cannot when the disk is
    // full: a restart only throws away the events still queued in memory, so the watchdog must not do it.
    let reason = null;
    let restartHelps = true;
    if (failing && metrics.diskFull) { reason = `the disk is full: ${unackedRecords} event(s) are held in memory and the writer keeps retrying (${metrics.lastError})`; restartHelps = false; }
    else if (failing) reason = `the log writer is failing and retrying: ${metrics.lastError}`;
    else if (stalled) reason = `the log writer has not answered for ${Math.round(Math.max(inflightAge, oldestQueued))} ms`;
    else if (probeStale) reason = 'the store probe has stopped running';
    else if (!probeOk) reason = `the store probe failed: ${lastProbe?.error || 'a layer did not round-trip'}`;
    else if (!ok) reason = `the writer queue is over half full (${unackedRecords} of ${QUEUE_MAX_RECORDS})`;
    return {
      ok: Boolean(ok), reason, restartHelps, diskFull: Boolean(failing && metrics.diskFull), mode: 'log', head, reserved, ringFloor, ringEvents: ring.length - ringHead, ringBytes,
      queue: { records: unackedRecords, waiting: queuedRecords, bytes: unackedBytes, oldestMs: Math.round(oldestQueued), inflightMs: Math.round(inflightAge), max: QUEUE_MAX_RECORDS },
      writer: { acked: metrics.acked, batches: metrics.batches, failures: metrics.failures, lastError: metrics.lastError, lastAckAgeMs: Date.now() - metrics.lastAckAt, retrying: Boolean(retryTimer) },
      lagMs: { n: sorted.length, p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99), max: sorted.length ? sorted[sorted.length - 1] : null },
      probe: lastProbe, probeAgeMs: probeAge, conversations: convs.size
    };
  }

  // ---- the interface -----------------------------------------------------------------------------------------------
  const findFf = stateDb.prepare('SELECT * FROM ff_messages WHERE at >= ? ORDER BY id');

  const store = {
    mode: 'log',
    db: stateDb,                       // the small non-event state (auth, ff, reading, scope moves and rules)
    logRoot, indexPath, statePath,
    flush, probe, health, metrics: () => ({ ...metrics, lagMs: [...lagMs] }),
    reserved: () => reserved,
    indexedMax,                        // the highest cursor the index held at boot
    ingestedThrough,                   // the highest legacy cursor (fragments included) the log has taken in, at boot
    committer,
    get reader() { return reader; },
    reopenReader() { reader.close(); reader = ChatIndex.openReadOnly(indexPath); },

    async close() {
      committer.flushAll();
      await Promise.race([flush(), new Promise((resolve) => { const t = setTimeout(resolve, options.closeTimeoutMs ?? 10_000); t.unref?.(); })]);
      closed = true;
      if (probeTimer) clearInterval(probeTimer);
      try { await Promise.race([transport('close'), new Promise((resolve) => { const t = setTimeout(resolve, options.closeTimeoutMs ?? 10_000); t.unref?.(); })]); } catch { /* inline has no close */ }
      if (inlineWriter) { inlineWriter.close(); inlineWriter = null; }
      reader.close();
      stateDb.close();
      // A clean shutdown tells the next boot where the cursors really stopped, so restarts do not skip a block.
      if (indexedSeq >= enqueueSeq) { try { reserve(head); } catch { /* the block stays reserved: the next boot starts above it */ } }
    },

    /** Shut the writer down cleanly without closing reads (a SIGTERM drain). */
    async drain() { committer.flushAll(); await flush(); },

    appliedAction(actionId) { return applied.get(actionId); },

    markApplied({ actionId, conversationId, op, cursorBefore, cursorAfter }) {
      if (applied.has(actionId)) return;
      // The legacy INSERT OR IGNORE silently dropped a receipt with no conversation (NOT NULL); a number is its text.
      let id;
      try { id = asId(conversationId); } catch { return; }
      const at = now();
      applied.set(actionId, { action_id: actionId, conversation_id: id, op, cursor_before: cursorBefore, cursor_after: cursorAfter, at });
      queueControl(id, '$applied', { actionId, op, cursorBefore, cursorAfter, at }, at);
    },

    between(cursorBefore, cursorAfter) { return sinceCursor(cursorBefore, Number.MAX_SAFE_INTEGER, cursorAfter); },

    cursor() { return head; },

    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    ensureConversation(given, { at, cwd = null, settings = {}, parentId = null, forkedFrom = null, title = 'New chat', source = 'webchat', sidechat = null, scope = null } = {}) {
      const id = asId(given);
      const st = stateFor(id);
      if (!st.row) {
        const fields = { at, cwd, settings: normalizeSettings(settings), parentId, forkedFrom, title, source, sidechat, scope };
        st.row = blankConversation(id, fields);
        queueControl(id, '$conv', fields, at);
      } else {
        const patch = {};
        if (scope && st.row.scope == null) patch.scope = scope;
        if (sidechat && st.row.sidechat == null) patch.sidechat = sidechat;
        if (Object.keys(patch).length) { st.row = projectSet(st.row, patch); queueControl(id, '$set', patch, at); }
      }
      return { ...st.row };
    },

    sidechatsOf(parentId) {
      return [...convs.values()].filter((st) => st.row && st.row.parent_id === parentId && st.row.sidechat != null)
        .sort((a, b) => (a.row.created_at < b.row.created_at ? -1 : a.row.created_at > b.row.created_at ? 1 : 0)).map(view);
    },

    markSpliced(id, cursor, { at = now() } = {}) {
      return this.append(id, 'conversation.meta', { splicedThrough: cursor }, { at });
    },

    append: appendEvent,

    backfillScope(scope) {
      let n = 0;
      for (const st of convs.values()) {
        if (st.row && st.row.scope == null) { st.row = projectSet(st.row, { scope }); queueControl(st.id, '$set', { scope }); n += 1; }
      }
      return n;
    },

    conversationIdsInScope(scope) { return [...convs.values()].filter((st) => st.row && st.row.scope === scope).map((st) => st.id); },

    conversationDigest(id) {
      const hash = createHashLazy();
      let count = 0;
      for (const event of this.allConversationEvents(id)) {
        if (event.kind === 'conversation.meta' && event.content?.scopeMove) continue;
        hash.update(JSON.stringify([event.kind, event.content, event.at, event.run_id ?? null]));
        hash.update('\n');
        count += 1;
      }
      return { count, hash: hash.digest('hex') };
    },

    exportConversation(id) {
      const st = convs.get(id);
      if (!st?.row) return null;
      const events = [];
      for (const event of this.allConversationEvents(id)) {
        if (event.kind === 'conversation.meta' && event.content?.scopeMove) continue;
        events.push({ kind: event.kind, content: event.content, at: event.at, run_id: event.run_id ?? null });
      }
      return { row: { ...st.row }, events, digest: this.conversationDigest(id) };
    },

    importConversation(bundle, { scope }) {
      const id = bundle?.row?.id;
      if (!id) throw new TypeError('A bundle needs a conversation row');
      if (convs.get(id)?.row) throw new Error(`conversation ${id} already exists in this store`);
      const row = { ...blankConversation(id), ...bundle.row, ...(scope !== undefined ? { scope } : {}) };
      const st = stateFor(id);
      st.row = row;
      queueControl(id, '$snapshot', { row }, row.created_at);
      for (const event of bundle.events) {
        const cursor = allocate();
        const ev = makeEvent(id, event.run_id ?? null, cursor, event.kind, clone(event.content), event.at);
        const bytes = queueRecord(st, ev, { np: 1 });
        pushTail(st, ev, enqueueSeq, bytes);
        ringInsert({ ev, eph: false, tok: null, bytes });
      }
      return this.conversationDigest(id);
    },

    /** Shadow phase: a conversation the legacy store imported, mirrored with the legacy cursors. */
    mirrorConversation(row, events) {
      const id = row.id;
      const st = stateFor(id);
      st.row = { ...blankConversation(id), ...row };
      queueControl(id, '$snapshot', { row: st.row }, row.created_at);
      for (const event of events) {
        const ev = makeEvent(id, event.run_id ?? null, useCursor(event.cursor), event.kind, clone(event.content), event.at);
        const bytes = queueRecord(st, ev, { np: 1 });
        pushTail(st, ev, enqueueSeq, bytes);
        ringInsert({ ev, eph: false, tok: null, bytes });
      }
    },

    deleteConversation(id) {
      committer.forget(id);
      const st = convs.get(id);
      // Records not yet sent for this conversation are void; the drop is queued in order behind what is in flight.
      for (let at = queue.length - 1; at >= 0; at -= 1) {
        if (queue[at].record?.i === id) { queuedRecords -= 1; queuedBytes -= queue[at].bytes; unackedRecords -= 1; unackedBytes -= queue[at].bytes; queue.splice(at, 1); }
      }
      convs.delete(id);
      for (const [key, row] of applied) if (row.conversation_id === id) applied.delete(key);
      ring = ring.slice(ringHead).filter((entry) => entry.ev.conversation_id !== id);
      ringHead = 0;
      ringBytes = ring.reduce((n, entry) => n + entry.bytes, 0);
      stateDb.prepare('DELETE FROM reading WHERE conversation_id = ?').run(id);
      enqueue({ drop: true, id, reason: 'deleteConversation' }, 64);
      void st;
    },

    beginScopeMove({ moveId, conversationId, from, to, actor, account = null, reason = null, at = now() }) {
      stateDb.prepare(`INSERT OR IGNORE INTO scope_moves (move_id, conversation_id, from_scope, to_scope, actor, account, state, reason, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`).run(moveId, conversationId, from, to, actor, account, reason, at);
      return this.scopeMove(moveId);
    },
    scopeMoveStep(moveId, step, detail = null, at = now()) {
      const current = stateDb.prepare('SELECT steps FROM scope_moves WHERE move_id = ?').get(moveId);
      if (!current) return;
      const steps = JSON.parse(current.steps);
      steps.push({ step, at, ...(detail ? { detail } : {}) });
      stateDb.prepare('UPDATE scope_moves SET steps = ? WHERE move_id = ?').run(JSON.stringify(steps), moveId);
    },
    finishScopeMove(moveId, { state, count = null, digest = null, at = now() }) {
      stateDb.prepare('UPDATE scope_moves SET state = ?, events_count = ?, digest = ?, finished_at = ? WHERE move_id = ?').run(state, count, digest, at, moveId);
    },
    scopeMove(moveId) { const r = stateDb.prepare('SELECT * FROM scope_moves WHERE move_id = ?').get(moveId); return r ? decodeMove(r) : null; },
    scopeMoves(conversationId = null) {
      const rows = conversationId
        ? stateDb.prepare('SELECT * FROM scope_moves WHERE conversation_id = ? ORDER BY started_at, rowid').all(conversationId)
        : stateDb.prepare('SELECT * FROM scope_moves ORDER BY started_at, rowid').all();
      return rows.map(decodeMove);
    },
    scopeRules(account) { return stateDb.prepare('SELECT prompt FROM scope_rules WHERE account = ?').get(account)?.prompt ?? null; },
    setScopeRules(account, prompt, at = now()) {
      if (!prompt) { stateDb.prepare('DELETE FROM scope_rules WHERE account = ?').run(account); return; }
      stateDb.prepare(`INSERT INTO scope_rules (account, prompt, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(account) DO UPDATE SET prompt = excluded.prompt, updated_at = excluded.updated_at`).run(account, prompt, at);
    },

    setSettings(id, settings) {
      const st = convs.get(id);
      const merged = normalizeSettings(settings, JSON.parse(st?.row?.settings || '{}'));
      if (st?.row) { st.row = projectSet(st.row, { settings: merged }); queueControl(id, '$set', { settings: merged }); }
      return merged;
    },

    ffAccept(text, at = now()) { return Number(stateDb.prepare('INSERT INTO ff_messages (text, at, state) VALUES (?, ?, ?)').run(text, at, 'routing').lastInsertRowid); },
    ffSettle(id, { state, conversationId = null, title = null, reason = null, error = null }) {
      stateDb.prepare('UPDATE ff_messages SET state = ?, conversation_id = ?, title = ?, reason = ?, error = ? WHERE id = ?').run(state, conversationId, title, reason, error, id);
    },
    markReading({ conversationId, itemId = null, ratio = 0, deviceId, at }) {
      if (!conversationId || !deviceId) return;
      stateDb.prepare(`INSERT INTO reading (conversation_id, item_id, ratio, device_id, at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET item_id = excluded.item_id, ratio = excluded.ratio, device_id = excluded.device_id, at = excluded.at
        WHERE excluded.at > reading.at`).run(conversationId, itemId, Number(ratio) || 0, deviceId, at);
    },
    reading(limit = 200) {
      return stateDb.prepare('SELECT * FROM reading ORDER BY at DESC LIMIT ?').all(limit).map((r) => ({ conversationId: r.conversation_id, itemId: r.item_id, ratio: r.ratio, deviceId: r.device_id, at: r.at }));
    },
    ffSince(at = '') {
      return findFf.all(at).map((r) => ({ id: r.id, text: r.text, at: r.at, state: r.state, conversationId: r.conversation_id, title: r.title, reason: r.reason, error: r.error }));
    },
    ffRecent(limit = 6) {
      return stateDb.prepare("SELECT * FROM ff_messages WHERE state = 'sent' ORDER BY id DESC LIMIT ?").all(limit).reverse()
        .map((r) => ({ text: r.text, conversationId: r.conversation_id, title: r.title }));
    },

    unfinished({ within = 24 * 3_600_000, now: clock = Date.now(), cap = RESUME_CAP, includeIds = false } = {}) {
      const out = [];
      for (const conversation of this.conversations()) {
        if (clock - Date.parse(conversation.updatedAt || 0) > within) continue;
        const st = convs.get(conversation.id);
        const owed = st?.owed || [];
        if (!owed.length) continue;
        if (owed.length > cap) {
          logger.error?.(`[store] ${conversation.id} has ${owed.length} unanswered messages and no ending;`
            + ` re-asking the newest ${cap}. A log with no terminal event reads this way.`);
        }
        const take = Number.isFinite(cap) ? owed.slice(Math.max(0, owed.length - Math.trunc(cap))) : owed;
        for (const item of take) out.push(includeIds ? { id: conversation.id, text: item.text, itemId: item.itemId } : { id: conversation.id, text: item.text });
      }
      return out;
    },

    runMarkers() {
      const out = new Map();
      for (const st of convs.values()) if (st.runs) out.set(st.id, { runs: st.runs, ended: st.ended || 0 });
      return out;
    },

    conversation(id) { return view(convs.get(id)); },

    conversationBySession(sessionId) {
      if (!sessionId) return null;
      let best = null;
      for (const st of convs.values()) {
        if (st.row?.session_id === String(sessionId) && (!best || st.row.updated_at > best.row.updated_at)) best = st;
      }
      return view(best);
    },

    conversations({ since = null } = {}) {
      const rows = [...convs.values()].filter((st) => st.row && (!since || st.row.updated_at >= since));
      rows.sort((a, b) => (a.row.updated_at < b.row.updated_at ? 1 : a.row.updated_at > b.row.updated_at ? -1 : 0));
      return rows.map(view);
    },

    since(cursor, limit = 2000) { return sinceCursor(cursor, limit); },

    *allConversationEvents(id, { after = 0, page = 20000 } = {}) {
      let cursor = after;
      for (;;) {
        const batch = this.conversationEvents(id, { after: cursor, limit: page });
        for (const event of batch) yield event;
        if (batch.length < page) return;
        cursor = batch[batch.length - 1].cursor;
      }
    },

    conversationEvents(id, options = {}) {
      const st = convs.get(id);
      if (st && !st.complete && st.tail.length < TAIL_LOAD && (options.newest || options.before != null)) loadTail(st);
      return eventsOf(id, options);
    },

    acceptedMessage(id, itemId) {
      const st = convs.get(id);
      if (st) for (let at = st.tail.length - 1; at >= 0; at -= 1) {
        const ev = st.tail[at].ev;
        if (ev.kind === 'message.user' && ev.content?.itemId === itemId) return ev;
      }
      if (st?.complete) return null;
      const r = reader.db.prepare("SELECT * FROM events WHERE conversation_id = ? AND kind = 'message.user' AND json_extract(content, '$.itemId') = ? ORDER BY cursor DESC LIMIT 1").get(id, itemId);
      return r ? rowToEvent(r) : null;
    },

    evaluationStatus(id, itemId) {
      const st = convs.get(id);
      if (st) for (let at = st.tail.length - 1; at >= 0; at -= 1) {
        const ev = st.tail[at].ev;
        if (ev.kind === 'evaluation.snapshot' && ev.content?.messageId === itemId) return ev;
      }
      if (st?.complete) return null;
      const r = reader.db.prepare("SELECT * FROM events WHERE conversation_id = ? AND kind = 'evaluation.snapshot' AND json_extract(content, '$.messageId') = ? ORDER BY cursor DESC LIMIT 1").get(id, itemId);
      return r ? rowToEvent(r) : null;
    },

    conversationProse(id, { limit = 4000 } = {}) { return ofKinds(id, ['message.user', 'assistant.message'], { limit, newest: false }); },

    /** The newest `limit` events of the named kinds, newest first (what handlers used to ask the events table). */
    recentOfKinds(id, kinds, limit) { return ofKinds(id, kinds, { limit, newest: true }).reverse(); },

    /** Every session id a conversation's meta events ever recorded. */
    sessionIdsOf(id) {
      const ids = new Set();
      for (const ev of ofKinds(id, ['conversation.meta'], { limit: 1_000_000, newest: false })) if (ev.content?.sessionId) ids.add(String(ev.content.sessionId));
      return [...ids];
    },

    conversationIdsWithPrefix(prefix) { return [...convs.values()].filter((st) => st.row && st.id.startsWith(prefix)).map((st) => st.id); },

    recent({ since, hydrate = 8, tail = 100, bytesPerConversation = 150_000 }) {
      const conversations = this.conversations({ since });
      const events = [];
      for (const conversation of conversations.slice(0, hydrate)) {
        const settled = this.conversationEvents(conversation.id, { newest: true, limit: tail + 50 }).filter((event) => event.kind !== 'tool.input_delta');
        const taken = [];
        let bytes = 0;
        for (let at = settled.length - 1; at >= 0 && taken.length < tail; at -= 1) {
          const size = JSON.stringify(settled[at]).length;
          if (bytes + size > bytesPerConversation && taken.length) break;
          taken.push(settled[at]);
          bytes += size;
        }
        events.push(...taken.reverse());
      }
      events.sort((a, b) => a.cursor - b.cursor);
      return { conversations, events, cursor: this.cursor() };
    },

    expand(query, opts) { return expandIndex(reader.db, query, opts); },
    search(query, opts) { return searchIndex(reader.db, query, opts); },
    // The same, on a worker thread: what request handlers call (a smart search is 0.5-1.9 s of CPU).
    searchAsync(query, opts) { return options.transport === 'inline' || typeof options.transport === 'function' ? Promise.resolve(searchIndex(reader.db, query, opts)) : searchService('search', indexPath, query, opts); },
    expandAsync(query, opts) { return options.transport === 'inline' || typeof options.transport === 'function' ? Promise.resolve(expandIndex(reader.db, query, opts)) : searchService('expand', indexPath, query, opts); }
  };

  /**
   * Apply `chatlog.replay.jsonl` once, at boot, before anything is served: one JSON object per line, `{op:'ensure', id,
   * at, cwd, title, settings}` or `{op:'event', id, key, kind, at, content}`. Each event is keyed (`replay:<key>`, an
   * applied-action receipt), so a file applied twice, or half applied before a crash, adds nothing the second time.
   * This is how a chat the webchat lost is put back from another record of it (scripts/chatlog-recover-from-memory.mjs);
   * it goes through append() like any write, so the log, the index and the projections all hear of it. The file is
   * renamed `.applied-<time>` when done and its outcome written beside it.
   */
  function replayPending() {
    const file = options.replayFile ?? path.join(dir, 'chatlog.replay.jsonl');
    if (!fs.existsSync(file)) return null;
    const result = { events: 0, skipped: 0, conversations: 0, errors: [] };
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.op === 'ensure') {
          if (!convs.get(asId(o.id))?.row) { store.ensureConversation(o.id, { at: o.at, cwd: o.cwd ?? null, settings: o.settings || {}, title: o.title || 'New chat' }); result.conversations += 1; }
        } else if (o.op === 'event') {
          const key = `replay:${o.key}`;
          if (applied.has(key)) { result.skipped += 1; continue; }
          store.append(o.id, o.kind, o.content || {}, { at: o.at, runId: o.runId ?? null });
          store.markApplied({ actionId: key, conversationId: o.id, op: 'replay', cursorBefore: 0, cursorAfter: head });
          result.events += 1;
        } else result.errors.push(`unknown op in: ${line.slice(0, 80)}`);
      } catch (error) { result.errors.push(`${error?.message || error}: ${line.slice(0, 80)}`); }
    }
    const stamp = new Date().toISOString().replace(/[-:.]/gu, '');
    fs.writeFileSync(`${file}.result-${stamp}.json`, JSON.stringify(result, null, 1));
    fs.renameSync(file, `${file}.applied-${stamp}`);
    logger.log?.(`[chatlog] replayed ${file}: ${JSON.stringify({ ...result, errors: result.errors.length })}`);
    return result;
  }

  // Tails are trimmed on a timer too: an idle server's memory follows its index.
  const trimTimer = setInterval(() => { try { trimAllTails(); } catch { /* best effort */ } }, 15_000);
  trimTimer.unref?.();
  store.replay = replayPending();
  const baseClose = store.close;
  store.close = async () => { clearInterval(trimTimer); resetBackoff(); return baseClose.call(store); };
  return store;
}

function createHashLazy() { return createHash('sha256'); }
