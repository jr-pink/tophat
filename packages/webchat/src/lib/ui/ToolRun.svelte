<script>
  import { tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import ToolCard from './ToolCard.svelte';
  import ThinkingCard from './ThinkingCard.svelte';
  import { formatDuration, runFoldIds } from '$lib/core/toolruns.js';
  import { useFolds } from './disclosure.svelte.js';

  let { run, onpath = () => {} } = $props();

  const ids = $derived(runFoldIds(run));
  const folds = useFolds();
  const open = $derived(folds.isOpen('run', ids));
  let box = $state(null);

  const took = $derived(formatDuration(run.ms));

  async function toggle() {
    const scroller = box?.closest('.scroller');
    const offsetOf = () => box.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const before = scroller && box && offsetOf() > -box.offsetHeight && offsetOf() < scroller.clientHeight ? offsetOf() : null;
    folds.toggle('run', ids);
    if (before === null) return;
    await tick();
    const restore = () => { if (box?.isConnected && scroller) scroller.scrollTop += offsetOf() - before; };
    restore();
    requestAnimationFrame(restore);
  }
</script>

<div class="run" bind:this={box} data-testid="tool-run">
  <button class="head press focus-ring" onclick={toggle} aria-expanded={open} data-testid="tool-run-head">
    <span class="chev" class:open>›</span>
    {#if run.count}
      <span class="what">called {run.count} tool{run.count === 1 ? '' : 's'}</span>
      <span class="sep">·</span>
      <span class="got">{run.results} result{run.results === 1 ? '' : 's'}</span>
    {/if}
    {#if run.failures}
      <span class="sep">·</span>
      <span class="warn" data-testid="tool-run-failures">{run.failures} failed ({run.failed.join(', ')})</span>
    {/if}
    {#if run.thinking}{#if run.count}<span class="sep">·</span>{/if}<span class="thought" data-testid="tool-run-thinking">thought {run.thinking === 1 ? 'once' : `${run.thinking} times`}</span>{/if}
    {#if took}<span class="sep">·</span><span class="took">{took}</span>{/if}
  </button>

  {#if open}
    <div class="cards" transition:slide={{ duration: 160, easing: cubicOut }}>
      {#each run.items || run.tools as card (card.id)}
        {#if card.type === 'thinking'}
          <ThinkingCard item={card} />
        {:else}
          <ToolCard item={card} {onpath} />
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .run { margin: 4px 0; }
  .head {
    display: flex; align-items: center; gap: 6px;
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--line-soft);
    border-radius: var(--radius);
    background: var(--bg-raised);
    font-family: var(--sans); font-size: 12.2px; color: var(--ink-dim);
    text-align: left;
  }
  .chev { color: var(--ink-faint); transition: transform var(--tap) var(--ease); }
  .chev.open { transform: rotate(90deg); }
  .sep { color: var(--ink-faint); }
  .warn { color: var(--warn); }
  .took, .thought { color: var(--ink-faint); }
  .cards { padding-top: 4px; display: flex; flex-direction: column; gap: 4px; }
</style>
