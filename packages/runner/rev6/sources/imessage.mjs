// iMessage/SMS from ~/Library/Messages/chat.db: poll for ingest (plane A source
// `imessage-history`) and recent/search for the tools. Records are byte-for-byte
// those of src/connectors/imessage.mjs (same SQL, same revision hash), so the
// plane-A event keys do not change. Two rules carried over because each once
// produced wrong statements: `is_from_me` alone decides the speaker (the handle
// is the counterpart and is 0 on sent rows), and a body is often only in the
// `attributedBody` typedstream blob, decoded here by the one decoder.
// Never writes: ingest reads a copy; recent() opens the live file mode=ro.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { APPLE_EPOCH, FULL_DISK_ACCESS_STEP, fail, hashJson, mtimeIso, openRo, readUnits, withCopy } from './common.mjs';

export const KIND = 'apple-imessage';
export const LIVE_DB = process.env.TOPHAT_RUNNER_IMESSAGE_DB || '';
export const COVERAGE = 'local-chat-db-as-synced-to-this-mac';

/** Body from a typedstream blob (hex): NSString, 0x84 0x01 0x2b, a length (byte | 0x81+u16 | 0x82+u32), UTF-8. '' on any malformed shape. */
export function decodeAttributedBody(hex) {
  if (typeof hex !== 'string') return '';
  const b = Buffer.from(hex, 'hex');
  const marker = b.indexOf('NSString');
  if (marker < 0) return '';
  const at = b.indexOf(Buffer.from([0x84, 0x01, 0x2b]), marker);
  if (at < 0) return '';
  let i = at + 4, n = b[at + 3];
  if (n === 0x81) { if (i + 2 > b.length) return ''; n = b.readUInt16LE(i); i += 2; }
  else if (n === 0x82) { if (i + 4 > b.length) return ''; n = b.readUInt32LE(i); i += 4; }
  if (!Number.isFinite(n) || n <= 0 || i + n > b.length) return '';
  return b.subarray(i, i + n).toString('utf8');
}

/** Apple date column (text): seconds before High Sierra, nanoseconds after; both since 2001. */
export function appleStamp(raw) {
  if (raw === null || raw === undefined || raw === '') fail('invalid-message-timestamp');
  const v = Number(raw), seconds = Math.abs(v) >= 1e12 ? v / 1e9 : v;
  const when = new Date((seconds + APPLE_EPOCH) * 1000);
  if (Number.isNaN(when.getTime())) fail('invalid-message-timestamp');
  return when.toISOString();
}

function select(present) {
  for (const c of ['guid', 'date', 'text', 'is_from_me']) if (!present.has(c)) fail('unsupported-message-schema');
  const blob = present.has('attributedBody') ? 'm.attributedBody' : 'NULL', service = present.has('service') ? 'm.service' : 'NULL';
  const body = present.has('attributedBody') ? "COALESCE(m.text,'') <> '' OR m.attributedBody IS NOT NULL" : "COALESCE(m.text,'') <> ''";
  return `SELECT m.ROWID AS rowid, m.guid AS guid, CAST(m.date AS TEXT) AS date, m.text AS text,
      m.is_from_me AS is_from_me, hex(${blob}) AS blob, ${service} AS service,
      h.id AS handle, c.chat_identifier AS chat, c.display_name AS chat_name
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE m.ROWID > ? AND (${body}) ORDER BY m.ROWID LIMIT ?`;
}

export function messageRecord(row, unit) {
  if (typeof row.guid !== 'string' || !row.guid) fail('invalid-message-identity');
  const text = typeof row.text === 'string' ? row.text : '';
  const recovered = text.trim() ? '' : decodeAttributedBody(row.blob);
  const direction = row.is_from_me == null ? 'unknown' : (row.is_from_me ? 'outgoing' : 'incoming');
  const handle = row.handle == null ? null : String(row.handle), chat = row.chat == null ? null : String(row.chat);
  const name = typeof row.chat_name === 'string' && row.chat_name.trim() ? row.chat_name.trim() : null;
  return {
    id: `imessage:${row.guid}`, revision: hashJson(row), occurredAt: appleStamp(row.date),
    ...(chat ? { threadId: `imessage:${chat}` } : {}),
    text: text.trim() ? text : recovered,
    metadata: {
      type: 'imessage', readMode: unit.mode, unitId: unit.id, capturedAt: unit.capturedAt, direction,
      sender: direction === 'outgoing' ? 'owner' : handle, handle, conversation: chat, conversationName: name,
      service: row.service == null ? null : String(row.service),
      bodySource: text.trim() ? 'text' : (recovered ? 'attributed-body' : 'none'),
      currentAsOf: unit.mode === 'live' ? 'read-instant' : unit.capturedAt, historyCoverage: COVERAGE,
    },
  };
}

