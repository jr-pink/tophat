// Beeper (WhatsApp, Signal, Discord, Slack bridged) from Beeper Desktop's own index (default
// ~/Library/Application Support/BeeperTexts/index.db, config.index for another path), opened mode=ro. Why the index and not
// the Client API: the API pages per chat and loses edits; the index has every row with a rowid and an edit stamp, so one
// cursor {rowid, edit_ms} catches new rows and edits alike. Records carry metadata.nativeMessageId = eventID and
// metadata.accountId (the bridge), revision "1" or the edit stamp. Text: the base column text_content is usually NULL;
// words are in the message JSON, the FTS content table and derived image OCR, merged by one extractor.
// Ported from an upstream adapter (VENDOR.json `ported`).
import os from 'node:os';
import path from 'node:path';
import { fail, hasTable, openRo, columnsOf } from '../lib/common.mjs';

export const KIND = 'beeper-index';
export const LIVE_INDEX = path.join(os.homedir(), 'Library/Application Support/BeeperTexts/index.db');

// Python's str.strip() set, so text hashes match records an earlier Python reader stored.
const PY_WS = '\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
const WS = new Set(PY_WS);
export function pyStrip(s) {
  const t = String(s); let a = 0, b = t.length;
  while (a < b && WS.has(t[a])) a++; while (b > a && WS.has(t[b - 1])) b--;
  return t.slice(a, b);
}
const str = (v) => (typeof v === 'string' ? pyStrip(v) : '');
const ENT = [['&nbsp;', ' '], ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"]];
function stripTags(html) {
  if (typeof html !== 'string') return '';
  let out = html.split('<br>').join('\n').split('<br/>').join('\n').split('<br />').join('\n').replace(/<[^>]+>/g, '');
  for (const [a, b] of ENT) out = out.split(a).join(b);
  return pyStrip(out);
}
// Python slices by code point, JS by UTF-16 unit; astral text must cut the Python way.
const cp = (s, n) => [...s].slice(0, n).join('');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * Every place a row keeps words: `m` is the parsed message JSON, `fts` the joined
 * FTS content, `ocr` the joined derived image text, `legacy` text_content.
 * Returns {text, basis}; text is null when no source had words (as in Python).
 */
export function beeperText(m, { fts = '', ocr = '', legacy = '' } = {}) {
  m = obj(m); const extra = obj(m.extra), basis = [];
  const body = str(m.text), formatted = stripTags(extra.sanitizedFormattedBody);
  const prc = extra.partialReactionContent, reaction = prc && typeof prc === 'object' && typeof prc.description === 'string' ? pyStrip(prc.description) : '';
  const picks = [[body, 'message.text'], [fts, 'fts_content'], [formatted, 'extra.sanitizedFormattedBody'], [pyStrip(legacy || ''), 'text_content'], [reaction, 'extra.partialReactionContent']];
  const [primary, from] = picks.find(([v]) => v) || ['', null];
  if (from) basis.push(from);
  const notes = [], seen = primary.toLowerCase();
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const cap = a.extra && typeof a.extra === 'object' && !Array.isArray(a.extra) ? str(a.extra.caption || '') : '';
    if (cap && !seen.includes(cap.toLowerCase())) notes.push(`[caption] ${cp(cap, 300)}`);
  }
  for (const l of Array.isArray(m.links) ? m.links : []) {
    if (!l || typeof l !== 'object' || Array.isArray(l)) continue;
    const bits = ['title', 'summary'].filter((k) => typeof l[k] === 'string' && pyStrip(l[k])).map((k) => pyStrip(l[k]));
    if (bits.length && !seen.includes(bits.join(' - ').toLowerCase())) notes.push(`[link] ${cp(bits.join(' - '), 300)}`);
  }
  if (ocr && !seen.includes(ocr.toLowerCase())) notes.push(`[image text] ${cp(ocr, 600)}`);
  basis.push(...notes.map((n) => n.slice(1, n.indexOf(']'))));
  const text = [primary, ...notes].filter(Boolean).join('\n');
  return { text: text || null, basis };
}

function auxReader(db) {
  const fts = hasTable(db, 'mx_room_messages_fts_content') ? db.prepare('SELECT c0 AS t FROM mx_room_messages_fts_content WHERE id=?') : null;
  const ocr = hasTable(db, 'message_derived_content') ? db.prepare("SELECT text_content AS t FROM message_derived_content WHERE message_id=? AND source_type<>'image_classification'") : null;
  const join = (st, id) => { if (!st) return ''; try { return pyStrip(st.all(id).filter((r) => r.t).map((r) => pyStrip(r.t)).join(' ')); } catch { return ''; } };
  return (id) => ({ fts: join(fts, id), ocr: join(ocr, id) });
}

const iso = (ms) => (ms && Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null);

