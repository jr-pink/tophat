<script>
  // The kit's context menu (lib/menu.js is its model). Output only: the open state ({ x, y, active }) is the app's
  // declared state, passed in; every hover, key and click becomes one call (onactive with an absolute path, onrun, onclose).
  // VS Code's feel: opens at the pointer, flips at the edges, submenus open on hover or →, a letter jumps, Esc closes a
  // level, a click outside or a scroll closes it, and the item runs on pointer RELEASE so press-drag-release picks an item.
  import { levelItems, menuKey, placeMenu, placeSubmenu, isSelectable } from '../lib/menu.js';

  let { items = [], x = 0, y = 0, active = [], onactive = () => {}, onrun = () => {}, onclose = () => {} } = $props();

  let panels = $state([]);
  const levels = $derived.by(() => {
    const out = [{ list: items, depth: 0 }];
    for (let d = 0; d < active.length; d += 1) {
      const it = levelItems(items, active, d)[active[d]];
      if (it?.children?.length && isSelectable(it)) out.push({ list: it.children, depth: d + 1, parentIndex: active[d] });
    }
    return out;
  });
  let pos = $state([]);
  $effect(() => {
    void levels; void x; void y;
    const vw = globalThis.innerWidth || 1024, vh = globalThis.innerHeight || 768;
    const next = [];
    levels.forEach((lv, d) => {
      const el = panels[d];
      const w = el?.offsetWidth || 220, h = el?.offsetHeight || 200;
      if (d === 0) next.push(placeMenu({ x, y, w, h, vw, vh }));
      else {
        const row = panels[d - 1]?.querySelector(`[data-index="${lv.parentIndex}"]`)?.getBoundingClientRect();
        next.push(row ? placeSubmenu({ row, w, h, vw, vh }) : { left: x, top: y });
      }
    });
    pos = next;
  });

  function onkey(event) {
    const r = menuKey(items, active, event.key);
    if (!r) { if (event.key === 'Tab') { event.preventDefault(); } return; }
    event.preventDefault();
    event.stopPropagation();
    if (r.close) onclose();
    else if (r.run) onrun(r.run);
    else if (r.active) onactive(r.active);
  }
  $effect(() => {
    const down = (e) => { if (!panels.some((p) => p?.contains(e.target))) onclose(); };
    const away = () => onclose();
    globalThis.addEventListener('keydown', onkey, true);
    globalThis.addEventListener('pointerdown', down, true);
    globalThis.addEventListener('blur', away);
    globalThis.addEventListener('resize', away);
    globalThis.addEventListener('wheel', down, { capture: true, passive: true });
    return () => {
      globalThis.removeEventListener('keydown', onkey, true);
      globalThis.removeEventListener('pointerdown', down, true);
      globalThis.removeEventListener('blur', away);
      globalThis.removeEventListener('resize', away);
      globalThis.removeEventListener('wheel', down, { capture: true });
    };
  });
  const isActive = (depth, i) => active[depth] === i;
  const hover = (depth, i, it) => { if (it.separator) return; const path = [...active.slice(0, depth), i]; if (path.join() !== active.join()) onactive(path); };
</script>

{#each levels as lv, d (d)}
  <div class="qk-menu" role="menu" tabindex="-1" bind:this={panels[d]} data-testid={d === 0 ? 'context-menu' : 'context-submenu'}
    style="left:{pos[d]?.left ?? x}px; top:{pos[d]?.top ?? y}px" oncontextmenu={(e) => e.preventDefault()}>
    {#each lv.list as it, i (it.id ?? `sep-${i}`)}
      {#if it.separator}
        <div class="qk-sep" role="separator"></div>
      {:else}
        <div class="qk-item" role="menuitem" tabindex="-1" data-index={i} data-id={it.id} aria-disabled={it.disabled ? 'true' : null}
          aria-haspopup={it.children?.length ? 'menu' : null} class:on={isActive(d, i)} class:danger={it.danger} class:off={it.disabled}
          onpointerenter={() => hover(d, i, it)}
          onpointerup={(e) => { if (e.button === 2 && !it.children?.length && isSelectable(it)) onrun(it); }}
          onclick={() => { if (!isSelectable(it)) return; if (it.children?.length) onactive([...active.slice(0, d), i, 0]); else onrun(it); }}>
          {#if lv.list.some((x) => 'checked' in x)}<span class="qk-check">{it.checked ? '✓' : ''}</span>{/if}
          <span class="qk-label">{it.label}</span>
          {#if it.keys}<span class="qk-keys">{it.keys}</span>{/if}
          {#if it.children?.length}<span class="qk-sub">›</span>{/if}
        </div>
      {/if}
    {/each}
  </div>
{/each}

<style>
  /* The host app's menu language (webchat PaneMenu, the hamburger menu): raised surface, 9px panel, 6px rows, a faint ink
     tint for the active row rather than an accent fill, quiet shortcuts. Tokens come from the host; fallbacks are neutral. */
  .qk-menu {
    position: fixed; z-index: 1000; min-width: 168px; max-width: 320px; max-height: calc(100vh - 8px); overflow-y: auto;
    padding: 4px; border-radius: 9px; outline: none;
    background: var(--bg-raised, #1d1d1d); color: var(--ink, #ddd); border: 1px solid var(--line, #333);
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.35); font-size: 12.5px; line-height: normal; user-select: none;
    display: flex; flex-direction: column;
  }
  .qk-item { display: flex; align-items: center; gap: 6px; padding: 6px 9px; border-radius: 6px; cursor: default; white-space: nowrap; color: var(--ink, #ddd); }
  .qk-item.on { background: color-mix(in srgb, var(--ink, #ddd) 9%, transparent); }
  .qk-item.off { color: var(--ink-faint, #777); }
  .qk-item.danger .qk-label { color: var(--danger, #e5534b); }
  .qk-check { width: 12px; text-align: center; flex: none; margin-left: -3px; }
  .qk-label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .qk-keys { margin-left: 20px; color: var(--ink-faint, #777); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .qk-sub { margin-left: 10px; color: var(--ink-faint, #777); }
  .qk-sep { height: 1px; margin: 4px 9px; background: var(--line, #333); flex: none; }
</style>
