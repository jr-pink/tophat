<script module>
  // A transcript that did not load. `session.hydrate` records the failure on
  // `status.transcriptError` and, crucially, leaves the conversation unhydrated so the next
  // open asks again -- an empty room and a failed read used to look identical.
  //
  // The field is one string for the whole session and carries no conversation id, so the pane
  // that owns it is the one with nothing to show: a conversation that never hydrated. A pane
  // that folded a cached tail keeps its transcript and says nothing here.

  export function transcriptFailed(status, conversation) {
    return Boolean(status?.transcriptError) && Boolean(conversation) && !conversation.hydrated;
  }
</script>

<script>
  let { message = '', onretry = () => {} } = $props();
</script>

<div class="failed" data-testid="transcript-error" role="status">
  <p class="why" data-testid="transcript-error-why">{message}</p>
  <button class="retry press focus-ring" data-testid="transcript-retry" onclick={() => onretry()}>Retry</button>
</div>

<style>
  
  .failed {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--ink-faint);
    font-size: 13px;
  }
  .why { margin: 0; max-width: var(--column); text-align: center; }
  .retry {
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 6px 14px;
    color: var(--ink);
    font-size: 13px;
  }
  .retry:hover { border-color: var(--accent); color: var(--accent); }
</style>
