<script>
  // First-run coaching tips. All state is the onboarding store (core/onboarding-state.js): which tip, where it sits.
  // This component only (1) tells the store what the app already knows (is the account old, is there an auto chat,
  // does he have workspaces), (2) reports the anchor's rectangle and its own size so the store can compute the tip's
  // absolute position, and (3) draws the tip at the position the store holds. Nothing here decides a step.
  import { onMount, tick } from 'svelte';
  import { every } from '../../../../runner/tools/docstore-kit/lib/timers.js';
  import { onboardingStore } from '$lib/client/onboarding.js';
  import { activeTip, anchorSelector, tipText, STEPS } from '$lib/core/onboarding-state.js';
  import { automatedTitle } from '$lib/core/title.js';
  import { isApple } from '$lib/core/keys.js';

  let { conversations = {}, status = {}, workspaceNames = [], replayRequest = 0 } = $props();

  const store = onboardingStore();
  const ob = $derived($store);
  const tip = $derived(activeTip(ob));
  const text = $derived(tip ? tipText(tip.key, isApple()) : null);
  const placed = $derived(Boolean(tip && ob.tip && ob.tip.key === tip.key && ob.tip.anchor === tip.anchor));
  const stepNo = $derived(tip && STEPS.includes(tip.key) ? STEPS.indexOf(tip.key) + 1 : 0);
  let box = $state(null);

  // Whether this is an account that already has chats. Chats the cache or server named settle it at once; an empty
  // list is only believed once the server connection has had a moment to deliver the list.
  const chatCount = $derived(Object.values(conversations).filter((c) => c && (c.turns > 0 || c.preview)).length);
  $effect(() => {
    if (ob.seeded) return;
    if (chatCount > 0) { store.dispatch('seed', { chats: chatCount }); return; }
    if (!status.connected) return;
    const wait = setTimeout(() => store.dispatch('seed', { chats: chatCount }), 2000);
    return () => clearTimeout(wait);
  });

  // The newest automated chat still in his list: the inbox tooltip's target. An automated chat that has since been
  // archived (by itself or by him) closes the tooltip.
  const autoRow = $derived(Object.values(conversations)
    .filter((c) => c && !c.archived && !c.aside && !c.revoked && (c.automated || automatedTitle(c.title).automated))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null);
  $effect(() => { if (ob.seeded && autoRow && !ob.autoChat && !ob.done.auto) store.dispatch('auto.seen', { chat: autoRow.id }); });
  $effect(() => { if (ob.autoChat && conversations[ob.autoChat]?.archived) store.dispatch('auto.ack'); });

  // Workspaces he already uses end the workspaces step without a tip.
  $effect(() => { if (workspaceNames.length) store.dispatch('workspace.made', { name: workspaceNames[0] }); });

  // The menu entry (and ?onboarding) start the tour over.
  let lastReplay = replayRequest;
  $effect(() => { if (replayRequest !== lastReplay) { lastReplay = replayRequest; store.dispatch('replay'); } });
  onMount(() => { if (new URLSearchParams(location.search).has('onboarding')) store.dispatch('replay'); });

  // Report the anchor's rectangle; the store answers with the position. Re-reported when the layout can have moved.
  function measure() {
    if (!tip || !box) return;
    const sel = anchorSelector(tip.anchor);
    const el = sel ? document.querySelector(sel) : null;
    const r = el?.getBoundingClientRect();
    const rect = r && (r.width || r.height) ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
    store.dispatch('tip.place', { key: tip.key, anchor: tip.anchor, side: tip.side, rect, size: { w: box.offsetWidth, h: box.offsetHeight }, view: { w: window.innerWidth, h: window.innerHeight } });
  }
  $effect(() => {
    if (!tip) return;
    void tip.key; void tip.anchor; void box;
    tick().then(measure);
    const sel = anchorSelector(tip.anchor);
    const el = sel ? document.querySelector(sel) : null;
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (el) watch?.observe(el);
    if (box) watch?.observe(box);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    // A pane opening or the list animating moves an anchor without a resize.
    const stopPoll = every('onboarding-tip', 400, measure, { budgetMs: 8 });
    return () => { watch?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); stopPoll(); };
  });

  const KEYS = /((?:Cmd|Ctrl)\+[A-Za-z]+(?:\+[A-Za-z]+)*|\bEnter\b)/u;
  const parts = (s) => s.split(KEYS).map((t, i) => ({ t, key: i % 2 === 1 })).filter((p) => p.t);

  const gotIt = () => (tip.key === 'auto' ? store.dispatch('auto.ack') : store.dispatch('tip.skip', { step: tip.key }));
  const terminal = $derived(tip && (tip.key === 'auto' || tip.key === 'workspaces'));
