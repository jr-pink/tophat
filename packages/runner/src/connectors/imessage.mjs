// iMessage and SMS, read from the local Messages database, normalized into
// events. This is the largest correspondence source on a Mac by an order of
// magnitude: the Beeper bridge carries a few thousand messages, and chat.db on
// a long-lived machine carries hundreds of thousands, so the two are not
// substitutes for one another.
//
// NOTHING HERE WRITES. The database is the owner's message store, and a reader
// that could damage it is the defect this module is shaped around. The live
// file is never opened at all: it is copied, the copy is opened with
// `readOnly`, and `PRAGMA query_only` is set on top of that. No schema is
// created, no write-ahead log is checkpointed, and a path that does not exist
// fails by name rather than being created as an empty database.
//
// READ MODE IS STATED, NOT ASSUMED, exactly as in `call-history.mjs`:
//
//   live     the path in `config.liveDatabase`, by default
//            ~/Library/Messages/chat.db. Current as of the copy instant.
//   extract  any other path: a copy, a backup, an archive. Current only as of
//            its own mtime, which is reported as the unit's `capturedAt` and
//            never as now.
//
// THE GRANT. Reading chat.db needs Full Disk Access, which only the owner can
// give. macOS refuses the copy with EPERM or EACCES, and a denied grant must
// never read as a Mac that has exchanged no messages, so that condition carries
// its own code and the read fails instead of returning an empty batch.
//
// TWO READING DEFECTS, both of which produced wrong statements in the legacy
// runtime, are fixed here by construction.
//
// ATTRIBUTION. `message.handle_id` is the OTHER party, and Apple leaves it 0 on
// a message the owner sent, so joining it to `handle` and printing that as the
// speaker attributes the owner's own message in a group chat to whichever
// participant the join found. `is_from_me` is the only authority for who spoke;
// the handle is only ever the counterpart.
//
// THE BODY IS NOT ALWAYS IN `text`. A large share of rows carry an empty `text`
// and hold the body in the `attributedBody` typedstream blob, so a reader
// filtering on `text` silently drops them. The blob is decoded here, and a blob
// that cannot be decoded is reported as an unrecovered body rather than as an
// empty message.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readUnits, DEFAULT_DEADLINE_MS } from './bounded-read.mjs';
import { FULL_DISK_ACCESS_STEP } from './call-history.mjs';

export const IMESSAGE_KIND = 'apple-imessage';
export const LIVE_MESSAGE_DATABASE = process.env.TOPHAT_RUNNER_IMESSAGE_DB || '';
// The same OS grant and the same System Settings pane as call history, so there
// is one spelling of the owner's step rather than two that can drift.
export { FULL_DISK_ACCESS_STEP };

// chat.db holds what this Mac has synced, which on a device signed in years
// after a conversation is less than the account's whole history. Saying so on
// every record keeps a reader from treating the local store as complete.
export const IMESSAGE_HISTORY_COVERAGE = 'local-chat-db-as-synced-to-this-mac';

// Both shapes sit in one long-lived database, so the unit is derived per row:
// no plausible date is under this many seconds, and no plausible date in
// seconds is over it.
const APPLE_EPOCH_SECONDS = 978307200;
const NANOSECONDS_ABOVE = 1e12;

// Everything a message is: which row, which message, when, the body in either
// of the two places it lives, who sent it, over which service, and which
// conversation. Nothing else in `message` is asked for.
const REQUIRED = ['guid', 'date', 'text', 'is_from_me'];
const OPTIONAL = ['attributedBody', 'service'];

const fail = code => { const error = new Error(code); error.code = code; throw error; };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function stamp(raw) {
  // The column is read as text, so an absent date is null rather than a zero
  // that would silently date the message to the Apple epoch.
  if (raw === null || raw === undefined || raw === '') fail('invalid-message-timestamp');
  const value = Number(raw);
  const seconds = Math.abs(value) >= NANOSECONDS_ABOVE ? value / 1e9 : value;
  // One check for both ways a date can be unusable: a column that is not a
  // number at all, and one so far out that no Date can hold it. Both arrive
  // here as an invalid Date, whose ISO string would throw.
  const when = new Date((seconds + APPLE_EPOCH_SECONDS) * 1000);
  if (Number.isNaN(when.getTime())) fail('invalid-message-timestamp');
  return when.toISOString();
}

