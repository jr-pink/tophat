// The chat log: the only source of truth for chat events.
//
// One append-only log per conversation, in segment files, framed so a torn write is detectable and a
// crash costs at most the record that was being written. SQLite (chat-index.js) is a derived index of
// these files and can be rebuilt from them; nothing here ever updates or deletes a record. Retention
// works on whole segments (dropSegmentsBefore) and on whole conversations (dropConversation).
//
// Layout, under one root directory:
//   MANIFEST.json                       format version, creation time, the cursor floor the log started at
//   cursor.reserve                      a number: no cursor above it has ever been handed out (chatlog-cursor.js)
//   conv/<xx>/<id>/<first-n>.log        segments of one conversation; <first-n> is the per-conversation
//                                       sequence number of the segment's first record, zero padded, so the
//                                       lexical order of the names is the order of the records
//   control.log                         whole-conversation events that belong to no conversation log (drops)
//   torn/                               bytes cut from a torn tail, kept (nothing is ever discarded silently)
//
// A record is one line: `<crc32 hex, 8>\t<json>\n`. The JSON is {i, n, c, k, r, t, d}:
//   i conversation id, n sequence number inside the conversation (1, 2, 3... no gaps),
//   c the event's global cursor (absent on control records), k kind, r run id, t timestamp, d content.
// Kinds starting with `$` are control records (they move a conversation's projection but are not
// events): `$conv` (creation fields), `$set` (partial fields), `$snapshot` (the whole derived row at a
// point, written by the backfill), `$applied` (an applied-action receipt).
//
// This module is synchronous and single-writer by contract: exactly one LogDir instance appends to a
// root at a time (the writer thread, or a test). Readers (scan) may run anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

export const LOG_FORMAT = 1;
export const SEGMENT_BYTES = Number(process.env.WEBCHAT_LOG_SEGMENT_BYTES || 64 * 1024 * 1024);
const MAX_OPEN = 256;
const TAIL_READ = 1024 * 1024;

export const CONTROL_KINDS = new Set(['$conv', '$set', '$snapshot', '$applied']);
export const isControl = (kind) => typeof kind === 'string' && kind.startsWith('$');

/** A directory name for a conversation id: the id itself when it is plain, else a hash-suffixed form. */
export function safeName(id) {
  const text = String(id);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(text)) return text;
  return `x-${createHash('sha256').update(text).digest('hex').slice(0, 40)}`;
}

export function encodeRecord(record) {
  const payload = JSON.stringify(record);
  const crc = (crc32(payload) >>> 0).toString(16).padStart(8, '0');
  return Buffer.from(`${crc}\t${payload}\n`, 'utf8');
}

/** { ok: true, record } | { ok: false, reason }. `line` has no trailing newline. */
export function decodeLine(line) {
  if (line.length < 11 || line[8] !== '\t') return { ok: false, reason: 'frame' };
  const payload = line.slice(9);
  const crc = (crc32(payload) >>> 0).toString(16).padStart(8, '0');
  if (crc !== line.slice(0, 8)) return { ok: false, reason: 'crc' };
  try { return { ok: true, record: JSON.parse(payload) }; } catch { return { ok: false, reason: 'json' }; }
}

const segmentName = (n) => `${String(n).padStart(10, '0')}.log`;
const segmentStart = (name) => Number(name.slice(0, 10));

function fsyncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* best effort */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* gone */ } }
}

