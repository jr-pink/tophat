<script>
  // A small info icon whose hover or keyboard focus shows a description in a tooltip; a click does `onclick` (opens the
  // editor). The tip is a manual popover, in the top layer, so the sidebar list (contain: paint) never clips it. The tip's
  // visibility follows the pointer and focus the way:hover does; it holds no app state.
  import Icon from './Icon.svelte';

  let { text = '', label = 'Description', onclick = null, testid = 'info', size = 12 } = $props();

  let btn = $state(null);
  let tip = $state(null);
  const uid = `tip-${Math.random().toString(36).slice(2, 9)}`;

  function show() {
    if (!tip || !btn || !text) return;
    const box = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    // Below the icon, right edges aligned, kept on screen.
    tip.style.top = `${Math.round(box.bottom + 6)}px`;
    tip.style.right = `${Math.max(8, Math.round(vw - box.right - 4))}px`;
    tip.style.maxWidth = `${Math.max(160, Math.min(260, Math.round(box.right + 4 - 8)))}px`;
    try { tip.showPopover?.(); } catch {}
  }
  function hide() { try { tip?.hidePopover?.(); } catch {} }
</script>

<button
  bind:this={btn}
  class="info press focus-ring"
  type="button"
  tabindex="-1"
  aria-label={label}
  aria-describedby={text ? uid : undefined}
  data-testid={testid}
  onpointerenter={show}
  onpointerleave={hide}
  onfocus={show}
  onblur={hide}
  onclick={(event) => { event.stopPropagation(); hide(); onclick?.(event); }}
><Icon name="info" {size} /></button>
{#if text}<div bind:this={tip} id={uid} class="infotip" popover="manual" role="tooltip" data-testid="{testid}-tip">{text}</div>{/if}

<style>
  .info {
    width: 22px; height: 22px; flex: none; display: grid; place-items: center; border-radius: 6px;
    border: 0; background: none; color: var(--ink-faint); cursor: pointer;
  }
  .info:hover { color: var(--ink); }
  .infotip {
    position: fixed; inset: auto; margin: 0; width: max-content;
    padding: 6px 9px; border: 1px solid var(--line); border-radius: 9px;
    background: var(--bg-raised); color: var(--ink); box-shadow: 0 10px 30px rgb(0 0 0 / 0.35);
    font-size: 12px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; pointer-events: none;
  }
</style>
