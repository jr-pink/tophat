// What the notes page does with a block's Automerge document (notes-crdt.js), in terms of the
// page's own block: `{ id, body, lines: [{ id, createdAt, ... }], lineIds, crdt }`, where `crdt` is the
// document, base64. Pure, so the page's use of it is tested without a browser.
//
// A block carries its document wherever the block goes: into the snapshot on disk, the outbox, the
// write, the answer. A block with no document (the library is not loaded, or an older snapshot) is
// still a block; it simply is not merged as characters.

import {
  applyLines, automergeReady, bootstrap, cloneDoc, cursorFor, decodeDoc, encodeDoc, mergeDocs, offsetOf, project, sameLineage
} from './notes-crdt.js';

export const crdtReady = automergeReady;

const bodyLines = (block) => String(block?.body ?? '').split('\n');

/** The block's lines as the document's editor wants them: `[{ id | null, body }]`. */
export function wantedLines(block) {
  const bodies = bodyLines(block);
  const ids = Array.isArray(block?.lineIds) && block.lineIds.length === bodies.length ? block.lineIds
    : Array.isArray(block?.lines) && block.lines.length === bodies.length ? block.lines.map((line) => line?.id) : null;
  return bodies.map((body, at) => ({ id: ids?.[at] || null, body }));
}

// The last few decoded documents, by their text: a keystroke should not decode the document it just
// made. Automerge documents are linear: one that has been edited or merged into is spent (forking
// one costs as much as its whole history, which grows with every keystroke), so a document is
// TAKEN out of this cache to be changed and its successor put in under its new text.
const recent = new Map();
function peek(text) {
  const hit = recent.get(text);
  if (hit) { recent.delete(text); recent.set(text, hit); return hit; }
  const doc = decodeDoc(text);
  recent.set(text, doc);
  if (recent.size > 48) recent.delete(recent.keys().next().value);
  return doc;
}
function take(text) {
  const hit = recent.get(text);
  if (!hit) return decodeDoc(text);
  recent.delete(text);
  return hit;
}
function keep(text, doc) {
  recent.set(text, doc);
  if (recent.size > 48) recent.delete(recent.keys().next().value);
}

/** The block's document: its own, or (for a block that has none yet) one bootstrapped from its lines. */
export function docOfBlock(block, { spend = false } = {}) {
  if (!automergeReady() || !block || block.kind === 'break') return null;
  try {
    if (typeof block.crdt === 'string' && block.crdt) return spend ? take(block.crdt) : peek(block.crdt);
    const lines = wantedLines(block).map((line, at) => ({ id: line.id || (at === 0 ? block.id : null), body: line.body }));
    if (lines.some((line) => !line.id)) return null;
    return bootstrap(block.id, lines);
  } catch { return null; }
}

/** The document after the edit that turned `prev` into `next`: a base64 string, or undefined when there is none. */
export function editedDoc(prev, next) {
  if (next?.kind === 'break') return undefined;
  const doc = docOfBlock(prev, { spend: true });
  if (!doc) return typeof next?.crdt === 'string' ? next.crdt : undefined;
  try {
    const edited = applyLines(doc, wantedLines(next), { consume: true });
    const text = encodeDoc(edited);
    keep(text, edited);
    return text;
  } catch (cause) {
    // The block still saves as lines; the next edit diffs the whole text into the document again.
    console.warn('notes: edit did not reach the block document', cause);
    return typeof next?.crdt === 'string' ? next.crdt : undefined;
  }
}

/** A new block's document, made when the block is. */
export function newBlockDoc(block) {
  const doc = docOfBlock(block);
  return doc ? encodeDoc(doc) : undefined;
}

const lineMeta = (lines) => new Map((lines || []).map((line) => [line?.id, line]));

/**
 * `mine` (the block on the page, with edits not yet sent) merged with `theirs` (the store's block),
 * as documents: every character either side has typed, deleted, cut or joined stays as it was done.
 * Returns the merged block fields `{ body, lines, lineIds, crdt }`, or null when either has no document.
 *
 * Two documents that do not share a bootstrap are not merged by Automerge (it keeps one of them),
 * so `theirs` becomes the base and the lines `mine` holds are applied over it: the rare path of a
 * block edited offline from a snapshot older than its document.
 */
export function mergeBlockDocs(mine, theirs) {
  if (!automergeReady() || !theirs || typeof theirs.crdt !== 'string' || !theirs.crdt) return null;
  const ours = docOfBlock(mine, { spend: true });
  if (!ours) return null;
  let theirDoc;
  try { theirDoc = peek(theirs.crdt); } catch { return null; }
  let merged;
  if (sameLineage(ours, theirDoc)) merged = mergeDocs(ours, theirDoc, { consume: true });
  else {
    const mineLines = wantedLines(mine).filter((line) => line.id);
    const known = new Set(mineLines.map((line) => line.id));
    const theirLines = project(theirDoc).lines;
    const wanted = [...mineLines];
    theirLines.forEach((line, at) => {
      if (known.has(line.id)) return;
      const before = theirLines.slice(0, at).reverse().find((other) => known.has(other.id));
      wanted.splice(before ? wanted.findIndex((entry) => entry.id === before.id) + 1 : 0, 0, line);
      known.add(line.id);
    });
    merged = applyLines(theirDoc, wanted);
  }
  const lines = project(merged).lines;
  const fromTheirs = lineMeta(theirs.lines);
  const fromMine = lineMeta(mine.lines);
  const rows = lines.map((line) => ({ ...(fromTheirs.get(line.id) || fromMine.get(line.id) || { createdAt: mine.createdAt }), id: line.id, body: line.body }));
  const crdt = encodeDoc(merged);
  keep(crdt, merged);
  return { body: lines.map((line) => line.body).join('\n'), lines: rows, lineIds: rows.map((row) => row.id), crdt };
}

/** A caret (a selection's two ends, as offsets in the block's body) made stable against merges. */
export function captureCursors(block, start, end) {
  const doc = docOfBlock(block);
  if (!doc) return null;
  try { return { start: cursorFor(doc, start), end: cursorFor(doc, end), crdt: block.crdt }; } catch { return null; }
}

/** Where a captured caret is now, in the block's current document; null when it cannot be told. */
export function cursorOffsets(block, cursors) {
  const doc = docOfBlock(block);
  if (!doc || !cursors) return null;
  try { return { start: offsetOf(doc, cursors.start), end: offsetOf(doc, cursors.end) }; } catch { return null; }
}

export { cloneDoc };
