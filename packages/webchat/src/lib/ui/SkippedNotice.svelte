<script module>
  // Events this build could not fold. `session.foldWithQuarantine` steps the cursor past them
  // and counts them on `status.skipped`, with the last thrown message on `status.skipReason`:
  // the tab keeps running, but the transcript in front of him is missing that many updates and
  // nothing else on screen would ever say so. One line, no dialog: the chat is still usable.

  export function skipLabel(count) {
    const many = Number(count) || 0;
    if (many < 1) return '';
    return `${many} update${many === 1 ? '' : 's'} cannot be shown here — reloading may fix it`;
  }
</script>

<script>
  let { count = 0, reason = '' } = $props();

  const label = $derived(skipLabel(count));
</script>

{#if label}
  
  <div class="skipped" data-testid="skipped-note" role="status" title={reason || ''}>{label}</div>
{/if}

<style>
  
  .skipped {
    flex: none;
    text-align: center;
    font-size: 11.5px;
    color: var(--ink-faint);
    padding: 6px var(--column-pad) 2px;
  }
</style>
