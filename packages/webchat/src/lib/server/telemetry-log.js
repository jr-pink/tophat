// Telemetry as daily append-only files, not SQLite.
//
// Interaction observations (a row per scroll, pointer and keystroke sample from every open tab) and the
// reading trace are lossy, aggregated, separate data. They lived in SQLite files that reached 5.7 GB (64 %
// free pages after retention deletes) and put a COMMIT, a WAL checkpoint and a DELETE on the disk the chat
// store shares; on a saturated boot disk each of those held the server for 1-3 s. Telemetry no longer
// shares a commit path with chat.
//
// The shape, and why each part is there:
//   * One file per UTC day, `YYYY-MM-DD.ndjson` (the live writer) plus `YYYY-MM-DD.import-<tag>.ndjson`
//     (rows migrated in from the old SQLite file). Size is bounded by construction: retention deletes
//     whole day files, there is no DELETE, VACUUM, WAL or free-page list, and a per-day byte cap stops a
//     runaway day.
//   * BoundedQueue on the HTTP thread: a request only validates and pushes. The queue is bounded in rows
//     and bytes, drops the OLDEST when full and counts what it dropped (exposed in /api/health). Telemetry
//     is lossy; the chat is not, so the telemetry side gives way.
//   * Flusher: at most one batch is in flight to the one worker thread that owns the files
//     (offload.js defineService). The worker appends, fsyncs on its own interval, rolls the day and
//     deletes expired files. A failed batch goes back to the front of the queue and is retried with
//     backoff. Nothing on the request path ever waits for the disk.
//   * Readers tolerate a crash mid-write: only newline-terminated lines count, and a writer that finds a
//     file ending mid-line terminates it before appending, so a torn line never swallows the next one.

import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const DAY_FILE = /^(\d{4}-\d{2}-\d{2})(?:\.([a-z0-9][a-z0-9-]*))?\.ndjson$/;

export const dayOf = (iso) => String(iso).slice(0, 10);

/** Day files in `dir`, oldest day first, imports before the live file of the same day. */
export function listDayFiles(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = DAY_FILE.exec(name);
    if (m) out.push({ name, path: join(dir, name), day: m[1], tag: m[2] || '' });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.tag ? 0 : 1) - (b.tag ? 0 : 1) || (a.name < b.name ? -1 : 1)));
}

/**
 * Visit every complete (newline-terminated) line of a file as a Buffer, in order, reading in chunks.
 * A final fragment with no newline is a torn write and is not visited.
 */
export function scanLines(path, visit, { chunk = 4 * 1024 * 1024 } = {}) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return 0; }
  let count = 0;
  try {
    const buf = Buffer.allocUnsafe(chunk);
    let carry = null;
    for (;;) {
      const n = readSync(fd, buf, 0, chunk, null);
      if (n <= 0) break;
      let data = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let start = 0;
      for (let i = data.indexOf(10, start); i !== -1; i = data.indexOf(10, start)) {
        if (i > start) { count += 1; if (visit(data.subarray(start, i)) === false) return count; }
        start = i + 1;
      }
      carry = start < data.length ? data.subarray(start) : null;
    }
  } finally { closeSync(fd); }
  return count;
}

/**
 * Delete whole day files older than `days` days: the cutoff is the UTC day of (now - days), and a file
 * survives when its day is on or after it. Only files that match DAY_FILE are ever touched, and never
 * a part of a file. Returns what it removed.
 */
export function pruneDayFiles(dir, { days, now = Date.now() } = {}) {
  const cutoff = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const removed = [];
  let bytes = 0;
  for (const f of listDayFiles(dir)) {
    if (f.day >= cutoff) continue;
    try { bytes += statSync(f.path).size; unlinkSync(f.path); removed.push(f.name); } catch { /* gone already, or busy: next pass */ }
  }
  return { removed: removed.length, files: removed, bytes, cutoff };
}

/**
 * Worker side: owns the open file of the current day. `append(day, text)` writes `text` (whole lines,
 * each ending in \n) to that day's file, opening it (and terminating a torn last line) on first use and
 * on rollover, and fsyncs at most every `fsyncMs`.
 */
export class DayWriter {
  constructor({ dir, fsyncMs = 2000, maxDayBytes = 1024 ** 3, retentionDays = 14, now = Date.now, onRoll = null }) {
    Object.assign(this, { dir, fsyncMs, maxDayBytes, retentionDays, now, onRoll });
    this.day = null; this.fd = null; this.bytes = 0; this.dirty = false; this.lastSync = 0; this.timer = null;
    this.capped = 0;
  }

  open(day) {
    this.closeFile();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `${day}.ndjson`);
    const fd = openSync(path, 'a+', 0o600);
    try { chmodSync(path, 0o600); } catch { /* not ours to chmod */ }
    const size = fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) writeSync(fd, '\n');
    }
    this.fd = fd; this.day = day; this.bytes = fstatSync(fd).size;
    if (this.onRoll) { try { this.onRoll(day); } catch { /* retention is best effort */ } }
  }

  append(day, text) {
    if (day !== this.day || this.fd === null) this.open(day);
    const size = Buffer.byteLength(text);
    if (this.bytes + size > this.maxDayBytes) { this.capped += 1; return { written: 0, capped: true }; }
    writeSync(this.fd, text);
    this.bytes += size; this.dirty = true;
    if (this.now() - this.lastSync >= this.fsyncMs) this.sync(); else this.arm();
    return { written: size, capped: false };
  }

  arm() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; try { this.sync(); } catch { /* retried on the next append */ } }, this.fsyncMs);
    this.timer.unref?.();
  }

  sync() {
    if (this.fd !== null && this.dirty) { fsyncSync(this.fd); this.dirty = false; }
    this.lastSync = this.now();
  }

  closeFile() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.fd !== null) { try { this.sync(); } catch { /* closing anyway */ } try { closeSync(this.fd); } catch { /* already closed */ } }
    this.fd = null; this.day = null; this.dirty = false;
  }
}

