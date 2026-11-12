<script>
  import { untrack } from 'svelte';
  import { MAX_SCALE, DOUBLE_TAP_SCALE, clamp, clampView, zoomAbout, pinchView, isDoubleTap } from './lightbox-zoom.js';
  import { lightbox, showFigures, hideFigures, finishClose, stepFigure, setFigureView } from './lightbox.svelte.js';

  // One viewer for every figure in a chat answer: images (Markdown's inline images, RichContent pictures) and
  // widget frames (RichContent opens those through openWidget). It listens on the document (capture phase) for a
  // click on a zoomable image, so nothing owns a modal of its own. Its state (open, items, index, zoom view, motion
  // phase) lives in lightbox.svelte.js; this file holds only live pointer scratch.
  // The image is the same URL the page already loaded: full resolution. A widget is re-rendered at the viewer's size.
  const ZOOMABLE = 'img[data-zoomable], .md-inline-image img';
  const REST = { s: 1, x: 0, y: 0 };
  const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
  const MS = 200;
  const WIDGET_MAX_SCALE = 6;

  const view = $derived(lightbox.view);
  const current = $derived(lightbox.items[lightbox.index] || null);
  const isWidget = $derived(current?.kind === 'widget');
  const native = $derived(view.s > 1);
  let root = $state();
  let stage = $state();
  let panel = $state();
  let innerWidth = $state(1280);
  let innerHeight = $state(800);

  // The widget's box: its in-chat aspect fitted into 90vw x 85vh (less the panel's padding and caption).
  const box = $derived.by(() => {
    const aspect = current?.aspect || 16 / 10;
    const maxW = Math.max(160, Math.min(innerWidth * 0.9, innerWidth - 52));
    const maxH = Math.max(120, innerHeight * 0.85 - 64);
    const w = Math.min(maxW, maxH * aspect);
    return { w: Math.round(w), h: Math.round(w / aspect) };
  });

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

  const describe = (el) => ({ kind: 'image', src: el.currentSrc || el.src, alt: el.getAttribute('alt') || '', el });

  function show(img) {
    const list = collect(img);
    showFigures(list.map(describe), Math.max(0, list.indexOf(img)));
  }

  function close() {
    hideFigures();
  }

  function onDocClick(event) {
    if (lightbox.open || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const img = event.target instanceof Element ? event.target.closest('img') : null;
    if (!img || !zoomable(img)) return;
    event.preventDefault();
    event.stopPropagation();
    show(img);
  }

  function onKey(event) {
    if (!lightbox.open) return;
    const key = event.key;
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (key === 'ArrowRight') { event.preventDefault(); stepFigure(1); return; }
    if (key === 'ArrowLeft') { event.preventDefault(); stepFigure(-1); return; }
    if (key === '1') { event.preventDefault(); toggleNative(); return; }
    if (key === '0') { event.preventDefault(); setFigureView({ ...REST }); return; }
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
    window.addEventListener('message', onFrameMessage);
    return () => {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('message', onFrameMessage);
    };
  });

  // Page scroll is locked and focus moves in while it is open; both are handed back when it closes.
  $effect(() => {
    if (!lightbox.open) return;
    const previousOverflow = document.body.style.overflow;
    const el = untrack(() => lightbox.items[lightbox.index]?.el);
    const trigger = el?.closest?.('button, a') || el;
    document.body.style.overflow = 'hidden';
    queueMicrotask(() => root?.focus({ preventScroll: true }));
    return () => {
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) {
        if (!trigger.matches('button, a, [tabindex]')) trigger.setAttribute('tabindex', '-1');
        trigger.focus({ preventScroll: true });
      }
    };
  });

  // Motion: one scale+fade between the figure's box in the chat and the centre, one easing, the same path back.
  // The figure's box is measured at rest (the panel carries no transform then); a figure scrolled away or gone
  // falls back to a fade.
  function fromFigure() {
    const el = current?.el;
    const target = panel?.querySelector('.viewport');
    if (!el?.isConnected || !target) return null;
    const a = el.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    if (!a.width || !a.height || !b.width || !b.height) return null;
    const s = clamp(a.width / b.width, 0.05, 1);
    const dx = a.left + a.width / 2 - (b.left + b.width / 2);
    const dy = a.top + a.height / 2 - (b.top + b.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${s})`;
  }
  const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function travel(reverse, done) {
    if (!panel?.animate || !root?.animate || still()) { done(); return; }
    const from = fromFigure();
    const frames = [{ transform: from || 'scale(0.96)', opacity: 0 }, { transform: 'none', opacity: 1 }];
    const options = { duration: MS, easing: EASE, fill: 'both', direction: reverse ? 'reverse' : 'normal' };
    const a = panel.animate(frames, options);
    const b = root.animate([{ opacity: 0 }, { opacity: 1 }], options);
    // A hidden tab runs no animations; a timer finishes the phase there.
    let ended = false;
    const end = () => { if (!ended) { ended = true; done(); } };
    Promise.all([a.finished, b.finished]).then(end, end);
    setTimeout(end, MS + 150);
  }

  $effect(() => {
    const phase = lightbox.phase;
    if (!lightbox.open || !panel) return;
    if (phase === 'in') travel(false, () => { if (lightbox.open && lightbox.phase === 'in') lightbox.phase = 'open'; });
    else if (phase === 'out') travel(true, () => { if (lightbox.phase === 'out') finishClose(); });
  });

  // A tap on the backdrop (anywhere but the panel and controls) closes. A tap or drag that began on the
  // figure never closes, even though pointer capture retargets its click to the stage.
  let downOnFigure = false;
  function onStageClick(event) {
    if (downOnFigure || event.target.closest('.panel, button')) { downOnFigure = false; return; }
    close();
  }

  const figure = () => stage?.querySelector('[data-fig]');
  const maxScale = () => {
    if (isWidget) return WIDGET_MAX_SCALE;
    const img = figure();
    const ratio = img && img.offsetWidth ? img.naturalWidth / img.offsetWidth : 0;
    return Math.max(MAX_SCALE, Number.isFinite(ratio) ? ratio : 0);
  };
  function geometry() {
    const fig = figure();
    const r = fig.getBoundingClientRect();
    const port = stage.querySelector('.viewport');
    return {
      c: { x: r.left + r.width / 2 - view.x, y: r.top + r.height / 2 - view.y },
      fit: { w: fig.offsetWidth, h: fig.offsetHeight },
      box: { w: port.clientWidth, h: port.clientHeight },
    };
  }
  function setView(next) {
    const g = geometry();
    setFigureView(clampView(next, g.fit, g.box, maxScale()));
  }
  function zoomTo(s, point) {
    const g = geometry();
    setView(s <= 1 ? { ...REST } : zoomAbout(view, s, point || g.c, g.c));
  }
  // The 1:1 control: native pixels when an image is larger than its fit size, else the double-tap scale.
  function toggleNative() {
    if (!stage || !figure()) return;
    if (view.s > 1) { setFigureView({ ...REST }); return; }
    const img = isWidget ? null : figure();
    const ratio = img && img.offsetWidth ? img.naturalWidth / img.offsetWidth : 0;
    zoomTo(ratio > 1.05 ? Math.min(ratio, maxScale()) : DOUBLE_TAP_SCALE);
  }

  // A widget frame swallows pointer events, so while it is at fit size it stays fully interactive and its bridge
  // script (rich-content.js) forwards a ctrl-wheel, a two-finger pinch, a double click and the keys Escape, 0 and 1 here (focus inside the frame would otherwise swallow them). Zoomed in,
  // a transparent layer over the frame takes the drag, wheel and double click like an image.
  function onFrameMessage(event) {
    const m = event.data;
    if (!lightbox.open || !isWidget || !m || typeof m !== 'object' || !m.tophatFigure) return;
    const frame = stage?.querySelector('iframe');
    if (!frame || event.source !== frame.contentWindow) return;
    const r = frame.getBoundingClientRect();
    const k = frame.offsetWidth ? r.width / frame.offsetWidth : 1;
    const p = { x: r.left + (Number(m.x) || 0) * k, y: r.top + (Number(m.y) || 0) * k };
    if (m.tophatFigure === 'wheel') zoomTo(Math.max(1, view.s * Math.exp(-(Number(m.dy) || 0) * 0.01)), p);
    else if (m.tophatFigure === 'pinch') zoomTo(Math.max(1, view.s * (Number(m.ratio) || 1)), p);
    else if (m.tophatFigure === 'key') onKey({ key: String(m.key), preventDefault() {}, stopPropagation() {} });
    else if (m.tophatFigure === 'dblclick') zoomTo(view.s > 1 ? 1 : DOUBLE_TAP_SCALE, p);
  }

  // Pointer gestures. One pointer pans when zoomed (a downward swipe closes at fit size on touch); two
  // pointers pinch and pan together; a second quick tap toggles 1x and 3x about the tap.
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let lastTap = null;
  let lastType = '';
  let lastOnFigure = false;
  const pair = () => { const [a, b] = [...pointers.values()]; return { m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: Math.hypot(a.x - b.x, a.y - b.y) }; };

  function down(event) {
    lastType = event.pointerType;
    lastOnFigure = !!event.target.closest('[data-fig], .pan');
    if (!pointers.size) downOnFigure = !!event.target.closest('[data-fig], .pan');
    if (!downOnFigure || event.target.closest('button')) return;
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
    else if (event.pointerType === 'touch' && dy > 0 && dy > Math.abs(dx)) lightbox.dragY = dy;
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
    const swipe = d.v0.s <= 1 && event.pointerType === 'touch' && lightbox.dragY > 90;
    lightbox.dragY = 0;
    if (swipe) { close(); return; }
    if (event.type === 'pointercancel' || d.moved || event.timeStamp - d.t > 350) { lastTap = null; return; }
    // A mouse double click arrives as a dblclick event (stageDblClick); touch and pen are timed here.
    if (event.pointerType === 'mouse') { lastTap = null; return; }
    const now = { t: event.timeStamp, x: event.clientX, y: event.clientY };
    if (isDoubleTap(lastTap, now)) {
      lastTap = null;
      zoomTo(view.s > 1 ? 1 : DOUBLE_TAP_SCALE, { x: now.x, y: now.y });
    } else lastTap = now;
  }

  function stageDblClick(event) {
    // Pointer capture retargets the click to the stage, so where the press began is what says it was on the figure.
    if (lastType !== 'mouse' || !lastOnFigure) return;
    zoomTo(view.s > 1 ? 1 : DOUBLE_TAP_SCALE, { x: event.clientX, y: event.clientY });
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

  const transform = $derived(view.s > 1 || view.x || view.y || lightbox.dragY ? `translate(${view.x}px, ${view.y + lightbox.dragY}px) scale(${view.s})` : null);
</script>

<svelte:window bind:innerWidth bind:innerHeight />

{#if lightbox.open && current}
  <div
    bind:this={root}
    class="lightbox"
    role="dialog"
    aria-modal="true"
    aria-label={current.alt || (isWidget ? 'Figure' : 'Image')}
    data-testid="lightbox"
    data-phase={lightbox.phase}
    tabindex="-1"
  >
    <div class="bar">
      {#if lightbox.items.length > 1}<span class="count" data-testid="lightbox-count">{lightbox.index + 1} / {lightbox.items.length}</span>{/if}
      {#if lightbox.items.length > 1}
        <button type="button" onclick={() => stepFigure(-1)} aria-label="Previous image">‹</button>
        <button type="button" onclick={() => stepFigure(1)} aria-label="Next image">›</button>
      {/if}
      <button type="button" class:on={native} aria-pressed={native} onclick={toggleNative} title={isWidget ? 'Zoom (1)' : 'Native pixels (1)'} data-testid="lightbox-native">{isWidget ? '2×' : '1:1'}</button>
      <button type="button" onclick={close} aria-label="Close" data-testid="lightbox-close">✕</button>
    </div>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="stage" class:native bind:this={stage} use:wheel onclick={onStageClick} ondblclick={stageDblClick} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
      <div class="panel" bind:this={panel} data-testid="lightbox-panel">
        {#if isWidget}
          <div class="viewport widget" style:width="{box.w}px" style:height="{box.h}px">
            <div class="fig" data-fig data-testid="lightbox-widget" style:transform>
              <iframe title={current.alt || 'Figure'} srcdoc={current.doc} sandbox="allow-scripts" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"></iframe>
            </div>
            {#if native}<div class="pan" data-testid="lightbox-pan"></div>{/if}
          </div>
        {:else}
          <div class="viewport">
            <img data-fig src={current.src} alt={current.alt} draggable="false" style:transform data-testid="lightbox-image" />
          </div>
        {/if}
        {#if current.alt}<p class="caption" data-testid="lightbox-caption">{current.alt}</p>{/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .lightbox {
    position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column;
    background: rgb(38 37 35 / 0.62); color: #e8e6e3; outline: none; overscroll-behavior: contain;
  }
  .bar { position: absolute; top: 0; right: 0; z-index: 1; display: flex; align-items: center; gap: 4px; padding: max(8px, env(safe-area-inset-top)) 10px 8px; font: 12px/1 ui-monospace, 'SF Mono', Menlo, monospace; }
  .count { margin-right: 8px; color: #d8d6d2; }
  button { font: inherit; font-size: 14px; min-width: 34px; min-height: 34px; padding: 0 8px; color: inherit; cursor: pointer; background: rgb(0 0 0 / 0.35); border: 1px solid #ffffff2e; border-radius: 6px; }
  button:hover, button.on { background: #ffffff26; }
  button:focus-visible { outline: 2px solid #d98a5c; outline-offset: 1px; }
  .stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 48px 16px 16px; overflow: hidden; touch-action: none; overscroll-behavior: contain; }
  .panel { display: flex; flex-direction: column; gap: 8px; max-width: 100%; padding: 10px; box-sizing: border-box; background: #e6e5e2; color: #2b2a28; border-radius: 10px; box-shadow: 0 12px 40px rgb(0 0 0 / 0.28); will-change: transform, opacity; }
  .viewport { position: relative; overflow: hidden; align-self: center; border-radius: 4px; max-width: 100%; }
  .viewport.widget { background: #fff; }
  .viewport img { display: block; max-width: min(90vw, calc(100vw - 52px)); max-height: calc(85vh - 64px); object-fit: contain; user-select: none; -webkit-user-drag: none; transform-origin: 50% 50%; will-change: transform; }
  .fig { width: 100%; height: 100%; transform-origin: 50% 50%; will-change: transform; }
  .fig iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
  .pan { position: absolute; inset: 0; cursor: grab; }
  .stage.native .pan, .stage.native img { cursor: grab; }
  .caption { margin: 0; text-align: center; font: 12.5px/1.45 ui-monospace, 'SF Mono', Menlo, monospace; color: #4a4946; overflow-wrap: anywhere; max-height: 22vh; overflow: auto; }
</style>
