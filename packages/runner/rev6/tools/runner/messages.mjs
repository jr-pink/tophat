import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeAttributedBody } from '../../sources/imessage.mjs';
import { privatePartyIn } from '../../base/privacy.mjs';
import { localStamp } from '../../base/clock.mjs';

const APPLE_EPOCH = 978307200;
const MAX_ROWS = 50;

export function messageSources(env = process.env) {
  const home = env.HOME || homedir();
  return {
    imessage: { id: 'imessage-history', label: 'local message database', path: env.TOPHAT_RUNNER_IMESSAGE_DB || '' },
    beeper: { id: 'beeper-history', label: 'bridged chat index', path: env.TOPHAT_RUNNER_BEEPER_INDEX || '' }
  };
}

export function messagesConfigured(env = process.env) {
  if (env.TOPHAT_RUNNER_MESSAGES === '0') return false;
  const s = messageSources(env);
  return existsSync(s.imessage.path) || existsSync(s.beeper.path);
}

export function sourcePolicy(env = process.env) {
  const file = env.TOPHAT_CONFIG || join(env.HOME || homedir(), '.config', 'tophat', 'config.json');
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    return Object.fromEntries((config.sources || []).map((s) => [s.id, s.enabled === true && s.policy?.model === 'allow' ? 'allow' : 'refused']));
  } catch { return {}; }
}

/** The private-person gate for one message, per author: the person whose words these are, or null.
 *
 * Three cases. A known OTHER speaker (a handle, plus the names the store holds for that handle) is judged alone,
 * so another person's words in a group a private person sits in stay readable; in a one-to-one the thread's own
 * label also counts, since the one other party is the author. the same words in a group with other people are
 * not. That follows `src/retrieval/private-rows.mjs` and `rev6/base/privacy.mjs`, which apply the owner's
 * instruction that the rule follows the person and not the direction; this function used to let the owner's side
 * through, so a thread with a private person read back as one-sided. An UNKNOWN speaker is placed by the chat: a
 * private person anywhere in the room (participants, their names, the title) withholds the row.
 *
 * `parties` is one array of labels per OTHER participant (id, full name, nickname); `participants` alone is the
 * same with one label each. A phone number is a label like any other, which is why the registry holds numbers:
 * chat.db names authors by number only. `judge` is the registry matcher (`privatePartyIn`); tests inject a
 * synthetic one, the runtime never does.
 */
export function privateSpeaker({ author, participants = [], parties = null, chat = null, authorLabels = [], threadLabels = [] }, judge = privatePartyIn) {
  const audience = parties || participants.map((p) => [p]);
  if (author === 'owner') {
    if (audience.length && audience.every((labels) => judge(labels))) return judge(audience[0]);
    if (audience.length <= 1) return judge([...threadLabels, chat || '']);
    return null;
  }
  if (author && author !== 'unknown') {
    const own = judge([author, ...authorLabels]);
    if (own) return own;
    // The only other party in a one-to-one is whoever writes there, so a title or chat label that names a private
    // person names the author too, even when the store keeps no name for the author's own id (a bare Discord id).
    return audience.length <= 1 ? judge([...threadLabels, chat || '']) : null;
  }
  return judge([...audience.flat(), ...threadLabels, chat || '']);
}

/**
 * Who a Beeper row is between, from the room's own tables: one label array per other participant (id, full name,
 * nickname), the names the sender goes by, and the thread title, which is the only thing naming a person on the
 * owner's side of a one-to-one chat. Columns a store lacks are skipped, never assumed. `cache` keeps one read per
 * room per call.
 */
export function beeperPartyGate(db, { roomID, senderContactID }, cache = new Map()) {
  if (!cache.has('#cols')) cache.set('#cols', { p: columnsOf(db, 'participants'), t: columnsOf(db, 'threads') });
  const cols = cache.get('#cols');
  if (!cache.has(roomID)) {
    const pick = (name) => (cols.p.has(name) ? name : `NULL AS ${name}`);
    let people = [];
    try { people = db.prepare(`SELECT id, ${pick('full_name')}, ${pick('nickname')}, ${pick('is_self')} FROM participants WHERE room_id = ?`).all(roomID); } catch { /* no participants table */ }
    let title = null;
    if (cols.t.has('thread')) { try { title = db.prepare('SELECT json_extract(thread, \'$.title\') AS title FROM threads WHERE threadID = ?').get(roomID)?.title ?? null; } catch { /* unreadable thread JSON */ } }
    cache.set(roomID, { people, title });
  }
  const { people, title } = cache.get(roomID);
  const labelsOf = (p) => [p.id, p.full_name, p.nickname].filter((v) => typeof v === 'string' && v);
  const others = people.filter((p) => !p.is_self);
  const me = people.find((p) => p.id === senderContactID);
  return { parties: others.map(labelsOf), authorLabels: me ? labelsOf(me).slice(1) : [], threadLabels: typeof title === 'string' && title ? [title] : [] };
}

