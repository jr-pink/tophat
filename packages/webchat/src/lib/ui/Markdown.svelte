<script>
  import { getContext } from 'svelte';
  import RichContent from './RichContent.svelte';
  import { createMarkdownCache, flatBlocks } from '$lib/core/markdown.js';
  import { offsetsOfRange, rangeFromOffsets } from '$lib/core/textrange.js';
  import { fetchFileVersion, rawPathsIn, stampImages } from '$lib/core/file-version.js';
  import { useFolds } from './disclosure.svelte.js';

  let { text = '', onpath = () => {}, foldId = null } = $props();

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
    for (const block of flatBlocks(blocks)) {
      if (block.rich) continue;
      for (const path of rawPathsIn(block.html)) {
        if (asked.has(path)) continue;
        asked.add(path);
        fetchFileVersion(path, conversation).then((v) => { versions = { ...versions, [path]: v }; });
      }
    }
  });

  // A details section's fold lives in the fold store (disclosure.svelte.js, per chat, persisted), keyed by the message
  // (foldId) and the section's own key, never only in the DOM: the element just projects it, so a reply still streaming,
  // a row scrolled away and back, a remount or a reload all keep what the reader opened. A section written as an open details tag
  // starts open and its key goes in the store when he shuts it. A Markdown with no foldId (a tool output, a file
  // preview) keeps its folds for its own lifetime only.
  const folds = useFolds();
  let localFolds = $state(new Set());
  const foldKey = (block) => `${foldId}/${block.key}`;
  const flipped = (block) => (foldId ? folds.isOpen(block.open ? 'details-shut' : 'details', foldKey(block)) : localFolds.has(block.key));
  const sectionOpen = (block) => (block.open ? !flipped(block) : flipped(block));
  function toggleSection(event, block) {
    event.preventDefault(); // the store is the only writer; the browser's own toggle would get ahead of it
    if (foldId) folds.toggle(block.open ? 'details-shut' : 'details', foldKey(block));
    else { const next = new Set(localFolds); if (next.has(block.key)) next.delete(block.key); else next.add(block.key); localFolds = next; }
  }

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
  {@render list(blocks)}
</div>

{#snippet list(items)}
  {#each items as block (block.key)}
    {#if block.details}<details class="md-details" open={sectionOpen(block)}><summary onclick={(e) => toggleSection(e, block)}>{@html withConversation(block.summary)}</summary><div class="md-details-body">{@render list(block.children)}</div></details>
    {:else if block.rich}<RichContent content={block.rich} conversationId={artifactConversation()} />{:else}<div class="block">{@html withConversation(stampImages(block.html, versions))}</div>{/if}
  {/each}
{/snippet}

<style>
  .block { display: contents; }
  /* a collapsible section: the summary line reads as a heading with a turning chevron; the body indents a little under it */
  .md-details { margin: 6px 0; }
  .md-details > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 8px; padding: 6px 0; border-radius: 6px; user-select: none; }
  .md-details > summary::-webkit-details-marker { display: none; }
  .md-details > summary::before { content: ""; flex: none; width: 6px; height: 6px; border-right: 1.5px solid var(--ink-faint); border-bottom: 1.5px solid var(--ink-faint); transform: translateY(-2px) rotate(-45deg); transition: transform 160ms ease; }
  .md-details[open] > summary::before { transform: translateY(-4px) rotate(45deg); }
  .md-details > summary:hover::before { border-color: var(--accent); }
  .md-details > summary :global(p) { margin: 0; }
  .md-details-body { padding: 2px 0 6px 14px; }
  /* the body keeps the prose's own paragraph rhythm (app.css .prose > * + * reaches only the message's direct children): one paragraph gap between blocks */
  .md-details-body > :global(* + *),
  .md-details-body > :global(* + * > :first-child),
  .md-details-body > :global(* > * + *) { margin-top: var(--para-gap); }
</style>
