// A selection that runs across lines, and across notes, edited the way VS Code edits one: the
// characters between the two ends go, not the whole lines they touch.
//
// A point is { id, at }: a note and a raw offset into its body. `order` is the notes' ids top to
// bottom as the page draws them. Everything here is pure; the page turns the answers into put/drop.

/** -1, 0 or 1: which of two points comes first in the document. */
export function comparePoints(order, a, b) {
  const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
  if (ia !== ib) return ia < ib ? -1 : 1;
  return a.at === b.at ? 0 : a.at < b.at ? -1 : 1;
}

/** The two ends of a selection, first one first. */
export function span(order, anchor, focus) {
  return comparePoints(order, anchor, focus) <= 0 ? [anchor, focus] : [focus, anchor];
}

/**
 * The text between two points: what ⌘C puts on the clipboard. Notes in between are whole, and a
 * boundary reads as a newline, so pasting it back gives the same lines.
 */
export function rangeText(bodies, order, from, to) {
  if (from.id === to.id) return bodies.get(from.id).slice(from.at, to.at);
  const first = order.indexOf(from.id), last = order.indexOf(to.id);
  const parts = [bodies.get(from.id).slice(from.at)];
  for (let index = first + 1; index < last; index += 1) parts.push(bodies.get(order[index]));
  parts.push(bodies.get(to.id).slice(0, to.at));
  return parts.join('\n');
}

/**
 * Delete what lies between two points. Within a note the characters go; across notes the first
 * note keeps what is before the start and takes what is after the end, and every note in between
 * goes with the last one, so the boundary that survives is the one after the last note: VS Code's
 * join of the first and last line, with the boundaries inside the range gone like the lines are.
 * Null when the ends are in different zones, which no edit crosses.
 */
export function deleteRange(bodies, order, from, to, zoneOf = () => null) {
  if (from.id === to.id) {
    const body = bodies.get(from.id);
    return { put: [{ id: from.id, body: body.slice(0, from.at) + body.slice(to.at) }], drop: [], caret: { id: from.id, at: from.at } };
  }
  const first = order.indexOf(from.id), last = order.indexOf(to.id);
  if (first < 0 || last < 0 || first > last) return null;
  if (zoneOf(from.id) !== zoneOf(to.id)) return null;
  const body = bodies.get(from.id).slice(0, from.at) + bodies.get(to.id).slice(to.at);
  return {
    put: [{ id: from.id, body }],
    drop: order.slice(first + 1, last + 1),
    caret: { id: from.id, at: from.at }
  };
}

/** Text in at a point, the caret after it. */
export function insertAt(body, at, text) {
  return { body: body.slice(0, at) + text + body.slice(at), at: at + text.length };
}

/** The line a body offset is on, and where that line starts and ends. */
export function lineOf(body, at) {
  const lines = String(body).split('\n');
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const end = start + lines[index].length;
    if (at <= end) return { index, start, end };
    start = end + 1;
  }
  const index = lines.length - 1;
  return { index, start: start - lines[index].length - 1, end: start - 1 };
}

/**
 * ⇧⌥↑ / ⇧⌥↓: lines from..to of a body copied, the copy above or below. VS Code leaves the caret
 * on the lower of the two runs for ↓ and on the upper for ↑, which is the same rows either way
 * for ↑; so the answer says how many lines the caret moves down: the run's length for ↓, 0 for ↑.
 */
export function duplicateLines(body, from, to, direction) {
  const lines = String(body).split('\n');
  const run = lines.slice(from, to + 1);
  lines.splice(to + 1, 0, ...run);
  return { body: lines.join('\n'), shift: direction > 0 ? run.length : 0 };
}

/** ⌘⇧K: lines from..to of a body gone. Null when nothing would be left of the note. */
export function deleteLines(body, from, to) {
  const lines = String(body).split('\n');
  if (to - from + 1 >= lines.length) return null;
  lines.splice(from, to - from + 1);
  return { body: lines.join('\n'), line: Math.min(from, lines.length - 1) };
}

/** ⌘⇧↵ and a whole-line paste: lines put in above line `index`. */
export function insertLinesAbove(body, index, inserted) {
  const lines = String(body).split('\n');
  lines.splice(index, 0, ...inserted);
  return { body: lines.join('\n') };
}

/** VS Code's word classes, for ⌥← and ⌥→ across a line edge. */
const SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';
const classOf = (ch) => (/\s/.test(ch) ? 'space' : SEPARATORS.includes(ch) ? 'sep' : 'word');

/** Where ⌥← or ⌥→ from `at` lands inside one line's words, or null at the edge. */
export function wordStop(words, at, direction) {
  let col = at;
  if (direction < 0) {
    if (col <= 0) return null;
    while (col > 0 && classOf(words[col - 1]) === 'space') col -= 1;
    if (col === 0) return 0;
    const kind = classOf(words[col - 1]);
    while (col > 0 && classOf(words[col - 1]) === kind) col -= 1;
    return col;
  }
  if (col >= words.length) return null;
  while (col < words.length && classOf(words[col]) === 'space') col += 1;
  if (col === words.length) return col;
  const kind = classOf(words[col]);
  while (col < words.length && classOf(words[col]) === kind) col += 1;
  return col;
}

/**
 * VS Code's double click on a line's words: the run of one character class around `at`. A word
 * touching the point wins over the blank or punctuation beside it, so a click just after the last
 * letter of a word still takes the word. Returns [start, end).
 */
export function wordAround(words, at) {
  const kindAt = (index) => (index < 0 || index >= words.length ? null : classOf(words[index]));
  let probe = at;
  if (kindAt(at) !== 'word' && kindAt(at - 1) === 'word') probe = at - 1;
  else if (kindAt(at) === null) probe = at - 1;
  const kind = kindAt(probe);
  if (kind === null) return [at, at];
  let start = probe, end = probe + 1;
  while (start > 0 && classOf(words[start - 1]) === kind) start -= 1;
  while (end < words.length && classOf(words[end]) === kind) end += 1;
  return [start, end];
}

/** VS Code's Home on a line's words: the first non-blank, and from there the very start. */
export function homeStop(words, at) {
  const first = words.length - words.trimStart().length;
  return at === first ? 0 : first;
}

/**
 * A DOM point inside a rendered line, as { block, line, offset } in that line's words: what a
 * document selection's anchor or focus means to the page. Null off the lines. A point in the line's
 * marker or indent counts as the start of its words, one past them as the end.
 */
export function linePoint(node, offset) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  const row = element?.closest?.('[data-line]');
  const block = row?.closest?.('[data-block]')?.dataset.block;
  if (!row || !block) return null;
  const text = row.querySelector('[data-text]');
  let at = 0;
  if (text && text.contains(node)) {
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(node, offset);
    at = range.toString().length;
  } else if (text && node && (text.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) {
    at = text.textContent.length;
  }
  // A blank line is drawn with a placeholder space so it has height; it has no words.
  if (text?.hasAttribute('data-empty')) at = 0;
  return { block, line: Number(row.dataset.line), offset: at };
}
