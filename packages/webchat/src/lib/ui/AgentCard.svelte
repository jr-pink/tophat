<script>
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import ToolCard from './ToolCard.svelte';
  import Markdown from './Markdown.svelte';
  import { useFolds } from './disclosure.svelte.js';

  let { item, children = [], onpath = () => {} } = $props();

  const folds = useFolds();
  const open = $derived(folds.isOpen('agent', item.id));

  const running = $derived(item.state === 'running');
  const currentTool = $derived([...children].reverse().find((child) => child.type === 'tool'));
  const status = $derived(
    running
      ? currentTool ? `${currentTool.tool}…` : 'thinking…'
      : item.state === 'failed' ? 'failed' : 'done'
  );
</script>

<div class="agent" class:running>
  <button class="head press focus-ring" onclick={() => folds.toggle('agent', item.id)} aria-expanded={open}>
    <span class="chev" class:open>›</span>
    <span class="kind">{item.agentType || 'agent'}</span>
    <span class="desc">{item.description}</span>
    <span class="status" class:live={running}>{status}</span>
    {#if running}<span class="dot live-dot"></span>{/if}
  </button>

  {#if open}
    <div class="body" transition:slide={{ duration: 180, easing: cubicOut }}>
      {#if item.prompt}
        <div class="prompt">{item.prompt}</div>
      {/if}
      {#each children as child (child.id)}
        {#if child.type === 'tool'}
          <ToolCard item={child} {onpath} />
        {:else if child.type === 'assistant'}
          <div class="nested"><Markdown text={child.text} {onpath} /></div>
        {/if}
      {/each}
      {#if item.result}
        <div class="section-label">returned</div>
        <div class="nested"><Markdown text={String(item.result).slice(0, 8000)} {onpath} /></div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .agent {
    border: 1px solid var(--line);
    border-left: 2px solid var(--ink-faint);
    border-radius: var(--radius);
    background: var(--bg-raised);
    margin: 8px 0;
    overflow: hidden;
  }
  .agent.running { border-left-color: var(--accent); }
  .head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 11px; text-align: left; min-height: 40px; }
  .head:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
  .chev { color: var(--ink-faint); transition: transform var(--tap) var(--ease); }
  .chev.open { transform: rotate(90deg); }
  .kind {
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--ink-faint); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; white-space: nowrap;
  }
  .desc { font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { font-size: 11px; color: var(--ink-faint); font-family: var(--mono); }
  .status.live { color: var(--accent); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
  .body { border-top: 1px solid var(--line-soft); padding: 8px 11px 10px; }
  .prompt {
    font-size: 12.5px; color: var(--ink-dim); background: var(--bg-sunken);
    border-radius: 6px; padding: 8px 10px; margin-bottom: 8px;
    max-height: 160px; overflow: auto; white-space: pre-wrap;
  }
  .nested { font-size: 14.5px; }
  .section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-faint); margin: 8px 0 4px; }
</style>
