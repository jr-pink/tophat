<script>
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { extensionOf, isImage } from '$lib/core/paths.js';
  import Markdown from './Markdown.svelte';
  import Code from './Code.svelte';
  import { languageOf } from '$lib/core/highlight.js';

  let {
    file = null,
    loading = false,
    error = null,
    conversationId = null,
    onclose = () => {},
    ondownload = () => {},
    onpath = () => {},
    onback = null
  } = $props();

  const markdown = $derived(Boolean(file?.name?.match(/\.(?:md|markdown)$/u)));

  // The image and the PDF are second requests for a file the preview already resolved, and /api/file
  // resolves against the conversation's working directory, so they have to say which conversation
  // they belong to or a file outside the openable roots comes back 404 the second time.
  const rawUrl = (path) => `/api/file?path=${encodeURIComponent(path)}&raw=1${conversationId ? `&conversation=${encodeURIComponent(conversationId)}` : ''}`;


  function keydown(event) {
    if (event.key === 'Escape') onclose();
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="backdrop" transition:fade={{ duration: 140 }} onclick={onclose} role="presentation"></div>
<section class="panel" transition:fly={{ x: 24, duration: 180, easing: cubicOut }} data-testid="quicklook" aria-label="File preview">
  <header>
    {#if onback}
      
      <button class="btn press focus-ring back" onclick={onback} data-testid="quicklook-back" aria-label="Back to the previous file">‹</button>
    {/if}
    <div class="names">
      <span class="name">{file?.name || 'Loading…'}</span>
      {#if file}<span class="path">{file.path}</span>{/if}
    </div>
    <div class="acts">
      {#if file?.remote}
        <a class="btn press focus-ring" href={file.path} target="_blank" rel="noreferrer noopener" data-testid="quicklook-open">open</a>
      {:else if file && !file.directory}
        <button class="btn press focus-ring" onclick={() => ondownload(file.path)} data-testid="download">download</button>
      {/if}
      <button class="btn press focus-ring" onclick={onclose} aria-label="Close preview">✕</button>
    </div>
  </header>

  <div class="scroller body">
    {#if error}
      <p class="error">{error}</p>
    {:else if loading && !file}
      <div class="skeleton"></div>
      <div class="skeleton short"></div>
      <div class="skeleton"></div>
    {:else if file?.directory}
      
      <ul class="listing" data-testid="quicklook-listing">
        {#each file.entries || [] as entry (entry.path)}
          <li>
            <button class="row press focus-ring" data-testid="listing-entry" onclick={() => onpath({ path: entry.path })}>
              {entry.name}{#if entry.directory}<span class="kind">/</span>{/if}
            </button>
          </li>
        {/each}
        {#if !(file.entries || []).length}<li class="note">Nothing in this folder.</li>{/if}
      </ul>
    {:else if file?.remote}
      <img src={file.url} alt={file.name} data-testid="quicklook-remote-image" />
    {:else if file?.binary && isImage(file.path)}
      <img src={rawUrl(file.path)} alt={file.name} />
    {:else if file?.binary && extensionOf(file.path) === 'pdf'}
      
      <iframe src={rawUrl(file.path)} title={file.name} data-testid="quicklook-pdf"></iframe>
    {:else if file?.binary}
      <p class="note">Binary file. Download to open it.</p>
    {:else if markdown}
      
      <Markdown text={file?.text || ''} {onpath} />
    {:else}
      <Code text={file?.text || ''} lang={languageOf(file?.path)} {onpath} />
    {/if}
    {#if file?.truncated}<p class="note">Truncated preview. Download for the whole file.</p>{/if}
    {#if file?.stale}<p class="note">Showing the cached copy; the machine is unreachable.</p>{/if}
  </div>
</section>

<style>
  .backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.4); z-index: 50; }
  .panel {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: min(680px, 92vw);
    background: var(--bg-raised);
    border-left: 1px solid var(--line);
    display: flex; flex-direction: column;
    z-index: 51;
    box-shadow: -12px 0 40px rgb(0 0 0 / 0.32);
  }
  header {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 14px; padding-top: max(12px, env(safe-area-inset-top));
    border-bottom: 1px solid var(--line-soft);
  }
  .names { min-width: 0; }
  .name { display: block; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .path { display: block; font-family: var(--mono); font-size: 10.5px; color: var(--ink-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .acts { display: flex; gap: 6px; flex: none; }
  .back { flex: none; font-size: 16px; line-height: 1; padding: 3px 10px; }
  .listing { list-style: none; margin: 0; padding: 0; }
  .listing li { border-bottom: 1px solid var(--line-soft); }
  .listing .row {
    display: block; width: 100%; text-align: left;
    padding: 7px 4px; font-family: var(--mono); font-size: 12.4px;
  }
  .listing .row:hover { background: color-mix(in srgb, var(--ink) 5%, transparent); }
  .listing .kind { color: var(--ink-faint); }
  .btn { border: 1px solid var(--line); border-radius: 7px; padding: 5px 10px; font-size: 12px; color: var(--ink-dim); }
  .btn:hover { color: var(--ink); border-color: var(--ink-faint); }
  .body { flex: 1; padding: 14px 16px; padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  img { max-width: 100%; border-radius: var(--radius); }
  iframe { width: 100%; height: 100%; min-height: 70vh; border: none; border-radius: var(--radius); background: var(--bg-sunken); }
  .note { color: var(--ink-faint); font-size: 12px; margin-top: 12px; }
  .error { color: var(--warn); font-size: 13px; }
  .skeleton {
    height: 13px; border-radius: 4px; margin-bottom: 9px;
    background: linear-gradient(90deg, var(--bg-sunken) 25%, var(--line-soft) 50%, var(--bg-sunken) 75%);
    background-size: 400% 100%;
    animation: shimmer 1.1s linear infinite;
  }
  .skeleton.short { width: 62%; }
  @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
</style>
