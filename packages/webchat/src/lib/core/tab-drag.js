// Where a dragged tab would land, as a pure function of the pointer and the measured groups. The page measures the groups
// (their rectangles, their strips, their tabs) and the kit holds the answer as `drag.over` (core/panes-state.js), so the strip
// indicator and the edge overlays are projections of kit state, never of the pointer.
//
// A group is { key, rect, strip: rect, tabs: [rect, ...] }; a rect is { left, top, right, bottom }.
//   - over a group's tab strip: { kind: 'strip', group, index }, the insertion position among its tabs (the tab count past the last);
//   - over the outer quarter of a group's body, left or right: { kind: 'edge', group, side }, a new group beside it;
//   - over the rest of the body: { kind: 'body', group }, the tab joins that group at the end;
//   - nowhere on a group, or onto where the tab already is (its own group's body, or an edge of a group it is the only tab of): null.
export const EDGE_FRACTION = 0.25;

const inside = (r, x, y) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;

export function dropTarget({ x, y, from, groups, only = false }) {
  const group = groups.find((g) => inside(g.rect, x, y));
  if (!group) return null;
  if (group.strip && inside(group.strip, x, y)) {
    const index = group.tabs.filter((t) => x > (t.left + t.right) / 2).length;
    return { kind: 'strip', group: group.key, index };
  }
  const own = group.key === from;
  const width = group.rect.right - group.rect.left;
  if (x < group.rect.left + width * EDGE_FRACTION) return own && only ? null : { kind: 'edge', group: group.key, side: 'left' };
  if (x >= group.rect.right - width * EDGE_FRACTION) return own && only ? null : { kind: 'edge', group: group.key, side: 'right' };
  return own ? null : { kind: 'body', group: group.key };
}

// The index `tab.move` takes (the tab's place once it has left its old position) for a drop at insertion position `at` of a strip
// whose tabs are `tabs`: dropping right after itself or right before itself is where it already is.
export function landingIndex(tabs, chat, at) {
  const from = tabs.indexOf(chat);
  return from >= 0 && from < at ? at - 1 : at;
}
