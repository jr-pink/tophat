// Pure link classification for reader view: which anchor is the next post in a
// series, which is the previous one, which points at the series index.
// No DOM, no node built-ins. Input is a plain list of candidate descriptors.

const PREV_GLYPHS = ['\u00ab', '\u2039', '\u2190', '\u27f5', '<'];
const NEXT_GLYPHS = ['\u00bb', '\u203a', '\u2192', '\u27f6', '>'];

const EDGE_TRIM = /^[\s\u00a0\u00ab\u00bb\u2039\u203a\u2190\u2192\u27f5\u27f6<>|\-\u2013\u2014:]+|[\s\u00a0\u00ab\u00bb\u2039\u203a\u2190\u2192\u27f5\u27f6<>|\-\u2013\u2014:]+$/g;

const SCORE = {
  rel: 100,
  className: 70,
  text: 60,
  glyph: 50,
  phrase: 40,
  sideOnly: 20
};

const AREA_BONUS = { nav: 2, footer: 2, article: 1, header: 0, body: 0 };

/** Collapse whitespace. */
function flat(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/** Human label: no arrow glyphs, no surrounding whitespace or separators. */
function labelOf(candidate) {
  const text = flat(candidate && candidate.text).replace(EDGE_TRIM, '');
  if (text) return text;
  return flat(candidate && candidate.ariaLabel).replace(EDGE_TRIM, '');
}

/**
 * Strip utm_ params and fbclid, drop the fragment unless it carries meaning,
 * drop a trailing slash except at root, lowercase the host. Used for dedupe.
 */
export function normalizeUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  for (const key of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(key) || key.toLowerCase() === 'fbclid') u.searchParams.delete(key);
  }
  u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : '';
  u.hash = keepsFragment(u) ? u.hash : '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  u.hostname = u.hostname.toLowerCase();
  return u.toString();
}

// A fragment survives when it addresses a place inside a document (epub-like
// anchors, footnotes, chapter ids) rather than decorating a page url.
function keepsFragment(u) {
  if (!u.hash || u.hash === '#') return false;
  if (/\.(x?html?|xml|epub)$/i.test(u.pathname)) return true;
  return /^#(chapter|chap|ch|section|sec|part|page|pg|note|fn|footnote|ref|anchor)[-_:]?\d*/i.test(u.hash);
}

/** Stable grouping key: host, plus first path segment when the path is deep. */
export function seriesKey(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split('/').filter(Boolean);
  return segments.length > 1 ? `${host}/${segments[0]}` : host;
}

function relTokens(candidate) {
  return flat(candidate.rel).toLowerCase().split(/[\s,]+/).filter(Boolean);
}

function relSignal(candidate) {
  const tokens = relTokens(candidate);
  if (tokens.includes('next')) return { dir: 'next', why: 'rel', score: SCORE.rel };
  if (tokens.includes('prev') || tokens.includes('previous')) {
    return { dir: 'prev', why: 'rel', score: SCORE.rel };
  }
  if (tokens.includes('up') || tokens.includes('index') || tokens.includes('contents')) {
    return { dir: 'up', why: 'rel', score: SCORE.rel };
  }
  return null;
}

function classText(candidate) {
  return `${flat(candidate.className)} ${flat(candidate.id)}`.toLowerCase();
}

function classSignal(candidate) {
  const hay = classText(candidate);
  const next = /(next|newer)/.test(hay);
  const prev = /(prev|previous|older)/.test(hay);
  if (next && !prev) return { dir: 'next', why: 'class-navlink', score: SCORE.className };
  if (prev && !next) return { dir: 'prev', why: 'class-navlink', score: SCORE.className };
  return null;
}

// 'navlink', 'post-nav' and friends say "this is navigation" without a side.
function navClassSupport(candidate) {
  return /(navlink|nav-link|post-nav|nav-post|pagination|page-nav|postnav|nav)/.test(classText(candidate));
}

function sideHint(candidate) {
  const hay = classText(candidate);
  const left = /(^|[^a-z])left([^a-z]|$)/.test(hay);
  const right = /(^|[^a-z])right([^a-z]|$)/.test(hay);
  if (left && !right) return 'left';
  if (right && !left) return 'right';
  return null;
}

function wordSignal(candidate) {
  const sources = [flat(candidate.text).replace(EDGE_TRIM, ''), flat(candidate.ariaLabel)];
  for (const source of sources) {
    if (!source) continue;
    const s = source.toLowerCase();
    if (/^(next|newer)\b/.test(s) || /\b(next|newer)$/.test(s)) {
      return { dir: 'next', why: 'text-next', score: SCORE.text };
    }
    if (/^(previous|prev|older)\b/.test(s) || /\b(previous|prev|older)$/.test(s)) {
      return { dir: 'prev', why: 'text-prev', score: SCORE.text };
    }
  }
  return null;
}

function phraseSignal(candidate) {
  const hay = `${flat(candidate.text)} ${flat(candidate.ariaLabel)}`.toLowerCase();
  const unit = '(post|posts|chapter|essay|part|article|entry|story|letter|issue)';
  if (new RegExp(`\\b(next|forward to|continue to|newer)\\s+${unit}\\b`).test(hay)) {
    return { dir: 'next', why: 'text-phrase', score: SCORE.phrase };
  }
  if (new RegExp(`\\b(previous|prev|preceding|earlier|last|older|back to (the )?)\\s*${unit}\\b`).test(hay)) {
    return { dir: 'prev', why: 'text-phrase', score: SCORE.phrase };
  }
  return null;
}

