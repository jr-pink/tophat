// Where a highlight lives in a document, and how to find it again after the document changes.
//
// A highlight is stored three ways at once: the exact text (quote), the ~48 characters either
// side of it (prefix/suffix), and the character offsets it had when it was made. Offsets alone
// break the moment a site edits a typo three paragraphs above; the quote alone is ambiguous when
// the same sentence appears twice. Resolution tries them in order of how much they prove and
// reports which one answered, so the UI can say "this highlight moved" rather than silently
// pointing at the wrong words.

export const CONTEXT = 48;

const norm = (text) => String(text || '').replace(/\s+/gu, ' ').trim();

/** The anchor to store for a selection of `text` from `start` to `end`. */
export function makeAnchor(text, start, end) {
  const body = String(text || '');
  const from = Math.max(0, Math.min(body.length, start | 0));
  const to = Math.max(from, Math.min(body.length, end | 0));
  return {
    quote: body.slice(from, to),
    prefix: body.slice(Math.max(0, from - CONTEXT), from),
    suffix: body.slice(to, Math.min(body.length, to + CONTEXT)),
    start: from,
    end: to
  };
}

function occurrences(body, quote, cap = 200) {
  const found = [];
  if (!quote) return found;
  let at = body.indexOf(quote);
  while (at !== -1 && found.length < cap) {
    found.push(at);
    at = body.indexOf(quote, at + 1);
  }
  return found;
}

/**
 * Find an anchor in `text`. Returns { start, end, how, exact } or null when the quote is gone.
 * how: 'offset' (offsets still hold), 'context' (prefix and suffix agreed), 'unique' (the quote
 * appears once), 'nearest' (several matches, took the one closest to the old offset),
 * 'loose' (whitespace-insensitive match).
 */
export function resolveAnchor(text, anchor) {
  const body = String(text || '');
  const quote = String(anchor?.quote || '');
  if (!quote) return null;
  const start = Number.isFinite(anchor?.start) ? anchor.start : 0;

  if (body.slice(start, start + quote.length) === quote) {
    return { start, end: start + quote.length, how: 'offset', exact: true };
  }

  const hits = occurrences(body, quote);
  if (hits.length === 1) {
    return { start: hits[0], end: hits[0] + quote.length, how: 'unique', exact: true };
  }
  if (hits.length > 1) {
    const prefix = String(anchor?.prefix || '');
    const suffix = String(anchor?.suffix || '');
    const scored = hits.map((at) => {
      const before = body.slice(Math.max(0, at - prefix.length), at);
      const after = body.slice(at + quote.length, at + quote.length + suffix.length);
      let score = 0;
      if (prefix && before === prefix) score += 2;
      if (suffix && after === suffix) score += 2;
      if (!prefix && !suffix) score += 1;
      return { at, score, distance: Math.abs(at - start) };
    });
    scored.sort((a, b) => b.score - a.score || a.distance - b.distance);
    const best = scored[0];
    return {
      start: best.at,
      end: best.at + quote.length,
      how: best.score >= 2 ? 'context' : 'nearest',
      exact: true
    };
  }

  // The page reflowed: match ignoring runs of whitespace, then map back to real offsets.
  const wanted = norm(quote);
  if (!wanted) return null;
  const map = [];
  let flat = '';
  let space = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (/\s/u.test(ch)) { space = true; continue; }
    if (space && flat) { flat += ' '; map.push(i); }
    space = false;
    flat += ch;
    map.push(i);
  }
  const at = flat.indexOf(wanted);
  if (at === -1) return null;
  const from = map[at];
  const last = map[Math.min(map.length - 1, at + wanted.length - 1)];
  return { start: from, end: last + 1, how: 'loose', exact: false };
}

/** Highlights that no longer resolve, so the UI can keep them instead of dropping them. */
export function orphansOf(text, anchors = []) {
  return anchors.filter((anchor) => !resolveAnchor(text, anchor));
}

/**
 * Non-overlapping ranges in document order. Two highlights over the same sentence are common
 * (a highlight, then a note on part of it); the renderer needs them flattened so a range never
 * starts inside another one.
 */
export function layoutRanges(ranges = []) {
  const sorted = [...ranges].filter((r) => r && r.end > r.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start < last.end) {
      if (range.end <= last.end) { last.ids = [...new Set([...(last.ids || []), ...(range.ids || [range.id])])]; continue; }
      out.push({ ...range, start: last.end, ids: range.ids || [range.id] });
      continue;
    }
    out.push({ ...range, ids: range.ids || [range.id] });
  }
  return out;
}
