<script>
  import { getContext } from 'svelte';
  import RichContent from './RichContent.svelte';
  import { createMarkdownCache } from '$lib/core/markdown.js';
  import { offsetsOfRange, rangeFromOffsets } from '$lib/core/textrange.js';
  import { fetchFileVersion, rawPathsIn, stampImages } from '$lib/core/file-version.js';

  let { text = '', onpath = () => {} } = $props();

  const artifactConversation = getContext('artifact-conversation') || (() => null);
  const cache = createMarkdownCache();
  const blocks = $derived(cache.compile(text));
  // An inline image of a local file asks /api/file on behalf of this conversation, so the server can
  // resolve it against the folders this chat has been working in. The compiled HTML is cached per
  // block and shared, so the conversation goes in here rather than at compile time.
  function withConversation(html) {
    const id = artifactConversation();
    return id && html.includes('/api/file?path=') ? html.replaceAll('/api/file?path=', `/api/file?conversation=${encodeURIComponent(id)}&amp;path=`) : html;
  }

  // A local image is addressed by its path, which does not change when the file is rewritten, and a
  // browser keeps one picture per URL: a later reply embedding the same path showed the earlier bytes.
  // So each image asks the server for the file's version when this message is drawn and its URL carries
  // it (`&v=<mtime>-<size>`); the img has no src until the answer comes, so the unversioned URL is
  // never fetched. Per component on purpose: a message drawn later asks again and gets the new bytes.
  // A failed lookup is '' and falls back to the plain URL.
  let versions = $state({});
  const asked = new Set();
  $effect(() => {
    const conversation = artifactConversation();
    for (const block of blocks) {
      if (block.rich) continue;
      for (const path of rawPathsIn(block.html)) {
        if (asked.has(path)) continue;
        asked.add(path);
        fetchFileVersion(path, conversation).then((v) => { versions = { ...versions, [path]: v }; });
      }
    }
  });

  function handle(event) {
    const target = event.target.closest('.md-path');
    if (!target) return;
    // A modified click on a web link still opens it in a new tab.
    if (target.tagName === 'A' && (event.metaKey || event.ctrlKey || event.shiftKey)) return;
    event.preventDefault();
    onpath({ path: target.dataset.path, line: target.dataset.line ? Number(target.dataset.line) : null, event });
  }

  function hover(event) {
    const target = event.target.closest?.('.md-path');
    if (target) onpath({ path: target.dataset.path, line: null, prefetch: true });
  }

  // While a reply streams, every piece that arrives replaces the nodes of the
  // block it lands in, and a selection inside those nodes dies with them: the
  // passage stops being highlighted and a keystroke meant to open a side thread
  // falls through to the main composer instead. So note where the selection was
  // immediately before each update and put it back immediately after, only when
  // the same words are still at those offsets.
  let root;
  let held = null;

  function selectionOffsets() {
    const selection = globalThis.getSelection?.();
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const offsets = offsetsOfRange(root, range);
    if (!offsets || offsets.end <= offsets.start) return null;
    return { ...offsets, text: range.toString() };
  }

  function restoreSelection(saved) {
    if (!saved || !root) return;
    const selection = globalThis.getSelection?.();
    if (!selection) return;
    if (selection.rangeCount && !selection.isCollapsed) return;
    const range = rangeFromOffsets(root, saved.start, saved.end);
    if (!range || range.toString() !== saved.text) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  $effect.pre(() => {
    void blocks;
    held = selectionOffsets();
  });

  $effect(() => {
    void blocks;
    restoreSelection(held);
    held = null;
  });
</script>

<div class="prose" bind:this={root} onclick={handle} onpointerover={hover} role="presentation">
  {#each blocks as block (block.key)}
    {#if block.rich}<RichContent content={block.rich} conversationId={artifactConversation()} />{:else}<div class="block">{@html withConversation(stampImages(block.html, versions))}</div>{/if}
  {/each}
</div>

<style>
  .block { display: contents; }
</style>