export async function poll(source, { cursor = null, copyFile = fs.copyFileSync } = {}) {
  const c = source.config ?? {}, batch = c.batchSize ?? 500;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 20000) fail('invalid-message-batch-size');
  const file = c.database ?? LIVE_DB;
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('absolute-message-database-path-required');
  const unit = { id: path.basename(file), path: file, mode: file === (c.liveDatabase ?? LIVE_DB) ? 'live' : 'extract', capturedAt: mtimeIso(file) };
  const stored = cursor?.version === 1 ? Number(cursor.rowid) : 0;
  const after = Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
  let next = after, drained = false;
  const { records, health } = await readUnits([{ id: unit.id, read: () => withCopy(file, 'chat.db', (db) => {
    const present = new Set(db.prepare('PRAGMA table_info(message)').all().map((r) => r.name));
    const rows = db.prepare(select(present)).all(after, batch);
    next = rows.length ? Number(rows.at(-1).rowid) : after; drained = rows.length < batch;
    return rows.map((r) => messageRecord(r, unit));
  }, { copyFile, prefix: 'tophat-messages-', what: 'message-database' }) }], { deadlineMs: c.deadlineMs ?? 20000 });
  return { records, cursor: { version: 1, rowid: next }, complete: drained, health: { ...health,
    coverage: unit.mode === 'live' ? 'live-message-database-snapshot' : 'message-database-extract-as-of-capture',
    readModes: [{ unit: unit.id, mode: unit.mode, capturedAt: unit.capturedAt }], historyCoverage: COVERAGE,
    ownerStep: health.unreadable.some((u) => u.code === 'full-disk-access-required') ? FULL_DISK_ACCESS_STEP : null } };
}

// ---- tools: recent / search, newest first, as of an instant (port of rev5/messages.mjs imessageRows) ----
const SECS = 'CASE WHEN m.date > 100000000000 THEN m.date / 1000000000.0 ELSE m.date END';
const toIso = (s) => new Date((Number(s) + APPLE_EPOCH) * 1000).toISOString();
const toSecs = (iso) => Date.parse(iso) / 1000 - APPLE_EPOCH;

/** Newest message at or before `asOf` and the row count: what any search over this store can see. */
export function freshness({ file = LIVE_DB, asOf = new Date().toISOString() } = {}) {
  const db = openRo(file);
  try {
    const r = db.prepare(`SELECT MAX(${SECS}) AS d, COUNT(*) AS n FROM message m WHERE ${SECS} <= ?`).get(toSecs(asOf));
    return { newest_message_at: r?.d ? toIso(r.d) : null, rows: r?.n ?? 0, as_of: asOf };
  } finally { db.close(); }
}

export function recent({ file = LIVE_DB, contact, query, since, asOf = new Date().toISOString(), limit = 20 } = {}) {
  const db = openRo(file);
  try {
    const where = [`${SECS} <= ?`], args = [toSecs(asOf)];
    if (since) { where.push(`${SECS} + ? > ?`); args.push(APPLE_EPOCH, Math.floor(Date.parse(since) / 1000)); }
    if (contact) { where.push('EXISTS (SELECT 1 FROM chat_handle_join ch2 JOIN handle h2 ON h2.ROWID = ch2.handle_id WHERE ch2.chat_id = j.chat_id AND h2.id LIKE ?)'); args.push(`%${String(contact).replace(/[^\w@.+]/g, '')}%`); }
    if (query) { where.push('(m.text LIKE ? OR instr(m.attributedBody, CAST(? AS BLOB)) > 0)'); args.push(`%${query}%`, query); }
    const sql = `SELECT m.ROWID AS rowid, m.guid, ${SECS} AS secs, m.is_from_me, m.text, hex(m.attributedBody) AS body_hex, m.service, h.id AS sender, c.chat_identifier, c.display_name,
        (SELECT group_concat(h3.id, ', ') FROM chat_handle_join ch3 JOIN handle h3 ON h3.ROWID = ch3.handle_id WHERE ch3.chat_id = j.chat_id) AS participants
      FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = j.chat_id
      WHERE ${where.join(' AND ')} ORDER BY m.date DESC LIMIT ?`;
    return db.prepare(sql).all(...args, Math.min(Math.max(Number(limit) || 20, 1), 50)).map((r) => ({
      source: 'imessage', at: toIso(r.secs), author: r.is_from_me ? 'owner' : (r.sender || 'unknown'), chat: r.display_name || r.chat_identifier || null,
      participants: r.participants ? r.participants.split(', ') : [], text: r.text || (r.body_hex ? decodeAttributedBody(r.body_hex) : ''),
      service: r.service || null, native_id: String(r.rowid), guid: r.guid }));
  } finally { db.close(); }
}

/** One message by ROWID or guid, for read_document-style lookups. */
export function read(idOrGuid, { file = LIVE_DB } = {}) {
  const db = openRo(file);
  try {
    const col = /^\d+$/.test(String(idOrGuid)) ? 'm.ROWID' : 'm.guid';
    const r = db.prepare(`SELECT m.ROWID AS rowid, m.guid, CAST(m.date AS TEXT) AS date, m.text, m.is_from_me, hex(m.attributedBody) AS blob, m.service, h.id AS handle
      FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE ${col} = ?`).get(String(idOrGuid).replace(/^imessage:/, ''));
    return r ? { native_id: String(r.rowid), guid: r.guid, at: appleStamp(r.date), author: r.is_from_me ? 'owner' : (r.handle || 'unknown'),
      text: (r.text || '').trim() ? r.text : decodeAttributedBody(r.blob), service: r.service } : null;
  } finally { db.close(); }
}
