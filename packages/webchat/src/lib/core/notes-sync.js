// Folding a server page into the document the browser is already showing.
//
// The notes app opens from what the browser has on disk and then reconciles, so the client holds
// the document and the server hands it pages of it. That makes this the one place where two
// versions of the same writing meet, and it is pure so it can be tested without a browser.
//
// The convergence rule is the store's own, not a new one. A line has its own id, its own float
// `ord` and per-field last-writer-wins by `updatedAt`; two replicas that apply the same edits in
// any order end up with the same document, which is what a CRDT buys and what the fractional ord
// was chosen for in the first place. What this module adds is the part a page needs. A block he is
// typing into is not held back: the server's version is merged into it as Automerge documents
// (notes-crdt.js, notes-block-doc.js), so a change made on another device lands at once and what he
// typed stays, with a join, a cut and an edit of the same line all landing on the same characters.
// A block is held only while an IME composition is under way in it (or when it has no
// document to merge); everything else merges whenever it arrives.
//
// A page is authoritative only for the range it covers. A past page that comes back with ords
// 10..40 says nothing about a block at ord 2, so only blocks inside the covered range may be
// dropped as deleted; everything outside keeps standing. Without that rule, backfilling one page
// would delete the rest of the document the browser had.

import { mergeBlockDocs } from './notes-block-doc.js';

export const ZONE_ORDER = ['past', 'timeline', 'future', 'state'];

export const zoneRank = (zone) => {
  const at = ZONE_ORDER.indexOf(zone || 'timeline');
  return at < 0 ? ZONE_ORDER.length : at;
};

