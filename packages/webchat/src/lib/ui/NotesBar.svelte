<script>
  // The notes bar: one floating pill riding above the soft keyboard, the reference app's mobile vocabulary.
  //
  // On a phone the notes page is a caret in a textarea and nothing else is reachable: indenting,
  // the marker ring, folding and handing a block to a chat are all ⌘ chords, and there is no ⌘.
  // So the chords get a surface. It is one rounded-full bar with hairlines between the segments,
  // a 48px touch target each, and it sits just above the keyboard rather than at the bottom of a
  // viewport the keyboard has already covered.
  //
  // Two rules make it usable with a caret: every button is tabindex="-1" and every press has its
  // default prevented, so a tap can never move focus. A blur here drops the soft keyboard and
  // loses the caret's place, which is the whole reason the bar exists.
  //
  // The last segment is cmd, held with one thumb while the other hand types; the state it
  // reports is `held`, and the page reads it in its own keydown to decide whether a key is a
  // chord. The chord table itself lives in hold-modifier.js.

  import { onMount } from 'svelte';
  import { holdModifier, LATCH_MS } from '$lib/client/hold-modifier.js';

  let {
    onindent = () => {}, onoutdent = () => {}, oncycle = () => {}, onfold = () => {},
    onchat = () => {}, onpresent = () => {}, onheld = () => {},
    held = $bindable(false), always = false
  } = $props();

  const PHONE = 768;   // the width the reference app calls a phone; the bar's media query uses the same one
  const BAR = 50;      // the bar's own height: where the top goes, measured off the keyboard
  const TAP_MS = 300;  // a press shorter than this was a tap, and a tap latches

  const cmd = holdModifier();

  let lifted = $state(null);   // the top the keyboard leaves, or null for the desktop bottom
  let downAt = 0;
  let timer = null;

  // Tapping the bar must never blur the editor. Touch has to be prevented too, or the page
  // scrolls under the finger that is holding cmd; that also cancels the synthetic click, which
  // is why every segment acts on pointerup instead.
  function hold(event) {
    event.preventDefault();
  }

  function report(next) {
    if (next === held) return;
    held = next;
    onheld(next);
  }

  function place() {
    const view = window.visualViewport;
    lifted = window.innerWidth < PHONE && view ? view.height - BAR : null;
  }

  function cmdDown(event) {
    event.preventDefault();
    // The finger may slide off the 48px target while the other hand types; capturing it keeps
    // the pointerup on this button, so the modifier can never stick on.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* no capture here */ }
    clearTimeout(timer);
    downAt = Date.now();
    report(cmd.press());
  }

  function cmdUp() {
    const tapped = Date.now() - downAt < TAP_MS;
    cmd.release();
    if (tapped) {
      cmd.latchFor(LATCH_MS);
      timer = setTimeout(() => report(cmd.isHeld()), LATCH_MS);
    }
    report(cmd.isHeld());
  }

  // A latch is spent by the key it was armed for. This runs on the window, after the editor's
  // own keydown has already read `held`, so the page still sees the chord it is being asked for.
  function onkeydown(event) {
    if (!held) return;
    cmd.chordFor(event.key);
    report(cmd.isHeld());
  }

  onMount(() => {
    place();
    const view = window.visualViewport;
    const keyboard = navigator.virtualKeyboard;
    // geometrychange is the exact signal when the page has opted into overlaying the keyboard;
    // the visualViewport pair is what every other browser gives, so both are listened to.
    keyboard?.addEventListener?.('geometrychange', place);
    view?.addEventListener('resize', place);
    view?.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    return () => {
      keyboard?.removeEventListener?.('geometrychange', place);
      view?.removeEventListener('resize', place);
      view?.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      clearTimeout(timer);
    };
  });
</script>

<svelte:window {onkeydown} />

<div class="wrap" class:always class:lifted={lifted !== null} style:top={lifted === null ? null : `${lifted}px`}>
  <div class="bar" data-testid="notes-bar">
    <button
      class="seg" tabindex="-1" aria-label="Indent" data-testid="notes-bar-indent"
      onpointerup={() => onindent()} onmousedown={hold} ontouchstart={hold}
    >⇥</button>
    <button
      class="seg" tabindex="-1" aria-label="Outdent" data-testid="notes-bar-outdent"
      onpointerup={() => onoutdent()} onmousedown={hold} ontouchstart={hold}
    >⇤</button>
    <button
      class="seg" tabindex="-1" aria-label="Cycle the marker" data-testid="notes-bar-cycle"
      onpointerup={() => oncycle()} onmousedown={hold} ontouchstart={hold}
    >☑</button>
    <button
      class="seg" tabindex="-1" aria-label="Fold this line" data-testid="notes-bar-fold"
      onpointerup={() => onfold()} onmousedown={hold} ontouchstart={hold}
    >▾</button>
    <button
      class="seg" tabindex="-1" aria-label="Ask a chat about this block" data-testid="notes-bar-chat"
      onpointerup={() => onchat()} onmousedown={hold} ontouchstart={hold}
    >↵</button>
    <button
      class="seg" tabindex="-1" aria-label="Back to the present" data-testid="notes-bar-present"
      onpointerup={() => onpresent()} onmousedown={hold} ontouchstart={hold}
    >↓</button>
    <button
      class="seg cmd" class:on={held} tabindex="-1" aria-label="Hold for chords"
      aria-pressed={held} data-testid="notes-bar-cmd"
      onpointerdown={cmdDown} onpointerup={cmdUp} onpointercancel={cmdUp}
      onmousedown={hold} ontouchstart={hold}
    >⌘</button>
  </div>
</div>

<style>
  /* The wrapper spans the width and catches nothing: the bar alone is touchable, so the note
     under it stays tappable either side of the pill. */
  .wrap {
    display: none;
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
    justify-content: center;
    padding: 8px;
    pointer-events: none;
  }
  .wrap.lifted { bottom: auto; }
  @media (max-width: 767px) { .wrap { display: flex; } }
  .wrap.always { display: flex; }

  .bar {
    display: flex; align-items: stretch;
    pointer-events: auto;
    background: var(--bg-raised);
    backdrop-filter: blur(12px);
    border: 1px solid var(--line);
    border-radius: 9999px;
    box-shadow: 0 10px 15px -3px rgb(0 0 0 / 10%), 0 4px 6px -2px rgb(0 0 0 / 5%);
    overflow: hidden;
  }
  /* The hairlines are the divide between segments, never an edge of the pill. */
  .seg + .seg { border-left: 1px solid var(--line); }

  .seg {
    padding: 12px; min-width: 48px;
    color: var(--ink-dim); font-size: 15px; line-height: 1;
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
  }
  .seg:first-child { padding-left: 16px; }
  .seg:last-child { padding-right: 16px; }
  .seg.cmd { color: var(--ink); }
  .seg.cmd.on { background: var(--accent); color: var(--bg); }

  /* Hover is a mouse's word. On a touch screen it sticks to whatever was tapped last. */
  @media (min-width: 768px) {
    .seg { padding: 8px 12px; }
    .seg:hover { color: var(--ink); }
  }
</style>
