// Ranking: how a term matches, how a corpus's candidate lines are ranked and
// cut, which line of a document is quoted, and how the pooled `=== best` block
// is scored. Ported from src/retrieval/select.mjs with one change: every sort
// ends on a total key (input index over inputs sorted by path), so equal
// scores can no longer reorder between runs. The old fanout gave different
// top-10s for the same question on 9 of 20 runs (design doc section 02).
export const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Short alphanumeric terms are word-bounded; dotted numbers digit-bounded.
export const bounded = (w) => /^\d+(?:\.\d+)+$/.test(w)
  ? `(^|[^0-9])${esc(w)}([^0-9]|$)`
  : (/^[a-z0-9]+$/i.test(w) && w.length <= 4 ? `\\b${esc(w)}\\b` : esc(w));

export const DF_SAMPLE = 4000;
export const PHRASE_WEIGHT = 1;

/** Every matcher for one query, compiled once so retrieval and scoring agree. */
export function matchers(words, { phrases = [] } = {}) {
  const rx = (w) => new RegExp(bounded(w), 'i');
  const RX = new Map(words.map((w) => [w, rx(w)]));
  const score = (l) => words.filter((w) => RX.get(w).test(l)).length;
  const PH = (phrases || []).filter(([a, b]) => RX.has(a) && RX.has(b))
    .map(([a, b]) => ({ a, b, re: new RegExp(`${esc(a)}[\\W_]{0,3}${esc(b)}`, 'i') }));
  // log(1 + N/(1+df)) over the candidates being ranked, sampled.
  // gate(i, t): false only when docs[i] cannot match term t (a cheaper superset test), so the regex is skipped there
  const idfOver = (docs, gate = null) => {
    const sample = docs.length > DF_SAMPLE ? docs.slice(0, DF_SAMPLE) : docs;
    const N = sample.length || 1, w = new Map();
    for (const t of words) { const re = RX.get(t); let df = 0; for (let i = 0; i < sample.length; i++) if ((!gate || gate(i, t)) && re.test(sample[i])) df++; w.set(t, Math.log(1 + N / (1 + df))); }
    return w;
  };
  const phraseBonus = (l, w) => PH.reduce((a, p) => a + (p.re.test(l) ? PHRASE_WEIGHT * ((w.get(p.a) || 0) + (w.get(p.b) || 0)) : 0), 0);
  const scoreW = (l, w) => words.reduce((a, t) => a + (RX.get(t).test(l) ? w.get(t) : 0), 0) + phraseBonus(l, w);
  // Centred on the first term: the answer sits mid-line on exactly the long lines.
  const snippet = (l, width = 240) => {
    if (l.length <= width) return l;
    let at = -1;
    for (const w of words) { const i = l.search(new RegExp(esc(w), 'i')); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (at < 0) return l.slice(0, width);
    const start = Math.max(0, at - Math.floor(width / 3));
    return (start ? '...' : '') + l.slice(start, start + width) + (start + width < l.length ? '...' : '');
  };
  return { words, rx, RX, score, idfOver, scoreW, snippet, phrases: PH.map((p) => [p.a, p.b]) };
}

/** Rank, then keep the best tier: within one heavy term of the best, and at least one term. */
export function rank(lines, m, { full = false, adjust = null } = {}) {
  const { words, score, scoreW, idfOver } = m;
  const wts = idfOver(lines);
  const maxWeight = words.length ? Math.max(...words.map((t) => wts.get(t) || 0)) : 1;
  const adj = typeof adjust === 'function' ? (l) => adjust(l, maxWeight) : () => 0;
  const scored = lines.map((l, i) => ({ l, i, s: scoreW(l, wts) + adj(l), n: score(l) })).sort((a, b) => b.s - a.s || a.i - b.i);
  if (full || words.length < 2 || !scored.length) return scored.map((x) => x.l);
  const best = scored[0].s, maxW = Math.max(...words.map((t) => wts.get(t)));
  const floor = Math.max(best - maxW, best * 0.34);
  return scored.filter((x) => x.s >= floor && x.n >= 1).map((x) => x.l);
}

export function rankedWithTotal(lines, m, cap, opts = {}) {
  const ranked = rank(lines, m, opts), shown = cap > 0 ? ranked.slice(0, cap) : ranked;
  return { lines: shown, shown: shown.length, ranked: ranked.length, matched: lines.length, cut: shown.length < ranked.length };
}

// ---- what a timestamped row is beyond its words: age and bulk ----------------
export function rowTime(line) {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(line || '').slice(0, 220));
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:00Z`);
  return Number.isFinite(t) ? t : null;
}
export const BULK_MARKERS = /unsubscribe|view (?:this|the) (?:post|email|message) (?:on|in) (?:the web|a browser)|view in browser|manage (?:your )?(?:email )?preferences|email preferences|opt[- ]?out|privacy policy|no-?reply@|do-?not-?reply@|newsletter|t\.co\/|utm_(?:campaign|medium|source)/i;
export const DATED_QUERY = /\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\blast (year|month|summer|winter)\b/i;

/** Newer is better, bulk is worse, both as fractions of the heaviest term; off for a dated question. */
export function rowAdjust({ now = Date.now(), recency = 0.45, bulk = 0.5, halfLifeDays = 400, dated = false } = {}) {
  return (line, maxWeight = 1) => {
    let s = 0;
    if (!dated && recency) { const t = rowTime(line); if (t) s += recency * maxWeight * Math.exp(-Math.max(0, (now - t) / 86400000) / halfLifeDays); }
    if (bulk && BULK_MARKERS.test(String(line))) s -= bulk * maxWeight;
    return s;
  };
}

// ---- documents --------------------------------------------------------------
export const MONEY_QUESTION = /\b(much|cost|costs?|pay|paid|paying|rate|rates|price|priced|fee|fees|salary|owe|owed|charge|charges|budget|invoice|amount)\b/i;
export const FIGURE = /\$\s?[\d,]+(\.\d+)?|\b\d[\d,]*(\.\d+)?\s*(usd|dollars|%)\b/i;
export const PERIODIC = /\b(rate|week|weekly|month|monthly|year|yearly|annual|annually|hour|hourly|day|daily|total|fee|per)\b/i;

/** One or two lines worth quoting; a money question spends one slot on a figure. */
export function bestLines(text, m, { money = false, width = 420 } = {}) {
  const { score, snippet } = m;
  const raw = text.split('\n'), seen = new Set(), lines = [];
  raw.forEach((r, i) => { const l = r.trim(); if (l.length > 12 && !seen.has(l)) { seen.add(l); lines.push({ l, i }); } });
  const picked = lines.map((x) => ({ ...x, s: score(x.l) })).filter((x) => x.s).sort((a, b) => b.s - a.s).slice(0, money ? 1 : 2);
  if (money) {
    const fig = lines.filter((x) => FIGURE.test(x.l)).map((x) => ({ ...x, s: score(x.l) * 2 + (PERIODIC.test(x.l) ? 1 : 0) })).sort((a, b) => b.s - a.s)[0];
    if (fig && !picked.some((x) => x.l === fig.l)) picked.push(fig);
  }
  const wrap = wrapWidth(raw);
  return [...new Set(picked.map((x) => snippet(clauseAt(raw, x.i, { wrap }), width)))].join('\n      ');
}

const ENDS = /[.;:!?)"'\u201d\u2019]\s*$/;
export function wrapWidth(raw) {
  const lens = raw.map((l) => l.trim().length).filter((n) => n);
  return lens.length < 5 ? 0 : lens.slice().sort((x, y) => x - y)[Math.floor(0.9 * (lens.length - 1))];
}
/** The clause around a hard-wrapped line, bounded by the document's own column width. */
export function clauseAt(raw, i, { max = 10, wrap = null, cap = 1400 } = {}) {
  const w = wrap === null ? wrapWidth(raw) : wrap;
  const wrapped = (n) => { const l = (raw[n] || '').trim(); return w >= 45 && l.length >= w - 12 && !ENDS.test(l); };
  let s = i, e = i;
  while (s > 0 && i - s < max && (raw[s - 1] || '').trim() && wrapped(s - 1)) s--;
  while (e + 1 < raw.length && e - s < max - 1 && (raw[e + 1] || '').trim() && wrapped(e)) e++;
  return raw.slice(s, e + 1).map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').slice(0, cap);
}

export function spotlightTiers({ words, bySpec, wholePhrase }) {
  return [...new Set([wholePhrase ? words.join(' ') : '', bySpec.slice(0, 3).join(' '), bySpec[0] || '', bySpec[1] || '', bySpec[2] || ''])].filter(Boolean);
}
export function specificTier(hits, bySpec, rx, text = (h) => h.text) {
  if (!bySpec.length) return hits;
  const one = (w) => (w ? hits.filter((h) => rx(w).test(text(h))) : []);
  return [hits.filter((h) => bySpec.slice(0, 3).every((w) => rx(w).test(text(h)))), one(bySpec[0]), one(bySpec[1]), one(bySpec[2])].find((t) => t.length) || hits;
}
export const docScore = (m, weights, name, line) => m.scoreW(line || '', weights) + m.scoreW(String(name || '').replace(/[^A-Za-z0-9]+/g, ' '), weights);
export function winningTier(tiers, answered) {
  const win = answered.findIndex((r) => r.length);
  return { win, broad: win >= 0 && tiers.length > 1 && !tiers[win].includes(' '), paths: answered.find((r) => r.length) || [] };
}
export function spotlightNote({ health, cut, paths = 0, tiersCut = 0, tiersRun = 0, tierMs = 0, localAnswered = false }) {
  if (health === 'dead') return '!! spotlight is switched off for this machine, so no document outside the local index was searched; `mdutil -s /` to confirm, `mdutil -i on /` to rebuild it';
  if (health === 'unknown' && !paths) return '!! spotlight health could not be determined and it returned nothing; treat any document outside the local index as unsearched';
  if (cut && !localAnswered) return paths ? `[ask] spotlight cut at ${cut}ms; rerun --only file for the rest` : `[ask] spotlight did not answer in ${cut}ms and the local index had nothing; the index may be rebuilding`;
  if (!localAnswered && tiersRun && tiersCut === tiersRun) return `[ask] every spotlight tier was CUT${tierMs ? ` at ${tierMs}ms` : ''}, so nothing was searched there; raise ASK_SPOTLIGHT_TIER_MS`;
  return null;
}

// ---- paragraphs (the operating manual answers in paragraphs) -----------------
const isBlank = (l) => !l || !l.trim();
const opensUnit = (l) => /^\s{0,3}(?:[-*+]\s|#{1,6}\s|\d+\.\s)/.test(l || '');
function paragraphStart(lines, i, max) { let s = i; while (s > 0 && !isBlank(lines[s - 1]) && !opensUnit(lines[s]) && i - s < max) s--; return s; }
function paragraphText(lines, i, max) {
  const out = [];
  for (let j = i; j < lines.length && out.length < max && !isBlank(lines[j]); j++) { if (out.length && opensUnit(lines[j])) break; out.push(lines[j].trim()); }
  return out.join(' ').replace(/\s+/g, ' ');
}
export function paragraphHits(hits, m, readLines, { width = 700, line = 260, max = 24 } = {}) {
  const { score, snippet } = m, groups = new Map();
  hits.forEach((h, i) => {
    const p = /^([^:]+):(\d+):([\s\S]*)$/.exec(h), lines = p ? readLines(p[1]) : null;
    if (!p || !Array.isArray(lines) || !lines.length) { groups.set(`raw:${i}`, { raw: h, s: score(h), i }); return; }
    const at = Number(p[2]), key = `${p[1]}:${paragraphStart(lines, at - 1, max)}`, prev = groups.get(key);
    if (prev) { prev.s += score(p[3]); prev.at = Math.min(prev.at, at); return; }
    groups.set(key, { file: p[1], lines, at, s: score(p[3]), i });
  });
  return [...groups.values()].sort((a, b) => b.s - a.s || a.i - b.i)
    .map((g) => (g.raw ? snippet(g.raw, line) : `${g.file}:${g.at}:${snippet(paragraphText(g.lines, g.at - 1, max), width)}`));
}

/** Files by IDF^1.5-weighted coverage, path terms counted again, plus 0.3 of the best line; ties by line count, then path. */
export function rankFiles(entries, m, { lines = (e) => e.lines, pathWeight = 2, lineWeight = 0.3, weights = null, rarityExponent = 1.5, tie = null } = {}) {
  const { words, RX, scoreW, idfOver } = m;
  const raw = weights && words.some((t) => (weights.get(t) || 0) > 0) ? weights : idfOver(entries.flatMap((e) => lines(e)));
  const kw = new Map([...raw].map(([t, w]) => [t, Math.pow(Math.max(0, w), rarityExponent)]));
  for (const e of entries) {
    const ls = lines(e), name = e.f.replace(/[-_/.]+/g, ' ');
    e.best = ls.length ? Math.max(...ls.map((l) => scoreW(l, kw))) : 0;
    let cov = 0;
    for (const t of words) {
      const w = kw.get(t) || 0, inPath = RX.get(t).test(name);
      if (inPath || ls.some((l) => RX.get(t).test(l))) cov += w;
      if (inPath) cov += pathWeight * w;
    }
    e.s = cov + lineWeight * e.best;
    e.n = ls.length;
  }
  // Equal scores: the file with more matching lines, then the path.
  const byPath = (a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0);
  const t = tie || ((a, b) => b.n - a.n);
  return { kw, ranked: entries.slice().sort((a, b) => b.s - a.s || t(a, b) || byPath(a, b)) };
}

/** The second quote out of a file is chosen for what the first does not say. */
export function diverseQuotes(hits, m, kw, n = 2, { tieWeight = 0.25 } = {}) {
  const { words, RX } = m, pool = hits.slice().sort((a, b) => b.s - a.s), picked = [], covered = new Set();
  while (picked.length < n && pool.length) {
    let bi = 0, bs = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      let novel = 0;
      for (const t of words) if (!covered.has(t) && RX.get(t).test(pool[i].raw)) novel += kw.get(t) || 0;
      const s = novel + tieWeight * pool[i].s;
      if (s > bs) { bs = s; bi = i; }
    }
    const [h] = pool.splice(bi, 1);
    for (const t of words) if (RX.get(t).test(h.raw)) covered.add(t);
    picked.push(h);
  }
  return picked;
}

/** At most `perDir` files per directory inside the window; the rest move behind it. */
export function spreadDirs(entries, { perDir = 3, window = 12 } = {}) {
  const seen = new Map(), win = [], rest = [];
  for (const e of entries) {
    const d = e.f.slice(0, e.f.lastIndexOf('/')), n = seen.get(d) || 0;
    if (win.length < window && n < perDir) { seen.set(d, n + 1); win.push(e); } else rest.push(e);
  }
  return win.concat(rest);
}

// ---- the pooled head block ----------------------------------------------------
export const isOperatorNote = (line) => /^\s*(?:!!|\[ask\])/.test(String(line));
export const CORPUS_PRIOR = { who: 0.15, 'findings+graphs': 0.10, filenames: 0.03, 'AGENTS.md+docs': 0.05, documents: 0.05, contracts: 0.05,
  'claude-memory': 0.02, knowledge: 0, stream: 0, imessage: -0.02, 'claude.ai-chats': -0.04, 'agent-sessions': -0.06, code: -0.06, headspaces: -0.06 };

export function entriesOf(label, out) {
  const es = [];
  for (const line of out) {
    const raw = String(line ?? '');
    if (!raw.trim() || raw.trimStart().startsWith('[ask]')) continue;
    const [head, ...rest] = raw.split('\n');
    es.push({ label, head: head.trim(), quotes: rest.map((r) => r.trim()).filter(Boolean), idx: es.length });
  }
  return es;
}

const PATH_HEAD = /^(?:~\/|\/|[\w.@-]+\/)/;
export function entryPath(head) {
  const s = String(head || '');
  return PATH_HEAD.test(s) ? s.split(/ {2,}/)[0].trim().replace(/:\d+$/, '') || null : null;
}
const shq = (s) => { const p = String(s), q = (x) => `'${x.replace(/'/g, "'\\''")}'`; return p.startsWith('~/') ? `~/${q(p.slice(2))}` : q(p); };
const GREP_HEAD = /^(~?[\w./@ -]*[\w.@-]):(\d+):/;
const TEXTISH = /\.(txt|csv|tsv|md|json|ya?ml|log|html?|xml|eml)$/i;

