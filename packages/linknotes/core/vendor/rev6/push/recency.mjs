// The dated pass of memory `search`: newest-first for latest-value questions, and every matching dated record for period,
// count and superlative questions, beside the relevance ranking.
//
// Why: `search` is a BM25 top-k with no notion of time, so "when did I last weigh myself" or "my current working weight"
// was answered from whichever older records the ranking returned, and "my average across my October weigh-ins" from a
// subset of them. Two causes, both general: nothing put the newest records about the topic in front of the answerer, and
// a record whose text never names its topic (a scale log "[08:00] 119 again" in a source named for bodyweight) is
// reachable only through its source name, which the full-text index lacks.
//
// The pass (no topic is special-cased):
//   topic      the query minus recency, aggregate, period and stop words.
//   about X    a record or note whose BM25 score is at least STRONG of the best score for the topic (raw_search and
//              mem_search), plus every raw record of a source whose name carries a topic word (see namedSources).
//              Visibility is the store's: the as-of cut, ELIGIBLE and the read policy (rawView, head).
//   period     a month ("October", "Oct 2026"; several months span first to last), YYYY-MM, YYYY-MM-DD, or this/last
//              week/month/year; a month without a year is the latest one at or before the anchor (the earlier of as_of and
//              the newest record), so an old corpus resolves to its own year.
//   ordering   a period, a count or a superlative (how many, average, best, worst, lowest...): every about-X item (inside the
//              period when one is named), oldest first, ahead of the ranked hits (up to WINDOW_CAP per kind, `complete` says
//              whether that was all); recency intent: the NEWEST about-X items first; otherwise the newest NEWEST_EXTRA records
//              and NEWEST_EXTRA_NOTES notes about X that the ranking missed are added after it (unkinded search with a derived
//              allowance) or take the places of its lowest-ranked hits (kinded or plain search, which keep their limit).
// (Replacing the lowest-ranked hits in the unkinded shape was measured and rejected: answers sat in those hits.)
import { ELIGIBLE } from './store.mjs';

// Self-contained (no import beyond the store) so the module can be copied beside any copy of store.mjs.
function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
}
/** The instant a local calendar day (YYYY-MM-DD) starts in `tz`. */
export function dayStart(day, tz) {
  if (!tz || tz === 'UTC') return new Date(`${day}T00:00:00.000Z`).toISOString();
  let ms = Date.parse(`${day}T00:00:00.000Z`);
  ms -= tzOffsetMs(ms, tz); ms = Date.parse(`${day}T00:00:00.000Z`) - tzOffsetMs(ms, tz);
  return new Date(ms).toISOString();
}

export const STRONG = 0.5;
export const NEWEST = 8;
export const NEWEST_EXTRA = 3;
export const NEWEST_EXTRA_NOTES = 2;
export const WINDOW_CAP = 100;
const SCAN = 2000;

const RECENCY = /\b(?:latest|last|current(?:ly)?|most recent|newest|recent(?:ly)?|now|lately|these days|nowadays|still|anymore|any more|today)\b/iu;
const SUPERLATIVE = /\b(?:best|worst|highest|lowest|max(?:imum)?|min(?:imum)?|most|least|fastest|slowest|longest|shortest|heaviest|lightest|biggest|smallest|peak|ever|record)\b/iu;
const AGGREGATE = /\b(?:how many|how much|how often|count|number of|average|avg|mean|median|total|sum|every|each|all (?:the|my)|across|per|times|frequency)\b/iu;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?:\s+(\d{4}))?\b/iu;
// lower-case "may", "mar", "jun" and the like are words, not months, unless a year follows
const monthWord = (m) => m && (m[2] || (m[1].length > 3 && !/^may$/iu.test(m[1])) || /^(?:May|Jan|Feb|Apr|Jul|Aug|Sep|Sept|Oct|Nov|Dec)$/u.test(m[1]));
const STOP = new Set(('a an and any are as at be been by can could did do does for from had has have how i i\'m i\'ve in into is it its me my mine of on or our over so that the their them then there these this those to up us was we were what when where which who whom why will with would you your u ' +
  'latest last current currently most recent newest recently now lately these days nowadays still anymore today ' +
  'many much often count number average avg mean median total sum every each all across per times frequency best worst highest lowest max maximum min minimum most least ever record peak ' +
  'week month year during since until between before after logged log entry entries record records myself what\'s whats tell show give find').split(/\s+/u));

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();
const localYmd = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return [+p.year, +p.month, +p.day];
};
const ymd = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.toISOString().slice(0, 10); };

