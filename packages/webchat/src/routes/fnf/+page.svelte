<script>
  import { onMount, tick } from 'svelte';
  import Composer from '$lib/ui/Composer.svelte';
  import Nav from '$lib/ui/Nav.svelte';
  import { FADE_DURATION_MS, msUntilNextFade, opacityFor } from '$lib/core/fade.js';

  let messages = $state([]);
  let list = $state(null);
  let error = $state(null);
  let standalone = $state(false);
  let keyboardOpen = $state(false);
  let viewportHeight = $state(null);
  let viewportTop = $state(0);

  onMount(() => {
    const display = window.matchMedia('(display-mode: standalone)');
    const viewport = window.visualViewport;
    const updateViewport = () => {
      standalone = display.matches || navigator.standalone === true;
      keyboardOpen = standalone && !!viewport && viewport.scale === 1
        && window.innerHeight - viewport.height > 100;
      viewportHeight = keyboardOpen ? viewport.height : null;
      viewportTop = keyboardOpen ? viewport.offsetTop : 0;
    };
    updateViewport();
    display.addEventListener('change', updateViewport);
    window.addEventListener('resize', updateViewport);
    viewport?.addEventListener('resize', updateViewport);
    viewport?.addEventListener('scroll', updateViewport);
    return () => {
      display.removeEventListener('change', updateViewport);
      window.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('scroll', updateViewport);
    };
  });

  let now = $state(Date.now());
  let browsing = $state(false);
  let hovered = $state(null);

  $effect(() => {
    // The wait is measured against the real clock, not against `now`. The list refreshes
    // every four seconds and every refresh hands `messages` a new array, which re-runs this
    // effect; a wait measured from the `now` this timer is going to set was the full minute
    // again each time, so the timer was cancelled and re-armed for ever and nothing faded
    // while the page stayed open. Reading `now` here is what arms the next fade after a tick.
    void now;
    const due = msUntilNextFade(messages, Date.now());
    if (due === null) return;
    const timer = setTimeout(() => { now = Date.now(); }, due + 50);
    return () => clearTimeout(timer);
  });

  let opening = $state(null);

  const openable = (message) => message.state === 'sent' && Boolean(message.conversationId);

  function confirmOpen(message) {
    if (!openable(message)) return;
    opening = message;
  }

  function go() {
    if (!opening) return;
    window.location.href = `/?stay&chat=${encodeURIComponent(opening.conversationId)}`;
  }

  function dialogKeys(event) {
    if (event.key === 'Escape') { event.preventDefault(); opening = null; }
    else if (event.key === 'Enter') { event.preventDefault(); go(); }
  }

  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();

  async function refresh() {
    try {
      const response = await fetch(`/api/ff?since=${encodeURIComponent(since)}`);
      if (!response.ok) return;
      const body = await response.json();
      messages = body.messages || [];
      error = null;
    } catch {  }
  }

  async function send(text) {
    const optimistic = { id: `local-${Date.now()}`, text, at: new Date().toISOString(), state: 'routing' };
    messages = [...messages, optimistic];
    await tick();
    scroll();
    try {
      const response = await fetch('/api/ff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'send failed');
      refresh();
    } catch (cause) {
      error = cause.message;
      messages = messages.map((m) => (m.id === optimistic.id ? { ...m, state: 'failed' } : m));
    }
  }

  function scroll() {
    if (list) list.scrollTop = list.scrollHeight;
  }

  function onScroll() {
    if (!list) return;
    browsing = list.scrollTop + list.clientHeight < list.scrollHeight - 24;
  }

  function focusOnMount(node) {
    node.focus();
  }

  const time = (at) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  onMount(() => {
    refresh().then(scroll);
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  });
  let ffEl = $state(null);
  let dropping = $state(false);
</script>

<svelte:head><title>fire and forget</title></svelte:head>

<div class="ff" bind:this={ffEl} class:dropping class:standalone class:keyboardOpen
  style:--fnf-height={viewportHeight === null ? '100dvh' : `${viewportHeight}px`}
  style:--fnf-top={`${viewportTop}px`}>
  <header>
    <div class="nav"><Nav current="fnf" /></div>
    <span class="dot"></span>
    <span class="label">fire and forget</span>
  </header>

  <div class="list" bind:this={list} data-testid="ff-list" onscroll={onScroll}>
    {#each messages as message (message.id)}
      <div
        class="sent"
        data-testid="ff-message"
        style:opacity={opacityFor(message, now, { browsing, hovered: hovered === message.id })}
        style:transition-duration={`${FADE_DURATION_MS}ms`}
        onpointerenter={() => (hovered = message.id)}
        onpointerleave={() => { if (hovered === message.id) hovered = null; }}
        onfocusin={() => (hovered = message.id)}
        onfocusout={() => { if (hovered === message.id) hovered = null; }}
      >
        {#if openable(message)}
          <button
            class="bubble open focus-ring"
            data-testid="ff-open"
            title="Open the chat this reached"
            onclick={() => confirmOpen(message)}
          >{message.text}</button>
        {:else}
          <p class="bubble">{message.text}</p>
        {/if}
        <div class="under">
          <span class="when">{time(message.at)}</span>
          {#if message.state === 'sent'}
            <span class="where" data-testid="ff-routed">→ {message.title || 'a chat'}</span>
          {:else if message.state === 'failed'}
            <span class="failed">didn't send</span>
          {:else}
            <span class="where">…</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  {#if opening}
    
    
    <div class="scrim" onclick={() => (opening = null)}></div>
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Open this chat?"
      data-testid="ff-confirm"
      tabindex="-1"
      onkeydown={dialogKeys}
      use:focusOnMount
    >
      <p class="ask">Open this chat?</p>
      <p class="which">{opening.title || 'the chat this reached'}</p>
      <div class="buttons">
        <button class="press focus-ring" data-testid="ff-confirm-cancel" onclick={() => (opening = null)}>Cancel</button>
        <button class="press focus-ring primary" data-testid="ff-confirm-open" onclick={go}>Open</button>
      </div>
    </div>
  {/if}

  {#if error}<div class="error">{error}</div>{/if}

  <Composer
    onsend={send}
    placeholder="Say it and forget it…"
    autofocus={true}
    draftKey="fire-and-forget"
    dropZone={ffEl}
    ondragfiles={(active) => (dropping = active)}
  />
</div>

<style>
  
  .ff.dropping { outline: 2px dashed color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: -2px; }
  .ff {
    --column: 640px;
    --column-gutter: clamp(12px, 4vw, 20px);
    --column-pad: max(var(--column-gutter), calc((100% - var(--column)) / 2));
    display: flex; flex-direction: column; height: 100dvh; background: var(--bg);
  }
  header {
    display: flex; align-items: center; gap: 8px;
    padding: 20px clamp(12px, 4vw, 20px) 12px;
    padding-top: max(20px, env(safe-area-inset-top, 0px));
    font-size: 12.5px; color: var(--ink-faint);
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  .ff.standalone {
    position: fixed;
    top: var(--fnf-top);
    left: 0; right: 0;
    height: var(--fnf-height);
    overflow: hidden;
  }
  .ff.keyboardOpen :global(.composer) { padding-bottom: 10px; }
  .label { letter-spacing: 0.02em; }
  .list {
    flex: 1; min-height: 0; overflow-y: auto;
    display: flex; flex-direction: column; gap: 14px;
    padding: 8px clamp(12px, 4vw, 20px) 16px;
  }
  .sent {
    max-width: 640px; width: 100%; align-self: center;
    
    transition-property: opacity;
    transition-timing-function: ease-in-out;
  }
  
  @media (prefers-reduced-motion: reduce) {
    .sent { transition-duration: 1ms !important; }
  }
  .bubble {
    display: block; width: 100%; margin: 0; text-align: left;
    background: var(--bg-raised);
    border: 1px solid var(--line-soft);
    border-radius: 14px;
    padding: 10px 14px;
    font-size: 15px; line-height: 1.45;
    color: inherit; font: inherit;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  
  .open { cursor: pointer; transition: border-color var(--tap) var(--ease); }
  .open:hover, .open:focus-visible { border-color: var(--line); }

  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); }
  .dialog {
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(320px, calc(100vw - 32px));
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 16px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  }
  .dialog .ask { margin: 0; font-size: 15px; }
  .dialog .which {
    margin: 6px 0 14px; font-size: 12.5px; color: var(--ink-faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .buttons button {
    
    min-height: 44px; padding: 0 16px;
    border-radius: 10px; border: 1px solid var(--line-soft);
    background: transparent; color: var(--ink); font-size: 14px; cursor: pointer;
  }
  .buttons .primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  .under {
    display: flex; gap: 8px; align-items: baseline;
    padding: 4px 4px 0;
    font-size: 11.5px; color: var(--ink-faint);
  }
  .where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .failed { color: var(--warn); }
  .error { padding: 0 clamp(12px, 4vw, 20px) 6px; font-size: 12px; color: var(--warn); }
</style>