/** One index row as a record (native identity in metadata), or {skip} when it has no usable time. */
export function rowRecord(row, { account, roster, aux }) {
  let m; try { m = JSON.parse(row.message); } catch { m = {}; }
  m = obj(m); const extra = obj(m.extra);
  const editedMs = row.lastEditionTimestamp || extra.lastEditionTimestamp || m.editedTimestamp;
  const edited = Boolean(row.isEdited) && Boolean(editedMs);
  const { text } = beeperText(m, { ...aux(row.id), legacy: row.text_content });
  let stamp = row.timestamp, derivedFrom = null;
  if (!stamp) for (const [v, label] of [[row.lastEditionTimestamp, 'lastEditionTimestamp'], [extra.lastEditionTimestamp, 'message.extra.lastEditionTimestamp'], [m.editedTimestamp, 'message.editedTimestamp']]) {
    if (v) { stamp = v; derivedFrom = label; break; }
  }
  const kind = extra.type || 'TEXT';
  const sender = m.senderID || row.senderContactID;
  const reply = m.linkedMessageID || row.inReplyToID;
  const revision = edited ? String(editedMs) : '1';
  if (!stamp || !Number.isFinite(Number(stamp))) return { skip: { rowid: row.id, eventID: row.eventID, reason: 'no-timestamp' } };
  return {
    id: `beeper:${row.eventID}`, revision, occurredAt: iso(stamp), threadId: row.roomID,
    text: row.isDeleted ? '' : (text || ''), participants: roster.length ? roster : [sender].filter(Boolean),
    metadata: {
      type: 'beeper-message', nativeMessageId: row.eventID, accountId: account, sender, kind,
      direction: row.isSentByMe ? 'outgoing' : 'incoming', indexRowid: row.id, deleted: Boolean(row.isDeleted),
      editedAt: edited ? iso(editedMs) : null, ...(derivedFrom ? { occurredDerivedFrom: derivedFrom } : {}),
      ...(reply ? (kind === 'REACTION' ? { reactsTo: reply } : { replyTo: reply }) : {}),
      attachments: (Array.isArray(m.attachments) ? m.attachments : []).filter((a) => a && typeof a === 'object')
        .map((a) => Object.fromEntries(['type', 'mimeType', 'fileName', 'isSticker'].filter((k) => a[k] != null).map((k) => [k, a[k]]))),
    },
  };
}

/** Rows above `rowid`, plus rows edited after `edit_ms`, in rowid order. */
export async function poll(source, { cursor = null } = {}) {
  const c = source.config ?? {}, file = c.index ?? LIVE_INDEX, limit = c.batchSize ?? 2000;
  const after = Number.isSafeInteger(cursor?.rowid) ? cursor.rowid : 0, editMs = cursor?.edit_ms ?? null;
  const db = openRo(file);
  try {
    if (!hasTable(db, 'mx_room_messages')) fail('unsupported-beeper-schema');
    const aux = auxReader(db), accounts = new Map();
    const threadStmt = db.prepare('SELECT accountID FROM threads WHERE threadID=?');
    const rosterStmt = db.prepare('SELECT id FROM participants WHERE room_id=? ORDER BY id');
    const accountOf = (room) => {
      if (!accounts.has(room)) accounts.set(room, { account: threadStmt.get(room)?.accountID || '', roster: rosterStmt.all(room).map((r) => r.id) });
      return accounts.get(room);
    };
    const rows = editMs == null
      ? db.prepare('SELECT * FROM mx_room_messages WHERE id>? ORDER BY id LIMIT ?').all(after, limit)
      : db.prepare('SELECT * FROM mx_room_messages WHERE (id>? OR (lastEditionTimestamp IS NOT NULL AND lastEditionTimestamp>?)) ORDER BY id LIMIT ?').all(after, editMs, limit);
    const records = [], skipped = [];
    let last = after, edits = editMs == null ? [] : [editMs];
    for (const row of rows) {
      const rec = rowRecord(row, { ...accountOf(row.roomID), aux });
      if (rec.skip) skipped.push(rec.skip); else { records.push(rec); if (rec.metadata.editedAt) edits.push(Date.parse(rec.metadata.editedAt)); }
      last = Math.max(last, row.id);
    }
    return { records, cursor: { rowid: last, edit_ms: edits.length ? Math.max(...edits) : null }, complete: rows.length < limit,
      health: { status: skipped.length ? 'partial' : 'ok', coverage: 'beeper-index', skipped } };
  } finally { db.close(); }
}

