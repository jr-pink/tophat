<script>
  // The compaction boundary as a transcript row.... opened it is the summary the model now reads instead of
  // those messages.
  import Icon from './Icon.svelte';
  import Markdown from './Markdown.svelte';

  let { item, open = false, ontoggle = () => {}, onpath = () => {} } = $props();

  function tokenLabel(tokens) {
    if (!Number.isFinite(tokens) || tokens <= 0) return '';
    if (tokens < 1000) return `${tokens} tokens`;
    if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k tokens`;
    return `${Math.round(tokens / 1000)}k tokens`;
  }

  const dropped = $derived(Number.isFinite(item.messages) && item.messages > 0 ? item.messages : null);
  const tokens = $derived(tokenLabel(item.preTokens));
  const gist = $derived([
    dropped === null ? 'earlier messages summarized' : `${dropped} message${dropped === 1 ? '' : 's'} summarized`,
    tokens ? `${tokens} before` : ''
  ].filter(Boolean).join(' · '));
  const manual = $derived(item.trigger === 'manual');
</script>

<div class="compaction" class:open data-testid="compaction-card" data-trigger={item.trigger || 'auto'}>
  <button
    class="head press focus-ring"
    onclick={ontoggle}
    aria-expanded={open}
    data-testid="compaction-toggle"
  >
    <span class="chev" class:open><Icon name="chevron" size={9} /></span>
    <span class="label">{manual ? 'Compact' : 'Background compact'}</span>
    <span class="gist" data-testid="compaction-gist">{gist}</span>
    <span class="spacer"></span>
    {#if manual}<span class="tag" data-testid="compaction-trigger">manual</span>{/if}
  </button>
  {#if open}
    <div class="body" data-testid="compaction-body">
      <p class="meta" data-testid="compaction-meta">
        {#if item.summaryAt}<span>summary written {item.summaryAt}</span>{/if}
        {#if item.model}<span>· by {item.model}</span>{/if}
        {#if !manual}<span>· triggered automatically</span>{/if}
      </p>
      {#if item.summary}
        <div class="summary" data-testid="compaction-summary">
          <Markdown text={item.summary} {onpath} />
        </div>
      {:else}
        <p class="missing" data-testid="compaction-missing">
          The summary text is not in this transcript; it stayed in the runner ledger.
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  /**     A quiet one-line marker, no box; opening it shows the summary. */
  .compaction { margin: 2px 0; }
  .head {
    display: flex; align-items: center; gap: 5px;
    width: 100%; text-align: left;
    padding: 1px 2px;
    border-radius: 6px;
    font-size: 11px;
    color: var(--ink-faint);
    min-height: 20px;
  }
  .head:hover { color: var(--ink-dim); }
  .chev { display: grid; place-items: center; transition: transform var(--tap) var(--ease); color: var(--ink-faint); }
  .chev.open { transform: rotate(90deg); }
  .label { font-weight: 500; flex: none; }
  .gist {
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--ink-faint);
  }
  .spacer { flex: none; }
  .tag {
    font-size: 10px; color: var(--ink-faint);
    border: 1px solid var(--line); border-radius: 999px; padding: 0 5px;
  }
  .body { padding: 2px 4px 6px 18px; }
  .meta {
    margin: 0 0 6px;
    font-size: 11px; color: var(--ink-faint);
    display: flex; flex-wrap: wrap; gap: 4px;
  }
  .summary {
    font-size: 12.5px; color: var(--ink-dim);
    border-left: 2px solid var(--line);
    padding-left: 10px;
    max-height: 60vh;
    overflow: auto;
    overflow-wrap: anywhere;
  }
  .missing { margin: 0; font-size: 11px; color: var(--ink-faint); }
</style>
