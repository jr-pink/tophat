<script module>
  // A send that failed on the way out and is still being retried. `session.post` puts the
  // transport's own words on `status.sendError` (and `status.error` carries the same kind of
  // trouble from bootstrap and sync), keeps the action in the outbox and re-arms the ladder.
  //
  // Nothing in the session ever clears `sendError`, so the outbox is what says whether the
  // trouble is still live: while something is queued it is being retried, and when the send
  // lands the queue empties and this line goes with it.

  export function retryingNote(status) {
    if (!status) return '';
    
    if ((Number(status.queued) || 0) < 1) return '';
    
    if (status.online === false || status.offline === true) return '';
    // A 4xx sets `error` too, and that one is not being retried -- the rejected strip owns it.
    const refused = new Set((status.rejected || []).map((entry) => entry?.reason));
    const reason = status.sendError || (refused.has(status.error) ? null : status.error);
    return reason ? `${reason} — retrying` : '';
  }
</script>

<script>
  let { note = '' } = $props();
</script>

{#if note}
  <div class="row">
    <span class="offline" data-testid="send-retry" role="status">{note}</span>
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    padding: 0 var(--column-pad) 2px;
    min-width: 0;
  }
  
  .offline {
    font-size: 11.5px;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
