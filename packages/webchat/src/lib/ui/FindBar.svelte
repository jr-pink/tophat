<script>
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { searchWithinChat } from '$lib/core/search.js';

  let { items = [], onjump = () => {}, onclose = () => {} } = $props();

  let query = $state('');
  let index = $state(0);
  let field = $state(null);

  const matches = $derived(searchWithinChat(items, query));

  $effect(() => { field?.focus(); });
  $effect(() => { if (index >= matches.length) index = 0; });
  $effect(() => { if (matches.length) onjump(matches[Math.min(index, matches.length - 1)]); });

  function step(delta) {
    if (!matches.length) return;
    index = (index + delta + matches.length) % matches.length;
  }
</script>

<div class="findbar" transition:fly={{ y: -8, duration: 140, easing: cubicOut }} data-testid="findbar">
  <input
    bind:this={field}
    bind:value={query}
    onkeydown={(event) => {
      if (event.key === 'Escape') onclose();
      if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    }}
    placeholder="Find in chat"
    data-testid="find-input"
    aria-label="Find in chat"
  />
  <span class="count" data-testid="find-count">{matches.length ? `${index + 1}/${matches.length}` : query ? '0' : ''}</span>
  <button class="press focus-ring" onclick={() => step(-1)} aria-label="Previous match">↑</button>
  <button class="press focus-ring" onclick={() => step(1)} aria-label="Next match">↓</button>
  <button class="press focus-ring" onclick={onclose} aria-label="Close find">✕</button>
</div>

<style>
  
  .findbar {
    position: absolute;
    top: 0; left: 0; right: 0;
    z-index: 8;
    display: flex; align-items: center; gap: 4px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--line-soft);
    
    background: var(--bg-raised);
  }
  input {
    flex: 1; min-width: 0;
    background: var(--bg-sunken); border: 1px solid var(--line); border-radius: 7px;
    padding: 5px 9px; color: var(--ink); font-size: 13px; outline: none;
  }
  input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .count { font-size: 11px; color: var(--ink-faint); font-variant-numeric: tabular-nums; min-width: 42px; text-align: center; }
  button { width: 26px; height: 26px; border-radius: 6px; color: var(--ink-faint); display: grid; place-items: center; font-size: 12px; }
  button:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 8%, transparent); }
</style>