export function messagesToolSpec() {
  const str = (description) => ({ type: 'string', description });
  return { name: 'messages_recent', description: 'Read current messages from this Mac\'s own stores (iMessage database, Beeper index), live, not from an index: the newest rows for a contact, a search phrase, or since a time, with each store\'s freshness (newest message time and age) as of the clock. Use it before saying a text does or does not exist, and quote texts from it verbatim. Withheld rows (private-person policy) are counted, not shown. Rows come newest first and are cut at limit (max 50 per store): read the TRUNCATED or coverage line at the top before saying a text does not exist, and page back with before (or read forward with order oldest) until the window you claim about is fully covered.',
    input_schema: { type: 'object', properties: { contact: str('phone number, email or handle fragment of the other party'), query: str('phrase to search in message text'), since: str('ISO instant; only messages after it'), before: str('ISO instant; only messages at or before it, to page back past a truncated result (pass the oldest shown time; that boundary row repeats, dedupe by native_id)'), order: str('newest (default, newest rows first) | oldest (the oldest rows after since first, to read a window forward)'), as_of: str('ISO instant; the stores as they stood then: only messages at or before it, freshness measured there (default: now)'), limit: { type: 'integer', description: 'max rows per store, default 20, max 50; a bigger value is cut to 50 and reported' }, source: str('imessage | beeper | both (default)') }, additionalProperties: false } };
}

function openRo(path) {
  if (!existsSync(path)) { const e = new Error('not present'); e.code = 'ENOENT'; throw e; }
  return new DatabaseSync(`file:${path}?mode=ro`, { readOnly: true });
}

const APPLE_SECS = 'CASE WHEN m.date > 100000000000 THEN m.date / 1000000000.0 ELSE m.date END';
const appleIso = (secs) => new Date((Number(secs) + APPLE_EPOCH) * 1000).toISOString();
const appleSecs = (iso) => Date.parse(iso) / 1000 - APPLE_EPOCH;
const ago = (iso, now) => { const m = Math.round((Date.parse(now) - Date.parse(iso)) / 60000); return m < 90 ? `${m} min` : m < 2880 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`; };
const readError = (error) => (error?.code === 'EPERM' || error?.code === 'EACCES' || /authorization denied|unable to open/i.test(error?.message || '')) ? 'not readable: this process lacks Full Disk Access (or the file is locked); freshness unknown'
  : error?.code === 'ENOENT' ? 'not present on this Mac' : `read failed: ${String(error?.message || error).slice(0, 120)}`;

export function freshness(env = process.env, now = new Date().toISOString(), asOf = now) {
  const sources = messageSources(env);
  const policy = sourcePolicy(env);
  const out = {};
  for (const [key, source] of Object.entries(sources)) {
    if (policy[source.id] !== 'allow') { out[key] = { label: source.label, refused: `no allow policy for ${source.id} in the owner config` }; continue; }
    try {
      const db = openRo(source.path);
      try {
        const row = key === 'imessage' ? db.prepare(`SELECT MAX(${APPLE_SECS}) AS d, COUNT(*) AS n FROM message m WHERE ${APPLE_SECS} <= ?`).get(appleSecs(asOf))
          : db.prepare('SELECT MAX(timestamp) AS d, COUNT(*) AS n FROM mx_room_messages WHERE timestamp <= ?').get(Date.parse(asOf));
        const newest = row?.d ? (key === 'imessage' ? appleIso(row.d) : new Date(Number(row.d)).toISOString()) : null;
        out[key] = { label: source.label, newest_message_at: newest, newest_message_at_local: newest ? localStamp(newest, env) : null, age: newest ? ago(newest, now) : null, rows: row?.n ?? 0, as_of: asOf };
      } finally { db.close(); }
    } catch (error) { out[key] = { label: source.label, error: readError(error), as_of: asOf }; }
  }
  return out;
}

export function freshnessLine(env = process.env, now = new Date().toISOString()) {
  const f = freshness(env, now);
  const parts = Object.values(f).map((s) => `${s.label}: ${s.refused ? s.refused : s.error ? s.error : s.newest_message_at ? `newest message ${s.newest_message_at} = ${s.newest_message_at_local} (${s.age} ago)` : 'empty'}`);
  return `[freshness as of ${now} = ${localStamp(now, env)}] ${parts.join('; ')}. Nothing after a store's newest message is visible to any search over it: say "not visible up to <time>", never "did not happen".`;
}