export class LogDir {
  /**
   * @param {string} root
   * @param {{segmentBytes?: number, fsync?: (fd: number) => void}} [options] `fsync` is a seam: a test slows or fails it.
   */
  constructor(root, { segmentBytes = SEGMENT_BYTES, fsync = (fd) => fs.fsyncSync(fd), write = (fd, buf, offset, length) => fs.writeSync(fd, buf, offset, length) } = {}) {
    this.root = root;
    this.write = write;
    this.segmentBytes = segmentBytes;
    this.fsync = fsync;
    this.open = new Map();      // conversation id -> { fd, segment, size, n }
    fs.mkdirSync(path.join(root, 'conv'), { recursive: true });
    const manifest = path.join(root, 'MANIFEST.json');
    if (!fs.existsSync(manifest)) {
      const tmp = `${manifest}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ format: LOG_FORMAT, createdAt: new Date().toISOString() }));
      fs.renameSync(tmp, manifest);
    }
  }

  convDir(id) {
    const name = safeName(id);
    return path.join(this.root, 'conv', name.slice(0, 2), name);
  }

  segments(id) {
    try { return fs.readdirSync(this.convDir(id)).filter((f) => /^\d{10}\.log$/u.test(f)).sort(); } catch { return []; }
  }

  conversationIds() {
    const out = [];
    const base = path.join(this.root, 'conv');
    for (const shard of fs.readdirSync(base)) {
      const shardDir = path.join(base, shard);
      let names = [];
      try { names = fs.readdirSync(shardDir); } catch { continue; }
      for (const name of names) {
        const segs = this.segmentsIn(path.join(shardDir, name));
        if (!segs.length) continue;
        // The id is carried by the records, not the directory name: read the first one.
        const first = this.firstRecord(path.join(shardDir, name, segs[0]));
        if (first?.i) out.push(first.i);
      }
    }
    return out;
  }

  segmentsIn(dir) {
    try { return fs.readdirSync(dir).filter((f) => /^\d{10}\.log$/u.test(f)).sort(); } catch { return []; }
  }

  firstRecord(file) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(65536);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const end = buf.subarray(0, read).indexOf(0x0a);
      if (end < 0) return null;
      const decoded = decodeLine(buf.subarray(0, end).toString('utf8'));
      return decoded.ok ? decoded.record : null;
    } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* gone */ } }
  }

  /**
   * Make a conversation's newest segment end on a whole record, and say where the log stands:
   * { n: last sequence number (0 when empty), segment, size }. A torn tail is moved to torn/ (never
   * deleted) and the segment truncated to its last good record. Idempotent; cheap (reads the tail).
   */
  recover(id) {
    const segs = this.segments(id);
    if (!segs.length) return { n: 0, segment: null, size: 0, torn: 0 };
    let torn = 0;
    for (let at = segs.length - 1; at >= 0; at -= 1) {
      const file = path.join(this.convDir(id), segs[at]);
      const result = this.recoverFile(file, id);
      torn += result.torn;
      if (result.n > 0) return { n: result.n, segment: segs[at], size: result.size, torn };
      // An empty (or entirely torn) newest segment holds no record: the answer is in the one before it.
      if (at === segs.length - 1 && result.size === 0) { try { fs.unlinkSync(file); } catch { /* raced */ } }
    }
    return { n: 0, segment: null, size: 0, torn };
  }

  recoverFile(file, id) {
    const size = fs.statSync(file).size;
    if (size === 0) return { n: 0, size: 0, torn: 0 };
    const fd = fs.openSync(file, 'r+');
    try {
      let window = Math.min(size, TAIL_READ);
      for (;;) {
        const start = size - window;
        const buf = Buffer.alloc(window);
        fs.readSync(fd, buf, 0, window, start);
        // Walk lines from the end; the first good one fixes the cut.
        let end = buf.length;                 // end of the candidate region (exclusive)
        let goodEnd = -1;
        let n = 0;
        while (end > 0) {
          // The candidate is the bytes after the previous newline up to `end`; a complete line ends in \n.
          const complete = buf[end - 1] === 0x0a;
          const lineEnd = complete ? end - 1 : end;
          const prev = buf.lastIndexOf(0x0a, lineEnd - 1);
          if (prev < 0 && start > 0) { goodEnd = -2; break; }     // line begins before the window: widen
          const lineStart = prev + 1;
          if (complete) {
            const decoded = decodeLine(buf.subarray(lineStart, lineEnd).toString('utf8'));
            if (decoded.ok) { goodEnd = end; n = decoded.record.n; break; }
          }
          end = lineStart;
        }
        if (goodEnd === -2 && window < size) { window = Math.min(size, window * 4); continue; }
        if (goodEnd < 0) goodEnd = 0;
        const keep = start + goodEnd;
        if (keep === size) return { n, size, torn: 0 };
        const cut = Buffer.alloc(size - keep);
        fs.readSync(fd, cut, 0, cut.length, keep);
        const tornDir = path.join(this.root, 'torn');
        fs.mkdirSync(tornDir, { recursive: true });
        fs.writeFileSync(path.join(tornDir, `${path.basename(path.dirname(file))}-${path.basename(file)}-${Date.now()}.torn`), cut);
        fs.ftruncateSync(fd, keep);
        fs.fsyncSync(fd);
        if (keep === 0) return { n: 0, size: 0, torn: cut.length };
        // Re-derive n for the (possibly shorter) good tail.
        return { ...this.recoverFile(file, id), torn: cut.length };
      }
    } finally { fs.closeSync(fd); }
  }

  state(id) {
    let entry = this.open.get(id);
    if (entry) { this.open.delete(id); this.open.set(id, entry); return entry; }
    const found = this.recover(id);
    const dir = this.convDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const segment = found.segment || segmentName(found.n + 1);
    const file = path.join(dir, segment);
    const fd = fs.openSync(file, 'a');
    entry = { fd, segment, size: found.size, n: found.n, dirty: false };
    this.open.set(id, entry);
    while (this.open.size > MAX_OPEN) {
      const [oldId, old] = this.open.entries().next().value;
      if (old.dirty) { this.fsync(old.fd); old.dirty = false; }
      try { fs.closeSync(old.fd); } catch { /* closed */ }
      this.open.delete(oldId);
    }
    return entry;
  }

  /** The newest sequence number of a conversation (recovers its tail first). */
  lastN(id) { return this.state(id).n; }

  /**
   * Append records. Each must carry its conversation id `i` and its sequence number `n`; records
   * whose `n` is not above the log's end are already there and are skipped (so a retried batch is
   * exactly-once). An `n` that leaves a gap is refused. Returns { written, skipped, ends } with
   * ends: id -> { n, segment, size } as of after the batch. Nothing is durable until sync().
   */
  append(records) {
    const byConv = new Map();
    let skipped = 0;
    for (const record of records) {
      if (!record || typeof record.i !== 'string' || !Number.isSafeInteger(record.n)) throw new TypeError('record needs i and n');
      const list = byConv.get(record.i) || [];
      list.push(record);
      byConv.set(record.i, list);
    }
    let written = 0;
    const ends = new Map();
    for (const [id, list] of byConv) {
      const entry = this.state(id);
      const chunks = [];
      let size = 0;
      let n = entry.n;
      for (const record of list) {
        if (record.n <= n) { skipped += 1; continue; }
        if (record.n !== n + 1) throw new Error(`log gap in ${id}: have ${n}, got ${record.n}`);
        const bytes = encodeRecord(record);
        // A segment is whole records: roll to a new one before it would pass the limit.
        if (entry.size + size > 0 && entry.size + size + bytes.length > this.segmentBytes) {
          try { this.flushChunks(entry, chunks, size); } catch (error) { this.invalidate(id); throw error; }
          chunks.length = 0; size = 0;
          this.roll(id, entry, n + 1);
        }
        chunks.push(bytes); size += bytes.length; n = record.n; written += 1;
      }
      try { this.flushChunks(entry, chunks, size); } catch (error) { this.invalidate(id); throw error; }
      entry.n = n;
      ends.set(id, { n, segment: entry.segment, size: entry.size });
    }
    return { written, skipped, ends };
  }

  flushChunks(entry, chunks, size) {
    if (!chunks.length) return;
    const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
    let offset = 0;
    while (offset < buf.length) offset += this.write(entry.fd, buf, offset, buf.length - offset);
    entry.size += buf.length;
    entry.dirty = true;
  }

  /**
   * A write failed part-way (a full disk, an I/O error): the segment may end in half a record and `entry` no longer
   * says where it ends. Forget it; the next append to this conversation runs recover(), which cuts the torn bytes
   * (keeping them in torn/) and re-reads the real last sequence number, so a re-sent batch is exactly-once.
   */
  invalidate(id) {
    const entry = this.open.get(id);
    if (!entry) return;
    try { fs.closeSync(entry.fd); } catch { /* closed */ }
    this.open.delete(id);
  }

  roll(id, entry, firstN) {
    if (entry.dirty) { this.fsync(entry.fd); entry.dirty = false; }
    fs.closeSync(entry.fd);
    entry.segment = segmentName(firstN);
    entry.fd = fs.openSync(path.join(this.convDir(id), entry.segment), 'a');
    entry.size = 0;
    fsyncDir(this.convDir(id));
  }

  /** Make everything appended so far durable. */
  sync() {
    for (const entry of this.open.values()) {
      if (entry.dirty) { this.fsync(entry.fd); entry.dirty = false; }
    }
  }

  close() {
    this.sync();
    for (const entry of this.open.values()) { try { fs.closeSync(entry.fd); } catch { /* closed */ } }
    this.open.clear();
  }

  /**
   * Every record of a conversation in order, optionally from sequence number `fromN` (inclusive).
   * Yields { record, segment, end } where `end` is the byte offset just past the record. A line that
   * fails its checksum yields { corrupt: reason, segment, offset } and the scan goes on, so a reader
   * can say exactly what it could not read instead of stopping.
   */
  *scan(id, { fromN = 1 } = {}) {
    const segs = this.segments(id);
    // Start at the last segment that can hold fromN.
    let first = 0;
    for (let at = 0; at < segs.length; at += 1) if (segmentStart(segs[at]) <= fromN) first = at;
    for (let at = first; at < segs.length; at += 1) {
      yield* this.scanFile(path.join(this.convDir(id), segs[at]), segs[at], fromN);
    }
  }

  *scanFile(file, segment, fromN = 1, startOffset = 0) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      const chunk = Buffer.alloc(4 * 1024 * 1024);
      let carry = Buffer.alloc(0);
      let base = startOffset;
      for (;;) {
        const read = fs.readSync(fd, chunk, 0, chunk.length, base + carry.length);
        if (read === 0) break;
        let buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
        let at = 0;
        for (;;) {
          const nl = buf.indexOf(0x0a, at);
          if (nl < 0) break;
          const decoded = decodeLine(buf.subarray(at, nl).toString('utf8'));
          const end = base + nl + 1;
          if (decoded.ok) { if (decoded.record.n >= fromN) yield { record: decoded.record, segment, end }; }
          else yield { corrupt: decoded.reason, segment, offset: base + at };
          at = nl + 1;
        }
        carry = Buffer.from(buf.subarray(at));
        base += at;
      }
      // A partial last line is a torn tail (recover() cuts it): reported, not yielded.
      if (carry.length) yield { corrupt: 'torn-tail', segment, offset: base };
    } finally { fs.closeSync(fd); }
  }

  /** The records after byte `offset` of `segment`, then every later segment: how an index catches up. */
  *scanFrom(id, { segment, offset }) {
    const segs = this.segments(id);
    const at = segs.indexOf(segment);
    if (at < 0) { yield* this.scan(id); return; }
    const file = path.join(this.convDir(id), segment);
    // `offset` is the end of the last record the index holds: a record boundary, so read on from there.
    yield* this.scanFile(file, segment, 1, offset);
    for (let next = at + 1; next < segs.length; next += 1) yield* this.scanFile(path.join(this.convDir(id), segs[next]), segs[next], 1);
  }

  /** Retention: delete segments that hold only records below sequence number `n`. Never the newest. */
  dropSegmentsBefore(id, n) {
    const segs = this.segments(id);
    let dropped = 0;
    for (let at = 0; at < segs.length - 1; at += 1) {
      if (segmentStart(segs[at + 1]) <= n) { fs.unlinkSync(path.join(this.convDir(id), segs[at])); dropped += 1; } else break;
    }
    return dropped;
  }

  /** Remove a whole conversation's log (the owner deleted it, or its scope moved). The caller has recorded why. */
  dropConversation(id) {
    const entry = this.open.get(id);
    if (entry) { try { fs.closeSync(entry.fd); } catch { /* closed */ } this.open.delete(id); }
    fs.rmSync(this.convDir(id), { recursive: true, force: true });
  }

  /** Append a line to control.log, durably. */
  control(record) {
    const file = path.join(this.root, 'control.log');
    const fd = fs.openSync(file, 'a');
    try { fs.writeSync(fd, encodeRecord(record)); this.fsync(fd); } finally { fs.closeSync(fd); }
  }

  *controlRecords() {
    const file = path.join(this.root, 'control.log');
    if (!fs.existsSync(file)) return;
    yield* this.scanFile(file, 'control.log', 0);
  }
}
