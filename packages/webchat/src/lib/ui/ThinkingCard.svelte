<script>
  import { tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Icon from './Icon.svelte';
  import { useFolds } from './disclosure.svelte.js';
  import { thinkingSummary } from '$lib/core/toolruns.js';

  // A thinking block drawn as a card in the tool-call family: collapsed by default, a "Thinking"
  // label and a one-line preview in the head, the full text when opened. Settled thinking between
  // finished tool calls is folded into the same run as those calls (core/toolruns.js), so it
  // collapses with them. The open state keeps its old fold key, 'thinking' + item id, so what he
  // opened before this change stays open.
  let { item } = $props();

  const folds = useFolds();
  const open = $derived(folds.isOpen('thinking', item.id));
  // Live: still streaming and not opened by him. The newest lines stream in under the head,
  // clamped to three lines, and fold away on their own when the block settles.
  const live = $derived(item.streaming === true && !open);
  const summary = $derived(thinkingSummary(item.text));

  let card = $state(null);

  async function toggle() {
    const scroller = card?.closest('.scroller');
    const offsetOf = () => card.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const visible = scroller && card && offsetOf() > -card.offsetHeight && offsetOf() < scroller.clientHeight;
    const before = visible ? offsetOf() : null;
    folds.toggle('thinking', item.id);
    if (before === null) return;
    await tick();
    const restore = () => { if (card?.isConnected && scroller) scroller.scrollTop += offsetOf() - before; };
    restore();
    requestAnimationFrame(restore);
  }
</script>

<div
  class="card"
  class:live
  bind:this={card}
  data-testid="thinking-card"
  data-thinking-live={live ? 'true' : 'false'}
>
  <button class="head press focus-ring" type="button" onclick={toggle} aria-expanded={open} data-testid="thinking-toggle">
    <span class="chev" class:open>›</span>
    <span class="icon"><Icon name="thinking" size={13} /></span>
    <span class="label">Thinking</span>
    {#if !open && summary}<span class="summary">{summary}</span>{/if}
    {#if item.streaming}<span class="dot"></span>{/if}
  </button>

  {#if live && item.text}
    <button class="stream focus-ring" type="button" data-testid="thinking-live" aria-label="show thinking" onclick={toggle}>
      <span class="stream-text">{item.text}</span>
    </button>
  {/if}

  {#if open}
    <div class="body" data-testid="thinking-body" transition:slide={{ duration: 180, easing: cubicOut }}>{item.text}</div>
  {/if}
</div>

<style>
  .card {
    border: 1px solid var(--line-soft);
    border-radius: var(--radius);
    background: var(--bg-raised);
    margin: 6px 0;
    overflow: hidden;
  }
  .card.live { border-color: color-mix(in srgb, var(--accent) 40%, var(--line-soft)); }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 11px;
    min-height: 38px;
    text-align: left;
    cursor: pointer;
  }
  .head:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
  .chev {
    display: inline-block;
    color: var(--ink-faint);
    transition: transform var(--tap) var(--ease);
    font-size: 15px;
    line-height: 1;
  }
  .chev.open { transform: rotate(90deg); }
  .icon { color: var(--ink-faint); display: grid; place-items: center; flex: none; }
  .label { font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em; flex: none; color: var(--ink-dim); }
  .summary {
    font-size: 12px;
    font-style: italic;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; margin-left: auto; }
  .stream {
    display: flex; flex-direction: column-reverse; max-height: 4.65em; overflow: hidden; width: 100%;
    text-align: left; cursor: pointer;
    border-top: 1px solid var(--line-soft);
    padding: 0 11px;
    font-size: 12.5px; line-height: 1.5; font-style: italic; color: var(--ink-faint);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 1.5em); mask-image: linear-gradient(to bottom, transparent 0, #000 1.5em);
    box-sizing: content-box;
  }
  .stream-text { white-space: pre-wrap; overflow-wrap: anywhere; padding: 4px 0 6px; }
  .body {
    border-top: 1px solid var(--line-soft);
    padding: 8px 11px 10px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink-dim);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 480px;
    overflow: auto;
  }
</style>