function imessageRows(db, { contact, query, since, before, order, asOf, limit }) {
  const where = [`${APPLE_SECS} <= ?`], args = [appleSecs(asOf)];
  if (before) { where.push(`${APPLE_SECS} < ?`); args.push(appleSecs(new Date(Date.parse(before) + 1).toISOString())); }
  if (since) { where.push(`${APPLE_SECS} + ? > ?`); args.push(APPLE_EPOCH, Math.floor(Date.parse(since) / 1000)); }
  if (contact) { where.push("EXISTS (SELECT 1 FROM chat_handle_join ch2 JOIN handle h2 ON h2.ROWID = ch2.handle_id WHERE ch2.chat_id = j.chat_id AND h2.id LIKE ?)"); args.push(`%${contact.replace(/[^\w@.+]/g, '')}%`); }
  if (query) { where.push("(m.text LIKE ? OR instr(m.attributedBody, CAST(? AS BLOB)) > 0)"); args.push(`%${query}%`, query); }
  const sql = `SELECT m.ROWID AS rowid, ${APPLE_SECS} AS secs, m.is_from_me, m.text, hex(m.attributedBody) AS body_hex, m.service, h.id AS sender, c.chat_identifier, c.display_name,
      (SELECT group_concat(h3.id, ', ') FROM chat_handle_join ch3 JOIN handle h3 ON h3.ROWID = ch3.handle_id WHERE ch3.chat_id = j.chat_id) AS participants
    FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = j.chat_id
    WHERE ${where.join(' AND ')} ORDER BY m.date ${order === 'oldest' ? 'ASC' : 'DESC'} LIMIT ?`;
  const matched = Number(db.prepare(`SELECT COUNT(*) AS n FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = j.chat_id WHERE ${where.join(' AND ')}`).get(...args).n);
  const rows = db.prepare(sql).all(...args, limit).map((r) => ({ source: 'imessage', at: appleIso(r.secs), author: r.is_from_me ? 'owner' : (r.sender || 'unknown'), chat: r.display_name || r.chat_identifier || null,
    participants: r.participants ? r.participants.split(', ') : [], text: r.text || (r.body_hex ? decodeAttributedBody(r.body_hex) : ''), service: r.service || null, native_id: String(r.rowid),
    // The handle on the message row names the other party even on the owner's own rows, and the chat identifier is the handle in a one-to-one: both go to the gate.
    gate: { parties: [...new Set([...(r.participants ? r.participants.split(', ') : []), r.sender].filter(Boolean))].map((h) => [h]), threadLabels: [r.display_name, r.chat_identifier].filter(Boolean) } }));
  return { rows, matched };
}

function beeperRows(db, { contact, query, since, before, order, asOf, limit }) {
  const where = ['m.timestamp <= ?'], args = [Date.parse(asOf)];
  if (before) { where.push('m.timestamp <= ?'); args.push(Date.parse(before)); }
  if (since) { where.push('m.timestamp > ?'); args.push(Date.parse(since)); }
  if (contact) { where.push('(m.senderContactID LIKE ? OR EXISTS (SELECT 1 FROM participants p WHERE p.room_id = m.roomID AND p.id LIKE ?))'); args.push(`%${contact}%`, `%${contact}%`); }
  if (query) { const q = beeperMatchClause(db, query, 'm'); where.push(q.sql); args.push(...q.args); }
  const j = beeperTextJoins(db, 'm');
  const sql = `SELECT m.id, m.roomID, m.timestamp, m.isSentByMe, m.senderContactID, m.protocol, m.text_content, m.message, t.accountID, ${j.select},
      (SELECT group_concat(p.id, ', ') FROM participants p WHERE p.room_id = m.roomID) AS participants
    FROM mx_room_messages m LEFT JOIN threads t ON t.threadID = m.roomID ${j.from} WHERE ${where.join(' AND ')} ORDER BY m.timestamp ${order === 'oldest' ? 'ASC' : 'DESC'} LIMIT ?`;
  const matched = Number(db.prepare(`SELECT COUNT(*) AS n FROM mx_room_messages m LEFT JOIN threads t ON t.threadID = m.roomID ${j.from} WHERE ${where.join(' AND ')}`).get(...args).n);
  const partyCache = new Map();
  const rows = db.prepare(sql).all(...args, limit).map((r) => {
    const extracted = beeperText(r);
    return { source: 'beeper', at: new Date(Number(r.timestamp)).toISOString(), author: r.isSentByMe ? 'owner' : (r.senderContactID || 'unknown'), chat: r.roomID, network: r.protocol || r.accountID || null,
      participants: r.participants ? r.participants.split(', ') : [], text: extracted.text, text_basis: extracted.basis.join('+') || null, native_id: String(r.id), gate: beeperPartyGate(db, r, partyCache) };
  });
  return { rows, matched };
}

