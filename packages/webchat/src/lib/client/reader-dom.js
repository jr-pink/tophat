// Turning a rendered article into character offsets and back.
//
// A highlight has to survive being stored as text, so the unit is an offset into the plain text
// of the article, not a DOM path: DOM paths break when the same page is fetched again with one
// more ad div in it. The index below is the one place that knows how to go between the two.
//
// Painting uses the CSS Custom Highlight API rather than wrapping the words in <mark>. A
// selection crosses element boundaries at arbitrary points (half of an <em>, into a <a>), and a
// wrapper would have to rewrite the article's DOM to paint it; the highlight registry paints
// ranges over a DOM nobody has touched. The price is that a highlight is not an element, so a
// click on one is resolved by asking the document which character is under the pointer.

export function textIndex(root) {
  const nodes = [];
  let text = '';
  if (!root) return { text, nodes };
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-reader-skip]')) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue || '';
    if (!value) continue;
    nodes.push({ node, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, nodes };
}

function locate(index, offset) {
  const { nodes } = index;
  let low = 0;
  let high = nodes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = nodes[mid];
    if (offset < entry.start) high = mid - 1;
    else if (offset > entry.end) low = mid + 1;
    else return { node: entry.node, offset: offset - entry.start };
  }
  const last = nodes[nodes.length - 1];
  return last ? { node: last.node, offset: last.end - last.start } : null;
}

export function offsetOf(index, node, offset) {
  for (const entry of index.nodes) {
    if (entry.node === node) return entry.start + offset;
  }
  // The selection landed on an element rather than a text node (a triple click, or the edge of a
  // paragraph): take the first text node inside it.
  if (node?.nodeType === 1) {
    const child = node.childNodes[Math.min(offset, node.childNodes.length - 1)];
    for (const entry of index.nodes) {
      if (child && (entry.node === child || child.contains?.(entry.node))) return entry.start;
    }
  }
  return null;
}

export function rangeFor(index, start, end) {
  const from = locate(index, start);
  const to = locate(index, end);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/** The selection as offsets, or null when it is empty or outside the article. */
export function selectionOffsets(root, index, selection = window.getSelection()) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const start = offsetOf(index, range.startContainer, range.startOffset);
  const end = offsetOf(index, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { start, end, rect: range.getBoundingClientRect() };
}

/** Which character is under the pointer, for clicking a painted highlight. */
export function offsetAtPoint(index, x, y) {
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    if (!position) return null;
    node = position.offsetNode;
    offset = position.offset;
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (!range) return null;
    node = range.startContainer;
    offset = range.startOffset;
  }
  return node ? offsetOf(index, node, offset) : null;
}

export const HIGHLIGHT_COLORS = ['yellow', 'blue', 'rose', 'green'];

export const supportsHighlightApi = () =>
  typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined' && typeof Highlight !== 'undefined';

/**
 * Paint every resolved highlight. Ranges are grouped by colour, and a highlight carrying a note
 * gets a second registration so it can be underlined as well as tinted.
 */
/**
 * Paint the stored highlights, and the selection a note is being typed on: while the box is open
 * the words it belongs to stay marked, so he can see what he is writing about.
 */
/** Register a set of named range groups with the highlight registry, replacing whatever was there.
 *
 * A caller that holds a single continuous text index should use paint() below; a caller whose
 * text is in many independent pieces, as a chat transcript is, builds its own ranges per piece
 * and comes here.
 */
export function paintRanges(byName) {
  if (!supportsHighlightApi()) return false;
  for (const [name, ranges] of byName) {
    if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
    else CSS.highlights.delete(name);
  }
  return true;
}

/** Every group the painter knows about, empty, so a repaint clears what it does not set. */
export function emptyGroups() {
  const byName = new Map();
  for (const colour of HIGHLIGHT_COLORS) byName.set(`reader-${colour}`, []);
  for (const name of ['reader-note', 'reader-active', 'reader-pending', 'reader-tophat']) byName.set(name, []);
  return byName;
}

export function paint(index, resolved = [], pending = null) {
  if (!supportsHighlightApi()) return false;
  const byName = new Map();
  for (const colour of HIGHLIGHT_COLORS) byName.set(`reader-${colour}`, []);
  byName.set('reader-note', []);
  byName.set('reader-active', []);
  byName.set('reader-pending', []);
  // A note tophat wrote is marked as tophat's on the words themselves, so a passage he skims is
  // never mistaken for his own thinking from the colour alone.
  byName.set('reader-tophat', []);
  if (pending && Number.isFinite(pending.start) && Number.isFinite(pending.end)) {
    const range = rangeFor(index, pending.start, pending.end);
    if (range) byName.get('reader-pending').push(range);
  }
  for (const entry of resolved) {
    const range = rangeFor(index, entry.start, entry.end);
    if (!range) continue;
    const name = `reader-${HIGHLIGHT_COLORS.includes(entry.color) ? entry.color : 'yellow'}`;
    byName.get(name).push(range);
    if (entry.note) byName.get('reader-note').push(range);
    if (entry.author === 'tophat') byName.get('reader-tophat').push(range);
    if (entry.active) byName.get('reader-active').push(range);
  }
  return paintRanges(byName);
}

export function clearPaint() {
  if (!supportsHighlightApi()) return;
  for (const name of ['reader-note', 'reader-active', ...HIGHLIGHT_COLORS.map((c) => `reader-${c}`)]) {
    CSS.highlights.delete(name);
  }
}

/** How far down a scroller the reader has got, 0..1, counting the bottom of the viewport. */
export function scrollRatio(el) {
  if (!el) return 0;
  const height = el.scrollHeight - el.clientHeight;
  if (height <= 0) return 1;
  return Math.max(0, Math.min(1, (el.scrollTop + el.clientHeight) / el.scrollHeight));
}
