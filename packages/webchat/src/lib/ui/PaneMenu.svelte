<script>
  import { isListDown, isListUp } from '$lib/core/keys.js';

  let { items = [], onpick = () => {}, onclose = () => {}, prefix = 'pane-menu', align = 'right', drop = 'down' } = $props();

  let cursor = $state(0);
  let root = $state(null);

  const enabled = $derived(items.filter((item) => !item.disabled));

  $effect(() => {
    const first = items.findIndex((item) => !item.disabled);
    cursor = first === -1 ? 0 : first;
    root?.focus();
  });

  function step(delta) {
    if (!enabled.length) return;
    let next = cursor;
    for (let tries = 0; tries < items.length; tries += 1) {
      next = (next + delta + items.length) % items.length;
      if (!items[next].disabled) break;
    }
    cursor = next;
  }

  function keydown(event) {
    if (isListDown(event)) { event.preventDefault(); step(1); return; }
    if (isListUp(event)) { event.preventDefault(); step(-1); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const item = items[cursor];
      if (item && !item.disabled) onpick(item.id);
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onclose(); }
  }

  $effect(() => {
    const host = root?.parentElement;
    if (!host) return;
    const away = (event) => { if (!host.contains(event.target)) onclose(); };
    const esc = (event) => { if (event.key === 'Escape') { event.preventDefault(); onclose(); } };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc, true);
    };
  });
</script>

<div
  class="menu"
  class:left={align === 'left'}
  class:up={drop === 'up'}
  role="menu"
  tabindex="-1"
  bind:this={root}
  onkeydown={keydown}
  data-testid={prefix}
>
  {#each items as item, index (item.id)}
    {#if item.href && !item.disabled}
    <!-- A real link, so Cmd/Ctrl/Shift-click and middle-click open it in a new tab or window natively; a plain
         left click still goes through onpick so the owner of the menu decides how to navigate. -->
    <a
      class="item"
      class:sel={index === cursor}
      role="menuitem"
      href={item.href}
      onmouseenter={() => { cursor = index; }}
      onclick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) { onclose(); return; }
        event.preventDefault();
        onpick(item.id);
      }}
      onauxclick={() => onclose()}
      data-testid="{prefix}-{item.id}"
    >{item.label}</a>
    {:else}
    <button
      class="item"
      class:sel={index === cursor}
      role="menuitem"
      disabled={item.disabled}
      onmouseenter={() => { if (!item.disabled) cursor = index; }}
      onclick={() => onpick(item.id)}
      data-testid="{prefix}-{item.id}"
    >{item.label}</button>
    {/if}
  {/each}
</div>

<style>
  .menu {
    position: absolute; top: calc(100% + 4px); right: 0; z-index: 51;
    
    min-width: 150px;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 4px;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.35);
    outline: none;
    display: flex; flex-direction: column;
  }
  .item {
    text-align: left;
    padding: 6px 9px;
    border-radius: 6px;
    font-size: 12.5px;
    color: var(--ink);
    white-space: nowrap;
  }
  a.item { display: block; text-decoration: none; }
    .menu.left { right: auto; left: 0; }
  /* A pill at the bottom of a phone has no room below it, so the menu grows upward instead. */
  .menu.up { top: auto; bottom: calc(100% + 4px); }
  .item.sel:not(:disabled) { background: color-mix(in srgb, var(--ink) 9%, transparent); }
  .item:disabled { color: var(--ink-faint); cursor: default; }
</style>