/**
 * Recover a body from the `attributedBody` typedstream blob, given as hex.
 * After the `NSString` class marker comes `0x84 0x01 0x2b`, then a length that
 * is one byte, or `0x81` plus a little-endian uint16, or `0x82` plus a uint32,
 * then that many UTF-8 bytes. Every malformed shape returns the empty string:
 * one truncated blob threw out of a length read in the legacy reader and took a
 * whole index build with it.
 */
export function decodeAttributedBody(hex) {
  if (typeof hex !== 'string') return '';
  // Hex decoding a string never throws; it stops at the first byte it cannot
  // read, which leaves a short buffer the length checks below already handle.
  const buffer = Buffer.from(hex, 'hex');
  const marker = buffer.indexOf('NSString');
  if (marker < 0) return '';
  const at = buffer.indexOf(Buffer.from([0x84, 0x01, 0x2b]), marker);
  if (at < 0) return '';
  let index = at + 3, length = buffer[index];
  index += 1;
  if (length === 0x81) {
    if (index + 2 > buffer.length) return '';
    length = buffer.readUInt16LE(index); index += 2;
  } else if (length === 0x82) {
    if (index + 4 > buffer.length) return '';
    length = buffer.readUInt32LE(index); index += 4;
  }
  if (!Number.isFinite(length) || length <= 0 || index + length > buffer.length) return '';
  return buffer.subarray(index, index + length).toString('utf8');
}

// A revoked grant, a missing file and a file that is not a database are three
// different answers and the caller needs to tell them apart.
function snapshot(file, into, copyFile) {
  const target = path.join(into, 'chat.db');
  try {
    copyFile(file, target);
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') fail('full-disk-access-required');
    fail('message-database-unavailable');
  }
  // The live database is always hot, and the newest messages are in its
  // write-ahead log rather than in the main file.
  for (const suffix of ['-wal', '-shm']) {
    try { copyFile(`${file}${suffix}`, `${target}${suffix}`); } catch { /* optional */ }
  }
  return target;
}

function open(file) {
  let database;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    database.exec('PRAGMA query_only=ON');
    return database;
  } catch {
    database?.close();
    fail('message-database-unreadable');
  }
}

// An older copy of the database may be missing a column this reader would like,
// which is not a reason to refuse it: the four it cannot work without fail by
// name, and the rest come back as NULL.
function statement(present) {
  for (const name of REQUIRED) if (!present.has(name)) fail('unsupported-message-schema');
  const [blob, service] = OPTIONAL.map(name => present.has(name) ? `m.${name}` : 'NULL');
  const body = present.has('attributedBody') ? "COALESCE(m.text,'') <> '' OR m.attributedBody IS NOT NULL" : "COALESCE(m.text,'') <> ''";
  // `date` is read as text on purpose. A post-High-Sierra row holds nanoseconds,
  // which is past the safe integer range, and the driver refuses to hand such a
  // value back as a number at all; casting in SQL keeps every digit and keeps
  // the row JSON-serializable for its revision hash.
  return `SELECT m.ROWID AS rowid, m.guid AS guid, CAST(m.date AS TEXT) AS date, m.text AS text,
      m.is_from_me AS is_from_me, hex(${blob}) AS blob, ${service} AS service,
      h.id AS handle, c.chat_identifier AS chat, c.display_name AS chat_name
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE m.ROWID > ? AND (${body}) ORDER BY m.ROWID LIMIT ?`;
}

