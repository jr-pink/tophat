// Query understanding for the unified search: what a short, casual personal query means in this owner's corpus.
// Pure functions (the one corpus probe is injected), so every rule here has a test and the bench can switch each off.
//
//   1. A letter plus "day" ("bday", "b-day", "aday") is a training-day label in his own notes ("day B", "V2 day B" in
//      Hevy, "B day" in chat) at least as often as a birthday. Both senses are searched; the corpus counts say which
//   2. "the new one we made last week" is a reference to an earlier conversation with the assistant, not to a file:
//      it carries a date window and a "newest wins" preference, which the search uses to pick conversations by date.
import { localDate, ownerZone } from '../base/clock.mjs';
import { tokenize } from './terms.mjs';

const LETTER_DAY = /^([a-f])-?day$/u;
const DAY_LETTER = /^day-?([a-f])$/u;
// Words that say nothing about the topic once the search is over conversations and notes.
const FILLER = new Set(['new', 'newest', 'latest', 'old', 'older', 'last', 'week', 'weeks', 'month', 'yesterday', 'made', 'make', 'designed', 'design',
  'built', 'build', 'bruh', 'bro', 'dude', 'ago', 'recent', 'recently', 'earlier', 'one', 'ones', 'again', 'got', 'get', 'need', 'give', 'show', 'tell', 'find', 'look', 'see']);
// Dropped from every leg's words by queryWords (qclean piece); a query that is all glue keeps its words.
const GLUE = new Set(['wait', 'something', 'someone', 'anyone', 'anything', 'everyone', 'say', 'says', 'said', 'full', 'right', 'deal', 'bunch', 'pull', 'particular', 'specific',
  'actual', 'actually', 'wrong', 'stop', 'getting', 'telling', 'talk', 'keeps', 'figure', 'hes', 'shes', 'wheres']);

export const contentWords = (q) => tokenize(q).map((t) => t.term);

/** Topic words: content words minus the ones that only carry the time or the "we made it" frame. */
export const topicWords = (q) => contentWords(q).filter((w) => !FILLER.has(w));

/** The words of one memory search: the question's own topic words, minus chat glue, plus (only when the question is too thin to
 * stand alone, "55g?", "get the right bolts for it too") the topic words of the message before it. Context words are never added
 * to a question that already carries its own terms: they crowd the real ones out of a bounded OR query.
 */
export function queryWords(question, { context = '', thinBelow = 3, maxContext = 6 } = {}) {
  const own = topicWords(question), keep = own.filter((w) => !GLUE.has(w));
  const base = keep.length ? keep : own; // all glue: keep what was asked
  const extra = context && (base.length < thinBelow) ? topicWords(context).filter((w) => !GLUE.has(w)).slice(0, maxContext) : [];
  return { own: base, extra };
}

/**
 * Terms and phrases to search, and the sense decisions made on the way.
 * `probe(expression)` returns how many corpus rows an FTS expression matches (webchat transcripts); without it
 * the senses are listed unscored.
 */
export function expandQuery(q, { probe = null, extraWords = [], ownWords = null } = {}) {
  const words = [...new Set([...(ownWords || topicWords(q)), ...extraWords])];
  const terms = [], phrases = [], senses = [];
  for (const w of words) {
    const a = LETTER_DAY.exec(w) || DAY_LETTER.exec(w);
    if (!a) { terms.push(w); continue; }
    const letter = a[1], reads = [`${letter} day`, `day ${letter}`];
    phrases.push(...reads);
    terms.push(w); // the literal token stays: "golden bday" in a text is still a birthday
    const others = words.filter((x) => x !== w);
    const sense = { from: w, as: reads, alt: letter === 'b' ? 'birthday' : null };
    if (probe) {
      try {
        const side = (expr) => ({ all: probe(expr), withOthers: others.length ? probe(`(${expr}) AND (${others.map((o) => `"${o}"`).join(' OR ')})`) : null });
        sense.training = side(reads.map((r) => `"${r}"`).join(' OR '));
        if (sense.alt) sense.birthday = side(`"${sense.alt}"`);
      } catch { /* an unprobed sense is still searched */ }
    }
    senses.push(sense);
  }
  return { terms: [...new Set(terms)], phrases: [...new Set(phrases)], senses };
}

const rx = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** One regexp per query term (a sense group counts as one unit, satisfied by the label or either reading), for coverage scoring. */
export function coverageUnits(expansion) {
  const groups = new Map((expansion.senses || []).map((s) => [s.from, s]));
  return (expansion.terms || []).flatMap((t) => {
    const s = groups.get(t), any = [`\\b${rx(t.slice(0, Math.max(4, Math.min(t.length, 6))))}`];
    if (s) { any.length = 0; any.push(`\\b${rx(t)}`, ...s.as.map((p) => `\\b${rx(p).replace(/ /gu, '[\\s-]+')}\\b`)); }
    const unit = new RegExp(any.join('|'), 'iu');
    return s ? [unit, unit, unit] : [unit]; // a sense group is the specific part of the query: it counts three times
  });
}
export const coverage = (text, units) => (units.length ? units.filter((u) => u.test(text)).length / units.length : 0.5);

