// The one writer of the chat log and its index.
//
// Everything that reaches disk for chat events goes through this module's LogWriter, on one thread:
// the request path (log-store.js) only queues records and reads memory. Per batch the writer
//   1. appends the records to their conversations' log segments,
//   2. fsyncs those segments (the batch is durable here: this is the acknowledgement),
//   3. folds the same records into the derived index in one SQLite transaction,
// and reports how long each step took. A crash between 2 and 3 leaves the log ahead of the index by
// at most one batch; catchUp() (chat-index.js) closes that gap at the next boot from log_pos.
//
// Thread: a worker started by defineService (offload.js), the same arrangement interaction.js uses
// for its SQLite connection. A worker, not a process, because the batches are small and frequent
// (a structured clone per batch is cheaper than a socket round trip and a second runtime), the
// single-writer property comes free from the worker's one message queue, and the bundled chunk
// carries the code, so nothing extra has to be published. A worker that dies is started again by the
// next call and the main thread re-sends the batch it had not heard back on; the log's per-conversation
// sequence numbers make that exactly-once.
//
// Test seams (environment, read by the worker): WEBCHAT_LOG_FSYNC_DELAY_MS slows every fsync (a
// stalled disk); WEBCHAT_LOG_CRASH_AFTER_LOG_ONCE=1 makes the worker exit between steps 2 and 3
// once, to prove the catch-up.

import fs from 'node:fs';
import path from 'node:path';
import { LogDir } from './chatlog.js';
import { ChatIndex, catchUp } from './chat-index.js';
import { defineService } from './offload.js';

const delay = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// A log has one writer. Two processes appending to the same conversation would each number their records
// from their own memory and silently interleave duplicates, so ownership is claimed in `root/WRITER`
// (pid and an instance token) and a live owner other than this instance refuses the claim. It is not a
// mutex around the work (there is none): it is the single-writer contract made checkable, taken once
// at open and released at close; a dead owner's claim is taken over.
const owners = new Map();      // root -> token, for instances inside this process

function claim(root) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'WRITER');
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8').trim(); } catch { /* unclaimed */ }
  if (existing) {
    const pid = Number(existing.split(':')[0]);
    const mine = pid === process.pid;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
    if (alive && (!mine || owners.get(root) === existing)) {
      throw Object.assign(new Error(`the chat log at ${root} is being written by pid ${pid}; one writer at a time`), { code: 'CHATLOG_OWNED' });
    }
  }
  fs.writeFileSync(file, token);
  owners.set(root, token);
  return { file, token };
}

function release(root, held) {
  try { if (fs.readFileSync(held.file, 'utf8').trim() === held.token) fs.rmSync(held.file); } catch { /* gone */ }
  if (owners.get(root) === held.token) owners.delete(root);
}

export class LogWriter {
  constructor({ root, indexPath, fsyncDelayMs = Number(process.env.WEBCHAT_LOG_FSYNC_DELAY_MS || 0), segmentBytes, seams } = {}) {
    this.root = root;
    this.indexPath = indexPath;
    this.held = claim(root);
    const fsync = fsyncDelayMs > 0 ? (fd) => { delay(fsyncDelayMs); fs.fsyncSync(fd); } : undefined;
    this.log = new LogDir(root, { ...(fsync ? { fsync } : {}), ...(segmentBytes ? { segmentBytes } : {}), ...(seams || {}) });
    this.index = new ChatIndex(indexPath);
    this.probeLog = new LogDir(path.join(root, '_probe'), { ...(fsync ? { fsync } : {}) });
    this.stats = { batches: 0, records: 0, skipped: 0, rejected: 0, lastBatch: null, maxLogMs: 0, maxIndexMs: 0 };
    // Make the index a prefix-complete view of the log before anything new is appended.
    this.recovered = catchUp(this.index, this.log);
    this.crashOnce = process.env.WEBCHAT_LOG_CRASH_AFTER_LOG_ONCE === '1';
  }

  /** A record that can never be written must not stand in front of every record behind it. So: a numeric conversation id
   * is the string it always was in the legacy TEXT column; anything else that is not a record (no conversation id, no
   * sequence number) is set aside whole in chatlog/rejected.jsonl, counted, and reported in the acknowledgement; the
   * rest of the batch goes on.
   */
  screen(records) {
    const good = []; const rejected = [];
    for (const record of records) {
      let r = record;
      if (r && typeof r === 'object' && (typeof r.i === 'number' || typeof r.i === 'bigint')) r = { ...r, i: String(r.i) };
      if (!r || typeof r !== 'object') rejected.push({ reason: 'not an object', record });
      else if (typeof r.i !== 'string' || !r.i) rejected.push({ reason: 'no conversation id', record });
      else if (!Number.isSafeInteger(r.n) || r.n < 1) rejected.push({ reason: 'no sequence number', record });
      else good.push(r);
    }
    if (rejected.length) {
      const at = new Date().toISOString();
      const lines = rejected.map((item) => `${JSON.stringify({ at, reason: item.reason, record: item.record })}\n`).join('');
      fs.appendFileSync(path.join(this.root, 'rejected.jsonl'), lines);
      this.stats.rejected = (this.stats.rejected || 0) + rejected.length;
    }
    return { good, rejected: rejected.length };
  }

