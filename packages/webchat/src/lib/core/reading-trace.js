// Reading trace: what was actually in front of his eyes, line by line, and for how long.
//
// So the unit is a LINE BOX, not a message: a paragraph is measured as it is laid out on his
// screen, which means the same text tracked on a phone and on a desktop has different line
// counts and both are correct. This file is the arithmetic, with no DOM and no database in it,
// so it can be tested directly.

/** The band of the viewport where reading actually happens: not the very top or bottom edge. */
export function readingBand(viewportHeight, { top = 0.12, bottom = 0.88 } = {}) {
  return { top: viewportHeight * top, bottom: viewportHeight * bottom };
}

/**
 * Which line boxes of a block are inside the band right now.
 * rects are viewport-relative line boxes, in order, as getClientRects gives them.
 * A line counts when its middle is inside the band, so a line half off the screen is not "read".
 */
export function visibleLines(rects, band) {
  const out = [];
  rects.forEach((rect, idx) => {
    const middle = rect.top + rect.height / 2;
    if (middle >= band.top && middle <= band.bottom) out.push(idx);
  });
  return out;
}

/** Words on one line, estimated from the block's words split over its line boxes by width. */
export function wordsPerLine(words, rects) {
  const total = rects.reduce((sum, r) => sum + Math.max(r.width, 1), 0) || 1;
  return rects.map((r) => (words * Math.max(r.width, 1)) / total);
}

/**
 * Fold a new sample into an accumulator keyed by block and line.
 * Each entry carries milliseconds in the band, when it was first and last seen, and how many
 * separate visits it took: a second visit after an absence is a re-read, which is the signal for
 * "this paragraph did not land the first time".
 */
export function accumulate(acc, { key, words, line, lines, at, dt, gapMs = 1500 }) {
  const entry = acc.get(key) || {
    key, words, line, lines, ms: 0, firstAt: at, lastAt: at, passes: 1
  };
  if (at - entry.lastAt > gapMs) entry.passes += 1;
  entry.ms += dt;
  entry.lastAt = at;
  entry.words = words;
  entry.lines = lines;
  acc.set(key, entry);
  return entry;
}

/** Words per minute over a set of rows, counting only first passes and sane dwell times. */
export function wordsPerMinute(rows, { minMs = 120, maxMsPerWord = 3000 } = {}) {
  let words = 0;
  let ms = 0;
  for (const row of rows) {
    if (row.ms < minMs) continue;
    const w = row.words || 0;
    if (!w) continue;
    if (row.ms / w > maxMsPerWord) continue;   // staring at the screen is not reading
    words += w;
    ms += row.ms;
  }
  if (!ms) return null;
  return Math.round((words / ms) * 60000);
}

/**
 * Where he slowed down or went back: the rows whose pace is far off his own median, or that he
 * visited more than once. For chat, these are the places an explanation did not land.
 */
export function snags(rows, { slowFactor = 2.2, minWords = 8 } = {}) {
  const paces = rows
    .filter((r) => (r.words || 0) >= minWords && r.ms >= 120)
    .map((r) => r.ms / r.words)
    .sort((a, b) => a - b);
  if (!paces.length) return [];
  const median = paces[Math.floor(paces.length / 2)];
  return rows
    .filter((r) => (r.words || 0) >= minWords)
    .map((r) => ({ ...r, pace: r.ms / r.words, slow: r.ms / r.words > median * slowFactor, reread: r.passes > 1 }))
    .filter((r) => r.slow || r.reread)
    .sort((a, b) => (b.passes - a.passes) || (b.pace - a.pace));
}
