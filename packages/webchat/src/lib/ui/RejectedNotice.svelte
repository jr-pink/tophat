<script module>
  // What the server refused, in the composer of the chat it was refused for.

  

  export function rejectedFor(rejected, conversationId, dismissed = []) {
    if (!rejected?.length || !conversationId) return [];
    return rejected.filter((entry) => entry?.conversationId === conversationId
      && !dismissed.includes(entry.id));
  }

  // One refusal dealt with, whichever button he pressed. The session has no method that takes
  // an entry off `status.rejected`, so the pane remembers the ids it has answered for and this
  // is the whole of that memory.
  export function dismiss(dismissed = [], entry) {
    const id = entry?.id;
    if (!id || dismissed.includes(id)) return dismissed;
    return [...dismissed, id];
  }

  // The op in his terms. Anything the session grows later falls through to the wire name
  // rather than being swallowed: an unnamed refusal is still a refusal he must see.
  const REFUSED = {
    'message.send': 'not sent',
    'conversation.create': 'chat not created',
    'conversation.fork': 'fork not created',
    'run.interrupt': 'not stopped',
    'conversation.rename': 'not renamed',
    'conversation.set_pinned': 'not pinned',
    'conversation.set_archived': 'not archived',
    'conversation.set_aside': 'not set aside',
    'conversation.set_workspace': 'not moved to that workspace',
    'conversation.set_deferred': 'not deferred',
    'conversation.set_read': 'not marked read',
    'conversation.set_settings': 'settings not saved',
    'conversation.touch': 'not opened'
  };

  export function refusalLabel(op) {
    return REFUSED[op] || `${op} refused`;
  }
</script>

<script>
  let {
    entries = [],
    onresend = () => {},
    ondiscard = () => {}
  } = $props();
</script>

{#if entries.length}
  <div class="rejected" data-testid="rejected" role="status" aria-live="polite">
    {#each entries as entry (entry.id)}
      <div class="note" data-testid="rejected-note" data-op={entry.op} data-status={entry.status}>
        <div class="line">
          
          <span class="what">{refusalLabel(entry.op)} — <span data-testid="rejected-reason">{entry.reason}</span></span>
          <span class="acts">
            
            {#if entry.text}
              <button
                class="act press focus-ring"
                data-testid="rejected-resend"
                onclick={() => onresend(entry)}
              >Re-send</button>
            {/if}
            <button
              class="act press focus-ring"
              data-testid="rejected-discard"
              onclick={() => ondiscard(entry)}
            >Discard</button>
          </span>
        </div>
        
        {#if entry.text}
          <p class="text" data-testid="rejected-text">{entry.text}</p>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .rejected {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px var(--column-pad) 0;
  }
  .note {
    background: var(--bg-raised);
    border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
    border-radius: 10px;
    padding: 7px 10px;
    font-size: 12px;
    color: var(--ink-dim);
  }
  .line {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .what { color: var(--warn); min-width: 0; }
  .acts { display: flex; gap: 6px; flex: none; }
  .act {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px 10px;
    color: var(--ink-dim);
    font-size: 11.5px;
  }
  .act:hover { border-color: var(--accent); color: var(--accent); }
  
  .text {
    margin: 5px 0 0;
    color: var(--ink-faint);
    white-space: pre-wrap;
    overflow-wrap: break-word;
    max-height: 5.4em;
    overflow-y: auto;
  }
</style>
