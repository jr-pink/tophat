// Test support only: synthetic native stores with the real schemas' relevant
// columns, seeded generators, and a minimal differential (the rev6/verify
// harness was not committed when this piece was built). Never opens live state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const tmp = (p = 'rev6-src-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const int = (n) => Math.floor(next() * n), pick = (l) => l[int(l.length)];
  const PIECES = ['hi', 'Hello there', ' ', '\n', '  padded  ', 'é', 'İstanbul', '\u{1F600}', '中文', '\u00a0', '\u2028', '\x1c', '\ufeff', 'trough', 'a'.repeat(310), '<b>x</b>', '&amp;', '&lt;', '<br>', '<BR/>', '"q"', 'OTP 123456'];
  const text = (n = 4) => Array.from({ length: int(n) + 1 }, () => pick(PIECES)).join('');
  return { next, int, pick, text, bool: (p = 0.5) => next() < p };
}
export const shaBody = (t) => createHash('sha256').update(String(t ?? '')).digest('hex');

/** Records keyed by (source, account, nativeId) -> set of `${revision} ${sha(body)}`; returns {missing, extra, changed, equal}. */
export function diffRecords(oldRecs, newRecs) {
  const key = (r) => `${r.source}\u0000${r.account ?? ''}\u0000${r.nativeId}`, val = (r) => `${r.revision} ${shaBody(r.body)}`;
  const index = (list) => { const m = new Map(); for (const r of list) { const k = key(r); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(val(r)); } return m; };
  const a = index(oldRecs), b = index(newRecs), out = { missing: [], extra: [], changed: [], equal: 0 };
  for (const [k, v] of a) { if (!b.has(k)) out.missing.push(k); else if ([...v].sort().join('|') !== [...b.get(k)].sort().join('|')) out.changed.push({ k, old: [...v], new: [...b.get(k)] }); else out.equal++; }
  for (const k of b.keys()) if (!a.has(k)) out.extra.push(k);
  return out;
}
export const planeAShape = (source, account = '') => (r) => ({ source, account, nativeId: r.id, revision: String(r.revision), body: JSON.stringify(r) });

