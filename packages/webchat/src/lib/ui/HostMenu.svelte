<script>
  // The hosts dropdown, under its button in the sidebar tools row, in the hamburger menu's look (PaneMenu.svelte): every peer a
  // chat can live on, checked when the router may pick it, its description behind an info icon. A description is the host's
  // definition for the router (the router never guesses at a host that has none); it is edited in a fold-down with Save and
  // Cancel, nothing written before Save. Edits go through the offline-first outbox in core/host-notes.js.... Open state and the
  // edit draft live in the sidebar store (core/sidebar-state.js hostMenu, descAt, descDraft).
  import Icon from './Icon.svelte';
  import InfoTip from './InfoTip.svelte';
  import DescEditor from './DescEditor.svelte';
  import { hostState, editHost, refreshHosts } from '$lib/core/hosts.svelte.js';
  import { sidebarDecl } from '$lib/core/sidebar-state.js';
  import { uiApp } from '$lib/client/ui-app.js';

  let { onclose = () => {} } = $props();

  const sb = uiApp().use(sidebarDecl);
  const peers = $derived(hostState.list.filter((h) => !h.local));
  const here = $derived(hostState.list.find((h) => h.local));
  const editing = $derived($sb.descAt?.startsWith('h:') ? $sb.descAt.slice(2) : null);
  let root = $state(null);
  $effect(() => { refreshHosts(); });

  const stateOf = (h) => (!h.configured ? 'no address' : h.online === false ? 'offline' : '');
  const edit = (h) => sb.dispatch('desc.open', { at: `h:${h.id}`, text: h.description || '' });
  const cancel = () => sb.dispatch('desc.close', {});
  function save(h, text) {
    sb.dispatch('desc.close', {});
    if (text !== (h.description || '')) editHost(h.id, { description: text });
  }

  // Click away or Esc closes it (PaneMenu's way); Esc inside an open editor cancels the edit only.
  $effect(() => {
    const host = root?.parentElement;
    if (!host) return;
    const away = (event) => { if (!host.contains(event.target) && !event.target?.closest?.('.infotip')) onclose(); };
    const esc = (event) => {
      if (event.key !== 'Escape' || event.target?.closest?.('.desceditor')) return;
      event.preventDefault();
      onclose();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc, true); };
  });
</script>

<div class="menu" role="menu" aria-label="Hosts" data-testid="host-menu" bind:this={root}>
  <div class="head">
    <span>Hosts</span>
    <InfoTip testid="host-help" label="About hosts" text="Each chat runs on one host. New chats can be routed to a checked host that has a description." />
  </div>
  {#if here}
    <div class="item static" data-testid="host-local"><span class="mark"></span><span class="name">{here.label}</span></div>
  {/if}
  {#each peers as h (h.id)}
    <div class="item" class:open={editing === h.id} data-testid="host-row" data-host={h.id}>
      <button class="pick press" role="menuitemcheckbox" aria-checked={h.auto === true} data-testid="host-auto"
        onclick={() => editHost(h.id, { auto: h.auto !== true })}>
        <span class="mark">{#if h.auto === true}<Icon name="check" size={12} />{/if}</span>
        <span class="name">{h.label}</span>
        {#if stateOf(h)}<span class="state down">{stateOf(h)}</span>{/if}
      </button>
      <InfoTip testid="host-info" label="Description of {h.label}" text={h.description || 'No description'} onclick={() => (editing === h.id ? cancel() : edit(h))} />
    </div>
    {#if editing === h.id}
      <div class="fold">
        <DescEditor value={$sb.descDraft} label="Description of {h.label}" placeholder="What to route here"
          testid="host-description-editor" texttestid="host-description" savetestid="host-description-save" canceltestid="host-description-cancel"
          oninput={(text) => sb.dispatch('desc.draft', { text })} onsave={(text) => save(h, text)} oncancel={cancel} />
      </div>
    {/if}
  {:else}
    <div class="item static empty">No other hosts</div>
  {/each}
</div>

<style>
  .menu {
    position: absolute; top: calc(100% + 4px); right: 0; z-index: 51;
    width: 240px; max-height: 60vh; overflow: auto;
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 9px; padding: 4px;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.35); display: flex; flex-direction: column;
  }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 2px 2px 2px 9px; font-size: 11px; color: var(--ink-faint); }
  .item { display: flex; align-items: center; border-radius: 6px; }
  .item:not(.static):hover, .item.open { background: color-mix(in srgb, var(--ink) 9%, transparent); }
  .item.static { padding: 6px 9px; gap: 6px; font-size: 12.5px; color: var(--ink); }
  .item.empty { color: var(--ink-faint); }
  .pick {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 6px 4px 6px 9px;
    border: 0; background: none; color: var(--ink); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
  }
  .mark { width: 12px; flex: none; display: grid; place-items: center; color: var(--ink); }
  .static .mark { color: var(--ink-faint); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { flex: none; font-size: 11px; color: var(--ink-faint); }
  .state.down { color: var(--warn); }
  .item :global(.info) { margin-right: 3px; opacity: 0; }
  .item:hover :global(.info), .item.open :global(.info), .item :global(.info:focus-visible), .head :global(.info) { opacity: 1; }
  @media (hover: none) { .item :global(.info) { opacity: 1; } }
  .fold { padding: 2px 0 4px; }
  .fold :global(.desceditor) { border: 0; padding: 4px 2px; background: none; }
</style>
