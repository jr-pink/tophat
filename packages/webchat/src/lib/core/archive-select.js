/** Where the view lands when the chat he is reading gets archived out from under it.
 *
 * Two rules, in order. If the mouse has been over a sidebar row in the last breath, that row is
 * where he was already looking, so it wins. Otherwise selection falls to the next chat DOWN the
 * sidebar, the one that slides up into the archived row's place, and only at the very bottom of
 * the list does it fall back upward.
 *
 * `order` is the ids in the order the sidebar paints them, WITH the chat being archived still in
 * place: the caller computes it before the archive lands, because afterwards the row is gone and
 * "next down" has no anchor.
 */

// Long enough that moving the pointer off a row and reaching for the keys still counts as
// hovering it; short enough that a mouse parked somewhere an hour ago does not decide anything.
export const HOVER_WINDOW_MS = 3000;

export function nextAfterArchive(order, archivedId, { hovered = null, hoveredAt = 0, now = Date.now() } = {}) {
  const ids = Array.isArray(order) ? order.filter((id) => typeof id === 'string' && id) : [];
  const live = (id) => id && id !== archivedId && ids.includes(id);

  if (live(hovered) && Number.isFinite(hoveredAt) && now - hoveredAt <= HOVER_WINDOW_MS) return hovered;

  const at = ids.indexOf(archivedId);
  if (at === -1) return ids.find((id) => id !== archivedId) || null;
  for (let i = at + 1; i < ids.length; i += 1) if (ids[i] !== archivedId) return ids[i];
  for (let i = at - 1; i >= 0; i -= 1) if (ids[i] !== archivedId) return ids[i];
  return null;
}
