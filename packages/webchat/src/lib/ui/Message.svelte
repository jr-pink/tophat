<script module>
  import { SvelteSet } from 'svelte/reactivity';
  const opened = new SvelteSet();
</script>

<script>
  import Markdown from './Markdown.svelte';
  import ToolCard from './ToolCard.svelte';
  import ThinkingCard from './ThinkingCard.svelte';
  import AgentCard from './AgentCard.svelte';
  import { messageAgo, agoTickMs } from '../core/ago.js';
  import { pointerLive } from './pointer-live.svelte.js';
  import { getContext } from 'svelte';
  import VideoPlayer from './VideoPlayer.svelte';
  import { attachedVideos } from '../core/rich-content.js';
  import { automatedEvent } from '../core/automated-event.js';
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  let { item, viewerParticipantId = undefined, agentChildren = [], onpath = () => {}, highlight = false, onfork = null } = $props();

  // Undefined is the private single-user transcript; null is a room still joining.
  const incoming = $derived(viewerParticipantId !== undefined &&
    (!viewerParticipantId || item.participantId !== viewerParticipantId));

  // An automated event (push plane, goal retry timer, watchers) is one muted line on the left, closed by
  // default; the block opens on a click. Pure client render of the stored text, so it works offline. The
  // opened ids live at module level so a remount (virtualised list, streaming re-render) keeps what he opened.
  const event = $derived(item.type === 'user' ? automatedEvent(item.text) : null);
  const eventOpen = $derived(event ? opened.has(item.id) : false);
  const toggleEvent = () => { if (opened.has(item.id)) opened.delete(item.id); else opened.add(item.id); };

  let hovering = $state(false);
  let tapped = $state(false);
  let now = $state(0);
  // Hovering alone is not asking: the mouse may just be where he left it while he types. The
  // stamp wants the pointer over the row AND the pointer live. A phone has no hover, so a tap is
  // what asks a message how old it is.
  const pointer = pointerLive();
  // Videos he attaches play inline under his bubble, through the same player as assistant embeds.
  const artifactConversation = getContext('artifact-conversation') || (() => null);
  const videos = $derived(item.type === 'user' ? attachedVideos(item.text) : []);
  const withConversation = (url) => { const id = artifactConversation(); return id ? `${url}&conversation=${encodeURIComponent(id)}` : url; };
  const showing = $derived((hovering && pointer.live) || tapped);
  const stamp = $derived(showing ? messageAgo(item.at, now) : '');

  // Touch only: a mouse already has hover, and the compat mouseleave would undo this.
  const tapStamp = (event) => {
    if (event.pointerType === 'touch') tapped = !tapped;
  };

  $effect(() => {
    if (!showing) return;
    const at = item.at;
    let timer;
    const tick = () => {
      const t = Date.now();
      now = t;
      const wait = agoTickMs(at, t);
      if (wait == null) return;
      timer = setTimeout(tick, Math.min(wait, 60_000));
    };
    tick();
    return () => clearTimeout(timer);
  });
</script>