export function elideHead(head, max = 120) {
  const s = String(head || '');
  if (s.length <= max) return s;
  const m = GREP_HEAD.exec(s), keep = m && /[./]/.test(m[1]) ? m[0].length : (entryPath(s) || '').length, cut = Math.max(keep, max - 3);
  return cut >= s.length ? s : s.slice(0, cut) + '...';
}

export const DEFAULT_INDEX_PATHS = { streamsDir: null, chatsIndex: null, streamMd: 'knowledge/memory/stream.md' };

/** The exact command that turns an entry into the answer, or null when it already is one. */
export function nextCall(entry, paths = DEFAULT_INDEX_PATHS) {
  const { streamsDir, chatsIndex, streamMd } = { ...DEFAULT_INDEX_PATHS, ...paths };
  const head = String(entry.head || '');
  if (entry.label === 'stream') {
    const ln = Number((/^(\d+):/.exec(head) || [])[1]);
    return Number.isFinite(ln) && ln > 0 && streamMd ? `sed -n '${Math.max(1, ln - 3)},${ln + 25}p' ${shq(streamMd)}` : null;
  }
  if (entry.label === 'claude.ai-chats') {
    const u = /\[([0-9a-f][0-9a-f-]{20,})\]/.exec(head);
    return u && chatsIndex ? `rg -F ${shq(u[1])} ${shq(chatsIndex)} | cut -f2,5 | head -60` : null;
  }
  const row = /^([a-z][\w-]*) \| (\d{4}-\d\d-\d\dT[\d:]+) \| /.exec(head);
  if (row && !streamsDir) return null;
  if (row && /gmail/.test(row[1])) return `rg -F -m 1 ${shq(row[2])} ${shq(`${streamsDir}/${row[1]}.tsv`)} | cut -c1-4000`;
  if (row) return `rg -F -B 2 -A 8 ${shq(row[2])} ${shq(`${streamsDir}/${row[1]}.tsv`)} | cut -c1-600`;
  const msg = entry.label === 'imessage' && /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \| /.exec(head);
  if (msg) return streamsDir ? `rg -F -B 2 -A 8 ${shq(msg[1])} ${shq(`${streamsDir}/imessage.tsv`)} | cut -c1-600` : null;
  const m = GREP_HEAD.exec(head), grep = m && /[./]/.test(m[1]) ? m : null, path = grep ? grep[1] : entryPath(head);
  if (!path) return null;
  const id = /\[(01[A-Z0-9]{6,})\]/.exec(head);
  if (id) return `rg -n -A 40 '${id[1]}' ${shq(path)}`;
  if (/\.(pdf|docx?|pages|key|numbers)$/i.test(path)) return `pdftotext -q ${shq(path)} - | head -120`;
  const n = grep ? Number(grep[2]) : Number((/^(\d+):/.exec(entry.quotes[0] || '') || [])[1]);
  if (Number.isFinite(n) && n > 0) return `sed -n '${Math.max(1, n - 3)},${n + 45}p' ${shq(path)}`;
  if ((path.startsWith('~/') || path.startsWith('/')) && TEXTISH.test(path)) {
    const quote = String(entry.quotes[0] || '').replace(/\s+/g, ' ').trim().replace(/^\.{3}/, '').slice(0, 60).replace(/\.{3}$/, '').trim();
    return quote.length >= 12 ? `rg -n -F -m 3 ${shq(quote)} ${shq(path)}` : `sed -n '1,120p' ${shq(path)}`;
  }
  return null;
}

