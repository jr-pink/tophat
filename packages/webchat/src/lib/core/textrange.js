

function textNodes(root) {
  const doc = root.ownerDocument || globalThis.document;
  const walker = doc.createTreeWalker(root, 4 );
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  return nodes;
}

export function offsetsOfRange(root, range) {
  if (!root || !range) return null;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = boundaryOffset(root, range.startContainer, range.startOffset);
  const end = boundaryOffset(root, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

function boundaryOffset(root, container, offset) {
  if (container.nodeType === 3) {
    let seen = 0;
    for (const node of textNodes(root)) {
      if (node === container) return seen + Math.min(offset, node.nodeValue.length);
      seen += node.nodeValue.length;
    }
    return null;
  }
  const child = container.childNodes[offset];
  if (child) return textLengthBefore(root, child);
  return textLengthBefore(root, container) + (container.textContent || '').length;
}


function textLengthBefore(root, node) {
  if (node === root) return 0;
  let seen = 0;
  for (const text of textNodes(root)) {
    
    
    
    if (!(node.compareDocumentPosition(text) & 2)) break;
    seen += text.nodeValue.length;
  }
  return seen;
}


export function rangeFromOffsets(root, start, end) {
  if (!root || !(end > start)) return null;
  const doc = root.ownerDocument || globalThis.document;
  let seen = 0;
  let from = null;
  let to = null;
  for (const node of textNodes(root)) {
    const length = node.nodeValue.length;
    if (from === null && seen + length >= start) from = [node, start - seen];
    if (to === null && seen + length >= end) { to = [node, end - seen]; break; }
    seen += length;
  }
  if (!from || !to) return null;
  const range = doc.createRange();
  range.setStart(from[0], Math.max(0, Math.min(from[1], from[0].nodeValue.length)));
  range.setEnd(to[0], Math.max(0, Math.min(to[1], to[0].nodeValue.length)));
  return range;
}

export function offsetAtPoint(root, x, y) {
  const doc = root?.ownerDocument || globalThis.document;
  let node = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    if (!position) return null;
    node = position.offsetNode;
    offset = position.offset;
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (!range) return null;
    node = range.startContainer;
    offset = range.startOffset;
  } else return null;
  if (!node || !root.contains(node)) return null;
  let seen = 0;
  for (const text of textNodes(root)) {
    if (text === node) return seen + Math.min(offset, text.nodeValue.length);
    seen += text.nodeValue.length;
  }
  return null;
}

const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th';

export function blockAt(root, target) {
  if (!root || !target?.closest) return null;
  const block = target.closest(BLOCKS);
  if (block && root.contains(block)) return block;
  return root;
}


export function offsetsOfNode(root, node) {
  if (!root || !node) return null;
  if (node === root) return { start: 0, end: root.textContent.length };
  const doc = root.ownerDocument || globalThis.document;
  const range = doc.createRange();
  range.selectNodeContents(node);
  return offsetsOfRange(root, range);
}
