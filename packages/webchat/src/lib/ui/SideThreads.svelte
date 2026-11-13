<script>
  import { tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import SideThread from './SideThread.svelte';
  import SelectPill from './SelectPill.svelte';
  import SelectBox from './SelectBox.svelte';
  import Icon from './Icon.svelte';
  import { GAP, RAIL_WIDTH, layout, resolveAnchor } from '$lib/core/sidechat.js';
  import { offsetAtPoint, rangeFromOffsets } from '$lib/core/textrange.js';

  let {
    session,
    chatState,
    threads = [],
    focusedId = null,
    collapsed = [],
    wide = true,
    autofocusId = null,
    hoverBlock = null,
    oncomment = () => {},
    selection = null,
    quick = null,
    onquote = () => {},
    onsidethread = () => {},
    onforkselection = () => {},
    onnote = () => {},
    // Highlight the selected words in a colour, no note; the reader pill's swatches.
    onhighlight = null,
    onreply = () => {},
    onquicksubmit = () => {},
    onquickcancel = () => {},
    onquickvalue = () => {},
    onquickkey = () => {},
    onquickbeforeinput = () => {},
    onquickbox = () => {},
    onfocus = () => {},
    oncollapse = () => {},
    onnewchat = () => {},
    // Comment mode (public documents): passed to each card; `onresolve(id, resolved)`.
    comments = false,
    onresolve = null,
    // Comment mode: `ondelete(id)` deletes a thread, `armedId` is the thread whose Delete was pressed once, `deletable(thread)` says whose card has it.
    ondelete = null,
    armedId = null,
    deletable = () => true,
    // The reader (src/routes/reader/+page.svelte): its anchors are offsets into one text index
    // over the whole article, not into a row, so it hands over the scroller, a function that turns
    // a thread into its DOM Range, and paints its own highlights. Unset, chat and docs as before.
    scrollRoot = null,
    locate = null,
    paintSpans = true,
    // Extra buttons in a card's header (the reader's Edit / Open link / Delete), given the thread.
    actions = null,
    // Width of the rail in px; the chat pane passes railWidthFor(its width).
    railWidth = RAIL_WIDTH
  } = $props();

  let root = $state(null);
  let scroller = $state(null);
  let heights = $state({});
  let anchors = $state({});
  let cards = $state({});

  const shown = $derived(threads.filter((thread) => !collapsed.includes(thread.id)));
  const visible = $derived(wide ? shown : []);

  const placed = $derived.by(() => {
    const input = visible
      .filter((thread) => anchors[thread.id] !== undefined)
      .map((thread) => ({ id: thread.id, anchorTop: anchors[thread.id], height: heights[thread.id] ?? 96 }));
    return layout(input, { focusedId, gap: GAP, minTop: 0 });
  });
  const topOf = $derived(Object.fromEntries(placed.map((card) => [card.id, card.top])));


  function rowFor(itemId) {
    if (!scroller || !itemId) return null;
    return scroller.querySelector(`[data-item="${CSS.escape(itemId)}"]`);
  }

  function rangeFor(thread) {
    if (locate) {
      const range = locate(thread);
      return range ? { row: scroller, range } : null;
    }
    const row = rowFor(thread.sidechat?.itemId);
    if (!row) return null;
    const resolved = resolveAnchor(thread.sidechat, row.textContent || '');
    if (resolved.state === 'orphaned') return { row, range: null };
    return { row, range: rangeFromOffsets(row, resolved.start, resolved.end) };
  }

  function measure() {
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const next = {};
    for (const thread of threads) {
      const found = rangeFor(thread);
      if (!found) continue;
      const rect = found.range ? found.range.getBoundingClientRect() : found.row.getBoundingClientRect();
      next[thread.id] = (!rect.height && !rect.width)
        ? Math.max(0, Math.round(found.row.offsetTop))
        : Math.max(0, Math.round(rect.top - box.top + scroller.scrollTop));
    }
    if (!same(next, anchors)) anchors = next;
    paint();
  }

  function same(a, b) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => a[key] === b[key]);
  }


  function paint() {
    if (!paintSpans) return;
    const registry = globalThis.CSS?.highlights;
    if (!registry) return;
    const all = [];
    const focus = [];
    for (const thread of threads) {
      const found = rangeFor(thread);
      if (!found?.range) continue;
      (thread.id === focusedId ? focus : all).push(found.range);
    }
    setHighlight(registry, 'sidechat', all);
    setHighlight(registry, 'sidechat-focus', focus);
  }

  function setHighlight(registry, name, ranges) {
    if (!ranges.length) { registry.delete(name); return; }
    registry.set(name, new globalThis.Highlight(...ranges));
  }

  $effect(() => () => {
    const registry = globalThis.CSS?.highlights;
    registry?.delete('sidechat');
    registry?.delete('sidechat-focus');
  });

  $effect(() => {
    if (!root) return;
    scroller = scrollRoot || root.closest('.scroller');
  });

  $effect(() => {
    threads.length;
    chatState.rev;
    focusedId;
    if (!scroller) return;
    tick().then(measure);
  });

  $effect(() => {
    if (!scroller) return;
    const column = scroller.querySelector('.column') || scroller;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(column);
    observer.observe(scroller);
    globalThis.document?.fonts?.ready?.then(schedule).catch(() => {});
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  });


  export function threadAtPoint(x, y) {
    for (const thread of threads) {
      const row = rowFor(thread.sidechat?.itemId);
      if (!row) continue;
      const rect = row.getBoundingClientRect();
      if (y < rect.top || y > rect.bottom || x < rect.left || x > rect.right) continue;
      const at = offsetAtPoint(row, x, y);
      if (at === null) continue;
      const resolved = resolveAnchor(thread.sidechat, row.textContent || '');
      if (resolved.state !== 'orphaned' && at >= resolved.start && at <= resolved.end) return thread.id;
    }
    return null;
  }

  /** Move a node to document.body for as long as it lives, out of any transformed ancestor. */
  function toBody(node) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  export function remeasure() { tick().then(measure); }
  export function focusCard(id) { cards[id]?.focusComposer(); }