/** The document's own order: the zones as they stand on the page, each by ord, ties by id. */
export function sortDocument(blocks) {
  return [...blocks].sort((a, b) =>
    zoneRank(a.zone) - zoneRank(b.zone)
    || (a.ord ?? 0) - (b.ord ?? 0)
    || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

/** The ord span a page covers, per zone, so only what it actually spoke for can be dropped. */
export function coveredRanges(blocks, { reachedStart = {}, reachedEnd = {} } = {}) {
  const ranges = {};
  for (const block of blocks) {
    const zone = block.zone || 'timeline';
    const ord = block.ord ?? 0;
    const range = ranges[zone] || (ranges[zone] = [ord, ord]);
    if (ord < range[0]) range[0] = ord;
    if (ord > range[1]) range[1] = ord;
  }
  for (const zone of Object.keys(ranges)) {
    if (reachedStart[zone]) ranges[zone][0] = -Infinity;
    if (reachedEnd[zone]) ranges[zone][1] = Infinity;
  }
  // A zone the page says it read to the end of, and found empty, still empties the client's copy.
  for (const zone of ZONE_ORDER) {
    if (ranges[zone]) continue;
    if (reachedStart[zone] && reachedEnd[zone]) ranges[zone] = [-Infinity, Infinity];
  }
  return ranges;
}

const takeFresh = (mine, fresh) => ({
  ...mine,
  ...fresh,
  // The DOM node is keyed by the view id, so a block that was already on screen keeps its node,
  // its focus and its composition across a reconcile.
  _viewId: mine._viewId || mine.id,
  // The server's lines name the rows now: a list of ids the page kept from before (a line moved or
  // cut meanwhile) would send the next write against the wrong rows.
  lineIds: Array.isArray(fresh.lines) && fresh.lines.length ? null : mine.lineIds,
  // A chat he started a moment ago may not have reached the store yet; losing it loses the chip.
  chatId: fresh.chatId ?? mine.chatId ?? null
});

const same = (a, b) =>
  a.body === b.body && a.ord === b.ord && a.updatedAt === b.updatedAt
  && (a.chatId ?? null) === (b.chatId ?? null) && (a.kind || 'text') === (b.kind || 'text')
  && (a.zone || 'timeline') === (b.zone || 'timeline');

/**
 * The lines of a page block as `{ id, body, ... }`, the words taken from the body he sees and the
 * rest (ids, ages) from the line rows beside it. Null when the rows do not line up with the body,
 * which is when nothing can be merged by line.
 */
export function lineRows(block) {
  const bodies = String(block?.body ?? '').split('\n');
  const rows = Array.isArray(block?.lineIds) && block.lineIds.length === bodies.length ? block.lineIds
    : Array.isArray(block?.lines) && block.lines.length === bodies.length ? block.lines.map((line) => line?.id) : null;
  if (!rows || rows.some((id) => !id)) return null;
  return bodies.map((body, at) => ({ ...(block.lines?.length === bodies.length ? block.lines[at] : {}), id: rows[at], body }));
}

/** What a block's lines are, for use as the base of later merges. */
export const baseOfBlock = (block) => (lineRows(block) || []).map((line) => ({ id: line.id, body: line.body, updatedAt: line.updatedAt }));

/**
 * `mine` and `theirs` of one block, merged: the block as the page should now hold it. Both carry an
 * Automerge document (`crdt`), and the documents are merged, so every character either side typed,
 * deleted, cut or joined stays as it was done, with nothing to hold back and nothing to double.
 * `base` (what the page last agreed with the store) is now only the block's position and chat link,
 * which are last-writer-wins per field: one he changed since the base is his, any other is whatever
 * the server now says. The block keeps its place in the page (`_viewId`). Null when either side has
 * no document, which is when nothing can be merged (the caller holds the block until it settles).
 */
export function mergeBlock(mine, baseIn, theirs) {
  const folded = mergeBlockDocs(mine, theirs);
  if (!folded) return null;
  const base = Array.isArray(baseIn) ? { lines: baseIn, fields: null } : baseIn;
  const out = { ...takeFresh(mine, theirs), ...folded };
  for (const field of ['ord', 'zone', 'chatId']) {
    const was = base?.fields?.[field];
    const now = field === 'zone' ? (mine.zone || 'timeline') : field === 'chatId' ? (mine.chatId ?? null) : mine.ord;
    if (base?.fields && now !== was) out[field] = now;
  }
  return out;
}

/**
 * Fold `incoming` into `local`.
 *
 * `busy(id)` is true for a block a merge cannot touch (a write in flight or awaiting its answer, an
 * IME composition under way): it keeps its local version and is reported in `held`, so the caller
 * can try again when it settles. `baseOf(id)` is, for a block with unsent edits, the lines (id,
 * words, age) those edits began from, or null for a block with none: a block with unsent edits is
 * merged three ways against it, one without simply takes the server's version. `merged` lists the
 * blocks that were merged, with the server lines each was merged with, so the caller can move the
 * base forward. `local: true` on a block means the browser made it and the server has not seen it
 * yet, so it is never dropped for being absent from the answer.
 */
export function mergeDocument(local, incoming, { ranges = {}, busy = () => false, baseOf = () => null } = {}) {
  const fresh = new Map((incoming || []).map((block) => [block.id, block]));
  const out = [];
  const held = [];
  const merged = [];
  let changed = false;
  for (const block of local || []) {
    const hit = fresh.get(block.id);
    if (hit) {
      fresh.delete(block.id);
      const taken = takeFresh(block, hit);
      if (same(block, taken)) { out.push(block); continue; }
      if (busy(block.id)) { out.push(block); held.push(hit); continue; }
      const base = baseOf(block.id);
      if (base) {
        const folded = mergeBlock(block, base, hit);
        if (!folded) { out.push(block); held.push(hit); continue; }
        merged.push({ id: block.id, theirs: hit.lines, base: Array.isArray(base) ? base : base.lines, fields: { ord: hit.ord, zone: hit.zone || 'timeline', chatId: hit.chatId ?? null } });
        // Nothing to carry forward but the fields: the documents hold the words.
        if (same(block, folded) && folded.body === block.body) { out.push(block); continue; }
        out.push(folded);
        changed = true;
        continue;
      }
      out.push(taken);
      changed = true;
      continue;
    }
    const range = ranges[block.zone || 'timeline'];
    const inside = range && (block.ord ?? 0) >= range[0] && (block.ord ?? 0) <= range[1];
    if (inside && !busy(block.id) && !baseOf(block.id) && !block._local) { changed = true; continue; }
    out.push(block);
  }
  for (const block of fresh.values()) { out.push(block); changed = true; }
  return { blocks: changed ? sortDocument(out) : local || [], held, merged, changed };
}

/**
 * What to keep on disk for the next cold open. The snapshot is the present and a peek either side,
 * bounded by bytes rather than by blocks, because one pasted page can be larger than a thousand
 * lines of writing. The present end of each zone is kept: that is what the next open paints.
 */
export function snapshotOf(blocks, { maxBytes = 1_500_000, pastBlocks = 2 } = {}) {
  const keep = [];
  let bytes = 0;
  const take = (block) => {
    const cost = JSON.stringify(block).length + 32;
    if (bytes + cost > maxBytes) return false;
    bytes += cost;
    keep.push(block);
    return true;
  };
  const byZone = (zone) => (blocks || []).filter((block) => (block.zone || 'timeline') === zone);
  for (const block of byZone('state')) take(block);
  for (const block of byZone('future')) take(block);
  // The timeline and the past are walked backwards: the newest writing is what he opens into.
  // Only a peek of the past is kept, however much of it has been paged in since, because the
  // next cold open must paint the present at the top and not a column of history above it.
  for (const zone of ['timeline', 'past']) {
    const rows = zone === 'past' ? byZone(zone).slice(-pastBlocks) : byZone(zone);
    for (let at = rows.length - 1; at >= 0; at -= 1) if (!take(rows[at])) break;
  }
  return sortDocument(keep);
}
