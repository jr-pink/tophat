<script>
  import { widgetDocument } from '$lib/core/rich-content.js';
  import VideoPlayer from './VideoPlayer.svelte';
  import { fetchFileVersion, withFileVersion } from '$lib/core/file-version.js';

  const MAX_WIDGET_CHARS = 16_000_000;

  let { content, conversationId = null } = $props();
  // Primitives, not the content object. The markdown compiler hands this component a fresh `content`
  // object on every pass (every streamed token, every parent update). An effect that read content.kind
  // re-ran on each new object, set state back to "loading", tore the iframe down and refetched the
  // file: the widget "kept reloading". A $derived of a string only notifies when the string changes.
  const kind = $derived(content.kind);
  const contentUrl = $derived(content.url);
  const withConversation = (u) => u?.startsWith('/api/file?') && conversationId ? u + '&conversation=' + encodeURIComponent(conversationId) : u;
  // A local image's URL carries the file's version (`&v=<mtime>-<size>`) so a rewritten file is a new
  // URL: the same path embedded again later would otherwise show the picture the browser kept for the
  // old bytes. The version is asked of the server when the image is drawn; until it answers the img
  // has no src, and a failed lookup ('') falls back to the plain URL.
  const versioned = $derived(kind === 'image' && !content.remote && contentUrl?.startsWith('/api/file?'));
  let version = $state(null);
  $effect(() => {
    if (!versioned) return;
    const raw = new URL(contentUrl, 'http://x').searchParams.get('path');
    let live = true;
    version = null;
    fetchFileVersion(raw, conversationId).then((v) => { if (live) version = v; });
    return () => { live = false; };
  });
  const url = $derived(withFileVersion(withConversation(contentUrl), versioned ? version : null));
  const ready = $derived(!versioned || version !== null);
  let state = $state({ status: 'ready', source: '', error: '' });
  let expanded = $state(false);
  // An image that will not load (host gone, refused address, signed out, offline with nothing cached)
  // shows its caption as a link to the original, never a broken box.
  let broken = $state(false);
  const remote = $derived(content.remote || null);
  let showSource = $state(false);
  const source = $derived(kind === 'widget' ? content.source : state.source);
  const document = $derived(widgetDocument(source));
  $effect(() => {
    if (kind !== 'widget-file') return;
    const target = url;
    const controller = new AbortController();
    state = { status: 'loading', source: '', error: '' };
    fetch(target, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load widget (${response.status})`);
      const text = await response.text();
      if (text.length > MAX_WIDGET_CHARS) throw new Error('Widget exceeds 16 MB');
      if (controller.signal.aborted) return;
      state = { status: 'ready', source: text, error: '' };
    }).catch((error) => {
      if (!controller.signal.aborted) state = { status: 'error', source: '', error: error.message };
    });
    return () => controller.abort();
  });
</script>

{#if kind === 'video'}
  <VideoPlayer {url} title={content.title} />
{:else if kind === 'videos'}
  <VideoPlayer items={content.items.map((i) => ({ title: i.title, url: withConversation(i.url) }))} />
{:else if kind === 'image' && broken}
  <p class="broken" data-testid="rich-content-broken">{#if remote}<a href={remote} target="_blank" rel="noreferrer noopener">{content.title}</a>{:else}{content.title} (image unavailable){/if}</p>
{:else}
<figure class:expanded data-testid="rich-content">
  <figcaption>
    <span class="title" title={content.title}>{content.title}</span>
    <div class="actions">
      {#if kind.startsWith('widget')}
        <button type="button" title={showSource ? 'Preview' : 'Source'} aria-label={showSource ? 'Preview' : 'Source'} aria-pressed={showSource} onclick={() => showSource = !showSource}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{#if showSource}<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" />{:else}<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />{/if}</svg>
        </button>
        <button type="button" title={expanded ? 'Collapse' : 'Expand'} aria-label={expanded ? 'Collapse' : 'Expand'} aria-pressed={expanded} onclick={() => expanded = !expanded}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{#if expanded}<path d="M6.5 2v4.5H2M9.5 14V9.5H14" />{:else}<path d="M9.5 2H14v4.5M6.5 14H2V9.5M14 2 9.5 6.5M2 14l4.5-4.5" />{/if}</svg>
        </button>
      {/if}
      {#if remote}
        <a href={remote} target="_blank" rel="noreferrer noopener" title="Open" aria-label="Open">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></svg>
        </a>
      {:else if content.url}
        <a href={url + (url.startsWith('/api/file?') ? '&download=1' : '')} target="_blank" rel="noreferrer" title="Download" aria-label="Download">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11" /></svg>
        </a>
      {/if}
    </div>
  </figcaption>
  {#if kind === 'image'}
    <a href={ready ? url : undefined} target="_blank" rel="noreferrer"><img src={ready ? url : undefined} alt={content.title} data-zoomable loading="lazy" onerror={() => broken = true} /></a>
  {:else if kind === 'video'}
    <video src={url} controls playsinline preload="metadata" aria-label={content.title}><track kind="captions" /></video>
  {:else if kind === 'audio'}
    <audio src={url} controls preload="metadata" aria-label={content.title}></audio>
  {:else if state.status === 'loading'}
    <p role="status">Loading widget…</p>
  {:else if state.status === 'error'}
    <p role="alert">{state.error}</p>
  {:else if showSource}
    <pre><code>{source}</code></pre>
  {:else}
    <iframe title={content.title} srcdoc={document} sandbox="allow-scripts" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"></iframe>
  {/if}
</figure>
{/if}

<style>
  /* The margin resets are !important on purpose: Markdown's ".prose > * + * > :first-child" and ".prose > * > * + *"
     rules (paragraph gaps) outrank a scoped class selector (Svelte emits it inside :where()) and would otherwise
     land on the header and the frame, which made the bar read as ~125px. */
  figure { margin: 1rem 0; overflow: hidden; border: 1px solid var(--line, #aaa5); border-radius: 12px; max-width: 100%; background: var(--bg-sunken, #8881); }
  figcaption { display: flex; align-items: center; justify-content: space-between; gap: .5rem; box-sizing: border-box; height: 34px; margin: 0 !important; padding: 0 .35rem 0 .8rem; font-family: var(--sans); font-size: .78rem; line-height: 1; color: var(--ink-dim, inherit); border-bottom: 1px solid var(--line, #aaa5); }
  figcaption > .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; flex-shrink: 0; align-items: center; gap: .1rem; }
  .actions :is(button, a) { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; margin: 0; border: 0; border-radius: 6px; background: none; color: var(--ink-faint, inherit); cursor: pointer; text-decoration: none; transition: color var(--tap, 90ms), background-color var(--tap, 90ms); }
  .actions :is(button, a):hover { color: var(--ink, inherit); background: var(--accent-soft, #8882); }
  .actions :is(button, a):focus-visible { outline: 2px solid var(--accent, currentColor); outline-offset: -2px; color: var(--ink, inherit); }
  .actions svg { display: block; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  @media (pointer: coarse) { .actions :is(button, a) { width: 32px; height: 32px; } }
  img, video { display: block; max-width: 100%; max-height: 75vh; margin: auto; object-fit: contain; }
  audio { display: block; width: 100%; }
  iframe { display: block; width: 100%; height: 420px; margin: 0 !important; border: 0; background: white; }
  .expanded iframe { height: 80vh; }
  pre { max-height: 65vh; overflow: auto; padding: 1rem; font-size: .8rem; }
  p { padding: 1rem; }
  p.broken { padding: .4rem 0; margin: 1rem 0; font-size: .85rem; overflow-wrap: anywhere; }
</style>
