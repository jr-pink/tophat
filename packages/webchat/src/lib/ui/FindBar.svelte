<script>
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { searchWithinChat } from '$lib/core/search.js';

  // `tools`: search tool calls too (the device preference, core/prefs-state.js). `loading` while the chat's earlier pages are
  // still coming in, `partial` when some of them could not be fetched (tophat-md/tophat#5).
  // `query` and `index` are the chat's find state in the kit (core/find-state.js); the bar only projects them and reports
  // changes through `onquery` / `onindex`, so it holds no copy that could drift.
  let { items = [], tools = true, loading = false, partial = false, query = '', index = 0, ontools = () => {}, onquery = () => {}, onindex = () => {}, onjump = () => {}, onclose = () => {} } = $props();

  let field = $state(null);

  const matches = $derived(searchWithinChat(items, query, { tools }));

  $effect(() => { field?.focus(); });
  $effect(() => { if (index && index >= matches.length) onindex(0); });
  // No match clears the old highlight instead of leaving it on the previous hit.
  $effect(() => { if (!loading) onjump(matches[Math.min(index, matches.length - 1)] ?? null); });

  function step(delta) {
    if (!matches.length) return;
    onindex((index + delta + matches.length) % matches.length);
  }
</script>

<div class="findbar" transition:fly={{ y: -8, duration: 140, easing: cubicOut }} data-testid="findbar">
  <input
    bind:this={field}
    value={query}
    oninput={(event) => onquery(event.currentTarget.value)}
    onkeydown={(event) => {
      if (event.key === 'Escape') onclose();
      if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    }}
    placeholder="Find in chat"
    data-testid="find-input"
    aria-label="Find in chat"
  />
  <label class="scope" title="Search tool calls, their output, thinking and subagents too">
    <input type="checkbox" checked={tools} onchange={(event) => { onindex(0); ontools(event.currentTarget.checked); }} data-testid="find-tools" />
    tool calls
  </label>
  <span class="count" data-testid="find-count" title={partial ? 'Earlier messages could not be loaded; this counts the loaded part' : null}>{query && loading ? '…' : matches.length ? `${index + 1}/${matches.length}` : query ? '0' : ''}{query && partial ? '+' : ''}</span>
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
  .scope { display: flex; align-items: center; gap: 4px; flex: none; padding: 0 4px; font-size: 11px; color: var(--ink-faint); cursor: pointer; white-space: nowrap; }
  .scope input { flex: none; margin: 0; padding: 0; accent-color: var(--accent); }
  input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .count { font-size: 11px; color: var(--ink-faint); font-variant-numeric: tabular-nums; min-width: 42px; text-align: center; }
  button { width: 26px; height: 26px; border-radius: 6px; color: var(--ink-faint); display: grid; place-items: center; font-size: 12px; }
  button:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 8%, transparent); }
</style>