// Direction comes from where the glyph points, never from which side of the
// page the link sits on.
function glyphSignal(candidate) {
  const text = flat(candidate.text) || flat(candidate.ariaLabel);
  if (!text) return null;
  const first = text[0];
  const last = text[text.length - 1];
  if (PREV_GLYPHS.includes(first)) return { dir: 'prev', why: 'arrow-glyph', score: SCORE.glyph };
  if (NEXT_GLYPHS.includes(last)) return { dir: 'next', why: 'arrow-glyph', score: SCORE.glyph };
  if (NEXT_GLYPHS.includes(first)) return { dir: 'next', why: 'arrow-glyph', score: SCORE.glyph };
  if (PREV_GLYPHS.includes(last)) return { dir: 'prev', why: 'arrow-glyph', score: SCORE.glyph };
  return null;
}

function upSignal(candidate, seriesTitle) {
  const hay = flat(candidate.text).replace(EDGE_TRIM, '').toLowerCase();
  const aria = flat(candidate.ariaLabel).toLowerCase();
  const both = `${hay} ${aria}`.trim();
  if (/table of contents|^contents$|^index$|all posts in this series|series index|^series$|back to (the )?(series|index|contents)|view all posts in/.test(both)) {
    return { dir: 'up', why: 'text-contents', score: 70 };
  }
  if (seriesTitle && hay && hay === flat(seriesTitle).toLowerCase()) {
    return { dir: 'up', why: 'series-title', score: 65 };
  }
  if (/(^|[^a-z])(series|toc|contents)([^a-z]|$)/.test(classText(candidate))) {
    return { dir: 'up', why: 'class-series', score: 60 };
  }
  return null;
}

// Things that look like series navigation but are not.
function exclusionOf(candidate, pageKey) {
  const href = flat(candidate.href);
  if (!href) return 'no-href';
  if (/^(javascript|mailto|tel):/i.test(href)) return 'bad-scheme';
  if (pageKey && normalizeUrl(href) === pageKey) return 'same-url';
  const hay = classText(candidate);
  if (/(comment|disqus|respond|reply)/.test(hay)) return 'comments';
  const label = flat(candidate.text).replace(EDGE_TRIM, '');
  if (/^\d+$/.test(label)) return 'numeric-text';
  if (/^(next|previous|prev|older|newer)\s+page$/i.test(label)) return 'index-pagination';
  let path = href;
  try {
    const u = new URL(href);
    path = `${u.pathname}${u.search}`;
  } catch {
    // relative or odd href: match on the raw string
  }
  if (/\/page\/\d+\/?$/.test(path) || /[?&]pag(e|ed|ination)=\d+/.test(path)) return 'index-pagination';
  return null;
}

function scoreCandidate(candidate, pageKey, seriesTitle) {
  const label = labelOf(candidate);
  const base = {
    ...candidate,
    label,
    direction: null,
    score: 0,
    why: null,
    excluded: false,
    signals: []
  };
  const excluded = exclusionOf(candidate, pageKey);
  if (excluded) return { ...base, excluded: true, why: excluded };

  const signals = [
    relSignal(candidate),
    classSignal(candidate),
    wordSignal(candidate),
    glyphSignal(candidate),
    phraseSignal(candidate),
    upSignal(candidate, seriesTitle)
  ].filter(Boolean);

  if (signals.length === 0) {
    const side = sideHint(candidate);
    if (side && navClassSupport(candidate)) {
      signals.push({
        dir: side === 'left' ? 'prev' : 'next',
        why: 'side-only',
        score: SCORE.sideOnly
      });
    }
  }
  if (signals.length === 0) return base;

  signals.sort((a, b) => b.score - a.score);
  const top = signals[0];
  const inHeadBonus = candidate.inHead && top.why === 'rel' ? 4 : 0;
  const agreeing = signals.filter((s) => s !== top && s.dir === top.dir).length;
  const conflicting = signals.some((s) => s.dir !== top.dir && s.score === top.score);
  const support = navClassSupport(candidate) && top.why !== 'side-only' ? 3 : 0;
  const positionBonus = Number(candidate.position) > 0.5 ? 2 : 0;
  const areaBonus = AREA_BONUS[candidate.area] == null ? 0 : AREA_BONUS[candidate.area];
  const score =
    top.score + inHeadBonus + agreeing * 3 + support + positionBonus + areaBonus - (conflicting ? 5 : 0);

  return {
    ...base,
    direction: top.dir,
    why: top.why,
    score,
    signals: signals.map((s) => ({ dir: s.dir, why: s.why, score: s.score }))
  };
}

function pickBest(annotated, direction) {
  const pool = annotated.filter((c) => !c.excluded && c.direction === direction);
  if (pool.length === 0) return null;
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = Number(a.position) || 0;
    const pb = Number(b.position) || 0;
    return pb - pa;
  });
  const winner = pool[0];
  return { href: winner.href, label: winner.label, why: winner.why };
}

/**
 * classifyLinks(candidates, { pageUrl, seriesTitle })
 * -> { next, prev, up, all }
 */
export function classifyLinks(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const pageKey = options.pageUrl ? normalizeUrl(options.pageUrl) : '';
  const seen = new Map();
  const all = [];
  for (const candidate of list) {
    const annotated = scoreCandidate(candidate || {}, pageKey, options.seriesTitle);
    all.push(annotated);
    // dedupe: same target twice keeps the better scoring one
    const key = annotated.excluded ? null : normalizeUrl(annotated.href);
    if (key) {
      const prior = seen.get(key);
      if (prior && prior.score >= annotated.score) annotated.duplicate = true;
      else if (prior) prior.duplicate = true;
      if (!prior || prior.score < annotated.score) seen.set(key, annotated);
    }
  }
  const live = all.filter((c) => !c.duplicate);
  return {
    next: pickBest(live, 'next'),
    prev: pickBest(live, 'prev'),
    up: pickBest(live, 'up'),
    all
  };
}

export default { classifyLinks, seriesKey, normalizeUrl };
