// Is the pointer the thing he is using right now?
//
// A hover is not attention when the mouse is simply where he left it.
//
// So hover-only chrome asks two questions, not one: is the pointer over me, and is the pointer
// live. It goes live on a real mouse move and goes quiet on the first keystroke, so loading a
// chat and pressing enter shows nothing, and moving the mouse brings the stamps straight back.

let live = $state(false);
let started = false;

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  // A touch pointer has no hover at all; its own tap handler is what asks.
  window.addEventListener('pointermove', (event) => {
    if (!event.pointerType || event.pointerType === 'mouse') live = true;
  }, { passive: true, capture: true });
  window.addEventListener('keydown', () => { live = false; }, { capture: true });
  window.addEventListener('blur', () => { live = false; });
}

/** The shared signal. One set of window listeners however many rows ask for it. */
export function pointerLive() {
  start();
  return { get live() { return live; } };
}

/** Tests and the odd caller that wants the page to start quiet again. */
export function resetPointerLive() { live = false; }
