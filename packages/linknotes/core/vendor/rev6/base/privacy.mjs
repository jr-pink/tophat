// The private no-model list: people whose message bodies never reach a model.
// Allowed for them: storage, delivery, dedupe, timing, counts. Forbidden: a body
// in a prompt, summary, topic, excerpt or embedding.
//
// The roster is data (private-people.json beside this file, or the file named by
// LINKNOTES_PRIVATE_PEOPLE_FILE), read by Node and by base.py alike, so the two
// runtimes cannot drift. A roster that cannot be read throws: fail closed.
//
// Token rule: a space inside a token matches any run of non-alphanumerics
// (contact cards put an emoji between the words), and a match is bounded by a
// non-alphanumeric ([^\p{L}\p{N}]) or the string edge on both sides, so
// `quantumishly` and `zbuster052` are somebody else. `strict` tokens identify
// the person; `loose` ones (bare first names) only where the corpus is already
// theirs; `exactLabels` match a whole display label, never inside prose.
//
// The row filter is per message by SENDER, never per thread, and follows the
// person rather than the direction: the owner's own message in a one-to-one
// thread with them is withheld; the same message in a group is not. A row that
// merely mentions them is somebody else's sentence and is kept.
// Never: drop a whole artifact because one person is on the list, or log a body.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROSTER_FILE = fileURLToPath(new URL('./private-people.json', import.meta.url));
export const rosterFile = (env = process.env) => env.LINKNOTES_PRIVATE_PEOPLE_FILE || ROSTER_FILE;

/** Refuse a person that could match everything or nothing. */
export function validatePeople(people) {
  if (!Array.isArray(people)) throw new Error('privatePeople must be an array');
  const ids = new Set();
  for (const p of people) {
    if (!p || typeof p !== 'object') throw new Error('each private person must be an object');
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(p.id || '') || ids.has(p.id)) throw new Error('private person ids must be unique kebab-case');
    ids.add(p.id);
    const strict = Array.isArray(p.strict) ? p.strict : [];
    if (!strict.length || strict.some((t) => typeof t !== 'string' || t.trim().length < 3)) throw new Error(`private person ${p.id} needs strict tokens of at least three characters`);
    for (const key of ['loose', 'exactLabels', 'handles', 'phones', 'emails']) {
      if (p[key] !== undefined && (!Array.isArray(p[key]) || p[key].some((t) => typeof t !== 'string' || !t.trim()))) throw new Error(`private person ${p.id} ${key} must be non-empty strings`);
    }
  }
  return people;
}

export function loadRoster(file = rosterFile()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`private-people roster ${file} is unreadable: ${error.code || 'parse error'}`);
  }
  return validatePeople(Array.isArray(raw) ? raw : raw?.people);
}

/** The matching tokens for one E.164 number as `strict` carries them (same function as src/core/private-people.mjs). */
export function phoneTokens(e164) {
  const digits = String(e164).replace(/\D/gu, '');
  if (/^1\d{10}$/u.test(digits)) {
    const n = digits.slice(1);
    return [digits, n, `1 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`, `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`];
  }
  if (/^86\d{11}$/u.test(digits)) {
    const n = digits.slice(2);
    return [digits, n, `86 ${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}`, `${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}`];
  }
  return [digits];
}

/** What is wrong with a roster, as sentences; empty when it holds. A person with no number the gate can match is a
 * fail-open shape (chat.db names authors by number only), so each needs `phones` or a `noPhone` reason,
 * every number is E.164 and spelled out in `strict`, and every number and email resolves to its own person. */
