<script>
  import Icon from './Icon.svelte';
  import { hookCount, hookRunning } from '$lib/core/hooks.js';

  let { hook, open = false, ontoggle = () => {}, body } = $props();

  const count = $derived(hookCount(hook));
  const running = $derived(hookRunning(hook));
  const label = $derived(hook.source === 'stop' ? 'Stop hook' : `${hook.source} hook`);
  const gist = $derived((hook.text || '').split('\n').find((line) => line.trim()) || '');
</script>

<div class="hook" class:open data-testid="hook-card" data-hook={hook.source}>
  <button class="head press focus-ring" onclick={ontoggle} aria-expanded={open} data-testid="hook-toggle">
    <span class="chev" class:open><Icon name="chevron" size={11} /></span>
    <span class="label">{label}</span>
    <span class="gist">{gist}</span>
    <span class="spacer"></span>
    {#if running}
      <span class="dot" title="still running"></span>
    {:else if count}
      <span class="count" data-testid="hook-count">{count}</span>
    {/if}
  </button>
  {#if open}
    <div class="body" data-testid="hook-body">
      {#if hook.text}<p class="reason">{hook.text}</p>{/if}
      {@render body?.()}
    </div>
  {/if}
</div>

<style>
  .hook {
    border: 1px solid var(--line-soft);
    border-radius: 9px;
    background: color-mix(in srgb, var(--ink) 3%, transparent);
    margin: 2px 0;
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
  .count {
    font-size: 10px; color: var(--ink-faint);
    border: 1px solid var(--line); border-radius: 999px; padding: 0 5px;
  }
  .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
  .body { padding: 2px 10px 8px; }
  .reason {
    margin: 0 0 6px;
    font-size: 11.5px; color: var(--ink-faint);
    white-space: pre-wrap;
  }
</style>