// ---- chat.db ----
export function chatDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, attributedBody BLOB, service TEXT, handle_id INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT); CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER); CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    INSERT INTO handle VALUES (1,'+15550001111'),(2,'friend@example.com'); INSERT INTO chat VALUES (1,'+15550001111',NULL),(2,'chat99','Group');
    INSERT INTO chat_handle_join VALUES (1,1),(2,1),(2,2);`);
  const put = db.prepare('INSERT INTO message VALUES (?,?,?,?,?,?,?,?)'), join = db.prepare('INSERT INTO chat_message_join VALUES (?,?)');
  rows.forEach((r, i) => { put.run(i + 1, r.guid ?? `G-${i}`, r.date, r.text ?? null, r.fromMe ? 1 : 0, r.blob ?? null, r.service ?? 'iMessage', r.handle ?? 1); if (r.chat !== 0) join.run(r.chat ?? 1, i + 1); });
  db.close();
}
/** A typedstream-shaped blob holding `text` (length as byte, 0x81+u16 or 0x82+u32). */
export function blobFor(text, { prefix = Buffer.from('streamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+', 'latin1') } = {}) {
  const body = Buffer.from(text, 'utf8'), n = body.length;
  const len = n < 0x81 ? Buffer.from([n]) : n < 0x10000 ? Buffer.concat([Buffer.from([0x81]), Buffer.from([n & 255, n >> 8])]) : Buffer.concat([Buffer.from([0x82]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; })()]);
  return Buffer.concat([prefix, len, body, Buffer.from([0x86, 0x84])]);
}

// ---- Beeper index.db ----
export function beeperIndex(file, rows, { fts = true, derived = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE mx_room_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, roomID TEXT NOT NULL, eventID TEXT NOT NULL, senderContactID TEXT NOT NULL, timestamp INTEGER NOT NULL,
      isEdited INTEGER NOT NULL, lastEditionTimestamp INTEGER, isDeleted INTEGER NOT NULL, inReplyToID TEXT, type TEXT NOT NULL DEFAULT 'TEXT', isSentByMe INTEGER NOT NULL, protocol TEXT, message JSON NOT NULL, text_content TEXT);
    CREATE TABLE threads (threadID TEXT, accountID TEXT); CREATE TABLE participants (room_id TEXT, id TEXT);
    INSERT INTO threads VALUES ('!r1:beeper.local','whatsapp'),('!r2:beeper.local','discordgo');
    INSERT INTO participants VALUES ('!r1:beeper.local','@a:beeper.local'),('!r1:beeper.local','@b:beeper.local');`);
  if (fts) db.exec('CREATE TABLE mx_room_messages_fts_content (id INTEGER, c0 TEXT)');
  if (derived) db.exec('CREATE TABLE message_derived_content (message_id INTEGER, text_content TEXT, source_type TEXT)');
  const put = db.prepare('INSERT INTO mx_room_messages (id,roomID,eventID,senderContactID,timestamp,isEdited,lastEditionTimestamp,isDeleted,inReplyToID,type,isSentByMe,protocol,message,text_content) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  rows.forEach((r, i) => {
    const id = r.id ?? i + 1;
    put.run(id, r.room ?? '!r1:beeper.local', r.eventID ?? `$e${id}`, r.sender ?? '@a:beeper.local', r.timestamp ?? 1790000000000 + id, r.isEdited ? 1 : 0, r.lastEdit ?? null, r.deleted ? 1 : 0, r.replyTo ?? null,
      r.type ?? 'TEXT', r.mine ? 1 : 0, r.protocol ?? null, typeof r.message === 'string' ? r.message : JSON.stringify(r.message ?? {}), r.textContent ?? null);
    for (const t of r.fts ?? []) if (fts) db.prepare('INSERT INTO mx_room_messages_fts_content VALUES (?,?)').run(id, t);
    for (const [t, kind] of r.ocr ?? []) if (derived) db.prepare('INSERT INTO message_derived_content VALUES (?,?,?)').run(id, t, kind);
  });
  db.close();
}

// ---- CallHistory, Photos ----
export function callsDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, ZUNIQUE_ID TEXT, ZDATE REAL, ZDURATION REAL, ZORIGINATED INTEGER, ZANSWERED INTEGER, ZCALLTYPE INTEGER, ZADDRESS TEXT, ZNAME TEXT, ZSERVICE_PROVIDER TEXT, ZISO_COUNTRY_CODE TEXT)');
  const put = db.prepare('INSERT INTO ZCALLRECORD VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  rows.forEach((r, i) => put.run(i + 1, r.id ?? `U-${i}`, r.date, r.duration ?? null, r.out ?? null, r.answered ?? null, r.type ?? 1, r.address ?? null, r.name ?? null, r.provider ?? null, r.cc ?? 'us'));
  db.close();
}
export function photosDb(file, rows, albums = []) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZDATECREATED REAL, ZLATITUDE REAL, ZLONGITUDE REAL, ZFAVORITE INTEGER, ZKIND INTEGER, ZADDEDDATE REAL);
    CREATE TABLE ZGENERICALBUM (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT); CREATE TABLE Z_28ASSETS (Z_28ALBUMS INTEGER, Z_3ASSETS INTEGER);`);
  rows.forEach((r, i) => db.prepare('INSERT INTO ZASSET VALUES (?,?,?,?,?,?,?,?)').run(i + 1, r.uuid ?? `P-${i}`, r.taken, r.lat ?? -180, r.lon ?? -180, r.fav ?? 0, r.kind ?? 0, r.added ?? null));
  albums.forEach(([pk, title, members]) => { db.prepare('INSERT INTO ZGENERICALBUM VALUES (?,?)').run(pk, title); for (const m of members) db.prepare('INSERT INTO Z_28ASSETS VALUES (?,?)').run(pk, m); });
  db.close();
}