// ---- tools ----
/** Rows newest first as of an instant, matched anywhere words live (message JSON, FTS content, OCR). */
export function recent({ file = LIVE_INDEX, contact, query, since, asOf = new Date().toISOString(), limit = 20 } = {}) {
  const db = openRo(file);
  try {
    const where = ['m.timestamp <= ?'], args = [Date.parse(asOf)];
    if (since) { where.push('m.timestamp > ?'); args.push(Date.parse(since)); }
    if (contact) { where.push('(m.senderContactID LIKE ? OR EXISTS (SELECT 1 FROM participants p WHERE p.room_id = m.roomID AND p.id LIKE ?))'); args.push(`%${contact}%`, `%${contact}%`); }
    if (query) {
      const like = `%${query}%`, parts = ['m.message LIKE ?', 'm.text_content LIKE ?']; args.push(like, like);
      if (hasTable(db, 'mx_room_messages_fts_content')) { parts.push('EXISTS (SELECT 1 FROM mx_room_messages_fts_content fc WHERE fc.id = m.id AND fc.c0 LIKE ?)'); args.push(like); }
      if (hasTable(db, 'message_derived_content')) { parts.push('EXISTS (SELECT 1 FROM message_derived_content dc WHERE dc.message_id = m.id AND dc.text_content LIKE ?)'); args.push(like); }
      where.push(`(${parts.join(' OR ')})`);
    }
    const aux = auxReader(db);
    const rows = db.prepare(`SELECT m.id, m.roomID, m.eventID, m.timestamp, m.isSentByMe, m.senderContactID, m.protocol, m.text_content, m.message, t.accountID,
        (SELECT group_concat(p.id, ', ') FROM participants p WHERE p.room_id = m.roomID) AS participants
      FROM mx_room_messages m LEFT JOIN threads t ON t.threadID = m.roomID WHERE ${where.join(' AND ')} ORDER BY m.timestamp DESC LIMIT ?`)
      .all(...args, Math.min(Math.max(Number(limit) || 20, 1), 50));
    return rows.map((r) => {
      let m; try { m = JSON.parse(r.message); } catch { m = {}; }
      const t = beeperText(m, { ...aux(r.id), legacy: r.text_content });
      return { source: 'beeper', at: new Date(Number(r.timestamp)).toISOString(), author: r.isSentByMe ? 'owner' : (r.senderContactID || 'unknown'), chat: r.roomID,
        network: r.protocol || r.accountID || null, participants: r.participants ? r.participants.split(', ') : [], text: t.text || '', text_basis: t.basis.join('+') || null,
        native_id: String(r.id), event_id: r.eventID };
    });
  } finally { db.close(); }
}

/** Newest row and the share of the newest `sample` wordful rows that yield text: 0 means the pipe is broken, not that nothing was said. */
export function freshness({ file = LIVE_INDEX, asOf = new Date().toISOString(), sample = 300 } = {}) {
  const db = openRo(file);
  try {
    const r = db.prepare('SELECT MAX(timestamp) AS d, COUNT(*) AS n FROM mx_room_messages WHERE timestamp <= ?').get(Date.parse(asOf));
    const cols = columnsOf(db, 'mx_room_messages'), aux = auxReader(db);
    const skip = [cols.has('isDeleted') ? 'COALESCE(isDeleted,0)=0' : null, cols.has('type') ? "COALESCE(type,'TEXT') NOT IN ('REACTION','MEMBERSHIP')" : null].filter(Boolean);
    const rows = db.prepare(`SELECT id, message, text_content FROM mx_room_messages ${skip.length ? `WHERE ${skip.join(' AND ')}` : ''} ORDER BY timestamp DESC LIMIT ?`).all(sample);
    let withText = 0;
    for (const row of rows) { let m; try { m = JSON.parse(row.message); } catch { m = {}; } if (beeperText(m, { ...aux(row.id), legacy: row.text_content }).text) withText++; }
    const rate = rows.length ? withText / rows.length : null;
    return { newest_message_at: r?.d ? iso(r.d) : null, rows: r?.n ?? 0, as_of: asOf, text_extraction: { sampled: rows.length, with_text: withText, rate, ok: rate == null || rate >= 0.2 } };
  } finally { db.close(); }
}

/** Chat discovery through the Client API (loopback only, GET only): display titles for the tools. Messages never come from here. */
export async function discoverChats({ baseUrl = 'http://127.0.0.1:23373', token, fetch: fetcher = globalThis.fetch, pageSize = 100, maxPages = 10 } = {}) {
  const base = new URL(baseUrl);
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(base.hostname)) fail('beeper-loopback-required');
  const chats = []; let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams({ limit: String(pageSize) }); if (cursor) { q.set('cursor', cursor); q.set('direction', 'before'); }
    let res; try { res = await fetcher(`${base.origin}/v1/chats?${q}`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20000) }); } catch { fail('beeper-desktop-unavailable'); }
    if ([401, 403].includes(res.status)) fail('beeper-authorization-required');
    if (!res.ok) fail(`beeper-http-${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.items)) fail('invalid-beeper-response');
    chats.push(...body.items.map((c) => ({ id: c.id, title: typeof c.title === 'string' ? c.title.trim() || null : null, network: c.network ?? null })));
    if (!body.hasMore || !body.oldestCursor) return { chats, complete: true };
    cursor = body.oldestCursor;
  }
  return { chats, complete: false };
}
