<script>
  // Edits go through the offline-first outbox in core/host-notes.js.
  import { hostState, editHost, refreshHosts } from '$lib/core/hosts.svelte.js';

  let { top = 0, onclose = () => {} } = $props();

  const peers = $derived(hostState.list.filter((h) => !h.local));
  const here = $derived(hostState.list.find((h) => h.local));
  // A description is saved when the field loses focus; the draft is the field's own until then.
  let drafts = $state({});
  $effect(() => { refreshHosts(); });

  const stateOf = (h) => (!h.configured ? 'no address' : h.online === false ? 'offline' : h.online ? 'online' : '');
  function saveDescription(h) {
    const text = drafts[h.id];
    if (text === undefined || text === h.description) return;
    editHost(h.id, { description: text });
    delete drafts[h.id];
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={onclose}></div>
<div class="menu" style="top:{top}px" role="dialog" aria-label="Hosts" data-testid="host-menu"
  onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onclose(); } }}>
  <div class="head">Hosts</div>
  <p class="note">Each chat runs on one host. Check a host to let new chats be routed there automatically; only hosts with a description are considered.</p>
  {#if here}<div class="row here" data-testid="host-local"><span class="name">{here.label}</span><span class="state">this machine</span></div>{/if}
  {#each peers as h (h.id)}
    <div class="row" data-testid="host-row" data-host={h.id}>
      <div class="line">
        <span class="name">{h.label}</span>
        {#if stateOf(h)}<span class="state" class:down={h.online === false || !h.configured}>{stateOf(h)}</span>{/if}
      </div>
      <label class="auto">
        <input type="checkbox" checked={h.auto === true} onchange={(event) => editHost(h.id, { auto: event.currentTarget.checked })} data-testid="host-auto" />
        consider for auto-routing
      </label>
      <textarea
        class="focus-ring"
        rows="3"
        maxlength="300"
        placeholder="What to route here, in your words"
        aria-label="What to route to {h.label}"
        data-testid="host-description"
        value={drafts[h.id] ?? h.description}
        oninput={(event) => { drafts[h.id] = event.currentTarget.value; }}
        onblur={() => saveDescription(h)}
      ></textarea>
    </div>
  {:else}
    <p class="note">No other machine is registered on the hub yet.</p>
  {/each}
</div>

<style>
  .scrim { position: absolute; inset: 0; z-index: 50; }
  .menu {
    position: absolute; z-index: 51; left: 10px; right: 10px; max-height: 70%; overflow: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px;
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.25);
  }
  .head { font-size: 11px; color: var(--ink-faint); padding: 4px 6px 0; }
  .note { margin: 0; padding: 2px 6px 6px; font-size: 11.5px; line-height: 1.35; color: var(--ink-faint); }
  .row { display: flex; flex-direction: column; gap: 5px; padding: 6px; border-top: 1px solid var(--line-soft); }
  .row.here { flex-direction: row; justify-content: space-between; align-items: baseline; }
  .line { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .name { font: 500 12.5px/1.2 var(--mono); color: var(--ink); overflow-wrap: anywhere; }
  .state { font: 10px/1 var(--mono); color: var(--ink-faint); white-space: nowrap; }
  .state.down { color: var(--warn); }
  .auto { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink); cursor: pointer; }
  textarea {
    resize: vertical; min-height: 56px; padding: 6px 8px; font: inherit; font-size: 12.5px; line-height: 1.35; color: var(--ink);
    background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  }
</style>
