<script>
  // The bar, grown into a box in the same place.
  //
  // The text belongs to the page, not to this component. The reader keeps it in a draft in local
  // storage from the first keystroke and feeds dictation into it; the chat sends it; neither of
  // those is this component's business, so the value comes in and every change goes back out.
  // The footer is the page's too, for the same reason the pill's buttons are.

  let {
    x = 0,
    y = 0,
    below = false,
    value = '',
    placeholder = 'Note',
    busy = false,
    /** What dictation has heard so far, shown under the words and not yet part of them. */
    partial = '',
    /** The passage being written about, when the page cannot keep it marked in the text itself. */
    quote = '',
    enterkeyhint = 'done',
    testid = null,
    onvalue = () => {},
    onkeydown = () => {},
    onbeforeinput = () => {},
    onblur = () => {},
    oninput = () => {},
    /** The textarea, handed up so the page can focus it, grow it and read its caret. */
    onbox = () => {},
    onroot = () => {},
    footer
  } = $props();

  let root = $state(null);
  let box = $state(null);
  $effect(() => { onroot(root); });
  $effect(() => { onbox(box); });
</script>

<div
  class="box"
  class:below
  bind:this={root}
  data-reader-pop
  data-sidechat
  style:left={`${x}px`}
  style:top={`${y}px`}
  data-testid={testid}
>
  {#if quote}<p class="quote" title={quote}>{quote}</p>{/if}
  <textarea
    bind:this={box}
    value={value}
    rows="1"
    {placeholder}
    disabled={busy}
    {enterkeyhint}
    onkeydown={onkeydown}
    onbeforeinput={onbeforeinput}
    onblur={onblur}
    oninput={(event) => { onvalue(event.currentTarget.value); oninput(event); }}
    data-testid={testid ? `${testid}-text` : null}
  ></textarea>
  {#if partial}<p class="partial">{partial}</p>{/if}
  <div class="row">{@render footer?.()}</div>
</div>

<style>
  .box {
    position: absolute;
    z-index: 25;
    transform: translate(-50%, calc(-100% - var(--float-gap, 8px)));
    width: min(30rem, calc(100vw - 24px));
    padding: 8px 10px 6px;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.24);
  }
  .box.below { transform: translate(-50%, var(--float-gap, 8px)); }
  .quote {
    margin: 0 0 6px;
    padding-left: 7px;
    border-left: 2px solid var(--line);
    color: var(--ink-faint);
    font-size: 12px;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  textarea {
    display: block;
    width: 100%;
    resize: none;
    overflow: auto;
    border: 0;
    background: none;
    color: var(--ink);
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.45;
    outline: none;
    padding: 2px 2px 4px;
  }
  textarea::placeholder { color: var(--ink-faint); }
  .partial { margin: 0 0 4px; padding: 0 2px; font-size: 14px; line-height: 1.4; color: var(--ink-faint); }
  .row { display: flex; gap: 10px; align-items: center; font-size: 10.5px; color: var(--ink-faint); }
  .row :global(.spacer) { flex: 1; }
  .row :global(.qgo) {
    font-size: 12.5px; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line);
    background: var(--bg); color: var(--ink-dim); cursor: pointer;
  }
  .row :global(.qgo.primary) { background: var(--accent-soft); color: var(--ink); border-color: transparent; }
  .row :global(.qgo:disabled) { opacity: 0.45; cursor: default; }
  .row :global(.qmic) {
    width: 26px; height: 26px; display: grid; place-items: center; padding: 0;
    border: 1px solid var(--line); border-radius: 999px; background: none; color: var(--ink-dim);
    cursor: pointer;
  }
  .row :global(.qmic.on) { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
</style>
