<script>
  import { segmentRefs } from '$lib/core/refs.js';

  let { text = '', segments = null, onpath = () => {} } = $props();

  const parts = $derived(segments ?? segmentRefs(text));

  function open(part, event) {
    event.stopPropagation();
    onpath({ path: part.path, line: part.line ?? null, event });
  }
</script>

{#each parts as part, index (index)}{#if part.type === 'path'}<button
    type="button"
    class="md-path ref"
    data-path={part.path}
    data-line={part.line ?? null}
    data-testid="tool-ref-path"
    title={part.line ? `${part.path}:${part.line}` : part.path}
    onclick={(event) => open(part, event)}
    onpointerenter={() => onpath({ path: part.path, line: null, prefetch: true })}
  >{part.text}</button>{:else if part.type === 'url'}<a
    class="md-path ref url"
    href={part.url}
    target="_blank"
    rel="noreferrer noopener"
    data-testid="tool-ref-url"
    title={part.url}
    onclick={(event) => event.stopPropagation()}
  >{part.text}</a>{:else}{part.text}{/if}{/each}

<style>
  
  .ref {
    font-family: inherit;
    font-size: inherit;
    text-align: left;
    white-space: inherit;
    vertical-align: baseline;
  }
  .url { text-decoration: none; }
  .url:hover { text-decoration: underline; }
</style>
