<script>
  import { MAX_SCALE, DOUBLE_TAP_SCALE, clampView, zoomAbout, pinchView, isDoubleTap } from './lightbox-zoom.js';

  // One lightbox for every chat image. It listens on the document (capture phase) for a click on a
  // zoomable image, so Markdown's inline images, RichContent figures and anything added later share it
  // without each owning a modal. The image is the same URL the page already loaded: full resolution.
  const ZOOMABLE = 'img[data-zoomable], .md-inline-image img';

  let open = $state(false);
  let items = $state([]);
  let index = $state(0);
  // Zoom view: translate(x, y) scale(s) about the image centre; s = 1 is the fit size. Reset on open,
  // on step and on close. Two-finger pinch, double tap, wheel and drag-to-pan all write it.
  let view = $state({ s: 1, x: 0, y: 0 });
  const native = $derived(view.s > 1);
  let dragY = $state(0);
  let root = $state();
  let stage = $state();
  let trigger = null;
  let previousOverflow = '';

  const current = $derived(items[index] || null);

  // A link around an image keeps its own behaviour, except the RichContent anchor that only opened the
  // same file in a new tab (it marks its image data-zoomable).
  function zoomable(el) {
    if (!(el instanceof Element) || !el.matches(ZOOMABLE)) return false;
    const link = el.closest('a[href]');
    return !link || el.hasAttribute('data-zoomable');
  }

  function collect(img) {
    const scope = img.closest('[data-item]') || img.closest('.prose') || document;
    const all = [...scope.querySelectorAll(ZOOMABLE)].filter(zoomable);
    if (!all.includes(img)) all.push(img);
    return all;
  }

  const describe = (el) => ({ src: el.currentSrc || el.src, alt: el.getAttribute('alt') || '', el });

  function show(img) {
    const list = collect(img);
    items = list.map(describe);
    index = Math.max(0, list.indexOf(img));
    view = { s: 1, x: 0, y: 0 };
    dragY = 0;
    trigger = img.closest('button, a') || img;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    open = true;
    queueMicrotask(() => root?.focus({ preventScroll: true }));
  }

  function close() {
    if (!open) return;
    open = false;
    view = { s: 1, x: 0, y: 0 };
    document.body.style.overflow = previousOverflow;
    const back = trigger;
    trigger = null;
    if (back?.isConnected) {
      if (!back.matches('button, a, [tabindex]')) back.setAttribute('tabindex', '-1');
      back.focus({ preventScroll: true });
    }
  }

  function step(delta) {
    if (items.length < 2) return;
    index = (index + delta + items.length) % items.length;
    view = { s: 1, x: 0, y: 0 };
  }

  function onDocClick(event) {
    if (open || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const img = event.target instanceof Element ? event.target.closest('img') : null;
    if (!img || !zoomable(img)) return;
    event.preventDefault();
    event.stopPropagation();
    show(img);
  }

  function onKey(event) {
    if (!open) return;
    const key = event.key;
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (key === 'ArrowRight') { event.preventDefault(); step(1); return; }
    if (key === 'ArrowLeft') { event.preventDefault(); step(-1); return; }
    if (key === '1') { event.preventDefault(); toggleNative(); return; }
    if (key === '0') { event.preventDefault(); view = { s: 1, x: 0, y: 0 }; return; }
    if (key === 'Tab') {
      const stops = [...root.querySelectorAll('button')];
      if (!stops.length) { event.preventDefault(); return; }
      const at = stops.indexOf(document.activeElement);
      const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at === stops.length - 1 ? 0 : at + 1);
      event.preventDefault();
      stops[next].focus();
    }
  }

  $effect(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (open) document.body.style.overflow = previousOverflow;
    };
  });

  // A tap on the backdrop (anywhere but the image and controls) closes. A tap or drag that began on the
  // image never closes, even though pointer capture retargets its click to the stage.
  let downOnImage = false;
  function onStageClick(event) {
    if (downOnImage || event.target.closest('img, button')) { downOnImage = false; return; }
    close();
  }

  const maxScale = () => {
    const img = stage?.querySelector('img');
    const ratio = img && img.offsetWidth ? img.naturalWidth / img.offsetWidth : 0;
    return Math.max(MAX_SCALE, Number.isFinite(ratio) ? ratio : 0);
  };
  function geometry() {
    const img = stage.querySelector('img');
    const r = img.getBoundingClientRect();
    return {
      c: { x: r.left + r.width / 2 - view.x, y: r.top + r.height / 2 - view.y },
      fit: { w: img.offsetWidth, h: img.offsetHeight },
      box: { w: stage.clientWidth, h: stage.clientHeight },
    };
  }
  function setView(next) {
    const g = geometry();
    view = clampView(next, g.fit, g.box, maxScale());
  }
  function zoomTo(s, point) {
    const g = geometry();
    setView(s <= 1 ? { s: 1, x: 0, y: 0 } : zoomAbout(view, s, point || g.c, g.c));
  }
  // The 1:1 control: native pixels when the file is larger than its fit size, else the double-tap scale.
  function toggleNative() {
    if (view.s > 1) { view = { s: 1, x: 0, y: 0 }; return; }
    const img = stage?.querySelector('img');
    const ratio = img && img.offsetWidth ? img.naturalWidth / img.offsetWidth : 0;
    zoomTo(ratio > 1.05 ? Math.min(ratio, maxScale()) : DOUBLE_TAP_SCALE);
  }

  // Pointer gestures. One pointer pans when zoomed (a downward swipe closes at fit size on touch); two
  // pointers pinch and pan together; a second quick tap toggles 1x and 3x about the tap.
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let lastTap = null;
  const pair = () => { const [a, b] = [...pointers.values()]; return { m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: Math.hypot(a.x - b.x, a.y - b.y) }; };

  function down(event) {
    if (!pointers.size) downOnImage = !!event.target.closest('img');
    if (!downOnImage || event.target.closest('button')) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    stage.setPointerCapture?.(event.pointerId);
    if (pointers.size === 2) {
      const { m, d } = pair();
      pinch = { v0: { ...view }, m0: m, d0: d, c: geometry().c };
      drag = null;
    } else if (pointers.size === 1) {
      drag = { x: event.clientX, y: event.clientY, v0: { ...view }, t: event.timeStamp, moved: false };
    }
  }
  function move(event) {
    const p = pointers.get(event.pointerId);
    if (!p) return;
    p.x = event.clientX; p.y = event.clientY;
    if (pinch && pointers.size >= 2) {
      const { m, d } = pair();
      setView(pinchView(pinch.v0, pinch.m0, pinch.d0, m, d, pinch.c, maxScale()));
      return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 8) drag.moved = true;
    if (drag.v0.s > 1) setView({ s: drag.v0.s, x: drag.v0.x + dx, y: drag.v0.y + dy });
    else if (event.pointerType === 'touch' && dy > 0 && dy > Math.abs(dx)) dragY = dy;
  }
  function up(event) {
    if (!pointers.delete(event.pointerId)) return;
    if (pinch) {
      // Fingers lifting one by one: the remaining finger carries on as a pan from where it is.
      pinch = null;
      drag = pointers.size === 1 ? (() => { const [r] = [...pointers.values()]; return { x: r.x, y: r.y, v0: { ...view }, t: 0, moved: true }; })() : null;
      return;
    }
    const d = drag;
    drag = null;
    if (!d) return;
    const swipe = d.v0.s <= 1 && event.pointerType === 'touch' && dragY > 90;
    dragY = 0;
    if (swipe) { close(); return; }
    if (event.type === 'pointercancel' || d.moved || event.timeStamp - d.t > 350) { lastTap = null; return; }
    const now = { t: event.timeStamp, x: event.clientX, y: event.clientY };
    if (isDoubleTap(lastTap, now)) {
      lastTap = null;
      zoomTo(view.s > 1 ? 1 : DOUBLE_TAP_SCALE, { x: now.x, y: now.y });
    } else lastTap = now;
  }

  // Wheel and trackpad pinch (ctrlKey) zoom about the cursor. Not passive, so the page never scrolls.
  function wheel(node) {
    const on = (event) => {
      event.preventDefault();
      const k = event.ctrlKey ? 0.01 : 0.0015;
      const s = view.s * Math.exp(-event.deltaY * k);
      zoomTo(Math.max(1, s), { x: event.clientX, y: event.clientY });
    };
    node.addEventListener('wheel', on, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', on) };
  }
</script>

{#if open && current}
  <div
    bind:this={root}
    class="lightbox"
    role="dialog"
    aria-modal="true"
    aria-label={current.alt || 'Image'}
    data-testid="lightbox"
    tabindex="-1"
  >
    <div class="bar">
      {#if items.length > 1}<span class="count" data-testid="lightbox-count">{index + 1} / {items.length}</span>{/if}
      {#if items.length > 1}
        <button type="button" onclick={() => step(-1)} aria-label="Previous image">‹</button>
        <button type="button" onclick={() => step(1)} aria-label="Next image">›</button>
      {/if}
      <button type="button" class:on={native} aria-pressed={native} onclick={toggleNative} title="Native pixels (1)" data-testid="lightbox-native">1:1</button>
      <button type="button" onclick={close} aria-label="Close" data-testid="lightbox-close">✕</button>
    </div>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="stage" class:native bind:this={stage} use:wheel onclick={onStageClick} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
      <img src={current.src} alt={current.alt} draggable="false" style:transform={view.s > 1 || view.x || view.y || dragY ? `translate(${view.x}px, ${view.y + dragY}px) scale(${view.s})` : null} data-testid="lightbox-image" />
    </div>
    {#if current.alt}<p class="caption" data-testid="lightbox-caption">{current.alt}</p>{/if}
  </div>
{/if}

<style>
  .lightbox {
    position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column;
    background: rgb(0 0 0 / 0.92); color: #e8e6e3; outline: none; overscroll-behavior: contain;
    animation: lightbox-fade 120ms linear;
  }
  @keyframes lightbox-fade { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .lightbox { animation: none; } }
  .bar { position: absolute; top: 0; right: 0; z-index: 1; display: flex; align-items: center; gap: 4px; padding: max(8px, env(safe-area-inset-top)) 10px 8px; font: 12px/1 ui-monospace, 'SF Mono', Menlo, monospace; }
  .count { margin-right: 8px; color: #a1a09c; }
  button { font: inherit; font-size: 14px; min-width: 34px; min-height: 34px; padding: 0 8px; color: inherit; cursor: pointer; background: rgb(0 0 0 / 0.5); border: 1px solid #ffffff2e; border-radius: 6px; }
  button:hover, button.on { background: #ffffff1f; }
  button:focus-visible { outline: 2px solid #d98a5c; outline-offset: 1px; }
  .stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 48px 16px 8px; overflow: hidden; touch-action: none; overscroll-behavior: contain; }
  .stage img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
  .stage.native { cursor: grab; }
  .stage img { transform-origin: 50% 50%; will-change: transform; }
  .caption { margin: 0; padding: 8px 16px max(14px, env(safe-area-inset-bottom)); text-align: center; font: 12.5px/1.45 ui-monospace, 'SF Mono', Menlo, monospace; color: #cfcdc9; overflow-wrap: anywhere; max-height: 22vh; overflow: auto; }
</style>