{#if event}
  <div class="row event" class:highlight data-item={item.id} data-role="user" data-automated="true" data-open={eventOpen ? 'true' : 'false'}>
    <button
      type="button"
      class="event-head focus-ring"
      aria-expanded={eventOpen}
      aria-label={eventOpen ? `Collapse: ${event.label}` : `Expand: ${event.label}`}
      title={event.label}
      data-testid="event-toggle"
      onclick={toggleEvent}
    >
      <span class="event-chev" class:open={eventOpen} aria-hidden="true">›</span>
      <span class="event-label">{event.label}</span>
    </button>
    {#if eventOpen}
      <div class="event-body" data-testid="event-text" transition:slide={{ duration: 180, easing: cubicOut }}>{item.text}</div>
    {/if}
  </div>
{:else if item.type === 'user'}
  
  <div
    class="row user"
    class:incoming
    class:highlight
    data-item={item.id}
    data-role="user"
    onmouseenter={() => (hovering = true)}
    onmouseleave={() => (hovering = false)}
    onpointerdown={tapStamp}
  >
    <div class="bubble" class:queued={item.queued} data-testid="user-text">{item.text}</div>
    {#if videos.length}<div class="attached-video"><VideoPlayer items={videos.map((v) => ({ title: v.title, url: withConversation(v.url) }))} /></div>{/if}
    
    <div class="rowtools">
      <span class="stamp float left" data-testid="stamp" aria-hidden={!stamp}>{stamp}</span>
      {#if item.queued}<span class="queued-tag" data-testid="queued">queued</span>{/if}
      {#if onfork}
        <button class="fork press focus-ring" onclick={() => onfork(item)} title="Fork the chat from here">fork here</button>
      {/if}
    </div>
  </div>
{:else if item.type === 'assistant'}
  
  <div
    class="row assistant"
    class:highlight
    data-item={item.id}
    data-role="assistant"
    data-streaming={item.streaming ? 'true' : 'false'}
    onmouseenter={() => (hovering = true)}
    onmouseleave={() => (hovering = false)}
    onpointerdown={tapStamp}
  >
    <Markdown text={item.text} {onpath} />
    
    <span class="stamp float" data-testid="stamp" aria-hidden={!stamp}>{stamp}</span>
  </div>
{:else if item.type === 'thinking'}
  <!-- A card in the tool-call family; settled thinking between finished calls folds into their run. -->
  <div class="row" class:highlight data-item={item.id}><ThinkingCard {item} /></div>
{:else if item.type === 'tool'}
  <div class="row" class:highlight data-item={item.id}><ToolCard {item} {onpath} /></div>
{:else if item.type === 'agent'}
  <div class="row" class:highlight data-item={item.id}><AgentCard {item} children={agentChildren} {onpath} /></div>
{:else if item.type === 'error'}
  <div class="row error" data-item={item.id} data-role="error">{item.text}</div>
{/if}

<style>
  .row { padding: 2px 0; position: relative; }
  .user { display: flex; flex-direction: column; align-items: flex-end; margin: 14px 0 10px; }
  .user.incoming { align-items: flex-start; }
  .incoming .bubble { border-radius: 14px 14px 14px 4px; }
  .incoming .stamp.float.left { left: 0; right: auto; }
  .bubble {
    background: var(--accent-soft);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    color: var(--ink);
    border-radius: 14px 14px 4px 14px;
    padding: 9px 13px;
    max-width: min(80%, 560px);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 14.5px;
    transition: opacity var(--panel) var(--ease);
  }
  .event { margin: 6px 0; display: flex; flex-direction: column; align-items: flex-start; max-width: min(88%, 640px); }
  .event-head {
    display: flex; align-items: center; gap: 6px; max-width: 100%; min-height: 24px;
    padding: 2px 8px 2px 4px; border-radius: 6px; cursor: pointer; text-align: left;
    font-family: var(--mono); font-size: 11.5px; color: var(--ink-faint);
  }
  .event-head:hover { color: var(--ink-dim); background: color-mix(in srgb, var(--ink) 4%, transparent); }
  .event-chev { flex: none; display: inline-block; font-size: 15px; line-height: 1; transition: transform var(--tap) var(--ease); }
  .event-chev.open { transform: rotate(90deg); }
  .event-label { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .event-body {
    margin: 2px 0 4px 8px; padding: 8px 11px; max-width: 100%;
    border-left: 2px solid var(--line); background: var(--bg-sunken); border-radius: 0 6px 6px 0;
    font-family: var(--mono); font-size: 11.8px; line-height: 1.5; color: var(--ink-dim);
    white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto;
  }
  @media (prefers-reduced-motion: reduce) { .event-chev { transition: none; } }
  .attached-video { width: 100%; }
  .bubble.queued { opacity: 0.55; border-style: dashed; }
  .rowtools { display: flex; gap: 8px; align-items: center; margin-top: 3px; height: 15px; position: relative; }
  .queued-tag { font-size: 10.5px; color: var(--ink-faint); }
  
  .fork { font-size: 10.5px; color: var(--ink-faint); opacity: 0; transition: opacity var(--tap) var(--ease); }
  .user:hover .fork, .fork:focus-visible { opacity: 1; }
  @media (hover: none) { .fork { opacity: 0.65; } }
  .assistant { margin: 8px 0 14px; }
  
  .stamp {
    font-size: 10.5px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
  }
  .stamp.float { position: absolute; right: 0; bottom: -12px; line-height: 12px; }
  .stamp.float.left { right: calc(100% + 8px); bottom: 0; line-height: 15px; }
  .error {
    color: var(--warn);
    border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
    background: color-mix(in srgb, var(--warn) 8%, transparent);
    border-radius: var(--radius);
    padding: 8px 11px;
    margin: 8px 0;
    font-size: 13.5px;
  }
  .highlight { background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: 8px; }
</style>