export function recentMessages({ contact, query, since, before, order, as_of, limit, source } = {}, env = process.env, now = new Date().toISOString(), { judge = privatePartyIn } = {}) {
  const wanted = source === 'imessage' || source === 'beeper' ? [source] : ['imessage', 'beeper'];
  const wantedLimit = Math.max(Number(limit) || 20, 1);
  const cap = Math.min(wantedLimit, MAX_ROWS);
  const direction = order === 'oldest' ? 'oldest' : 'newest';
  if (order && order !== 'oldest' && order !== 'newest') return { error: `order "${order}" is not newest or oldest` };
  if (before && Number.isNaN(Date.parse(before))) return { error: `before "${before}" is not an ISO instant` };
  if (since && Number.isNaN(Date.parse(since))) return { error: `since "${since}" is not an ISO instant` };
  if (as_of && Number.isNaN(Date.parse(as_of))) return { error: `as_of "${as_of}" is not an ISO instant` };
  const asOf = as_of ? new Date(Date.parse(as_of)).toISOString() : now;
  // A contact argument that itself names a private person reads nothing at all: no query runs and no row is fetched,
  // so not even a count of their messages leaves the store. A fragment that does not name them (the last four digits)
  // still reaches their rows, and the per-row gate withholds those.
  const contactPerson = contact ? judge([String(contact)]) : null;
  if (contactPerson) {
    return { checked_at: now, checked_at_local: localStamp(now, env), as_of: asOf, stores: freshness(env, now, asOf), filters: { contact, query: query || null, since: since || null, before: before || null, order: direction }, coverage: {}, messages: [], withheld: 0,
      refused_contact: { person: contactPerson.id, reason: 'the contact is on the private no-model list; nothing was read' },
      note: 'The contact names a person on the private no-model list: their messages, in either direction, are never shown and nothing was read for this call.' };
  }
  const sources = messageSources(env);
  const policy = sourcePolicy(env);
  const stores = freshness(env, now, asOf);
  const messages = [];
  const coverage = {};
  let withheld = 0;
  for (const key of wanted) {
    if (policy[sources[key].id] !== 'allow' || stores[key]?.error) continue;
    try {
      const db = openRo(sources[key].path);
      try {
        if (key === 'beeper') {
          const health = beeperExtractionHealth(db);
          if (health) {
            stores[key] = { ...stores[key], text_extraction: health };
            const warn = extractionWarning(health);
            if (warn) stores[key].warning = warn;
          }
        }
        const read = (key === 'imessage' ? imessageRows : beeperRows)(db, { contact, query, since, before, order: direction, asOf, limit: cap });
        const ats = read.rows.map((r) => r.at).sort();
        coverage[key] = { label: stores[key]?.label || key, order: direction, matched: read.matched, returned: read.rows.length, not_shown: Math.max(read.matched - read.rows.length, 0),
          truncated: read.matched > read.rows.length, oldest_shown_at: ats[0] || null, newest_shown_at: ats[ats.length - 1] || null, limit_applied: cap, limit_requested: wantedLimit };
        for (const row of read.rows) {
          const { gate, ...shown } = row;
          if (privateSpeaker({ ...row, ...gate }, judge)) { withheld += 1; continue; }
          messages.push({ source: shown.source, at: shown.at, at_local: localStamp(shown.at, env), ...shown });
        }
      } finally { db.close(); }
    } catch (error) { stores[key] = { ...stores[key], error: readError(error) }; }
  }
  messages.sort((a, b) => (direction === 'oldest' ? (a.at < b.at ? -1 : 1) : (a.at < b.at ? 1 : -1)));
  return { checked_at: now, checked_at_local: localStamp(now, env), as_of: asOf, stores, filters: { contact: contact || null, query: query || null, since: since || null, before: before || null, order: direction }, coverage, messages, withheld,
    note: 'Texts are evidence from the owner\'s own stores as of as_of, quoted verbatim; "author: owner" is the owner, "author: unknown" is a row the store does not attribute (never assume it is the owner). withheld counts rows spoken by a private person. A store\'s newest_message_at bounds what any search can see. coverage says per store how many rows matched, how many are shown and the oldest and newest shown; rows are cut at the limit, so a claim that a text does not exist needs coverage that reaches the whole window. Compare days in the _local renderings.' };
}