</script>

{#if tip && text}
  <div
    class="ob" class:placed bind:this={box} role="note" aria-live="polite"
    data-testid="onboarding-tip" data-step={tip.key} data-side={placed ? ob.tip.side : ''}
    style="left:{placed ? ob.tip.x : 0}px; top:{placed ? ob.tip.y : 0}px; --ax:{placed ? ob.tip.ax : 0}px; --ay:{placed ? ob.tip.ay : 0}px"
  >
    <i class="arrow" aria-hidden="true"></i>
    <div class="title">{text.title}</div>
    <div class="body">{#each parts(text.body) as p}{#if p.key}<kbd>{p.t}</kbd>{:else}{p.t}{/if}{/each}</div>
    <div class="foot">
      {#if stepNo}<span class="count">{stepNo}/{STEPS.length}</span>{/if}
      <button type="button" class="link" onclick={() => store.dispatch('tour.skip')} data-testid="onboarding-skip-all">Skip tour</button>
      <span class="grow"></span>
      <button type="button" class="go" onclick={gotIt} data-testid="onboarding-next">{terminal ? 'Got it' : 'Skip'}</button>
    </div>
  </div>
{/if}

<style>
  .ob {
    position: fixed; z-index: 60; box-sizing: border-box;
    width: min(300px, calc(100vw - 16px));
    padding: 10px 12px 9px; border-radius: 8px;
    background: var(--bg-raised); color: var(--ink);
    border: 1px solid var(--line); box-shadow: 0 6px 22px rgb(0 0 0 / 0.28);
    font-family: var(--mono); font-size: 12px; line-height: 1.45;
    visibility: hidden; opacity: 0; transition: opacity 120ms var(--ease);
  }
  .ob.placed { visibility: visible; opacity: 1; }
  .title { color: var(--accent); font-size: 12px; margin-bottom: 4px; }
  .body { color: var(--ink-dim); }
  kbd {
    font: inherit; color: var(--ink); background: var(--bg-sunken);
    border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; white-space: nowrap;
  }
  .foot { display: flex; align-items: center; gap: 10px; margin-top: 9px; color: var(--ink-faint); }
  .grow { flex: 1; }
  .count { font-size: 11px; }
  button { font: inherit; font-size: 11px; cursor: pointer; }
  .link { background: none; border: 0; padding: 0; color: var(--ink-faint); text-decoration: underline; text-underline-offset: 2px; }
  .link:hover { color: var(--ink-dim); }
  .go { background: none; color: var(--ink); border: 1px solid var(--line); border-radius: 5px; padding: 2px 9px; }
  .go:hover { border-color: var(--accent); }
  /* The arrow is a rotated square on the edge facing the anchor, its offset along that edge from the store. */
  .arrow { position: absolute; width: 9px; height: 9px; background: var(--bg-raised); border: 1px solid var(--line); transform: rotate(45deg); display: none; }
  .ob[data-side='above'] .arrow { display: block; bottom: -5px; left: calc(var(--ax) - 5px); border-top: 0; border-left: 0; }
  .ob[data-side='below'] .arrow { display: block; top: -5px; left: calc(var(--ax) - 5px); border-bottom: 0; border-right: 0; }
  .ob[data-side='right'] .arrow { display: block; left: -5px; top: calc(var(--ay) - 5px); border-top: 0; border-right: 0; }
  .ob[data-side='left'] .arrow { display: block; right: -5px; top: calc(var(--ay) - 5px); border-bottom: 0; border-left: 0; }
</style>
