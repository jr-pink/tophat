<script>
  /** What just happened, and one press to put it back. The reader draws it inline under the
   * shelf, where it has always been; the chat list floats it over the foot of the sidebar,
   * since that list has no foot of its own to sit in.
   *
   * It names the action rather than saying "Undone": the offer is for the gesture he just made,
   * and Cmd-Z handles the ones before it (core/undo.js).
   *
   * On a phone the float does not sit where a control sits. It takes the band between the
   * composer and the nav pill, and while it is up it publishes its own height as `--notif-lift`
   * on the document root, which the nav pill and the new-chat button add to their own offsets.
   * Nothing that is only telling him something may cover something he taps.
   */
  let {
    label = '',
    onundo = () => {},
    ondismiss = null,
    variant = 'inline',
    testid = 'undo-bar'
  } = $props();

  let node = $state(null);

  // The lift is the bar's measured height plus the gap above it, so the controls above move by
  // exactly as much as the bar takes and land back where they were when it goes.
  const GAP = 8;

  $effect(() => {
    if (variant !== 'float') return;
    const root = typeof document === 'undefined' ? null : document.documentElement;
    if (!root) return;
    const element = label ? node : null;
    const clear = () => {
      root.style.removeProperty('--notif-lift');
      root.style.removeProperty('--notif-floor');
    };
    if (!element) { clear(); return; }
    const publish = () => {
      const band = Math.round(element.getBoundingClientRect().height) + GAP;
      root.style.setProperty('--notif-lift', `${band}px`);
      // How far up from the bottom of the screen the bar stands, for a surface that cannot
      // lift a control out of the way and has to give up the band instead: the chat-list
      // drawer covers the composer this bar is anchored to, so its own foot yields by this.
      root.style.setProperty('--notif-floor', `calc(var(--pane-chrome-h, 0px) + 10px + ${band}px)`);
    };
    publish();
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    watch?.observe(element);
    return () => {
      watch?.disconnect();
      clear();
    };
  });
</script>

{#if label}
  <div
    bind:this={node}
    class="undobar"
    class:float={variant === 'float'}
    data-testid={testid}
    role="status"
    aria-live="polite"
  >
    <span class="utext">{label}</span>
    <button class="ubtn" onclick={onundo} data-testid={`${testid}-btn`}>Undo</button>
    {#if ondismiss}
      <button class="dbtn" onclick={ondismiss} title="Dismiss" aria-label="Dismiss" data-testid={`${testid}-dismiss`}>×</button>
    {/if}
  </div>
{/if}

<style>
  .undobar {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    margin-top: 10px; padding: 8px 10px;
    border: 1px solid var(--line); border-radius: 10px;
    background: var(--bg-raised);
    font-size: 12px; color: var(--ink-dim);
  }
  .utext { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ubtn {
    flex: none; border: 0; background: none; cursor: pointer;
    color: var(--accent); font: inherit; font-weight: 500; padding: 2px 4px;
  }
  .ubtn:hover { text-decoration: underline; }
  .dbtn {
    flex: none; border: 0; background: none; cursor: pointer;
    color: var(--ink-faint); font: inherit; padding: 2px 4px; line-height: 1;
  }
  .dbtn:hover { color: var(--ink); }
  /* Over the chat list, clear of the composer and of the sidebar's own foot trays. */
  .float {
    position: fixed; z-index: 40;
    left: clamp(12px, 2vw, 20px);
    bottom: calc(14px + var(--keyboard-inset, 0px));
    margin: 0; max-width: min(360px, calc(100vw - 32px));
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.32);
  }
  /* On a phone: its own band, directly above the composer and below the pill. Full width, so it
     never has to be centred over the thing he is reaching for, and the pill and the new-chat
     button ride up on --notif-lift rather than being covered. */
  @media (max-width: 860px) {
    .float {
      left: clamp(10px, 3vw, 16px);
      right: clamp(10px, 3vw, 16px);
      transform: none;
      max-width: none;
      bottom: calc(var(--pane-chrome-h, 0px) + 10px + var(--keyboard-inset, 0px));
    }
  }
</style>