/** The coverage of a result in words: a loud TRUNCATED line per store the limit cut, or one line saying the window is fully covered. */
export function coverageLines(result, stamp = (iso) => iso) {
  const cov = Object.entries(result.coverage || {});
  if (!cov.length) return [];
  const f = result.filters || {};
  const lines = [];
  for (const [key, c] of cov) {
    if (!c.truncated) continue;
    const oldestFirst = c.order === 'oldest';
    const edge = oldestFirst ? `showing the OLDEST ${c.returned} of ${c.matched} matching rows; newest shown ${stamp(c.newest_shown_at)}; ${c.not_shown} newer rows not shown`
      : `showing the NEWEST ${c.returned} of ${c.matched} matching rows; oldest shown ${stamp(c.oldest_shown_at)}${f.since ? `, requested since ${stamp(f.since)}` : ''}; ${c.not_shown} older rows not shown`;
    const next = oldestFirst ? `read on with since=${new Date(Date.parse(c.newest_shown_at) - 1).toISOString()} (the boundary row repeats; dedupe by native_id)`
      : `page back with before=${c.oldest_shown_at} (the boundary row repeats; dedupe by native_id), or order=oldest to read forward from since`;
    const capped = c.limit_requested > c.limit_applied ? ` The limit you asked for (${c.limit_requested}) was cut to ${c.limit_applied}.` : '';
    lines.push(`!! TRUNCATED (${c.label}): ${edge}. Coverage starts ${oldestFirst ? 'at the window start' : stamp(c.oldest_shown_at)}${!oldestFirst && f.since ? `, not ${stamp(f.since)}` : ''}; ${next}.${capped} Do not say a text does not exist from this window.`);
  }
  if (!lines.length) lines.push(`Coverage complete: every matching row in the window is shown (${cov.map(([, c]) => `${c.label} ${c.matched}`).join(', ')}).`);
  return lines;
}

/** Names from the owner's Contacts app, so a bare number or address in a message row reads as the person. Read-only,
 * once per call; a Mac without Contacts, or a locked database, yields no names and the raw handle stays.
 */
export function contactNameLookup(env = process.env) {
  const byPhone = new Map(); const byMail = new Map();
  const root = join(env.HOME || homedir(), 'Library', 'Application Support', 'AddressBook', 'Sources');
  try {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, 'AddressBook-v22.abcddb');
      if (!existsSync(file)) continue;
      let db;
      try {
        db = new DatabaseSync(file, { readOnly: true });
        const nameOf = (r) => [r.ZFIRSTNAME, r.ZLASTNAME].filter(Boolean).join(' ').trim() || r.ZORGANIZATION || null;
        for (const r of db.prepare('SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, p.ZFULLNUMBER AS v FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER').all()) {
          const key = String(r.v || '').replace(/\D/g, '').slice(-10); const name = nameOf(r);
          if (key.length >= 7 && name && !byPhone.has(key)) byPhone.set(key, name);
        }
        for (const r of db.prepare('SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, e.ZADDRESS AS v FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER').all()) {
          const key = String(r.v || '').toLowerCase(); const name = nameOf(r);
          if (key && name && !byMail.has(key)) byMail.set(key, name);
        }
      } catch { /* locked or unreadable card file: its people keep their raw handles */ } finally { try { db?.close(); } catch { /* already closed */ } }
    }
  } catch { /* no Contacts here */ }
  return (handle) => {
    const h = String(handle || '').trim();
    if (!h) return null;
    if (h.includes('@') && !h.startsWith('@')) return byMail.get(h.toLowerCase()) || null;
    const digits = h.replace(/\D/g, '');
    return /^\+?[\d\s().-]{7,}$/.test(h) && digits.length >= 7 ? byPhone.get(digits.slice(-10)) || null : null;
  };
}

