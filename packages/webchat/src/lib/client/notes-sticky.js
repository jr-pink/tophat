// Sticky completion: a task he ticks stays where it was until he clicks away.
//
// The tick has to take effect at once -- the status is written through to the shared work item
// immediately, and nothing here waits for a model -- but the line must not vanish under his hand,
// because the thing he most often wants next is the line he just touched: to undo it, to read
// what was under it, or to tick the one below. So the row is PINNED while it is still his, and
// retired from the active view the moment his attention leaves it.
//
// Three rules keep this from losing anything:
//
//  * Retiring is a view decision, nothing else. The line keeps its id, its words, its order, its
//    history and its place in the store; `tasks`/`state read` still answer with it, and absence
//    from this projection is not absence from the document.
//  * Only a line HE closed in this session retires. A line that was already done when the page
//    loaded renders exactly as it did before, because quietly hiding standing text he never
//  * Reopening a retired line takes it straight back off the list, so an undo is one click and
//    not a hunt.
//
// Pure, so the behaviour is decided in functions a unit test can drive rather than in the page.

/** The marker states that retire. A bullet is not a task and never retires. */
const CLOSED = new Set(['done', 'dropped']);

/**
 * Remember (or forget) that he just set this line's marker himself. `done` and `dropped` join the
 * set; `todo` and a line that stopped being a checkbox leave it, which is the undo.
 */
export function markClosedByHand(closed, lineId, status) {
  const next = new Set(closed);
  if (!lineId) return next;
  if (CLOSED.has(status)) next.add(lineId);
  else next.delete(lineId);
  return next;
}

/** Ids no longer in the document at all: dropped from the set so it cannot grow without bound. */
export function forgetMissing(closed, liveIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
  const next = new Set();
  for (const id of closed) if (live.has(id)) next.add(id);
  return next;
}

/**
 * Which of a block's rows are retired from the active view right now.
 *
 * `rows` are `{ index, lineId, status }` in document order. A row retires when he closed it in
 * this session and it is neither the line the caret is in nor the line under the pointer; the
 * caret and the pointer are what "still his" means. `keep` holds ids a caller wants rendered
 * whatever happens, which is how a filtered search or a direct link at one line stays honest.
 */
export function retiredRows(rows, { closed, activeLineId = null, hoverLineId = null, keep = null } = {}) {
  const shut = closed instanceof Set ? closed : new Set(closed || []);
  const kept = keep instanceof Set ? keep : new Set(keep || []);
  const out = new Set();
  for (const row of rows || []) {
    if (!row?.lineId || !shut.has(row.lineId) || !CLOSED.has(row.status)) continue;
    if (row.lineId === activeLineId || row.lineId === hoverLineId || kept.has(row.lineId)) continue;
    out.add(row.index);
  }
  return out;
}

/** How many rows of a block are retired, for the count the page can offer to bring them back. */
export const retiredCount = (rows, options) => retiredRows(rows, options).size;
