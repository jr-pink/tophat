<script>
  import { tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { targetPath } from '$lib/core/partial-json.js';
  import Icon from './Icon.svelte';
  import Markdown from './Markdown.svelte';
  import Code from './Code.svelte';
  import Refs from './Refs.svelte';
  import { languageOf } from '$lib/core/highlight.js';
  import { summarySegments } from '$lib/core/refs.js';
  import { toolIcon, toolSummary } from '$lib/core/toolsummary.js';
  import { hasBackgrounded, isTimed, ringDash, ringFor } from '$lib/core/toolpatience.js';
  import { useFolds } from './disclosure.svelte.js';

  let { item, onpath = () => {} } = $props();

  const folds = useFolds();
  const open = $derived(folds.isOpen('card', item.id));

  let now = $state(Date.now());
  const timed = $derived(isTimed(item));
  $effect(() => {
    if (!timed) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 250);
    return () => clearInterval(timer);
  });

  const ring = $derived(timed ? ringFor(item, now) : null);
  const backgrounded = $derived(hasBackgrounded(item, now));
  const ringLabel = $derived(ring
    ? (ring.tone === 'foreground'
        ? `${Math.ceil(ring.remainingMs / 1000)}s before this is backgrounded`
        : `running in the background; ${Math.ceil(ring.remainingMs / 1000)}s of its budget left`)
    : null);
  const dash = $derived(ringDash(ring?.fraction ?? 0));

  let card = $state(null);
  let reserved = $state(0);

  function hold() {
    if (!card) return;
    reserved = card.offsetHeight;
    const scroller = card.closest('.scroller');
    const release = () => { reserved = 0; scroller?.removeEventListener('scroll', release); };
    scroller?.addEventListener('scroll', release, { passive: true, once: true });
  }

  async function toggle() {
    const scroller = card?.closest('.scroller');
    const offsetOf = () => card.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const visible = scroller && card && offsetOf() > -card.offsetHeight && offsetOf() < scroller.clientHeight;
    const before = visible ? offsetOf() : null;
    reserved = 0;
    folds.toggle('card', item.id);
    if (before === null) return;
    await tick();
    const restore = () => { if (card?.isConnected && scroller) scroller.scrollTop += offsetOf() - before; };
    const until = performance.now() + 260;
    const pin = () => {
      restore();
      if (performance.now() < until && card?.isConnected) requestAnimationFrame(pin);
    };
    pin();
  }

  let wasStreaming = false;
  $effect(() => {
    const streaming = Boolean(streamingBody);
    if (wasStreaming && !streaming && !open) hold();
    wasStreaming = streaming;
  });

  // The glyph and the one-line summary are the same rules for every provider, so they live in a
  // pure module (core/toolsummary.js) that can be tested without mounting a card.
  const icon = $derived(toolIcon(item.tool));

  // rawInput goes in too: while the input is still streaming there is no parsed object yet, and an
  // Agent launch should say what it is launching before the brief finishes arriving.
  const summary = $derived(toolSummary({ tool: item.tool, input: item.input, rawInput: item.rawInput, preview: item.preview }));

  const summaryRefs = $derived(summarySegments({ tool: item.tool, input: item.input || {}, display: summary }));

  function rowClick(event) {
    if (event.target.closest('.md-path')) return;
    toggle();
  }

  // Agent and Task stream their prompt (partial-json's STREAMING_FIELD), so the subagent brief is
  // readable as it is written; the body disappears again once the call completes.
  const STREAM_BODY = new Set(['Write', 'Edit', 'NotebookEdit', 'Agent', 'Task']);
  const streamingBody = $derived(
    item.state === 'running' && STREAM_BODY.has(item.tool) && item.preview?.text ? item.preview.text : null
  );
  const streamLang = $derived(languageOf(targetPath(item.input, item.rawInput)));
  const outputText = $derived(typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '', null, 2));
  const lineCount = $derived(outputText ? outputText.split('\n').length : 0);
  const markdownOutput = $derived(/\.(?:md|markdown)$/u.test(item.input?.file_path || ''));
</script>

<div
  class="card"
  bind:this={card}
  class:failed={item.state === 'failed'}
  class:running={item.state === 'running'}
  class:backgrounded={backgrounded && item.state === 'running'}
  style:min-height={reserved ? `${reserved}px` : null}
  data-testid="tool-card"