export function registryProblems(people, reg = registry(people)) {
  const problems = [];
  const owners = new Map();
  for (const p of people) {
    const phones = p.phones || [];
    if (!phones.length && !p.noPhone) problems.push(`${p.id} has no phone number and no noPhone reason: chat.db would not recognise their rows`);
    for (const phone of phones) {
      if (!/^\+[1-9]\d{7,14}$/u.test(phone)) { problems.push(`${p.id} phone ${phone} is not E.164`); continue; }
      for (const t of phoneTokens(phone)) if (!(p.strict || []).includes(t)) problems.push(`${p.id} strict lacks ${t} for ${phone}`);
      const key = phone.replace(/\D/gu, '');
      if (owners.has(key) && owners.get(key) !== p.id) problems.push(`${phone} is listed for both ${owners.get(key)} and ${p.id}`);
      owners.set(key, p.id);
    }
    for (const v of [...phones, ...(p.emails || [])]) {
      const hit = reg.personIn(v);
      if (hit?.id !== p.id) problems.push(`${p.id} handle ${v} resolves to ${hit?.id ?? 'nobody'}`);
    }
  }
  return problems;
}

export const PRIVATE_PEOPLE = loadRoster();

const escape = (token) => token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '[^\\p{L}\\p{N}]+');
const patternCache = new Map();
/** The bounded matcher for one token. */
export function tokenPattern(token) {
  let rx = patternCache.get(token);
  if (!rx) { rx = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${escape(token)})(?:[^\\p{L}\\p{N}]|$)`, 'iu'); patternCache.set(token, rx); }
  return rx;
}

const text = (value) => String(value ?? '').trim();
const normLabel = (value) => text(value).toLowerCase().replace(/\s+/gu, ' ');
const strings = (values) => (Array.isArray(values) ? values : [values]).filter((v) => typeof v === 'string' && v);

/** A matcher over one list of people. */
export function registry(people = PRIVATE_PEOPLE) {
  const list = people.map((p) => ({ ...p, strict: p.strict || [], loose: p.loose || [], exactLabels: (p.exactLabels || []).map(normLabel) }));
  const tokensOf = (p, loose) => (loose ? [...p.strict, ...p.loose] : p.strict);
  const personIn = (values, { loose = false } = {}) => {
    const s = strings(values);
    if (!s.length) return null;
    const haystack = s.join('\n');
    return list.find((p) => tokensOf(p, loose).some((t) => tokenPattern(t).test(haystack))) || null;
  };
  const exactLabel = (value) => {
    const label = normLabel(value);
    return label ? list.find((p) => p.exactLabels.includes(label)) || null : null;
  };
  const tokensNamed = (p, v) => [...new Set([...p.strict, ...p.loose])].filter((t) => tokenPattern(t).test(v)).length;
  // A contact label naming TWO of one person's tokens is that person (a
  // surname-first card); a lone loose token is not. Labels only, never bodies.
  const identify = (value) => {
    const v = text(value);
    if (!v) return null;
    return personIn(v) || exactLabel(v) || list.find((p) => tokensNamed(p, v) >= 2) || null;
  };
  return { people: list, personIn, exactLabel, identify, isPerson: (values, options) => personIn(values, options) != null };
}

export const registryWith = (extra = []) => registry([...PRIVATE_PEOPLE, ...validatePeople(extra || [])]);
const DEFAULT = registry();

// ---- string questions --------------------------------------------------------

export const privatePersonIn = (values, options) => DEFAULT.personIn(values, options);
export const isPrivatePerson = (values, options) => privatePersonIn(values, options) != null;
export const privateExactLabel = (value) => DEFAULT.exactLabel(value);

/** The person a discrete party label (a whole name, not prose) is: exact label first, then tokens. */
export function privatePartyIn(values, options) {
  const list = strings(values);
  for (const v of list) { const exact = privateExactLabel(v); if (exact) return exact; }
  return privatePersonIn(list, options);
}

/** What a record may still carry once its body is withheld. */
export function privacyFor(person, body = '') {
  if (!person) return null;
  const b = typeof body === 'string' ? body : '';
  return {
    classification: 'private-contact', person: person.id, semantic_processing: 'forbidden',
    allowed_processing: ['storage', 'delivery', 'word-count', 'timing', 'dedupe'],
    wordCount: b.trim() ? b.trim().split(/\s+/u).length : 0, characters: b.length,
  };
}

export const privatePeopleLabel = () => PRIVATE_PEOPLE.map((p) => `${p.name} (${(p.handles || []).join(', ')})`).join('; ');

// ---- index rows and payloads -------------------------------------------------

export const GROUP_PREFIX = 'group: ';
export const COMMUNICATION_SOURCES = new Set(['imessage', 'bluebubbles-imessage', 'beeper']);

export function isCommunicationSource(source, extra = null) {
  const s = String(source || '');
  return COMMUNICATION_SOURCES.has(s) || /^gmail-/.test(s) || Boolean(extra && extra.has(s));
}

export const identifyPrivateParty = (value, reg = DEFAULT) => reg.identify(value);

/** Labels for listed people closed over a handle map: a handle that identifies them makes its card name identifying. */
export function privateLabelSet(handles, reg = DEFAULT) {
  const entries = handles instanceof Map ? [...handles] : Object.entries(handles || {});
  const labels = new Set();
  const add = (v) => { const t = text(v); if (t) labels.add(t); };
  for (const [h, name] of entries) if (reg.identify(h) || reg.identify(name)) { add(h); add(name); }
  for (const [h, name] of entries) if (labels.has(text(h)) || labels.has(text(name))) { add(h); add(name); }
  return labels;
}

export function isPrivateParty(value, labels, reg = DEFAULT) {
  const v = text(value);
  if (!v) return false;
  if (labels && labels.has(v)) return true;
  return reg.identify(v) != null;
}

/** Sender and counterparty of a TSV row (iMessage `at, who, chat, text`; others `ts, label, text, entry`), or null. */
export function rowParties(source, cols, extraSources = null) {
  if (source === 'imessage' || source === 'bluebubbles-imessage') {
    const chat = text(cols[2]);
    const group = chat.startsWith(GROUP_PREFIX);
    return { sender: cols[1], others: group ? [] : [chat], group };
  }
  if (source === 'beeper') {
    const m = /^\[([^\]]*)\]\s/u.exec(text(cols[2]));
    const title = m ? m[1].trim() : '';
    const group = /,| & /u.test(title);
    return { sender: cols[1], others: group || !title ? [] : [title], group };
  }
  if (/^gmail-/.test(String(source)) || (extraSources && extraSources.has(source))) return { sender: cols[1], others: [], group: false };
  return null;
}

/** True when this TSV row must not exist in a corpus a model reads. */
export function withholdRow(source, line, { labels, registry: reg = DEFAULT, sources = null } = {}) {
  const cols = Array.isArray(line) ? line : String(line ?? '').split('\t');
  const parties = rowParties(source, cols, sources);
  if (!parties) return false;
  if (isPrivateParty(parties.sender, labels, reg)) return true;
  if (parties.group) return false;
  return parties.others.some((o) => isPrivateParty(o, labels, reg));
}

/** True when a message payload must not be indexed; one-to-one means two or fewer parties, owner included. */
export function withholdMessage(payload, { labels, registry: reg = DEFAULT } = {}) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.privacy && payload.privacy.semantic_processing === 'forbidden') return true;
  const sender = payload.sender ?? payload.sender_name ?? payload.senderName ?? payload.from;
  if (isPrivateParty(sender, labels, reg)) return true;
  const recipients = Array.isArray(payload.recipients) ? payload.recipients : payload.recipients ? [payload.recipients] : [];
  const parties = new Set([sender, ...recipients].map(text).filter(Boolean));
  if (parties.size > 2) return false;
  return [...parties].some((p) => isPrivateParty(p, labels, reg));
}

// At the END of the module, after every const the check touches (temporal dead zone).
{
  const broken = registryProblems(PRIVATE_PEOPLE);
  if (broken.length) throw new Error(`private-people roster is broken, and a broken gate fails open: ${broken.join('; ')}`);
}
