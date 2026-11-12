// Dragging the chat list's right edge, as a pure function of the pointer. The width follows the pointer's MOVEMENT from the width
// the list has when the button goes down: width = startWidth + (x - startX). The old code set width = clientX, which read the
// pointer's distance from the viewport's left edge as if it were the list's width, so the first move after a press jumped by the
// pointer's offset inside the 7px handle (up to 4px) and, in a window that does not start at the viewport's left (the demo's
// desktop frame), by that whole inset. A press with no movement changes nothing: no width, no collapse, nothing to save.
export const SIDEBAR_MIN_PX = 200;
export const SIDEBAR_MAX_PX = 560;
export const SIDEBAR_COLLAPSE_PX = 140;
export const SIDEBAR_DEFAULT_PX = 280;

/**
 * @param {{ startWidth: number, startX: number }} from  the list's rendered width and the pointer's x at pointerdown
 * Returns move(x) -> { hidden, width } for the state to show now (width null while collapsed), and end() -> the width to save
 * (null when the pointer never moved or the list ended collapsed).
 */
export function resizeDrag({ startWidth, startX }) {
  let moved = false;
  let width = null;
  let hidden = false;
  return {
    move(x) {
      if (x !== startX) moved = true;
      if (!moved) return { hidden: false, width: null };
      const raw = startWidth + (x - startX);
      if (raw < SIDEBAR_COLLAPSE_PX) { hidden = true; return { hidden, width }; }
      hidden = false;
      width = Math.round(Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, raw)));
      return { hidden, width };
    },
    end() { return moved && !hidden ? width : null; }
  };
}
