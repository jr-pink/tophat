<script>
  // His public documents: the list and "new doc". hooks.server.js keeps /docs and /api/docs behind
  // his session; a document itself is /docs/<token>, editable by anyone with that link.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import Nav from '$lib/ui/Nav.svelte';
  import { uiApp } from '$lib/client/ui-app.js';
  import { docsDecl } from '$lib/core/docs-state.js';

  const docState = uiApp().use(docsDecl); // the list last seen is its `list` field: painted at once, offline too
  const docs = $derived($docState.list);
  let title = $state('');
  let busy = $state(false);
  let error = $state(null);
  let offline = $state(false);

  async function load() {
    try {
      const response = await fetch('/api/docs', { signal: AbortSignal.timeout(6000) });
      if (response.status >= 500 || !(response.headers.get('content-type') || '').includes('json')) { offline = true; return; }
      if (!response.ok) { error = `docs ${response.status}`; return; }
      docState.dispatch('list.set', { docs: (await response.json()).docs || [] });
      offline = false;
    } catch { offline = true; }
  }

  async function create() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const response = await fetch('/api/docs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.trim() || 'Untitled' }) });
      const answer = await response.json();
      if (!response.ok) throw new Error(answer.error || `create ${response.status}`);
      title = '';
      await goto(answer.path);
    } catch (cause) { error = cause.message; }
    finally { busy = false; }
  }

  async function remove(token) {
    if (!confirm('Delete this document? Its link stops working.')) return;
    const response = await fetch('/api/docs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remove: token }) });
    if (response.ok) docState.dispatch('list.remove', { token });
  }

  const when = (at) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  onMount(load);
</script>

<svelte:head><title>docs</title></svelte:head>

<div class="page">
  <header><Nav current="docs" /><span class="label">docs</span>{#if offline}<span class="state">offline</span>{/if}</header>
  <form class="new" onsubmit={(event) => { event.preventDefault(); create(); }}>
    <input bind:value={title} placeholder="Title of a new document" maxlength="200" data-testid="docs-new-title" />
    <button class="go" disabled={busy} data-testid="docs-new">new doc</button>
  </form>
  {#if error}<p class="err">{error}</p>{/if}
  <ul class="list" data-testid="docs-list">
    {#each docs as doc (doc.token)}
      <li>
        <a href={`/docs/${doc.token}`} data-testid="docs-item">{doc.title || 'Untitled'}</a>
        <span class="when">{when(doc.updatedAt)}</span>
        <button class="x" onclick={() => remove(doc.token)} title="Delete">×</button>
      </li>
    {:else}
      <li class="empty">No documents yet. Anyone you send a document's link to can edit it.</li>
    {/each}
  </ul>
</div>

<style>
  .page { max-width: 44rem; margin: 0 auto; padding: 12px 16px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .label { font-size: 13px; color: var(--ink-faint); }
  .state { font-size: 11px; color: var(--ink-faint); margin-left: auto; }
  .new { display: flex; gap: 8px; margin-bottom: 16px; }
  .new input {
    flex: 1; font: inherit; font-size: 15px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--bg-raised); color: var(--ink);
  }
  .go { border: 0; border-radius: 999px; background: var(--accent); color: #14100d; font-weight: 600; padding: 6px 16px; cursor: pointer; }
  .list { list-style: none; padding: 0; margin: 0; }
  .list li { display: flex; align-items: center; gap: 10px; padding: 9px 4px; border-bottom: 1px solid var(--line-soft, var(--line)); }
  .list a { color: var(--ink); text-decoration: none; flex: 1; }
  .list a:hover { text-decoration: underline; }
  .when { font-size: 12px; color: var(--ink-faint); }
  .x { border: 0; background: none; color: var(--ink-faint); font-size: 16px; cursor: pointer; }
  .x:hover { color: var(--warn, #d66); }
  .empty { color: var(--ink-faint); font-size: 13px; }
  .err { color: var(--warn, #d66); font-size: 13px; }
</style>
