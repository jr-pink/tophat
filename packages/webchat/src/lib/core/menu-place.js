// Where a popover menu goes so it is always fully on screen.
//
// The menu hangs under its anchor, right edges aligned (the anchor sits at the right of a pane
// header), and is then clamped inside the viewport with a margin on both sides. It is never wider
// than the viewport less those margins. It drops down when there is room for `minHeight` below the
// anchor or when below is the roomier side, otherwise it opens upward; either way `maxHeight` is
// what fits, and the menu scrolls past it.
export function placeMenu({ anchor, width, vw, vh, margin = 8, gap = 4, minHeight = 220 }) {
  const w = Math.max(0, Math.min(width, vw - margin * 2));
  const preferred = anchor.right - w;
  const left = Math.round(Math.min(Math.max(preferred, margin), Math.max(margin, vw - margin - w)));
  const below = vh - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const drop = below >= minHeight || below >= above ? 'down' : 'up';
  const maxHeight = Math.max(0, Math.floor(drop === 'down' ? below : above));
  const top = drop === 'down' ? Math.round(anchor.bottom + gap) : null;
  const bottom = drop === 'up' ? Math.round(vh - anchor.top + gap) : null;
  return { left, width: w, top, bottom, maxHeight, drop };
}

// Whether a header's inline controls should fold into its menu: they stay on the bar only while
// the title still keeps `titleMin` pixels beside them. `inlineWidth` is the controls' natural width,
// which does not depend on the bar's (they never shrink), so the answer cannot oscillate. Before
// the controls have ever been measured (0) nothing folds; the CSS container query covers that frame.
export function shouldCollapse({ barWidth, inlineWidth, endsWidth = 0, titleMin = 180, chrome = 0 }) {
  if (!(inlineWidth > 0) || !(barWidth > 0)) return false;
  return barWidth < inlineWidth + endsWidth + titleMin + chrome;
}