/**
 * HTTP-thread side: a bounded in-memory queue. Pushing past either bound drops the oldest items and
 * counts them. `take` removes a batch from the front; `requeue` puts a failed batch back at the front
 * (and, when that overflows, the oldest of everything is the first to go).
 */
export class BoundedQueue {
  constructor({ maxItems = 20_000, maxBytes = 32 * 1024 * 1024 } = {}) {
    Object.assign(this, { maxItems, maxBytes });
    this.items = []; this.head = 0; this.bytes = 0; this.dropped = 0; this.droppedBytes = 0; this.accepted = 0;
  }
  get size() { return this.items.length - this.head; }
  push(entry, bytes = 0) {
    this.items.push({ entry, bytes }); this.bytes += bytes; this.accepted += 1;
    this.trim();
  }
  trim() {
    while (this.size > this.maxItems || (this.bytes > this.maxBytes && this.size > 1)) {
      const old = this.items[this.head]; this.items[this.head++] = undefined;
      this.bytes -= old.bytes; this.dropped += 1; this.droppedBytes += old.bytes;
    }
    if (this.head > 1024 && this.head * 2 > this.items.length) { this.items = this.items.slice(this.head); this.head = 0; }
  }
  take(maxItems = 500, maxBytes = 2 * 1024 * 1024) {
    const out = []; let bytes = 0;
    while (this.size && out.length < maxItems && (!out.length || bytes + this.items[this.head].bytes <= maxBytes)) {
      const item = this.items[this.head]; this.items[this.head++] = undefined;
      this.bytes -= item.bytes; bytes += item.bytes; out.push(item);
    }
    return out;
  }
  requeue(batch) {
    if (!batch.length) return;
    const live = this.items.slice(this.head);
    this.items = batch.concat(live); this.head = 0;
    for (const item of batch) this.bytes += item.bytes;
    this.trim();
  }
}

/**
 * Drains a BoundedQueue through `send(entries)` (a promise), one batch in flight, after `delayMs`.
 * A failed send requeues its batch and backs off up to `maxBackoffMs`. `flush()` resolves when the queue
 * is empty and nothing is in flight (tests, shutdown); it rejects if `timeoutMs` passes first.
 */
export class Flusher {
  constructor({ queue, send, delayMs = 500, maxBackoffMs = 30_000, batchItems = 500, batchBytes = 2 * 1024 * 1024 }) {
    Object.assign(this, { queue, send, delayMs, maxBackoffMs, batchItems, batchBytes });
    this.timer = null; this.inflight = null; this.fails = 0; this.written = 0; this.flushes = 0;
    this.lastError = null; this.lastErrorAt = null; this.lastFlushAt = null; this.lastFlushMs = null; this.idle = [];
  }
  schedule(delay = this.delayMs) {
    if (this.timer || this.inflight || !this.queue.size) return;
    this.timer = setTimeout(() => { this.timer = null; this.run(); }, delay);
    this.timer.unref?.();
  }
  run() {
    if (this.inflight || !this.queue.size) { this.settleIdle(); return this.inflight; }
    const batch = this.queue.take(this.batchItems, this.batchBytes);
    const started = Date.now();
    this.inflight = Promise.resolve().then(() => this.send(batch.map((b) => b.entry))).then((result) => {
      this.fails = 0; this.written += batch.length; this.flushes += 1;
      this.lastFlushAt = new Date().toISOString(); this.lastFlushMs = Date.now() - started;
      return result;
    }, (error) => {
      this.fails += 1; this.lastError = String(error?.message || error); this.lastErrorAt = new Date().toISOString();
      this.queue.requeue(batch);
    }).finally(() => {
      this.inflight = null;
      if (this.queue.size) this.schedule(this.fails ? Math.min(this.maxBackoffMs, 250 * 2 ** Math.min(this.fails, 10)) : 0);
      else this.settleIdle();
    });
    return this.inflight;
  }
  settleIdle() { if (!this.queue.size && !this.inflight) for (const done of this.idle.splice(0)) done(); }
  flush({ timeoutMs = 10_000 } = {}) {
    if (!this.queue.size && !this.inflight) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { const i = this.idle.indexOf(done); if (i >= 0) this.idle.splice(i, 1); reject(new Error('telemetry flush timed out')); }, timeoutMs);
      const done = () => { clearTimeout(t); resolve(); };
      this.idle.push(done);
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.fails = 0;
      this.run();
    });
  }
}

/** Total bytes and file count of the day files in a directory (health, watchdog). */
export function dirStats(dir) {
  const files = listDayFiles(dir);
  let bytes = 0;
  for (const f of files) { try { bytes += statSync(f.path).size; } catch { /* raced a delete */ } }
  return { files: files.length, bytes, oldest: files[0]?.day ?? null, newest: files.at(-1)?.day ?? null };
}
