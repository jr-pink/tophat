<script>
  /** A folded tray at the foot of a list: the things he has put down, out of the way but one click
   * from the screen. Archived chats had one of these; set aside and deferred are the same shape,
   * and the reader stacks them over its shelf for documents, so it lives here rather than in the
   * sidebar.
   *
   * and a defer until, where i can set a time or condition. same as todo tasks. The stacking order
   * is the caller's: deferred, set aside, archived, bottom last.
   *
   * The rows are the caller's `children` snippet, so a tray of chats and a tray of documents are
   * the same component with different rows inside.
   */
  import Icon from './Icon.svelte';

  let {
    label = '',
    count = 0,
    countWhenClosed = true,   // false: the number shows only while the tray is open
    badge = true,             // false: no number at all; count only decides whether the tray shows
    onnearend = null,         // called when the open body scrolls within about a screen of its end
    open = false,
    onopen = () => {},
    icon = null,
    note = null,          // a quiet right-hand hint: "2 still running", the next hour due
    testid = 'tray',
    toggletestid = null,
    listtestid = null,
    children = null
  } = $props();
</script>

{#if count}
  <div class="tray" class:open data-testid={testid}>
    <button
      class="head press focus-ring"
      onclick={() => onopen(!open)}
      aria-expanded={open}
      title={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
      data-testid={toggletestid || `toggle-${testid}`}
    >
      <span class="caret" class:down={open}><Icon name="chevron" size={12} /></span>
      {#if icon}<span class="glyph"><Icon name={icon} size={12} /></span>{/if}
      <span class="label">{label}</span>
      {#if badge && (open || countWhenClosed)}<span class="count">{count}</span>{/if}
      {#if note}<span class="note">{note}</span>{/if}
    </button>
    {#if open}
      <div class="scroller body" data-testid={listtestid || `${testid}-list`}
        onscroll={onnearend ? (e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) onnearend(); } : undefined}>
        {@render children?.()}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Pinned to the foot of whatever list it sits under, and never taller than a third of it: a
     long tray scrolls inside itself instead of pushing the header off the screen.
     A stack of these has to shrink rather than overflow. Three open trays of 34vh each come to
     102vh, which on a phone pushed the Archived tray's rows 300px below the bottom of the fixed
     drawer; they were only "pinned" while at most one of them was open. So a tray is shrinkable
     (flex-shrink 1, basis auto) and its head is not: the column gives back the body height it
     cannot afford, every head stays on screen, and the last tray still ends at the foot. */
  .tray {
    /* min-height:0 is the half that matters: a tray's automatic minimum size is its head plus its
       body's whole content, so with it left at auto the stack refused to shrink and overflowed
       instead. The head is flex:none inside, so what gives is body height, never the header. */
    flex: 0 1 auto; min-height: 0;
    display: flex; flex-direction: column;
    border-top: 1px solid var(--line-soft); background: var(--bg-sunken, transparent);
  }
  .head {
    width: 100%; flex: none;
    display: flex; align-items: center; gap: 6px;
    padding: 8px 10px;
    border: 0; background: none; cursor: pointer;
    color: var(--ink-faint); font: inherit; font-size: 12px; text-align: left;
  }
  .head:hover { color: var(--ink-dim); }
  .caret { display: inline-flex; transition: transform var(--tap, 120ms) var(--ease, ease); }
  .caret.down { transform: rotate(90deg); }
  .glyph { display: inline-flex; opacity: 0.8; }
  .label { white-space: nowrap; }
  .count {
    min-width: 16px; padding: 0 5px; border-radius: 999px;
    background: color-mix(in srgb, var(--ink, #888) 10%, transparent);
    font-size: 11px; text-align: center;
  }
  .note { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
  .body { flex: 0 1 auto; min-height: 0; max-height: 34vh; overflow-y: auto; padding: 0 4px 6px; }
</style>
