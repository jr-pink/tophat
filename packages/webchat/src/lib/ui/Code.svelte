<script>
  import { mayHoldRef, tokenizeLines } from '$lib/core/highlight.js';
  import Refs from './Refs.svelte';

  let { text = '', lang = null, onpath = () => {}, chunkLines = 40, linePx = 19 } = $props();

  const EAGER_CHUNKS = 3;
  let built = $state(EAGER_CHUNKS);

  const chunks = $derived.by(() => {
    const lines = tokenizeLines(text, lang);
    const out = [];
    for (let at = 0; at < lines.length; at += chunkLines) {
      const slice = lines.slice(at, at + chunkLines);
      out.push({
        key: at,
        lines: slice.map((line) => line.map((token) => ({ ...token, ref: mayHoldRef(token) }))),
        height: slice.length * linePx
      });
    }
    return out;
  });

  $effect(() => {
    const total = chunks.length;
    if (total <= EAGER_CHUNKS) {
      built = total;
      return;
    }
    built = EAGER_CHUNKS;
    const frame = requestAnimationFrame(() => { built = total; });
    return () => cancelAnimationFrame(frame);
  });

  const shown = $derived(chunks.slice(0, built));
</script>

<pre class="code" data-testid="code">{#each shown as chunk (chunk.key)}<code class="chunk" style="contain-intrinsic-size: auto {chunk.height}px">{#each chunk.lines as line, index (index)}{#each line as token, at (at)}{#if token.ref}<span class={token.type === 'text' ? '' : `tok-${token.type}`}><Refs text={token.text} {onpath} /></span>{:else if token.type === 'text'}{token.text}{:else}<span class="tok-{token.type}">{token.text}</span>{/if}{/each}
{/each}</code>{/each}</pre>

<style>
  .code {
    font-family: var(--mono);
    font-size: 12.2px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0;
  }
  
  .chunk { display: block; content-visibility: auto; }
</style>
