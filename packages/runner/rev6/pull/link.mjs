// Pre-search linking: who the people named in his message are, settled mechanically before the automatic search runs.
//
// For each person-name in the message (a first name, a full name or an alias of a person entity, possessives stripped),
// the candidates are every person entity carrying that name; entities that share an identity (the same phone, email
// or handle) are one person. The candidates are then narrowed by tiers, in order, and the first tier that leaves
// exactly one person decides:
//   1 this conversation: people its earlier turns named (mentions in this chat's raw turns, which include an
//     event-born chat's arrival text) and the parties of the record an event chat was born from
//   2 recent correspondents: people with a message thread to or from him in the last 14 days (iMessage, Beeper, mail),
//     by identity
//   3 his Contacts: people with a Contacts card
//   4 the whole store
// A tier with two or more of the candidates stops the ladder as ambiguous (the tie is shown, never guessed); a tier
// with none passes to the next. No score, no model: a ladder of equalities, like rev6/push/identity.mjs resolve().
//
// A bare first name ("rohan") that two or more people carry is NOT laddered by recency or Contacts: it is ambiguous, with
// every candidate listed (name, numbers, hints), unless this chat already settled it. "Settled" counts only earlier mentions
// that were unambiguous (TRUSTED_METHODS: a unique name, a thread key, thread co-presence, a new entity, an explicit id),
// never a candidate/ambiguous row, a "mention" row (one derived from earlier mentions of the key, the way our own wrong pick
// became sticky) or a scored context guess. Full names still use the ladder.
//
// Reads memory.sqlite read-only with indexed queries (identities, mentions_thread, raw_author, raw_thread); measured in
// the lookup bench (bench/lookup).
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { findMyFor } from './findmy-link.mjs';
// identity.mjs (rev6/push) holds the private-people gate; loaded so that a broken push module (it is edited by other
// work) cannot take the runner's tools down with it. Without the gate, linking is off (fail closed), never ungated.
let identity = null;
try { identity = await import('../push/identity.mjs'); } catch { identity = null; }

const RECENT_DAYS = 14;
const MSG_SOURCES = String(process.env.TOPHAT_MESSAGING_SOURCES || 'imessage-history,beeper').split(',').map((s) => s.trim()).filter(Boolean);
// mentions.method values (rev6/push/identity.mjs resolve) that are a settled identity, not a guess or a carry-over.
export const TRUSTED_METHODS = ['name', 'thread-key', 'thread-copresence', 'new', 'interpreter-code'];
const TRUSTED_SQL = TRUSTED_METHODS.map((m) => `'${m}'`).join(',');
const SHOWN = 10;
// Words that are also first names in his store but are ordinary words in his messages ("grant letter", "will do").
const COMMON = new Set('email idk lol bruh pls someone future bunch also will may mark grant bill rose june april august art max pat ray sky hope faith joy rich dean chase frank sage ash bo dawn eve gene jack jade jay kit lane lee long love major miles page penny reed river rob rock sam sandy star summer sun tim todd van wade wang ward young yan amber angel august autumn bear bishop blue brook brooks cash cole cruz dale drew early ember ezra fox gray green hunter iris ivy jean jordan joy judge king lake lily march mason merry mint north oak ocean paris park parker pearl pierce prince queen rain ray rivers rusty scout shadow silver sterling stone storm tank trinity true victory wolf zen the and for with from that this what when about all any can new one our out you your his her its not but are was were has had did does done open close dm tophat claude yearn shop'.split(' '));
// Lowercase entries of the system word list are ordinary English ("bunch", "someone", "tasker"): a single-word name
// that is one counts only when he capitalised it or a candidate is someone with a messaging identity.
let dict = null;
function english() {
  if (dict) return dict;
  dict = new Set();
  try { for (const w of readFileSync('/usr/share/dict/words', 'utf8').split('\n')) if (w && w === w.toLowerCase()) dict.add(w); } catch { /* no word list */ }

  return dict;
}
const DETERMINER = /^(the|a|an|my|our|this|that|his|her|their)\s/u;
const norm = (t) => String(t ?? '').replace(/[\u2018\u2019]/gu, "'").toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').replace(/[^a-z0-9+@.' ]+/gu, ' ').replace(/\s+/gu, ' ').trim();
const nameKey = (t) => norm(t).replace(/'s\b/gu, '').replace(/'/gu, '');

let cached = null;
function open(dbPath) {
  if (cached?.path === dbPath) return cached;
  try { cached?.db.close(); } catch { /* gone */ }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  cached = { path: dbPath, db, index: null, indexAt: 0, stmts: new Map() };
  return cached;
}
const stmt = (h, sql) => { let s = h.stmts.get(sql); if (!s) { s = h.db.prepare(sql); h.stmts.set(sql, s); } return s; };

