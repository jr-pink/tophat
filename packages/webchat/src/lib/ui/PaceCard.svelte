<script>
  // The ten-minute pace checkpoint as a transcript row. add a visible card so i can see teh reminder and 2.
  // ask the model to recite the whole goal and etc (full prompt i was telling it). Collapsed it is one line
  // saying the checkpoint fired and how long the run had been going; opened it is the exact text the model
  // was handed.
  import Icon from './Icon.svelte';

  let { item, open = false, ontoggle = () => {} } = $props();

  function elapsedLabel(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return `${Math.round(ms / 1000)}s into the run`;
    if (minutes < 60) return `${minutes} min into the run`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}h${rest ? ` ${rest}m` : ''} into the run`;
  }

  const gist = $derived(elapsedLabel(item.elapsedMs) || 'recite the goal, check status, re-decide');
</script>

<div class="pace" class:open data-testid="pace-card">
  <button
    class="head press focus-ring"
    onclick={ontoggle}
    aria-expanded={open}
    data-testid="pace-toggle"
  >
    <span class="chev" class:open><Icon name="chevron" size={11} /></span>
    <span class="label">Pace check</span>
    <span class="gist" data-testid="pace-gist">{gist}</span>
    <span class="spacer"></span>
    <span class="tag">10 min</span>
  </button>
  {#if open}
    <div class="body" data-testid="pace-body">
      {#if item.text}
        <pre class="text" data-testid="pace-text">{item.text}</pre>
      {:else}
        <p class="missing" data-testid="pace-missing">
          The checkpoint text is not in this transcript; it stayed in the runner ledger.
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Same card and disclosure language as CompactionCard and HookCard. */
  .pace {
    border: 1px solid var(--line-soft);
    border-radius: 9px;
    background: color-mix(in srgb, var(--ink) 3%, transparent);
    margin: 6px 0;
  }
  .head {
    display: flex; align-items: center; gap: 7px;
    width: 100%; text-align: left;
    padding: 6px 10px;
    border-radius: 9px;
    font-size: 12px;
    color: var(--ink-dim);
    min-height: 30px;
  }
  .head:hover { color: var(--ink); }
  .chev { display: grid; place-items: center; transition: transform var(--tap) var(--ease); color: var(--ink-faint); }
  .chev.open { transform: rotate(90deg); }
  .label { font-weight: 600; flex: none; }
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
  .body { padding: 2px 10px 8px; }
  .text {
    margin: 0;
    font-size: 12.5px; color: var(--ink-dim);
    border-left: 2px solid var(--line);
    padding-left: 10px;
    max-height: 60vh;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: inherit;
  }
  .missing { margin: 0; font-size: 11.5px; color: var(--ink-faint); }
</style>