export function messagesText(result, env = process.env, nameOf = null) {
  const nameFor = nameOf || contactNameLookup(env);
  const labelled = (h) => { const n = h && h !== 'owner' && h !== 'unknown' ? nameFor(h) : null; return n ? `${n} (${h})` : h; };
  const stamp = (iso) => (iso ? localStamp(iso, env) || iso : null);
  const f = result.filters || {};
  const head = [`messages as of ${stamp(result.as_of) || result.as_of || 'now'}`, f.contact ? `contact ${f.contact}` : null,
    f.query ? `query "${f.query}"` : null, f.since ? `since ${stamp(f.since) || f.since}` : null, f.before ? `before ${stamp(f.before) || f.before}` : null, f.order === 'oldest' ? 'oldest first' : null,
    `${(result.messages || []).length} shown`, Object.values(result.coverage || {}).some((c) => c.truncated) ? 'TRUNCATED, see below' : null,
    result.refused_contact ? 'REFUSED: the contact is on the private no-model list, nothing was read' : null,
    result.withheld ? `${result.withheld} withheld: spoken by a private person, counted not shown` : null];
  const stores = Object.values(result.stores || {}).map((s) => `${s.label}: ${s.refused || s.error
    || (s.newest_message_at ? `newest message ${s.newest_message_at} = ${s.newest_message_at_local || stamp(s.newest_message_at)} (${s.age} ago), ${s.rows} rows` : 'empty')}${s.warning ? `\n  !! ${s.warning}` : ''}`);
  const rows = (result.messages || []).map((m) => {
    const who = [labelled(m.author), m.chat && m.chat !== m.author ? `in ${labelled(m.chat)}` : null].filter(Boolean).join(' ');
    const line = [`${m.source} ${m.native_id}`, m.at_local || stamp(m.at), who, m.network || m.service].filter(Boolean).join(' | ');
    const text = String(m.text ?? '');
    return `${line}\n${text ? text.split('\n').map((l) => (l ? `    ${l}` : '')).join('\n') : '    (no text: an attachment or a reaction)'}`;
  });
  return [`[${head.filter(Boolean).join(' | ')}]`, ...coverageLines(result, stamp), ...stores,
    'Nothing after a store\'s newest message is visible to a search over it: say "not visible up to <time>", never "did not happen". One line per message below (store native_id | owner-local time | author in chat | network) with its text verbatim, indented four spaces; author "owner" is the owner, "unknown" is a row the store does not attribute.',
    '', rows.length ? rows.join('\n') : 'no messages matched.'].join('\n');
}

function hasTable(db, name) {
  try { return !!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name); } catch { return false; }
}

function columnsOf(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); } catch { return new Set(); }
}

export function beeperTextTables(db) {
  return { fts: hasTable(db, 'mx_room_messages_fts_content'), derived: hasTable(db, 'message_derived_content') };
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const stripTags = (html) => text(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);

export function messageJsonText(parsed) {
  const m = parsed && typeof parsed === 'object' ? parsed : {};
  const extra = m.extra && typeof m.extra === 'object' ? m.extra : {};
  const body = text(m.text);
  const formatted = stripTags(extra.sanitizedFormattedBody);
  const reaction = text(extra.partialReactionContent?.description);
  const captions = [], files = [], links = [];
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    if (!a || typeof a !== 'object') continue;
    const caption = text(a.extra?.caption);
    if (caption) captions.push(caption);
    const name = text(a.fileName);
    if (name) files.push(name);
  }
  for (const l of Array.isArray(m.links) ? m.links : []) {
    if (!l || typeof l !== 'object') continue;
    const bits = [text(l.title), text(l.summary)].filter(Boolean);
    if (bits.length) links.push(bits.join(' - '));
  }
  return { body, formatted, reaction, captions, files, links };
}