function messageRecord(row, unit) {
  if (typeof row.guid !== 'string' || !row.guid) fail('invalid-message-identity');
  const text = typeof row.text === 'string' ? row.text : '';
  const recovered = text.trim() ? '' : decodeAttributedBody(row.blob);
  const body = text.trim() ? text : recovered;
  const direction = row.is_from_me == null ? 'unknown' : (row.is_from_me ? 'outgoing' : 'incoming');
  const handle = row.handle == null ? null : String(row.handle);
  const chat = row.chat == null ? null : String(row.chat);
  const name = typeof row.chat_name === 'string' && row.chat_name.trim() ? row.chat_name.trim() : null;
  return {
    id: `imessage:${row.guid}`,
    revision: hash(row),
    occurredAt: stamp(row.date),
    ...(chat ? { threadId: `imessage:${chat}` } : {}),
    text: body,
    metadata: {
      type: 'imessage',
      readMode: unit.mode,
      unitId: unit.id,
      capturedAt: unit.capturedAt,
      direction,
      // `is_from_me` decides the speaker.
      sender: direction === 'outgoing' ? 'owner' : handle,
      handle,
      conversation: chat,
      conversationName: name,
      service: row.service == null ? null : String(row.service),
      // An empty body and a body this reader could not recover are different
      // statements about the message.
      bodySource: text.trim() ? 'text' : (recovered ? 'attributed-body' : 'none'),
      currentAsOf: unit.mode === 'live' ? 'read-instant' : unit.capturedAt,
      historyCoverage: IMESSAGE_HISTORY_COVERAGE,
    },
  };
}

function readDatabase(unit, { after, batchSize, copyFile }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tophat-messages-'));
  fs.chmodSync(temporary, 0o700);
  let database;
  try {
    database = open(snapshot(unit.path, temporary, copyFile));
    const present = new Set(database.prepare('PRAGMA table_info(message)').all().map(row => row.name));
    const rows = database.prepare(statement(present)).all(after, batchSize);
    return { rows, records: rows.map(row => messageRecord(row, unit)) };
  } finally {
    database?.close();
    fs.rmSync(temporary, { recursive: true });
  }
}

function plan(config) {
  const file = config.database ?? LIVE_MESSAGE_DATABASE;
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('absolute-message-database-path-required');
  const live = config.liveDatabase ?? LIVE_MESSAGE_DATABASE;
  let capturedAt = null;
  try { capturedAt = fs.statSync(file).mtime.toISOString(); } catch { capturedAt = null; }
  return { id: path.basename(file), path: file, mode: file === live ? 'live' : 'extract', capturedAt };
}

export async function pollIMessage(source, { cursor = null, copyFile = fs.copyFileSync } = {}) {
  if (source.kind !== IMESSAGE_KIND) fail('unsupported-imessage-kind');
  const config = source.config ?? {};
  const batchSize = config.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 20000) fail('invalid-message-batch-size');
  const unit = plan(config);
  // `message.ROWID` is insert order, so a message written after this cycle sits
  // above the frontier whatever date it carries and cannot be skipped.
  // A stored place in the database is a positive whole rowid; a cursor from
  // another version, a fraction or a negative number starts from the beginning
  // rather than silently skipping the messages below it.
  const stored = cursor?.version === 1 ? Number(cursor.rowid) : 0;
  const after = Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
  let next = after, drained = false;
  const { records, health } = await readUnits([{
    id: unit.id,
    read: () => {
      const { rows, records: read } = readDatabase(unit, { after, batchSize, copyFile });
      next = rows.length ? Number(rows.at(-1).rowid) : after;
      drained = rows.length < batchSize;
      return read;
    },
  }], { deadlineMs: config.deadlineMs ?? DEFAULT_DEADLINE_MS });
  return {
    records,
    cursor: { version: 1, rowid: next },
    complete: drained,
    health: {
      ...health,
      coverage: unit.mode === 'live' ? 'live-message-database-snapshot' : 'message-database-extract-as-of-capture',
      readModes: [{ unit: unit.id, mode: unit.mode, capturedAt: unit.capturedAt }],
      historyCoverage: IMESSAGE_HISTORY_COVERAGE,
      ownerStep: health.unreadable.some(item => item.code === 'full-disk-access-required')
        ? FULL_DISK_ACCESS_STEP : null,
    },
  };
}
