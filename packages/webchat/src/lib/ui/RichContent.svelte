<script>
  import { widgetDocument } from '$lib/core/rich-content.js';
  import VideoPlayer from './VideoPlayer.svelte';

  const MAX_WIDGET_CHARS = 16_000_000;

  let { content, conversationId = null } = $props();
  // Primitives, not the content object. The markdown compiler hands this component a fresh `content`
  // object on every pass (every streamed token, every parent update). An effect that read content.kind
  // re-ran on each new object, set state back to "loading", tore the iframe down and refetched the
  // file: the widget "kept reloading". A $derived of a string only notifies when the string changes.
  const kind = $derived(content.kind);
  const contentUrl = $derived(content.url);
  const withConversation = (u) => u?.startsWith('/api/file?') && conversationId ? u + '&conversation=' + encodeURIComponent(conversationId) : u;
  const url = $derived(withConversation(contentUrl));
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
    <span>{content.title}</span>
    <div class="actions">
      {#if kind.startsWith('widget')}
        <button type="button" onclick={() => showSource = !showSource}>{showSource ? 'Preview' : 'Source'}</button>
        <button type="button" onclick={() => expanded = !expanded}>{expanded ? 'Collapse' : 'Expand'}</button>
      {/if}
      {#if remote}<a href={remote} target="_blank" rel="noreferrer noopener">Open</a>{:else if content.url}<a href={url + (url.startsWith('/api/file?') ? '&download=1' : '')} target="_blank" rel="noreferrer">Download</a>{/if}
    </div>
  </figcaption>
  {#if kind === 'image'}
    <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={content.title} data-zoomable loading="lazy" onerror={() => broken = true} /></a>
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
  figure { margin: 1rem 0; overflow: hidden; border: 1px solid var(--border, #aaa5); border-radius: 12px; max-width: 100%; background: var(--bg-sunken, #8881); }
  figcaption { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .65rem .8rem; font-size: .8rem; border-bottom: 1px solid var(--border, #aaa5); }
  figcaption > span { overflow-wrap: anywhere; }
  .actions { display: flex; flex-shrink: 0; gap: .65rem; }
  button, .actions a { font: inherit; color: inherit; cursor: pointer; background: none; border: 0; padding: .2rem 0; text-decoration: underline; }
  img, video { display: block; max-width: 100%; max-height: 75vh; margin: auto; object-fit: contain; }
  audio { display: block; width: 100%; }
  iframe { display: block; width: 100%; height: 420px; border: 0; background: white; }
  .expanded iframe { height: 80vh; }
  pre { max-height: 65vh; overflow: auto; padding: 1rem; font-size: .8rem; }
  p { padding: 1rem; }
  p.broken { padding: .4rem 0; margin: 1rem 0; font-size: .85rem; overflow-wrap: anywhere; }
</style>