</script>


{#snippet selectionButtons()}
  
  {#if onhighlight}
    {#each ['yellow', 'blue', 'rose', 'green'] as color (color)}
      <button class={`swatch ${color}`} onclick={() => onhighlight(color)} data-testid={`highlight-${color}`}
              aria-label={`Highlight ${color}`} title={`Highlight ${color}`}></button>
    {/each}
    <button class="press focus-ring ico" onclick={onnote} data-testid="note-selection" aria-label="Note" title="Highlight and write a note on this">
      <Icon name="note" size={18} />
    </button>
    <span class="div"></span>
  {/if}
  <button class="press focus-ring ico" onclick={onquote} data-testid="quote-into-main" aria-label="Quote into the main chat" title="Quote into the main chat">
    <Icon name="quote-in" size={18} />
  </button>
  <button class="press focus-ring ico" onclick={onsidethread} data-testid="open-side-thread" aria-label="Sidechat" title="Ask a side question about this, in a small floating chat">
    <Icon name="side-thread" size={18} />
  </button>
  <button class="press focus-ring ico" onclick={onforkselection} data-testid="fork-selection" aria-label="Fork" title="Fork the whole chat from this message">
    <Icon name="fork" size={18} />
  </button>
{/snippet}

{#if selection && !quick}
  <!-- mousedown would collapse the selection before the click lands, and the pill would vanish
       under the pointer; holding the selection is what makes the buttons clickable. -->
  {#if selection.docked}
    <!-- Docked is position:fixed, and the transcript's ancestors carry transforms that would
         become its containing block (it rendered 71,000px above the screen), so it lives on body. -->
    <div class="dock" use:toBody style:--dock-bottom="{selection.dockBottom ?? 14}px" onmousedown={(event) => event.preventDefault()} role="presentation">
      <SelectPill docked testid="selection-bar">{@render selectionButtons()}</SelectPill>
    </div>
  {:else}
    <div class="at" style:transform="translate3d({selection.left}px, {selection.top}px, 0)"
         onmousedown={(event) => event.preventDefault()} role="presentation"
         transition:fly={{ x: -6, duration: 120, easing: cubicOut }}>
      <SelectPill x={0} y={0} corner testid="selection-bar">{@render selectionButtons()}</SelectPill>
    </div>
  {/if}
{/if}

{#if quick}
  <div class="at" style:transform="translate3d({quick.left}px, {quick.top}px, 0)">
    <SelectBox
      x={0} y={0}
      quote={quick.quote}
      value={quick.text}
      busy={quick.busy}
      placeholder={quick.mode === 'note' ? 'Note on this' : 'Reply to this'}
      testid="selection-note"
      onbox={onquickbox}
      onvalue={onquickvalue}
      onkeydown={onquickkey}
      onbeforeinput={onquickbeforeinput}
    >
      {#snippet footer()}
        {#if quick.error}<span class="err">{quick.error}</span>{/if}
        <span class="spacer"></span>
        <span>{quick.mode === 'note' ? '↵ save' : '↵ send, you stay here'}</span>
        <button class="qgo primary" disabled={quick.busy || !String(quick.text || '').trim()}
                onclick={onquicksubmit} data-testid="selection-note-go">{quick.mode === 'note' ? 'Note' : 'Reply'}</button>
      {/snippet}
    </SelectBox>
  </div>
{/if}

<div class="rail" class:on={visible.length > 0} bind:this={root} data-testid="sidechat-rail" style:--rail-width="{railWidth}px">
  {#each visible as thread (thread.id)}
    <div
      class="slot"
      class:placed={topOf[thread.id] !== undefined && heights[thread.id] > 0}
      style:transform="translate3d(0, {topOf[thread.id] ?? anchors[thread.id] ?? 0}px, 0)"
      data-testid="sidechat-slot"
      data-sidechat-slot={thread.id}
    >
      <div bind:clientHeight={heights[thread.id]} in:fly={{ x: 16, duration: 180, easing: cubicOut }}>
        <SideThread
          bind:this={cards[thread.id]}
          {session}
          {chatState}
          {thread}
          focused={thread.id === focusedId}
          autofocus={thread.id === autofocusId}
          onfocus={() => onfocus(thread.id)}
          oncollapse={() => oncollapse(thread.id)}
          {onnewchat}
          {comments}
          resolved={Boolean(thread.resolvedAt)}
          onresolve={onresolve ? (value) => onresolve(thread.id, value) : null}
          ondelete={ondelete && deletable(thread) ? () => ondelete(thread.id) : null}
          deleteArmed={armedId === thread.id}
          {actions}
        />
      </div>
    </div>
  {/each}
</div>

<style>
  
  .rail {
    position: absolute;
    top: 0;
    right: 12px;
    width: var(--rail-width);
    height: 0;
    pointer-events: none;
    z-index: 4;
  }
  .slot {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    pointer-events: auto;
    
    transition: transform var(--panel) var(--ease), opacity var(--panel) var(--ease);
    opacity: 0;
  }
  .slot.placed { opacity: 1; }

  /* The shared pill and box carry their own chrome; this only puts them where the words are. */
  .at { position: absolute; top: 0; left: 0; z-index: 8; }
  .at :global([data-testid="selection-bar"]) { border-radius: 999px; padding: 3px; }
  .dock { position: fixed; z-index: 60; inset: auto 0 0 0; height: 0; }
  .dock :global([data-testid="selection-bar"]) { border-radius: 999px; padding: 4px; }
  .err { color: var(--warn, #d66); }

  
  @media (prefers-reduced-motion: reduce) {
    .slot { transition: none; }
  }
</style>