>
  
  
  
  <div class="head press" onclick={rowClick}>
    <button class="disclosure focus-ring" type="button" data-testid="tool-head" aria-expanded={open} aria-label="{item.tool} {summary}">
      <span class="chev" class:open>›</span>
      <span class="icon"><Icon name={icon} size={13} /></span>
      <span class="tool">{item.tool}</span>
    </button>
    <span class="summary"><Refs segments={summaryRefs} {onpath} /></span>
    {#if ring}
      
      <span
        class="annulus"
        class:muted={ring.tone === 'background'}
        title={ringLabel}
        data-testid="tool-countdown"
        data-tone={ring.tone}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <circle class="track" cx="8" cy="8" r="6.5" fill="none" stroke-width="2.4" />
          <circle
            class="sweep" cx="8" cy="8" r="6.5" fill="none" stroke-width="2.4"
            stroke-linecap="round"
            stroke-dasharray={dash.dasharray}
            stroke-dashoffset={dash.dashoffset}
            transform={dash.transform}
          />
        </svg>
        <span class="sr-only">{ringLabel}</span>
      </span>
    {:else if item.state === 'running'}
      <span class="dot live-dot"></span>
    {:else if item.state === 'failed'}
      <span class="badge warn">failed</span>
    {:else if lineCount > 1}
      <span class="badge">{lineCount} lines</span>
    {/if}
  </div>

  {#if streamingBody && !open}
    
    <div class="stream" transition:slide={{ duration: 150, easing: cubicOut }}>
      
      {#if streamLang}
        <div class="stream-body"><Code text={tail(streamingBody)} lang={streamLang} {onpath} /></div>
      {:else}
        
        <div class="stream-body prose"><Markdown text={tail(streamingBody)} {onpath} /></div>
      {/if}
    </div>
  {/if}

  {#if open}
    <div class="body" transition:slide={{ duration: 180, easing: cubicOut }}>
      
      {#if item.input}
        <div class="section-label">input</div>
        <pre class="block"><Refs text={JSON.stringify(item.input, null, 2)} {onpath} /></pre>
      {:else if item.rawInput}
        <div class="section-label">input</div>
        <pre class="block"><Refs text={item.rawInput} {onpath} /></pre>
      {/if}
      {#if outputText}
        <div class="section-label">output</div>
        {#if markdownOutput}
          <div class="block"><Markdown text={outputText} {onpath} /></div>
        {:else}
          <pre class="block out"><Refs text={outputText} {onpath} /></pre>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<script module>
  const TAIL = 4000;
  export function tail(text) {
    return text.length > TAIL ? `…\n${text.slice(-TAIL)}` : text;
  }
</script>

<style>
  .card {
    border: 1px solid var(--line-soft);
    border-radius: var(--radius);
    background: var(--bg-raised);
    margin: 6px 0;
    overflow: hidden;
  }
  .card.running { border-color: color-mix(in srgb, var(--accent) 40%, var(--line-soft)); }
  .card.failed { border-color: color-mix(in srgb, var(--warn) 45%, var(--line-soft)); }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 11px;
    text-align: left;
    min-height: 38px;
    cursor: pointer;
  }
  .head:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
  .disclosure { display: flex; align-items: center; gap: 8px; flex: none; }
  .chev {
    display: inline-block;
    color: var(--ink-faint);
    transition: transform var(--tap) var(--ease);
    font-size: 15px;
    line-height: 1;
  }
  .chev.open { transform: rotate(90deg); }
  .icon { color: var(--ink-faint); display: grid; place-items: center; flex: none; }
  .tool { font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em; }
  .summary {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .badge {
    font-size: 10.5px;
    color: var(--ink-faint);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 6px;
    white-space: nowrap;
  }
  .badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }

  
  .annulus { display: inline-flex; flex: none; line-height: 0; }
  .annulus .track { stroke: color-mix(in srgb, var(--ink) 12%, transparent); }
  .annulus .sweep { stroke: var(--accent); transition: stroke-dashoffset 250ms linear; }
  
  .annulus.muted .sweep { stroke: var(--ink-faint); }
  .annulus.muted .track { stroke: color-mix(in srgb, var(--ink) 8%, transparent); }

  
  .backgrounded { opacity: 0.55; }
  .backgrounded .tool, .backgrounded .summary { color: var(--ink-faint); }

  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .annulus .sweep { transition: none; }
  }
  .body { border-top: 1px solid var(--line-soft); padding: 8px 11px 10px; }
  .section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-faint);
    margin: 6px 0 4px;
  }
  .block {
    font-family: var(--mono);
    font-size: 11.8px;
    line-height: 1.5;
    background: var(--bg-sunken);
    border-radius: 6px;
    padding: 8px 10px;
    margin: 0;
    max-height: 420px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .out { max-height: 320px; }
  .stream { border-top: 1px solid var(--line-soft); }
  .stream-body {
    padding: 8px 11px;
    max-height: 260px;
    overflow: auto;
    font-size: 14px;
    background: var(--bg-sunken);
  }
</style>