export function beeperText(row = {}) {
  let parsed = null;
  if (row.message && typeof row.message === 'object') parsed = row.message;
  else { try { parsed = JSON.parse(row.message || '{}'); } catch { parsed = null; } }
  const f = messageJsonText(parsed);
  const fts = text(row.fts_text);
  const legacy = text(row.text_content);
  const derived = text(row.derived_text);

  const basis = [];
  let primary = '';
  if (f.body) { primary = f.body; basis.push('message.text'); }
  else if (fts) { primary = fts; basis.push('fts_content'); }
  else if (f.formatted) { primary = f.formatted; basis.push('extra.sanitizedFormattedBody'); }
  else if (legacy) { primary = legacy; basis.push('text_content'); }
  else if (f.reaction) { primary = f.reaction; basis.push('extra.partialReactionContent'); }

  const notes = [];
  const seen = primary.toLowerCase();
  for (const c of f.captions) if (!seen.includes(c.toLowerCase())) notes.push(`[caption] ${clip(c, 300)}`);
  for (const l of f.links) if (!seen.includes(l.toLowerCase())) notes.push(`[link] ${clip(l, 300)}`);
  if (derived && !seen.includes(derived.toLowerCase())) notes.push(`[image text] ${clip(derived, 600)}`);
  if (!primary && !notes.length) for (const n of f.files) notes.push(`[file] ${n}`);
  if (notes.length) basis.push(...notes.map((n) => n.slice(1, n.indexOf(']'))));

  const out = [primary, ...notes].filter(Boolean).join('\n');
  return { text: out, primary, basis, empty: !out };
}

export function beeperTextJoins(db, alias = 'm') {
  const t = beeperTextTables(db);
  const select = [], from = [];
  if (t.fts) { select.push('fts.c0 AS fts_text'); from.push(`LEFT JOIN mx_room_messages_fts_content fts ON fts.id = ${alias}.id`); }
  else select.push('NULL AS fts_text');
  if (t.derived) select.push(`(SELECT group_concat(d.text_content, ' ') FROM message_derived_content d WHERE d.message_id = ${alias}.id AND d.source_type <> 'image_classification') AS derived_text`);
  else select.push('NULL AS derived_text');
  return { select: select.join(', '), from: from.join(' '), tables: t };
}

export function beeperMatchClause(db, needle, alias = 'm') {
  const t = beeperTextTables(db);
  const like = `%${needle}%`;
  const parts = [`${alias}.message LIKE ?`, `${alias}.text_content LIKE ?`];
  const args = [like, like];
  if (t.fts) { parts.push(`EXISTS (SELECT 1 FROM mx_room_messages_fts_content fc WHERE fc.id = ${alias}.id AND fc.c0 LIKE ?)`); args.push(like); }
  if (t.derived) { parts.push(`EXISTS (SELECT 1 FROM message_derived_content dc WHERE dc.message_id = ${alias}.id AND dc.text_content LIKE ?)`); args.push(like); }
  return { sql: `(${parts.join(' OR ')})`, args };
}

export function beeperExtractionHealth(db, { sample = 300 } = {}) {
  const j = beeperTextJoins(db, 'm');
  const cols = columnsOf(db, 'mx_room_messages');
  const skip = [cols.has('isDeleted') ? 'COALESCE(m.isDeleted, 0) = 0' : null,
    cols.has('type') ? `COALESCE(m.type, 'TEXT') NOT IN ('REACTION', 'MEMBERSHIP')` : null].filter(Boolean);
  let rows;
  try {
    rows = db.prepare(`SELECT m.id, m.message, m.text_content, ${j.select} FROM mx_room_messages m ${j.from}
      ${skip.length ? `WHERE ${skip.join(' AND ')}` : ''}
      ORDER BY m.timestamp DESC LIMIT ?`).all(sample);
  } catch { return null; }
  if (!rows.length) return { sampled: 0, with_text: 0, rate: null, ok: true };
  const withText = rows.filter((r) => !beeperText(r).empty).length;
  const rate = withText / rows.length;
  return { sampled: rows.length, with_text: withText, rate: Number(rate.toFixed(3)), ok: rate >= 0.2, tables: j.tables };
}

export function extractionWarning(health) {
  if (!health || health.ok || health.sampled === 0) return null;
  return `TEXT EXTRACTION BROKEN: only ${health.with_text} of the newest ${health.sampled} Beeper rows yielded any text (${Math.round(health.rate * 100)}%). `
    + 'This store is not searchable right now; "no messages matched" here means the reader is broken, not that the message does not exist. '
    + 'Beeper keeps text in message JSON, mx_room_messages_fts_content and message_derived_content, never in mx_room_messages.text_content.';
}