  /** Append, make durable, index. Returns the acknowledgement. */
  append(input) {
    const t0 = performance.now();
    const { good: records, rejected } = this.screen(input);
    const { written, skipped, ends } = this.log.append(records);
    this.log.sync();
    const t1 = performance.now();
    if (this.crashOnce && written) { this.crashOnce = false; process.exit(99); }
    const applied = this.index.applyBatch(records, ends);
    const t2 = performance.now();
    this.stats.batches += 1; this.stats.records += written; this.stats.skipped += skipped;
    this.stats.maxLogMs = Math.max(this.stats.maxLogMs, t1 - t0);
    this.stats.maxIndexMs = Math.max(this.stats.maxIndexMs, t2 - t1);
    this.stats.lastBatch = { records: records.length, logMs: +(t1 - t0).toFixed(3), indexMs: +(t2 - t1).toFixed(3), at: Date.now() };
    return { written, skipped, rejected, durable: true, logMs: t1 - t0, indexMs: t2 - t1, applied };
  }

  /** The conversation was deleted: record why in control.log, then drop its log and its index rows. */
  drop(id, reason) {
    this.log.control({ n: 0, k: '$drop', i: id, t: new Date().toISOString(), d: { reason, lastN: this.log.lastN(id) } });
    this.log.dropConversation(id);
    this.index.dropConversation(id);
    return { dropped: true };
  }

  /**
   * A real round trip through every layer the chat path uses, on throwaway data: append a record to
   * the probe log, fsync it, commit a row to the index, read both back. What it proves is that this
   * thread is alive, its disk accepts a durable write and the index database commits; the main thread
   * adds the queue and the read-only-connection halves (log-store.js probe()).
   */
  probe(token) {
    const t0 = performance.now();
    const n = this.probeLog.lastN('probe') + 1;
    this.probeLog.append([{ i: 'probe', n, c: null, k: '$probe', t: new Date().toISOString(), d: { token } }]);
    this.probeLog.sync();
    const t1 = performance.now();
    this.index.setMeta('probe', token);
    const t2 = performance.now();
    let readBack = null;
    for (const item of this.probeLog.scan('probe', { fromN: n })) if (item.record?.d?.token === token) readBack = item.record.n;
    // The probe log must not grow without bound: a segment of probes is dropped once a newer one exists.
    if (n % 1000 === 0) this.probeLog.dropSegmentsBefore('probe', n);
    return { ok: readBack === n && this.index.meta('probe') === String(token), logMs: t1 - t0, indexMs: t2 - t1, readMs: performance.now() - t2, n };
  }

  info() {
    return { ...this.stats, recovered: this.recovered, maxCursor: this.index.maxCursor(), pid: process.pid };
  }

  checkpoint() { return this.index.checkpoint('PASSIVE'); }

  close() {
    try { this.log.close(); this.probeLog.close(); } finally { this.index.checkpoint('PASSIVE'); this.index.close(); release(this.root, this.held); }
  }
}

// ---- the worker service ---------------------------------------------------------------------------------

let writer = null;
let config = null;

export const service = {
  open(options) {
    const same = writer && config && config.root === options.root && config.indexPath === options.indexPath;
    if (!same) {
      if (writer) writer.close();
      writer = new LogWriter(options);
      config = { root: options.root, indexPath: options.indexPath };
    }
    return { opened: true, ...writer.info() };
  },
  // Each call names the writer it is for, so a worker that was restarted opens itself again.
  append(records, options) { if (options) service.open(options); if (!writer) throw new Error('chat log writer is not open'); return writer.append(records); },
  drop(id, reason, options) { if (options) service.open(options); return writer.drop(id, reason); },
  probe(token, options) { if (options) service.open(options); if (!writer) throw new Error('chat log writer is not open'); return writer.probe(token); },
  info() { return writer ? writer.info() : null; },
  checkpoint() { return writer?.checkpoint() ?? null; },
  close() { if (writer) { writer.close(); writer = null; config = null; } return { closed: true }; }
};

export const callWriter = defineService(import.meta.url, 'chatlog', service);
