<script>
  /**
   * One list row with two swipes on it. Left is the away gesture (archive: "ok, I read it"), and
   * the row flies out of the list. Right is the keeping gesture (star: worth referring back to),
   * a toggle, so the row springs back and stays where it is. Both have the same buttons on hover,
   * and a touch drag does what a two-finger trackpad swipe does. The chat sidebar and the reader
   * library share it, so the distance, the strip behind the row and the wording are the same in
   * both places.
   *
   * The row's own content is the `children` snippet and keeps its own styling; anything this
   * component adds sits on top of it. `actions` is for the other per-row buttons a view already
   * has (pin, mark unread): they join the same hover cluster, left of star and archive.
   *
   * A row that passes no `onstar` leaves the rightward gesture alone, where it is the browser's
   * back gesture.
   */
  import Icon from './Icon.svelte';
  import {
    SWIPE_IDLE_MS,
    SWIPE_MAX,
    SWIPE_SLOP,
    dragSwipe,
    idleSwipe,
    releaseSwipe,
    swallowsClick,
    wheelSwipe
  } from '$lib/core/swipe.js';

  let {
    onarchive = () => {},
    onstar = null,
    archived = false,
    starred = false,
    label = null,
    starLabel = null,
    starIcon = 'star',
    starIconOn = 'star-on',
    // A narrow row can afford the gesture but not another button: the chat sidebar takes the
    // rightward swipe and leaves the cluster at four, so the hover buttons stop covering the
    // row's own text.
    starbutton = true,
    disabled = false,
    testid = 'swipe-archive',
    startestid = 'swipe-star',
    actions = null,
    // Buttons that sit to the right of Done, e.g. the chat list's defer and open-in-pane.
    trailing = null,
    children = null
  } = $props();

  const word = $derived(label || (archived ? 'Put back' : 'Done'));
  const glyph = $derived(archived ? 'up' : 'archive');
  const starWord = $derived(starLabel || (starred ? 'Unstar' : 'Star'));
  const starGlyph = $derived(starred ? starIconOn : starIcon);
  const takesRight = $derived(Boolean(onstar));
  const bounds = $derived({ left: true, right: takesRight });

  let swipe = $state(idleSwipe());
  let flying = $state(false);
  let idleTimer = null;
  let flyTimer = null;
  let swipedAt = 0;

  // A finger drag, measured from where it went down. A mouse never starts one: that is what the
  // hover buttons are for.
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let pointer = null;

  $effect(() => () => { clearTimeout(idleTimer); clearTimeout(flyTimer); });

  // Archiving takes the row out of the list, so it leaves first and the list reorders after.
  function fly() {
    swipedAt = Date.now();
    flying = true;
    swipe = { offset: -SWIPE_MAX, active: false, armed: true };
    clearTimeout(flyTimer);
    flyTimer = setTimeout(() => {
      flying = false;
      swipe = idleSwipe();
      onarchive();
    }, 120);
  }

  // Starring is a toggle and the row stays: it snaps back and the star lights up.
  function starNow() {
    swipedAt = Date.now();
    swipe = idleSwipe();
    onstar?.();
  }

  function finish() {
    clearTimeout(idleTimer);
    const { commit, direction, state } = releaseSwipe(swipe);
    if (swallowsClick(swipe)) swipedAt = Date.now();
    if (commit && direction === 'right' && takesRight) { starNow(); return; }
    if (commit && direction === 'left') { fly(); return; }
    swipe = state;
  }

  function onwheel(event) {
    if (disabled || flying) return;
    const step = wheelSwipe(swipe, event, bounds);
    if (!step.handled) return;
    // Claiming the event is also what keeps a rightward swipe from navigating back.
    event.preventDefault();
    swipe = step.state;
    clearTimeout(idleTimer);
    // A trackpad sends no end event, so the gesture ends when the events stop coming.
    idleTimer = setTimeout(finish, SWIPE_IDLE_MS);
  }

  function onpointerdown(event) {
    if (disabled || flying || event.pointerType === 'mouse') return;
    startX = event.clientX;
    startY = event.clientY;
    pointer = event.pointerId;
    tracking = true;
  }

  function onpointermove(event) {
    if (!tracking) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!swipe.active) {
      if (Math.abs(dy) > Math.abs(dx)) { tracking = false; return; }  // he is scrolling the list
      if (dx > -SWIPE_SLOP && !(takesRight && dx > SWIPE_SLOP)) return;
      event.currentTarget.setPointerCapture?.(pointer);
    }
    swipe = dragSwipe(swipe, dx, bounds).state;
  }

  function onpointerup() {
    if (!tracking) return;
    tracking = false;
    finish();
  }

  // A row that moved is not a row that was clicked, and the click arrives after the gesture.
  function onclickcapture(event) {
    if (!swallowsClick(swipe) && Date.now() - swipedAt > 320) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function archiveNow(event) {
    event.preventDefault();
    event.stopPropagation();
    onarchive();
  }

  function starClick(event) {
    event.preventDefault();
    event.stopPropagation();
    onstar?.();
  }
</script>

<div
  class="swiperow"
  class:armed={swipe.armed}
  class:sliding={swipe.offset !== 0}
  class:right={swipe.offset > 0}
  class:flying
  {onwheel}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={onpointerup}
  {onclickcapture}
>
  <div class="behind" aria-hidden="true">
    {#if takesRight}
      <span class="behindin keep"><Icon name={starGlyph} size={14} /><span class="word">{starWord}</span></span>
    {/if}
    <span class="behindin away"><Icon name={glyph} size={14} /><span class="word">{word}</span></span>
  </div>

  <div class="front" style:transform={swipe.offset ? `translateX(${swipe.offset}px)` : null}>
    {@render children?.()}
    <div class="rowactions">
      {#if actions}{@render actions()}{/if}
      {#if takesRight && (starbutton || starred)}
        <button
          class="arcbtn"
          class:lit={starred}
          onclick={starClick}
          title={starWord}
          aria-label={starWord}
          aria-pressed={starred}
          data-testid={startestid}
        ><Icon name={starGlyph} size={13} /></button>
      {/if}
      <button
        class="arcbtn"
        onclick={archiveNow}
        title={word}
        aria-label={word}
        data-testid={testid}
      ><Icon name={glyph} size={13} /></button>
      {#if trailing}{@render trailing()}{/if}
    </div>
  </div>
</div>

<style>
  .swiperow {
    position: relative;
    isolation: isolate;
    /* Vertical panning stays the list's; horizontal panning is ours. */
    touch-action: pan-y;
  }
  .front {
    position: relative;
    z-index: 1;
    background: var(--swipe-bg, transparent);
    border-radius: 8px;
    will-change: transform;
  }
  /* No transition while the fingers are on it: the row tracks them. Springing back and flying
     out are the only animated parts. */
  .swiperow:not(.sliding) .front,
  .swiperow.flying .front { transition: transform var(--panel, 180ms) var(--ease, ease); }
  .swiperow.flying .front { opacity: 0.35; transition: transform var(--panel, 180ms) var(--ease, ease), opacity var(--panel, 180ms) var(--ease, ease); }

  .behind {
    position: absolute;
    inset: 0;
    z-index: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    border-radius: 8px;
    opacity: 0;
    background: color-mix(in srgb, var(--warn, #c0783c) 22%, transparent);
    color: var(--ink-dim, inherit);
    transition: opacity var(--tap, 120ms) var(--ease, ease), background-color var(--tap, 120ms) var(--ease, ease);
  }
  /* Whichever way it is going, that side's word is the one showing. */
  .behind .keep { visibility: hidden; }
  .sliding .behind { opacity: 1; }
  .sliding.right .behind { background: color-mix(in srgb, var(--accent, #6aa) 20%, transparent); }
  .sliding.right .behind .keep { visibility: visible; }
  .sliding.right .behind .away { visibility: hidden; }
  .armed .behind {
    background: color-mix(in srgb, var(--warn, #c0783c) 40%, transparent);
    color: var(--ink, inherit);
  }
  .armed.right .behind { background: color-mix(in srgb, var(--accent, #6aa) 38%, transparent); }
  .behindin { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; letter-spacing: 0.02em; }
  .behindin.away { margin-left: auto; }
  .word { white-space: nowrap; }

  .rowactions {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    pointer-events: none;
    padding-left: 18px;
    /* --rowactions-bg: the row's own painted colour (a highlighted row is not --swipe-bg), so the cluster never shows a box edge over a highlight */
    background: linear-gradient(90deg, transparent, var(--rowactions-bg, var(--swipe-bg, transparent)) 22%);
    transition: opacity var(--tap, 120ms) var(--ease, ease);
  }
  /* The cluster itself never takes a pointer, only its buttons do: a strip of padding and
     gradient across the middle of a 280px row was swallowing hovers and clicks meant for the
     row underneath it. */
  @media (hover: hover) and (pointer: fine) {
    .swiperow:hover .rowactions,
    .swiperow:focus-within .rowactions { opacity: 1; }
    .swiperow:hover .rowactions > :global(*),
    .swiperow:focus-within .rowactions > :global(*) { pointer-events: auto; }
    .arcbtn { width: 22px; height: 22px; }
  }
  /* A touch screen has no hover, so the buttons are simply there and one tap still opens the row. */
  @media (hover: none) and (pointer: coarse) {
    .rowactions { opacity: 1; }
    .rowactions > :global(*) { pointer-events: auto; }
    .arcbtn { width: 30px; height: 30px; }
  }
  .sliding .rowactions, .flying .rowactions { opacity: 0; pointer-events: none; }
  .sliding .rowactions > :global(*), .flying .rowactions > :global(*) { pointer-events: none; }

  .arcbtn {
    width: 26px; height: 26px;
    border: 0; border-radius: 6px;
    background: none;
    display: grid; place-items: center;
    color: var(--ink-faint, inherit);
    cursor: pointer;
  }
  .arcbtn:hover { color: var(--ink, inherit); background: color-mix(in srgb, var(--ink, #888) 8%, transparent); }
  .arcbtn.lit { color: var(--accent, #6aa); opacity: 1; }
  .arcbtn:focus-visible { outline: 2px solid var(--accent, #6aa); outline-offset: 1px; }
</style>
