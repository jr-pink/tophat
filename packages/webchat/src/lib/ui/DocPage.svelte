<script>
  // The frame around a public document: who you are (a name chosen on first open and kept on this
  // device, or bound to a guest passkey through DocNamePrompt; his session is always "the owner"), the title, who else is here, and the link. The
  // document itself is NotesEditor in doc mode.
  import { onMount } from 'svelte';
  import NotesEditor from './NotesEditor.svelte';
  import DocNamePrompt from './DocNamePrompt.svelte';
  import Nav from './Nav.svelte';
  import { liveClientId } from '$lib/client/live.js';
  import { hueOf } from '$lib/core/doc-presence.js';
  import { uiApp } from '$lib/client/ui-app.js';
  import { docsDecl } from '$lib/core/docs-state.js';

  let { token } = $props();

  // The name is ONE state (docs-state.js), read here, in DocNamePrompt and by the editor: never a copy.
  const docs = uiApp().use(docsDecl);
  const cachedMeta = docs.get().meta[token] ?? null;

  let own = $state({ owner: Boolean(cachedMeta?.owner), title: cachedMeta?.title || '' });
  const name = $derived(own.owner ? 'the owner' : $docs.name);
  // The editor reads this live: a renamed author is the next write's author.
  const doc = { token, get owner() { return own.owner; }, get name() { return name; }, get title() { return own.title; }, set title(value) { own.title = value; } };
  const keepMeta = () => docs.dispatch('meta.set', { token, title: doc.title, owner: doc.owner, bound });
  let bound = $state(Boolean(cachedMeta?.bound));
  let ready = $state(Boolean(cachedMeta));
  let asking = $state(false);
  let titleDraft = $state(cachedMeta?.title || '');
  let editingTitle = $state(false);
  let copied = $state(false);
  let gone = $state(false);

  async function loadMeta() {
    try {
      const response = await fetch(`/api/docs/${token}/meta`, { signal: AbortSignal.timeout(6000) });
      if (response.status === 404) { gone = true; return; }
      if (!response.ok || !(response.headers.get('content-type') || '').includes('json')) return;
      const meta = await response.json();
      own.owner = Boolean(meta.me?.owner);
      own.title = meta.title || '';
      if (!editingTitle) titleDraft = doc.title;
      bound = Boolean(meta.me?.bound);
      if (!doc.owner && bound && meta.me?.name) docs.dispatch('name.set', { name: meta.me.name });
      keepMeta();
    } catch { /* offline: the cached title and identity stand */ }
    finally { ready = true; if (!doc.owner && !name) asking = true; }
  }

  // DocNamePrompt has already set the name state (and, for a passkey, the server has set the guest
  // cookie); tell the others in the document at once.
  function nameSaved({ name, bound: isBound }) {
    bound = isBound;
    asking = false;
    keepMeta();
    fetch(`/api/docs/${token}/presence`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-doc-name': encodeURIComponent(name), 'x-doc-client': liveClientId() },
      body: JSON.stringify({ client: liveClientId(), name })
    }).catch(() => {});
  }

  async function saveTitle() {
    editingTitle = false;
    const title = titleDraft.trim();
    if (!title || title === doc.title) { titleDraft = doc.title; return; }
    own.title = title;
    try {
      const response = await fetch(`/api/docs/${token}/meta`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-doc-client': liveClientId() }, body: JSON.stringify({ title })
      });
      if (response.ok) { const info = await response.json(); own.title = info.title; titleDraft = info.title; }
    } catch { /* kept locally; the next rename sends it */ }
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(location.href); copied = true; setTimeout(() => { copied = false; }, 1500); } catch { /* no clipboard */ }
  }

  const initials = (name) => String(name || '?').split(/\s+/u).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  // The same colour as the person's caret in the document (DocCursors.svelte).
  const hue = hueOf;

  onMount(loadMeta);
</script>

{#snippet bar({ presence = [] } = {})}
  <div class="docbar" data-testid="doc-bar">
    {#if doc.owner}<Nav current="docs" />{/if}
    {#if doc.owner}<a class="all" href="/docs" title="All documents">docs</a>{/if}
    {#if editingTitle}
      <input class="title-edit" bind:value={titleDraft} maxlength="200" data-testid="doc-title-input"
        onblur={saveTitle} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveTitle(); } if (event.key === 'Escape') { titleDraft = doc.title; editingTitle = false; } }} />
    {:else}
      <button class="title" onclick={() => { titleDraft = doc.title; editingTitle = true; }} title="Rename" data-testid="doc-title">{doc.title || 'Untitled'}</button>
    {/if}
    <div class="here" data-testid="doc-presence">
      {#each presence.filter((entry, index, list) => list.findIndex((other) => other.name === entry.name && other.owner === entry.owner) === index) as person (person.client)}
        <span class="avatar" class:owner={person.owner} style:--hue={hue(person.name)} title={person.name + (person.owner ? ' (owner)' : '')}>{initials(person.name)}</span>
      {/each}
    </div>
    {#if !doc.owner}
      <button class="chip" onclick={() => { asking = true; }} data-testid="doc-name" title={bound ? 'Your name is saved with your passkey' : 'Change your name'}>{doc.name || 'set name'}</button>
    {/if}
    <button class="chip" onclick={copyLink} data-testid="doc-copy-link" title="Anyone with the link can edit">{copied ? 'copied' : 'link'}</button>
  </div>
{/snippet}

{#if gone}
  <div class="gone"><p>This document does not exist.</p></div>
{:else if ready}
  <NotesEditor {doc} docBar={bar} />
{/if}

{#if !doc.owner}
  <DocNamePrompt open={asking} {bound} allowCancel={Boolean(name)}
    onsave={nameSaved} oncancel={() => { asking = false; }} />
{/if}

<style>
  .docbar { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
  .all { font-size: 12px; color: var(--ink-faint); text-decoration: none; }
  .all:hover { color: var(--ink); }
  .title {
    font: inherit; font-size: 15px; font-weight: 600; color: var(--ink); background: none; border: 0;
    padding: 2px 4px; border-radius: 6px; cursor: text; max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .title:hover { background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .title-edit {
    font: inherit; font-size: 15px; font-weight: 600; color: var(--ink); background: var(--bg-raised);
    border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; width: min(40vw, 24rem);
  }
  .here { display: flex; gap: 3px; margin-left: auto; }
  .avatar {
    width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
    font-size: 10px; font-weight: 700; color: #fff; background: hsl(var(--hue) 70% 50%);
  }
  .avatar.owner { box-shadow: 0 0 0 2px var(--accent); }
  .chip {
    border: 1px solid var(--line); border-radius: 999px; background: var(--bg-raised);
    color: var(--ink-dim); font-size: 12px; padding: 5px 11px; cursor: pointer; white-space: nowrap;
    max-width: 10rem; overflow: hidden; text-overflow: ellipsis;
  }
  .gone { display: grid; place-items: center; height: 100dvh; color: var(--ink-faint); }
</style>