/** name key -> Set(entity id): every person entity's full name, first name and person-like aliases; rebuilt every 10 min. */
function nameIndex(h, now = Date.now()) {
  if (h.index && now - h.indexAt < 600_000) return h.index;
  const byName = new Map(), rows = new Map();
  const merged = new Map();
  for (const r of stmt(h, "SELECT id, merged_into FROM entities WHERE merged_into IS NOT NULL").all()) merged.set(r.id, r.merged_into);
  const head = (id) => { let x = id, n = 0; while (merged.has(x) && n++ < 20) x = merged.get(x); return x; };
  const add = (k, id) => { if (!k || k.length < 3 || COMMON.has(k) || DETERMINER.test(k) || /^\+?\d/u.test(k) || k.includes('@')) return; if (!byName.has(k)) byName.set(k, new Set()); byName.get(k).add(id); };
  for (const r of stmt(h, "SELECT id, name, aliases, name_status FROM entities WHERE type='person' AND merged_into IS NULL").all()) {
    let aliases = []; try { aliases = JSON.parse(r.aliases || '[]'); } catch { /* none */ }
    const name = String(r.name || '').replace(/\s*\([^)]*\)\s*/gu, ' ').trim();
    rows.set(r.id, { id: r.id, name: r.name, aliases, status: r.name_status });
    const first = nameKey(name).split(' ')[0];
    for (const n of [name, ...aliases]) {
      const k = nameKey(n);
      if (!k || /\d/u.test(k)) continue;
      const words = k.split(' ');
      // an alias is a name only when it is a full name or the entity's own first name ("calwater" on "Bill K" is not)
      if (n !== name && words.length === 1 && k !== first && !nameKey(name).split(' ').some((w) => w.length >= 3 && w.slice(0, 3) === k.slice(0, 3))) continue;
      if (words.length <= 3) add(k, r.id);
      if (n === name && words.length >= 2 && words.length <= 3 && /^[a-z]+$/u.test(words[0])) add(words[0], r.id);
    }
  }
  h.index = { byName, rows, head }; h.indexAt = now;
  return h.index;
}

/** Person-name mentions in the text: two-word full names first, then single names, each once. */
export function nameMentions(text, index, hasIdentity = () => true) {
  const words = nameKey(text).split(' ').filter(Boolean), out = [], used = new Set(), dictionary = english();
  const capital = new Set((String(text).match(/\b[A-Z][a-z]+/gu) || []).map((w) => w.toLowerCase()));
  const single = (w) => !dictionary.has(w) || capital.has(w) || [...index.byName.get(w)].some((id) => nameKey(index.rows.get(id)?.name).split(' ')[0] === w && hasIdentity(id));
  for (let i = 0; i + 1 < words.length; i++) { const k = `${words[i]} ${words[i + 1]}`; if (index.byName.has(k)) { out.push({ key: k, at: i }); used.add(i); used.add(i + 1); } }
  for (let i = 0; i < words.length; i++) if (!used.has(i) && index.byName.has(words[i]) && single(words[i]) && !out.some((o) => o.key === words[i])) out.push({ key: words[i], at: i });
  return out;
}

function identitiesOf(h, ids) {
  const out = [];
  for (const id of ids) for (const r of stmt(h, 'SELECT source, account, native, key, created_at FROM identities WHERE entity_id=?').all(id)) out.push({ ...r, entity: id });
  return out;
}

