<script>
  // The bar that appears over a selection.
  //
  // It owns position, the shape and the chrome. What the buttons ARE is the page's business and
  // comes in as children, because a book offers colours and a share sheet while a transcript
  // offers a reply and a side thread, and pretending those are the same list would make a worse
  // bar for both.

  let {
    x = 0,
    y = 0,
    below = false,
    /** On a phone the bar leaves the selection entirely and docks at the bottom of the screen,
     *  where iOS never puts its own Copy/Look Up callout. */
    docked = false,
    /** The point is the bar's top-left corner, not the middle of the selection it sits above:
     *  the chat transcript places it to the right of the selection on a desktop. */
    corner = false,
    testid = null,
    onroot = () => {},
    children
  } = $props();

  let root = $state(null);
  $effect(() => { onroot(root); });
</script>

<div
  class="pop"
  class:below
  class:docked
  class:corner
  bind:this={root}
  data-reader-pop
  data-sidechat
  style:left={docked ? null : `${x}px`}
  style:top={docked ? null : `${y}px`}
  data-testid={testid}
>
  {@render children?.()}
</div>

<style>
  .pop {
    position: absolute;
    z-index: 24;
    transform: translate(-50%, calc(-100% - var(--float-gap, 8px)));
    display: flex;
    align-items: center;
    gap: 2px;
    max-width: calc(100vw - 24px);
    overflow-x: auto;
    scrollbar-width: none;
    padding: 4px 5px;
    border: 1px solid var(--line);
    border-radius: 11px;
    background: var(--bg-raised);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.26);
  }
  .pop.below { transform: translate(-50%, var(--float-gap, 8px)); }
  .pop.corner { transform: none; }
  .pop.docked {
    position: fixed;
    left: 50%;
    top: auto;
    bottom: calc(var(--dock-bottom, 14px) + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
  }
  .pop::-webkit-scrollbar { display: none; }

  /* The buttons belong to whoever passed them in, but they all wear the bar's clothes. */
  .pop :global(button) {
    flex: none;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--ink-dim);
    cursor: pointer;
    padding: 4px 8px;
    font-size: 12.5px;
    line-height: 1;
    display: grid;
    place-items: center;
  }
  .pop :global(button:hover) { background: var(--accent-soft); color: var(--ink); }
  .pop :global(button:disabled) { opacity: 0.45; cursor: default; }
  .pop :global(.swatch) { width: 16px; height: 16px; border-radius: 50%; padding: 0; }
  .pop :global(.swatch.yellow) { background: #f1dd8a; }
  .pop :global(.swatch.blue) { background: #a8c6ef; }
  .pop :global(.swatch.rose) { background: #eeb6cf; }
  .pop :global(.swatch.green) { background: #a9d5ad; }
  .pop :global(.div) { width: 1px; align-self: stretch; margin: 2px 2px; background: var(--line); }

  @media (max-width: 760px) {
    .pop :global(button) { padding: 7px 10px; font-size: 14px; }
  }

  /* Icon-only buttons are whole touch targets: 36px under a pointer, 48px on a touch screen. */
  .pop :global(button.ico) { box-sizing: border-box; width: 36px; height: 36px; padding: 0; border-radius: 999px; }
  @media (hover: none) {
    .pop :global(button.ico) { width: 48px; height: 48px; padding: 0; }
  }
</style>
