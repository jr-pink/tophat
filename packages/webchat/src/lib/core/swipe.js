/** Row swipes, the part worth testing on its own: where the row sits, whether it has travelled far
 * enough to count, which way it went, and whether letting go fires.
 *
 * A trackpad gesture is a wheel with a horizontal delta and no end event, so the gesture ends
 * when the events stop (SWIPE_IDLE_MS of silence). A touch gesture is a pointer drag and ends on
 * pointerup. Both feed the same two numbers, so the component is the same in the chat sidebar and
 * in the reader library.
 *
 * Two directions, and a row opts into each. Left is the destructive one (archive: "ok, I read
 * it"); right is the keeping one (star: worth referring back to). A row that does not claim the
 * rightward gesture leaves it to the browser, where it is the back gesture.
 */

export const SWIPE_COMMIT = 64;   // px of travel past which letting go fires
export const SWIPE_MAX = 96;      // px the row can travel at all
export const SWIPE_IDLE_MS = 160; // wheel silence standing in for the touchend a trackpad never sends
export const SWIPE_SLOP = 6;      // px below which the gesture is still a click, not a swipe

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function idleSwipe() {
  return { offset: 0, active: false, armed: false };
}

function settle(offset, { commit, max, left, right }) {
  const next = clamp(offset, left ? -max : 0, right ? max : 0);
  return { offset: next, active: true, armed: Math.abs(next) >= commit };
}

/**
 * One wheel event. Returns the next state and whether this component consumed it; unconsumed
 * events are left alone so the list keeps scrolling vertically and pinch-zoom keeps zooming.
 */
export function wheelSwipe(state, event = {}, options = {}) {
  const { commit = SWIPE_COMMIT, max = SWIPE_MAX, left = true, right = false } = options;
  const dx = Number(event.deltaX) || 0;
  const dy = Number(event.deltaY) || 0;
  if (event.ctrlKey) return { state, handled: false };   // pinch zoom arrives as a ctrl-wheel
  if (!state.active) {
    if (!dx) return { state, handled: false };
    if (dx > 0 && !left) return { state, handled: false };
    if (dx < 0 && !right) return { state, handled: false };  // left to the browser's back gesture
    if (Math.abs(dx) <= Math.abs(dy) * 1.2) return { state, handled: false };  // a vertical scroll
  }
  if (!dx && !state.offset) return { state, handled: state.active };
  return { state: settle(state.offset - dx, { commit, max, left, right }), handled: true };
}

/** A touch drag, measured from where the finger went down. */
export function dragSwipe(state, dx, options = {}) {
  const { commit = SWIPE_COMMIT, max = SWIPE_MAX, left = true, right = false } = options;
  return { state: settle(Number(dx) || 0, { commit, max, left, right }), handled: true };
}

/** Which way a travelled row went, whatever it has travelled so far. */
export function swipeDirection(state) {
  const offset = Number(state?.offset) || 0;
  if (offset < 0) return 'left';
  if (offset > 0) return 'right';
  return null;
}

/** Letting go: armed fires, anything short of it springs back. */
export function releaseSwipe(state) {
  return {
    commit: Boolean(state?.armed),
    direction: state?.armed ? swipeDirection(state) : null,
    state: idleSwipe()
  };
}

/** A row that moved is not a row that was clicked. */
export function swallowsClick(state) {
  return Math.abs(state?.offset || 0) > SWIPE_SLOP;
}