/** Candidates for a name, grouped into persons: entities sharing any identity key are one person. */
function persons(h, index, ids) {
  const list = [...ids].map(index.head), idents = identitiesOf(h, list);
  const parent = new Map(list.map((x) => [x, x]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const byKey = new Map();
  for (const r of idents) { if (!r.key || r.source === 'contacts') continue; const k = r.key; if (byKey.has(k)) parent.set(find(r.entity), find(byKey.get(k))); else byKey.set(k, r.entity); }
  const groups = new Map();
  for (const x of list) { const g = find(x); if (!groups.has(g)) groups.set(g, new Set()); groups.get(g).add(x); }
  return [...groups.values()].map((members) => {
    const m = [...members];
    // the display entity: a qualified one first, then the fullest name
    m.sort((a, b) => (index.rows.get(b)?.status === 'qualified') - (index.rows.get(a)?.status === 'qualified') || String(index.rows.get(b)?.name || '').split(' ').length - String(index.rows.get(a)?.name || '').split(' ').length);
    return { entity: m[0], members: m, name: index.rows.get(m[0])?.name || m[0], idents: idents.filter((r) => members.has(r.entity)) };
  });
}

function lastExchange(h, p, since, until) {
  let best = null;
  for (const r of p.idents) {
    if (r.source === 'contacts') continue;
    const native = String(r.native || ''), key = String(r.key || '');
    const forms = new Set([native]);
    if (key.startsWith('phone:')) { const d = key.slice(6); forms.add(`+1${d}`); forms.add(`+${d}`); }
    if (key.startsWith('email:')) forms.add(key.slice(6));
    for (const f of forms) {
      if (!f) continue;
      for (const src of MSG_SOURCES) {
        const a = stmt(h, 'SELECT MAX(occurred_at) t FROM raw_data WHERE source=? AND author=? AND occurred_at>=? AND occurred_at<=?').get(src, f, since, until)?.t;
        if (a && (!best || a > best.at)) best = { at: a, via: src, handle: f };
      }
      const t = stmt(h, "SELECT MAX(occurred_at) t FROM raw_data WHERE source='imessage-history' AND account='' AND thread=? AND occurred_at>=? AND occurred_at<=?").get(`imessage:${f}`, since, until)?.t;
      if (t && (!best || t > best.at)) best = { at: t, via: 'imessage-history', handle: f };
    }
  }
  return best;
}

/** The conversation's own context, as it stood at the question:
 *   named:   entities its earlier turns named UNAMBIGUOUSLY (TRUSTED_METHODS only), and, for a chat born from an event, entities named in the arrival's thread
 *            and that thread's parties (the wake text names "thread X" and "raw record r_...")
 */
function conversationContext(h, sessionId, at) {
  const named = new Set(), cut = new Date(Date.parse(at) - 1000).toISOString();
  if (!sessionId) return { named };
  for (const r of stmt(h, `SELECT DISTINCT entity_id FROM mentions WHERE source='webchat' AND thread=? AND at<? AND created_at<=? AND entity_id IS NOT NULL AND method IN (${TRUSTED_SQL})`).all(String(sessionId), cut, at)) named.add(r.entity_id);
  const threads = new Set(), raws = new Set();
  for (const r of stmt(h, "SELECT text FROM raw_data WHERE source='webchat' AND account='' AND thread=? AND occurred_at<? AND role='owner' AND text LIKE '[Automated event%' ORDER BY occurred_at LIMIT 20").all(String(sessionId), cut)) {
    for (const m of String(r.text).matchAll(/\bthread ([^\s;,]+)/gu)) threads.add(m[1]);
    for (const m of String(r.text).matchAll(/\br_[0-9a-f]{10,}\b/gu)) raws.add(m[0]);
  }
  for (const id of raws) {
    const r = stmt(h, 'SELECT thread, author, participants FROM raw_data WHERE id=?').get(id);
    if (!r) continue;
    if (r.thread) threads.add(r.thread);
    let parts = []; try { parts = JSON.parse(r.participants || '[]'); } catch { /* none */ }
    for (const n of [r.author, ...parts].filter(Boolean)) for (const e of stmt(h, 'SELECT entity_id FROM identities WHERE native=? AND created_at<=?').all(String(n), at)) named.add(e.entity_id);
  }
  for (const t of threads) for (const r of stmt(h, `SELECT DISTINCT entity_id FROM mentions WHERE thread=? AND at<? AND created_at<=? AND entity_id IS NOT NULL AND method IN (${TRUSTED_SQL}) LIMIT 200`).all(t, cut, at)) named.add(r.entity_id);
  return { named };
}

let people = null;
function privacy(env) {
  if (people) return people;
  const file = env.TOPHAT_PRIVATE_PEOPLE_FILE || join(new URL('../base/', import.meta.url).pathname, 'private-people.json');
  try { people = existsSync(file) ? identity.loadPeople(file) : {}; } catch { people = null; }
  return people;
}

/** Phone numbers a person is known by: phone: identity keys and phone-shaped aliases, as +E.164 (NANP assumed for 10 digits). */
function phonesOf(p, index) {
  const out = new Set(), add = (d) => { d = String(d).replace(/\D/gu, ''); if (d.length === 10) out.add(`+1${d}`); else if (d.length === 11 && d[0] === '1') out.add(`+${d}`); else if (d.length >= 11 && d.length <= 15) out.add(`+${d}`); };
  for (const r of p.idents) if (String(r.key || '').startsWith('phone:')) add(r.key.slice(6));
  for (const e of p.members) for (const a of index.rows.get(e)?.aliases || []) if (/^\+?[\d\s().-]{10,18}$/u.test(String(a))) add(a);
  return [...out].slice(0, 2);
}

const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
const shortDate = (iso) => String(iso || '').slice(0, 10);

/**
 * Link the people his message names. Returns {ms, links: [{name, status: 'resolved'|'ambiguous', tier, entity, display,
 * why, candidates, aliases}], line} where line is the one-line "Resolved: ..." for the top of the search context.
 * opts: {dbPath, sessionId, at (ISO, the question's instant), context (previous owner message, for event text), env}.
 */
export function linkPeople(text, { dbPath, sessionId = null, at = new Date().toISOString(), context = '', env = process.env, findmyDb } = {}) {
  const t0 = performance.now();
  if (!dbPath || !existsSync(dbPath)) return { ms: 0, links: [], line: '' };
  if (!identity || !privacy(env)) return { ms: 0, links: [], line: '', off: 'private-people gate unavailable' };
  const h = open(dbPath), index = nameIndex(h);
  const since = new Date(Date.parse(at) - RECENT_DAYS * 864e5).toISOString();
  const mentions = nameMentions(text, index, (id) => Boolean(stmt(h, "SELECT 1 FROM identities WHERE entity_id=? AND source NOT IN ('contacts','webchat') LIMIT 1").get(id)));
  const links = [];
  let convo = null;
  for (const m of mentions) {
    const ps = persons(h, index, index.byName.get(m.key));
    if (!ps.length) continue;
    const pick = (tier, keep, why) => ({ tier, keep, why });
    const bare = !m.key.includes(' ');
    let decided = null;
    if (ps.length === 1) decided = pick(4, ps, () => 'the only person by that name');
    else {
      convo ??= conversationContext(h, sessionId, at);
      const inChat = (p) => p.members.some((e) => convo.named.has(e));
      const recent = (p) => { p.last ??= lastExchange(h, p, since, at); return p.last; };
      const inContacts = (p) => p.idents.some((r) => r.source === 'contacts');
      const hint = (p) => [inChat(p) && 'named earlier in this chat', inContacts(p) && 'in your Contacts', recent(p) && `messaged ${days(at, p.last.at) <= 0 ? 'today' : shortDate(p.last.at)} via ${p.last.via}`].filter(Boolean).join(', ') || 'in the store';
      if (bare) {
        // a bare first name: only this chat's own unambiguous earlier resolution may pick; recency and Contacts only annotate
        const named = ps.filter(inChat);
        if (named.length === 1) decided = pick(1, named, () => 'named earlier in this chat, unambiguously');
        else decided = { tier: named.length ? 1 : 4, keep: [...ps].sort((a, b) => inContacts(b) - inContacts(a) || (inChat(b) - inChat(a)) || String(recent(b)?.at || '').localeCompare(String(recent(a)?.at || ''))), why: hint, bareAmbiguous: true };
      } else {
        const tiers = [
          [1, inChat, () => 'named earlier in this chat'],
          [2, (p) => Boolean(recent(p)), (p) => `messaged ${days(at, p.last.at) <= 0 ? 'today' : `${shortDate(p.last.at)}`} via ${p.last.via}, ${p.last.handle}`],
          [3, inContacts, () => 'in your Contacts'],
        ];
        for (const [tier, test, why] of tiers) {
          const keep = ps.filter((p) => test(p));
          if (keep.length) { decided = pick(tier, keep, why); break; }
        }
        decided ??= pick(4, ps, () => 'in the store');
      }
    }
    const pv = privacy(env);
    const visible = decided.keep.filter((p) => !identity.privateIn(pv, [p.name], ''));
    if (!visible.length) continue;
    const surface = m.key;
    if (visible.length === 1) {
      const p = visible[0], row = index.rows.get(p.entity);
      const link = { name: surface, status: 'resolved', tier: decided.tier, entity: p.entity, members: p.members, display: p.name, why: decided.why(p), aliases: row?.aliases || [], rivals: ps.filter((x) => x !== p).map((x) => ({ entity: x.entity, members: x.members, name: x.name })) };
      // Find My: bound display names (identities source 'findmy'), else the full name matched ignoring emoji and case.
      let bound = [];
      try { bound = p.members.flatMap((e) => stmt(h, "SELECT native FROM identities WHERE source='findmy' AND entity_id=?").all(e).map((r) => r.native)); } catch { bound = []; }
      link.findmy = findMyFor(link, bound, { findmyDb });
      links.push(link);
    } else {
      links.push({ name: surface, status: 'ambiguous', tier: decided.tier, candidates: visible.map((p) => ({ entity: p.entity, members: p.members, name: p.name, phones: phonesOf(p, index), contacts: p.idents.some((r) => r.source === 'contacts'), why: decided.why(p) })) });
    }
  }
  const parts = links.map((l) => (l.status === 'resolved' ? `${l.name} = ${l.display} (${l.why}${l.findmy ? `; ${l.findmy}` : ''})` : `${l.name} is ambiguous, ${l.candidates.length} people (not guessed; ask or use context): ${l.candidates.slice(0, SHOWN).map((c) => `${c.name}${c.phones?.length ? ` ${c.phones.join(' ')}` : ''} (${c.why})`).join(' | ')}${l.candidates.length > SHOWN ? ` | +${l.candidates.length - SHOWN} more` : ''}`));
  return { ms: Math.round((performance.now() - t0) * 10) / 10, links, line: parts.length ? `Resolved: ${parts.join('; ')}` : '' };
}
