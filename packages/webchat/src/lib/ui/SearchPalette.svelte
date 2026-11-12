<script>
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { CACHED_LIMIT, mergeResults, quickIndexFor, quickswitchResults, recentChats, searchCachedChats, searchStages, titleMatches } from '$lib/core/search.js';
  import { rankConversations } from '$lib/core/recency.js';
  import { isListDown, isListUp } from '$lib/core/keys.js';
  import { extStore, runExtCommand } from '$lib/client/extensions.js';

  let { chatState, session, onopen = () => {}, onclose = () => {} } = $props();

  let query = $state('');
  let results = $state([]);
  let serverResults = $state([]);
  let expanded = $state([]);
  let selected = $state(0);
  let field = $state(null);
  let requestId = 0;

  const recents = $derived(query.trim() ? [] : recentChats(chatState.conversations, { rank: rankConversations }));
  const titles = $derived(titleMatches(chatState.conversations, query, { rank: rankConversations }));
  const cached = $derived(searchCachedChats(chatState, query, { limit: CACHED_LIMIT }));
  // A query starting with ">" lists commands (EXTENSIONS-V1 section 7, VS Code's palette): each is one action, run by name.
  const ext = extStore();
  const commandMode = $derived(query.startsWith('>'));
  const commands = $derived(commandMode
    ? ($ext.commands || []).filter((c) => c.title.toLowerCase().includes(query.slice(1).trim().toLowerCase()))
      .map((c) => ({ conversationId: `cmd:${c.id}`, command: c.id, title: c.title, excerpt: c.category || c.ext, kind: 'command' }))
    : []);
  const merged = $derived(commandMode ? commands : query.trim()
    ? quickswitchResults(titles, mergeResults(serverResults, cached))
    : recents);
  function choose(result) {
    if (result?.command) { runExtCommand(result.command, {}); onclose(); return; }
    onopen(result, query);
  }

  $effect(() => { results = merged; if (selected >= merged.length) selected = 0; });
  $effect(() => { field?.focus(); });

  $effect(() => {
    const value = query;
    if (!value.trim() || value.startsWith('>')) { serverResults = []; expanded = []; return; }
    const id = ++requestId;
    const timer = setTimeout(async () => {
      try {
        await searchStages(session, value, (body) => {
          if (id !== requestId) return false;
          serverResults = body.results;
          expanded = body.expanded || [];
          return true;
        });
      } catch {  }
    }, 90);
    return () => clearTimeout(timer);
  });

  function keydown(event) {
    if (event.key === 'Escape') return onclose();
    const quick = quickIndexFor(event);
    if (quick !== null) {
      event.preventDefault(); event.stopPropagation();
      const target = results[quick];
      if (target) choose(target);
      return;
    }
    if (isListDown(event)) {
      event.preventDefault(); event.stopPropagation();
      selected = Math.min(selected + 1, results.length - 1);
      return;
    }
    if (isListUp(event)) {
      event.preventDefault(); event.stopPropagation();
      selected = Math.max(selected - 1, 0);
      return;
    }
    if (event.key === 'Enter' && results[selected]) {
      event.preventDefault();
      choose(results[selected]);
    }
  }
</script>

<div class="backdrop" transition:fade={{ duration: 120 }} onclick={onclose} role="presentation"></div>
<div class="palette" transition:fly={{ y: -12, duration: 160, easing: cubicOut }} data-testid="search-palette">
  <input
    bind:this={field}
    bind:value={query}
    onkeydown={keydown}
    placeholder="Jump to a chat, search every one, or > for commands"
    data-testid="search-input"
    aria-label="Search every chat"
  />
  {#if expanded.length}
    <div class="expanded">also matching {expanded.slice(0, 5).join(', ')}</div>
  {/if}
  <div class="scroller results" data-testid="search-results">
    {#each results as result, index (result.conversationId)}
      <button
        class="result press"
        class:sel={index === selected}
        onclick={() => choose(result)}
        onpointerenter={() => (selected = index)}
        data-testid="search-result"
        data-kind={result.kind || 'text'}
      >
        {#if index < 9}
          
          <span class="digit" data-testid="search-digit">{index + 1}</span>
        {:else}
          <span class="digit blank"></span>
        {/if}
        <span class="rbody">
          <span class="rtitle">{result.title || 'Untitled'}</span>
          <span class="rexcerpt">{result.excerpt || ''}</span>
        </span>
        {#if result.archived}<span class="tag" data-testid="archived-tag">archived</span>{/if}
        {#if result.offline && result.kind === 'text'}<span class="tag">cached</span>{/if}
      </button>
    {/each}
    {#if query && !results.length}<p class="empty">Nothing matches.</p>{/if}
    {#if !query && !results.length}<p class="empty">No chats yet.</p>{/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); z-index: 60; }
  .palette {
    position: fixed;
    top: max(10vh, 48px); left: 50%; transform: translateX(-50%);
    width: min(620px, 94vw);
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 14px;
    z-index: 61;
    box-shadow: 0 24px 60px rgb(0 0 0 / 0.45);
    overflow: hidden;
  }
  input {
    width: 100%;
    background: none; border: none;
    border-bottom: 1px solid var(--line-soft);
    padding: 14px 16px;
    color: var(--ink);
    font-size: 16px;
    outline: none;
  }
  .expanded { font-size: 11px; color: var(--ink-faint); padding: 6px 16px 0; }
  .results { max-height: min(56vh, 460px); padding: 6px; }
  .result {
    display: flex; align-items: center; gap: 8px;
    width: 100%; text-align: left;
    padding: 8px 10px; border-radius: 8px;
  }
  
  .rbody { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .result.sel { background: var(--accent-soft); }
  .rtitle { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rexcerpt { font-size: 11.5px; color: var(--ink-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag { font-size: 9.5px; color: var(--ink-faint); }
  .empty { color: var(--ink-faint); font-size: 12.5px; padding: 14px 12px; }

  
  .digit {
    flex: none; width: 15px; text-align: center;
    font-size: 10.5px; color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .digit.blank { visibility: hidden; }
</style>