/** The period a query names, as {since, until (exclusive), label}, or null. `anchorMs` stands for "now". */
export function periodOf(query, anchorMs, tz = 'UTC') {
  const q = String(query || '');
  const [ay, am, ad] = localYmd(anchorMs, tz);
  const span = (a, b, label) => ({ since: dayStart(a, tz), until: dayStart(b, tz), label });
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/u.exec(q);
  if (m) return span(`${m[1]}-${m[2]}-${m[3]}`, ymd(+m[1], +m[2], +m[3] + 1), `${m[1]}-${m[2]}-${m[3]}`);
  m = /\b(\d{4})-(\d{2})\b/u.exec(q);
  if (m && +m[2] >= 1 && +m[2] <= 12) return span(ymd(+m[1], +m[2], 1), ymd(+m[1], +m[2] + 1, 1), `${m[1]}-${m[2]}`);
  // Every month the query names ("between mid-October and early November"): the span from the first to the end of the last.
  const months = [...q.matchAll(new RegExp(MONTH_RE.source, 'giu'))].filter((x) => monthWord(x) && !(/^may$/iu.test(x[1]) && !x[2] && /\bmay (?:be|have|not|i|we|you|it)\b/iu.test(q)))
    .map((x) => { const mi = MONTHS.findIndex((n) => n.startsWith(x[1].toLowerCase().slice(0, 3))) + 1; return { mi, y: x[2] ? +x[2] : (mi <= am ? ay : ay - 1) }; })
    .sort((a, b) => a.y - b.y || a.mi - b.mi);
  if (months.length) {
    const a = months[0], b = months.at(-1), name = (x) => `${MONTHS[x.mi - 1][0].toUpperCase()}${MONTHS[x.mi - 1].slice(1)} ${x.y}`;
    return span(ymd(a.y, a.mi, 1), ymd(b.y, b.mi + 1, 1), a === b || (a.mi === b.mi && a.y === b.y) ? name(a) : `${name(a)} to ${name(b)}`);
  }
  if (/\bthis month\b/iu.test(q)) return span(ymd(ay, am, 1), ymd(ay, am + 1, 1), 'this month');
  if (/\blast month\b|\bprevious month\b/iu.test(q)) return span(ymd(ay, am - 1, 1), ymd(ay, am, 1), 'last month');
  const wd = (new Date(Date.UTC(ay, am - 1, ad)).getUTCDay() + 6) % 7; // Monday = 0
  if (/\bthis week\b/iu.test(q)) return span(ymd(ay, am, ad - wd), ymd(ay, am, ad - wd + 7), 'this week');
  if (/\blast week\b|\bprevious week\b/iu.test(q)) return span(ymd(ay, am, ad - wd - 7), ymd(ay, am, ad - wd), 'last week');
  if (/\bthis year\b/iu.test(q)) return span(ymd(ay, 1, 1), ymd(ay + 1, 1, 1), 'this year');
  if (/\blast year\b/iu.test(q)) return span(ymd(ay - 1, 1, 1), ymd(ay, 1, 1), 'last year');
  m = /\b(?:in|during|of|for)\s+(\d{4})\b/u.exec(q);
  if (m) return span(ymd(+m[1], 1, 1), ymd(+m[1] + 1, 1, 1), m[1]);
  return null;
}