/** The asker's own question read back (4+ words, exact containment). */
export function isEcho(text, query) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return q.split(' ').length >= 4 && String(text || '').toLowerCase().replace(/\s+/g, ' ').includes(q);
}
const RETRIEVAL_META = /\b(?:benchmarks?|lookup|retrieval|fanout|ask(?:-select)?\.mjs|mdfind|spotlight)\b/i;
export const isRetrievalMeta = (text, query) => !RETRIEVAL_META.test(query) && (RETRIEVAL_META.test(text) || /(?:-bench|\.test|\.spec)\.[cm]?[jt]s\b/i.test(text));

/** Pool every corpus's printed entries, re-score with one IDF table, dedupe by path; ties keep corpus order. */
export function bestAcross(corpora, m, { max = 6, prior = CORPUS_PRIOR, decay = 0.02, query = '', paths = DEFAULT_INDEX_PATHS, adjust = null } = {}) {
  const all = [];
  for (const c of corpora || []) all.push(...entriesOf(c.label, c.out || []));
  if (!all.length) return [];
  const text = (e) => `${e.head} ${e.quotes.join(' ')}`;
  const dw = m.idfOver(all.map(text)), total = [...dw.values()].reduce((a, b) => a + b, 0) || 1;
  const maxWeight = m.words.length ? Math.max(...m.words.map((t) => dw.get(t) || 0)) : 1;
  const adj = typeof adjust === 'function' ? (e) => adjust(text(e), maxWeight) / total : () => 0;
  const scored = all.map((e, order) => ({ ...e, order, score: m.scoreW(text(e), dw) / total + adj(e) + (prior[e.label] ?? 0) - decay * e.idx
    - (isEcho(text(e), query) ? 1 : 0) - (query && isRetrievalMeta(text(e), query) ? 1 : 0) }));
  const seen = new Set(), out = [];
  for (const e of scored.sort((a, b) => b.score - a.score || a.order - b.order)) {
    const key = entryPath(e.head) || e.head;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ ...e, next: nextCall(e, paths) });
    if (out.length >= max) break;
  }
  return out;
}
