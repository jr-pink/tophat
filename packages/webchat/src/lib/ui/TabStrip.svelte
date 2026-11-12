<script>
  // One editor group's tab strip (the top of a pane). Output only: the tabs, the active one, the drop indicator and the
  // dragged tab all come from the kit's panes state (core/panes-state.js) through the page; every gesture here reports to
  // the page, which turns it into one absolute action (tab.activate, tab.close, a drag through core/tab-drag.js).
  // `preview` is the group's preview tab (core/panels.js): shown in italic, as VS Code does; a double click keeps it.
  import Icon from './Icon.svelte';

  let { group, tabs = [], active = null, preview = null, focused = false, inset = 0, drag = null, ondown = () => {}, onclose = () => {}, onnew = () => {}, onkeep = () => {} } = $props();

  let strip = $state(null);
  const dropAt = $derived(drag?.over?.kind === 'strip' && drag.over.group === group ? drag.over.index : null);

  // The active tab stays in view when it changes (a tab opened past the edge, Ctrl-Tab, a click on a clipped one).
  $effect(() => {
    void active;
    if (!strip) return;
    const el = [...strip.querySelectorAll('[data-tab]')].find((t) => t.dataset.tab === active);
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  });

  function wheel(event) {
    if (!strip || event.deltaX || !event.deltaY) return;
    strip.scrollLeft += event.deltaY;
    event.preventDefault();
  }

  function down(event, chat) {
    if (event.button === 1) { event.preventDefault(); return; }
    if (event.button !== 0 || event.target.closest?.('.x')) return;
    ondown(chat, event);
  }
</script>

<div class="tabstrip" class:focused data-testid="tabstrip" data-group={group} data-ctx="tabstrip" data-ctx-group={group} role="tablist" tabindex="-1" aria-label="Tabs" style:padding-left={inset ? `${inset}px` : null}
  ondblclick={(event) => { if (event.target === strip) onnew(); }}>
  <div class="tabs" bind:this={strip} onwheel={wheel} data-testid="tabs">
    {#each tabs as tab, index (tab.id)}
      {#if dropAt === index}<span class="drop" aria-hidden="true" data-testid="tab-drop"></span>{/if}
      <div class="tab" class:active={tab.id === active} class:preview={tab.id === preview} data-preview={tab.id === preview ? 'true' : null} class:dragging={drag?.chat === tab.id && drag?.from === group}
        role="tab" tabindex="-1" aria-selected={tab.id === active} data-tab={tab.id} data-testid="tab" data-ctx="tab" data-ctx-group={group} data-ctx-chat={tab.id} title={tab.title}
        onpointerdown={(event) => down(event, tab.id)}
        ondblclick={(event) => { if (!event.target.closest?.('.x')) onkeep(tab.id); }}
        onauxclick={(event) => { if (event.button === 1) { event.preventDefault(); onclose(tab.id); } }}>
        <span class="label">{#if tab.automated}<span class="auto" data-testid="automated-tag">auto</span>{/if}{tab.title}</span>
        <button class="x press" type="button" tabindex="-1" aria-label="Close tab" data-testid="tab-close"
          onclick={(event) => { event.stopPropagation(); onclose(tab.id); }}><Icon name="close" size={10} /></button>
      </div>
    {/each}
    {#if dropAt === tabs.length}<span class="drop" aria-hidden="true" data-testid="tab-drop"></span>{/if}
  </div>
</div>

<style>
  .tabstrip {
    flex: none; height: 28px; display: flex; min-width: 0;
    background: var(--bg-sunken); border-bottom: 1px solid var(--line-soft);
  }
  .tabs {
    flex: 1; min-width: 0; display: flex; align-items: stretch;
    overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    position: relative; flex: 0 0 auto; display: flex; align-items: center; gap: 4px;
    min-width: 72px; max-width: 190px; padding: 0 4px 0 10px;
    border-right: 1px solid var(--line-soft);
    font: 12px/1 var(--mono); color: var(--ink-faint);
    cursor: default; user-select: none; touch-action: none; white-space: nowrap;
  }
  .tab:hover { color: var(--ink-dim); }
  .tab.active { background: var(--bg); color: var(--ink); }
  .tab.active::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px; background: var(--line);
  }
  .focused .tab.active::after { background: var(--accent); }
  .tab.dragging { opacity: 0.45; }
  .tab.preview .label { font-style: italic; }
  .drop { flex: 0 0 0; position: relative; z-index: 2; }
  .drop::before { content: ''; position: absolute; top: 3px; bottom: 3px; left: -1px; width: 2px; background: var(--accent); }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .auto { margin-right: 5px; font-size: 9.5px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-faint); }
  .x {
    flex: none; width: 16px; height: 16px; display: grid; place-items: center; border-radius: 4px;
    border: 0; background: transparent; color: inherit; padding: 0; opacity: 0;
  }
  .tab:hover .x, .tab.active .x { opacity: 0.7; }
  .x:hover { opacity: 1 !important; background: color-mix(in srgb, var(--ink) 12%, transparent); }
</style>