export function senseNote(senses) {
  return senses.map((s) => {
    const p = (x) => (x ? `${x.withOthers ?? x.all}${x.withOthers == null ? '' : ' with your other words'}` : 'n/a');
    return `"${s.from}" read as "${s.as[0]}" / "${s.as[1]}" (training day)${s.alt ? ` and as "${s.alt}"` : ''}; chat rows: training-day ${p(s.training)}${s.alt ? `, ${s.alt} ${p(s.birthday)}` : ''}`;
  }).join('; ');
}

// ---- time windows, in the owner's zone ------------------------------------------------------------------------
const DAY = 864e5;
function tzOffsetMs(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
/** UTC ms of local midnight at the start of the owner-local day `dayOffset` days from `nowMs`'s local date. */
export function localMidnight(nowMs, dayOffset, zone) {
  const [y, m, d] = localDate(new Date(nowMs).toISOString(), { TOPHAT_TIMEZONE: zone }).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d + dayOffset);
  let t = guess - tzOffsetMs(guess, zone);
  t = guess - tzOffsetMs(t, zone);
  return t;
}
const weekdayIndex = (nowMs, zone) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(new Date(nowMs)));

const COLLAB = /\b(?:we|you and i|u and i|us)\b[^.?!]{0,60}\b(?:made|designed|built|set up|wrote|came up with|decided|talked|discussed|planned|worked out|created|figured|landed on|did|had)\b|\b(?:you|u)\s+(?:made|gave|told|wrote|said|suggested|designed|sent|drafted)\b|\bour\s+(?:plan|design|version|draft|split|routine|decision|chat|conversation)\b|\blast time we\b|\bthe new (?:one|version|plan|split|routine)\b|\bwe (?:made|designed|did) (?:it|that|this)\b/iu;
const NEWEST = /\b(?:new|newest|latest|updated|current|final|revised|redesigned|most recent)\b/iu;

/**
 * {since, until, label, collab, newest} when the text carries a time reference or an "our earlier conversation" frame, else null.
 * since/until are ISO instants; the window is deliberately a little wide ("last week" is the previous calendar week plus a day each side).
 */
export function timeWindow(text, nowIso, env = process.env) {
  const t = String(text || ''), nowMs = Date.parse(nowIso), zone = ownerZone(env);
  if (!Number.isFinite(nowMs)) return null;
  const collab = COLLAB.test(t), newest = NEWEST.test(t);
  const iso = (ms) => new Date(ms).toISOString();
  const mk = (fromDay, toDay, label) => ({ since: iso(localMidnight(nowMs, fromDay, zone)), until: iso(localMidnight(nowMs, toDay, zone)), label, collab, newest });
  const wd = weekdayIndex(nowMs, zone); // Monday = 0
  let w = null;
  if (/\blast week\b|\bprevious week\b|\blast wk\b/iu.test(t)) w = mk(-wd - 8, -wd + 1, 'last week (previous calendar week, plus a day each side)');
  else if (/\bthis week\b/iu.test(t)) w = mk(-wd, 1, 'this week');
  else if (/\byesterday\b/iu.test(t)) w = mk(-1, 0, 'yesterday');
  else if (/\blast night\b/iu.test(t)) w = mk(-1, 1, 'last night');
  else if (/\b(?:earlier today|this morning|today)\b/iu.test(t)) w = mk(0, 1, 'today');
  else if (/\b(?:a few|couple|couple of|few) days ago\b|\bthe other day\b|\brecently\b/iu.test(t)) w = mk(-7, 0, 'the last week');
  else if (/\blast month\b/iu.test(t)) w = mk(-31, 1, 'last month');
  else if (/\b(\d{1,2}) days? ago\b/iu.test(t)) { const n = +/\b(\d{1,2}) days? ago\b/iu.exec(t)[1]; w = mk(-n - 1, -n + 2, `${n} days ago`); }
  if (!w && (collab || /\bwe (?:made|designed)\b/iu.test(t))) w = { since: iso(nowMs - 45 * DAY), until: iso(nowMs), label: 'the last 45 days (an earlier conversation is meant; no date given)', collab, newest };
  return w;
}

/** Owner-first-person lookups are personal; anything else may also go to the public web. */
export const PERSONAL = /\b(?:my|mine|me|myself|our|ours|we|us|i|i'm|ive|i've|u|you|your|remember|last time|earlier|yesterday|last week|bday|we made|before)\b|@|\d{3}[-. ]\d{3,4}/iu;
