import { rawOffset, visibleOffset } from './notes-format.js';

// Measure browser layout, including proportional glyphs, inline marks and wrapping.
// Textareas expose no text ranges, so give their text an identically styled mirror.
export function caretStops(editor) {
  const doc = editor.ownerDocument;
  const textarea = editor.tagName === 'TEXTAREA';
  let root = editor;
  if (textarea) {
    root = doc.createElement('div');
    const style = getComputedStyle(editor);
    for (const property of style) root.style.setProperty(property, style.getPropertyValue(property));
    const rect = editor.getBoundingClientRect();
    Object.assign(root.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: 'auto', margin: '0', visibility: 'hidden',
      pointerEvents: 'none', transform: 'none', boxSizing: 'border-box' });
    root.textContent = editor.value || '\u200b';
    doc.body.append(root);
  }
  try {
    const text = textarea ? editor.value : root.textContent;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let length = 0, node;
    while ((node = walker.nextNode())) { nodes.push({ node, start: length }); length += node.length; }
    const offsets = [0, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      part => part.index + part.segment.length)];
    const range = doc.createRange();
    return offsets.map(offset => {
      const entry = nodes.find(({ node, start }) => offset <= start + node.length);
      let rect;
      if (entry) {
        range.setStart(entry.node, offset - entry.start);
        range.collapse(true);
        rect = range.getClientRects()[0];
      }
      if (!rect) rect = root.getBoundingClientRect();
      return { offset: textarea ? offset : rawOffset(editor.value, offset), visible: offset,
        x: rect.left - (textarea ? editor.scrollLeft : 0),
        y: rect.top - (textarea ? editor.scrollTop : 0) };
    });
  } finally { if (textarea) root.remove(); }
}

export function currentStop(editor, stops) {
  const offset = editor.tagName === 'TEXTAREA' ? editor.selectionStart : visibleOffset(editor.value, editor.selectionStart);
  return stops.reduce((best, stop) => Math.abs(stop.visible - offset) < Math.abs(best.visible - offset) ? stop : best);
}

export function closestStop(stops, x, y) {
  return stops.filter(stop => Math.abs(stop.y - y) < 1)
    .reduce((best, stop) => !best || Math.abs(stop.x - x) < Math.abs(best.x - x) ? stop : best, null);
}