/** What the query asks of time: {latest, aggregate, topic words, period}. */
export function searchIntent(query, anchorMs, tz = 'UTC') {
  const q = String(query || '');
  const period = periodOf(q, anchorMs, tz);
  // "last week" / "last month" name a period, not the latest item
  const latest = RECENCY.test(q.replace(/\blast\s+(?:week|month|year|night)\b/giu, ' '));
  const aggregate = AGGREGATE.test(q), superlative = SUPERLATIVE.test(q);
  const scrub = q.replace(new RegExp(MONTH_RE.source, 'giu'), (x, a, b) => (monthWord([x, a, b]) ? ' ' : x)).replace(/\b\d{4}(?:-\d{2}){0,2}\b/gu, ' ');
  const words = (scrub.toLowerCase().match(/[\p{L}\p{N}_'.-]+/gu) || []).map((w) => w.replace(/^[.'-]+|[.'-]+$/gu, '')).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d{1,2}$/u.test(w));
  return { latest, aggregate, superlative, period, topic: [...new Set(words)] };
}

/** Sources a topic word names: a word that IS a source name names only that source; otherwise a word of 4+ characters names a
 *  source when it equals one of the name's tokens (split at - : / _ . and spaces) or, from 5 characters, is part of one
 *  ("weigh" and "weight" name hevy-bodyweight; "hevy" names hevy and hevy-bodyweight). A source is kept when it was named
 *  exactly or when its naming words are at least half the topic: "bodyweight" or "weigh" is about the scale log, while in
 *  "hip thrust weight" the word "weight" qualifies a topic the text carries, so the scale log is not pulled in. */
export function namedSources(store, topic) {
  const all = store.all('SELECT DISTINCT source FROM raw_data').map((r) => String(r.source));
  const by = new Map(), exactly = new Set();
  const add = (src, w) => { if (!by.has(src)) by.set(src, new Set()); by.get(src).add(w); };
  for (const w of topic) {
    const exact = all.filter((s) => s.toLowerCase() === w);
    if (exact.length) { exact.forEach((s) => { add(s, w); exactly.add(s); }); continue; }
    for (const part of w.split(/[-:/_.]+/u).filter((x) => x.length >= 4)) {
      for (const s of all) if (s.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((t) => t.length >= 4 && (t === part || (part.length >= 5 && t.includes(part))))) add(s, w);
    }
  }
  return [...by].filter(([src, words]) => exactly.has(src) || words.size * 2 >= topic.length).map(([src]) => src);
}

/** The topic as an FTS expression: OR of its words; a word of 5+ characters (a trailing plural s dropped) is a prefix ("weigh"
 *  finds weight, weighed, weigh-in; "squats" finds squat). */
export function topicExpr(topic) {
  return topic.map((t) => t.replace(/"/gu, '""')).filter(Boolean).map((t) => { const stem = t.length >= 6 ? t.replace(/(?<=[^s])s$/u, '') : t; return stem.length >= 5 ? `"${stem}"*` : `"${t}"`; }).join(' OR ');
}

const strongCut = (rows) => { if (!rows.length) return []; const best = rows[0].score; return rows.filter((r) => r.score <= best * STRONG); };

/** About-X items (raw and notes) with their dates, newest first, optionally inside a period. */
export function aboutItems(store, topic, { asOf = null, period = null, kind = null } = {}) {
  const asOfIso = asOf || '9';
  const expr = topicExpr(topic.slice(0, 16));
  const items = new Map();
  const wantRaw = !kind || kind === 'raw', wantNotes = !kind || kind === 'note';
  if (wantRaw) {
    const win = period ? ' AND r.occurred_at >= :since AND r.occurred_at < :until' : '';
    const args = { as_of: asOfIso, n: SCAN, ...(period ? { since: period.since, until: period.until } : {}) };
    const rows = [];
    if (expr) rows.push(...strongCut(store.all(`SELECT r.*, bm25(raw_search) AS score, snippet(raw_search,1,'[',']','…',12) AS snip FROM raw_search s JOIN raw_data r ON r.id=s.id WHERE raw_search MATCH :q AND ${store.localOnlyCut} AND ${ELIGIBLE}${win} ORDER BY score LIMIT :n`, { ...args, q: expr })));
    const sources = namedSources(store, topic);
    if (sources.length) {
      const cap = period ? SCAN : NEWEST * 4;
      rows.push(...store.all(`SELECT r.* FROM raw_data r WHERE r.source IN (SELECT value FROM json_each(:src)) AND ${store.localOnlyCut} AND ${ELIGIBLE}${win} ORDER BY r.occurred_at DESC LIMIT :n`, { ...args, src: JSON.stringify(sources), n: cap }));
    }
    for (const r of rows) {
      if (items.has(`raw|${r.id}`)) continue;
      const view = store.rawView(r, false);
      if ('withheld' in view) continue;
      items.set(`raw|${r.id}`, { kind: 'raw', ...view, snippet: r.snip ?? clipText(r.text, 240), _at: r.occurred_at });
    }
  }
  if (wantNotes && expr) {
    const rows = strongCut(store.all("SELECT id, bm25(mem_search) AS score, snippet(mem_search,2,'[',']','…',12) AS snip FROM mem_search WHERE mem_search MATCH ? AND kind='note' ORDER BY score LIMIT ?", [expr, SCAN]));
    for (const r of rows) {
      if (items.has(`note|${r.id}`)) continue;
      const head = store.head('note', r.id);
      if (!head || !head.at || (asOf && head.at > asOf)) continue;
      if (period && !(head.at >= period.since && head.at < period.until)) continue;
      items.set(`note|${r.id}`, { kind: 'note', snippet: r.snip, ...head, _at: head.at });
    }
  }
  return [...items.values()].sort((a, b) => (a._at < b._at ? 1 : a._at > b._at ? -1 : 0));
}
function clipText(s, n) { s = String(s ?? ''); return s.length <= n ? s : `${s.slice(0, n)}…`; }

const keyOf = (h) => `${h.kind}|${h.id}`;
const strip = ({ _at, ...h }) => h;

/**
 * The search answer `base` (from hybridSearch) with the dated pass applied. Returns base unchanged when the query has no
 * topic words. `tz` resolves period names; `now` stands in for the clock (tests).
 */
export function withDatedPass(store, base, req, { tz = 'UTC', now = Date.now() } = {}) {
  if (!base || !Array.isArray(base.hits)) return base;
  const asOf = base.as_of || null;
  const newestRow = store.one(`SELECT MAX(occurred_at) AS t FROM raw_data r WHERE ${store.localOnlyCut} AND r.occurred_at <= :as_of`, { as_of: asOf || '9' });
  const anchor = Math.min(asOf ? Date.parse(asOf) : now, newestRow?.t ? Date.parse(newestRow.t) + DAY : now);
  const intent = searchIntent(req.query, anchor, tz);
  if (!intent.topic.length) return base;
  const kind = req.kind && ['raw', 'note'].includes(req.kind) ? req.kind : (req.kind ? 'skip' : null);
  if (kind === 'skip') return base;
  const all = aboutItems(store, intent.topic, { asOf, period: intent.period, kind });
  const shown = new Set(base.hits.map(keyOf));
  let hits, mode, added;
  if (intent.period || intent.aggregate || intent.superlative) {
    // A period, a count or a superlative needs every dated item about X (inside the period when one is named), not the top-k.
    const raw = all.filter((h) => h.kind === 'raw'), notes = all.filter((h) => h.kind === 'note');
    const front = [...raw.slice(0, WINDOW_CAP), ...notes.slice(0, WINDOW_CAP)].sort((a, b) => (a._at < b._at ? -1 : a._at > b._at ? 1 : 0)).map((h) => ({ ...strip(h), dated: intent.period ? 'in-period' : 'all-dated' }));
    const fk = new Set(front.map(keyOf));
    hits = [...front, ...base.hits.filter((h) => !fk.has(keyOf(h)))];
    mode = intent.period ? 'period' : 'all-dated'; added = front.filter((h) => !shown.has(keyOf(h))).length;
    return { ...base, hits, coverage: { ...base.coverage, dated: { mode, ...(intent.period ? { period: intent.period } : {}), about: intent.topic, matching_raw: raw.length, matching_notes: notes.length, shown_raw: Math.min(raw.length, WINDOW_CAP), shown_notes: Math.min(notes.length, WINDOW_CAP), complete: raw.length <= WINDOW_CAP && notes.length <= WINDOW_CAP, added } } };
  }
  // Not a period: the answer keeps search's size (limit raw hits plus the derived allowance, or limit hits in all), so the
  // newest items take the place of the lowest-ranked ones rather than growing the answer.
  const cov = base.coverage || {};
  const split = cov.derived !== undefined && cov.derived !== null;
  const caps = split ? { raw: cov.limit ?? 20, other: cov.derived } : { all: cov.limit ?? 20 };
  const dedupe = (xs) => { const seen = new Set(); return xs.filter((h) => !seen.has(keyOf(h)) && seen.add(keyOf(h))); };
  const isRaw = (h) => h.kind === 'raw';
  const mark = (xs) => xs.map((h) => ({ ...strip(h), dated: 'newest' }));
  if (intent.latest) {
    const front = mark(all.slice(0, NEWEST));
    hits = split ? [...dedupe([...front.filter(isRaw), ...base.hits.filter(isRaw)]).slice(0, caps.raw), ...dedupe([...front.filter((h) => !isRaw(h)), ...base.hits.filter((h) => !isRaw(h))]).slice(0, caps.other)]
      : dedupe([...front, ...base.hits]).slice(0, caps.all);
    hits = [...hits.filter((h) => h.dated), ...hits.filter((h) => !h.dated)];
    mode = 'newest-first';
  } else {
    const fresh = all.filter((h) => !shown.has(keyOf(h)));
    const exRaw = mark(fresh.filter(isRaw).slice(0, NEWEST_EXTRA)), exNotes = mark(fresh.filter((h) => h.kind === 'note').slice(0, NEWEST_EXTRA_NOTES));
    const room = (have, cap, n) => have.slice(0, Math.max(0, Math.min(have.length, cap - n)));
    if (split) {
      // unkinded with a derived allowance (the answerer's and the prefetch's shape): the newest are added after the ranking
      hits = [...base.hits.filter(isRaw), ...exRaw, ...base.hits.filter((h) => !isRaw(h)), ...exNotes];
    } else {
      const ex = [...exRaw, ...exNotes].sort((x, y) => (x.occurred_at || x.at) < (y.occurred_at || y.at) ? 1 : -1).slice(0, NEWEST_EXTRA);
      hits = [...room(base.hits, caps.all, ex.length), ...ex.slice(0, caps.all)];
    }
    mode = 'newest-appended';
  }
  added = hits.filter((h) => !shown.has(keyOf(h))).length;
  return { ...base, hits, coverage: { ...base.coverage, dated: { mode, about: intent.topic, about_items: all.length, newest_at: all[0]?._at ?? null, added } } };
}
