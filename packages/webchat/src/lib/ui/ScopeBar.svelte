<script>
  // The chat's scope: a dropdown in the header. Choosing another scope moves the chat, history and all.
  // Opening a chat to more people asks first, on a plain screen; narrowing does not. The router (server)
  // sets the same value by the same operation, so this only ever shows the chat's current scope.
  import { scopeState, saveRules } from '$lib/core/scopes.svelte.js';
  import { isWidening, scopeKind, wideningWarning } from '$lib/core/scopes.js';

  let { conversation = null, onmove = () => {} } = $props();

  const scopes = $derived(scopeState.scopes);
  const current = $derived(conversation?.scope || scopeState.personalScope || scopes[0]?.id || '');
  const nameOf = (entry) => (entry.kind === 'personal' || scopeKind(entry.id) === 'personal' ? 'personal' : entry.label || entry.id);

  let confirming = $state(null);    // { to } while the screen is up
  let rulesOpen = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let failure = $state('');

  function pick(event) {
    const to = event.currentTarget.value;
    if (!to || to === current) return;
    const hasHistory = (conversation?.turns || 0) > 0;
    if (hasHistory && isWidening(current, to, scopes)) {
      event.currentTarget.value = current;
      confirming = { to };
      return;
    }
    onmove(to, { confirmed: false });
  }

  function confirm() {
    const { to } = confirming;
    confirming = null;
    onmove(to, { confirmed: true });
  }

  function openRules() {
    draft = scopeState.rules?.prompt || '';
    failure = '';
    rulesOpen = true;
  }

  async function save(text) {
    saving = true;
    failure = '';
    try { await saveRules(text); rulesOpen = false; }
    catch (cause) { failure = String(cause?.message || cause); }
    finally { saving = false; }
  }
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') { if (confirming) confirming = null; else if (rulesOpen) rulesOpen = false; } }} />

{#if scopeState.enabled && scopes.length}
  <select
    class="scope focus-ring"
    value={current}
    onchange={pick}
    aria-label="Scope"
    title="Which scope this chat lives in. Moving it moves the whole history."
    data-testid="scope"
    data-scope={current}
  >
    {#each scopes as entry (entry.id)}<option value={entry.id}>{nameOf(entry)}</option>{/each}
  </select>
  <button class="rules press focus-ring" onclick={openRules} title="How chats get sorted into scopes" data-testid="scope-rules-open">rules</button>
{/if}

{#if confirming}
  <div class="scrim" role="presentation" onclick={() => (confirming = null)} data-testid="scope-confirm-scrim"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Move this chat" data-testid="scope-confirm">
    <p class="words" data-testid="scope-confirm-text">{wideningWarning({ from: current, to: confirming.to, scopes })}</p>
    <div class="foot">
      <button class="plain press" onclick={() => (confirming = null)} data-testid="scope-confirm-cancel">Cancel</button>
      <button class="go press" onclick={confirm} data-testid="scope-confirm-go">Move chat</button>
    </div>
  </div>
{/if}

{#if rulesOpen}
  <div class="scrim" role="presentation" onclick={() => (rulesOpen = false)}></div>
  <div class="sheet wide" role="dialog" aria-modal="true" aria-label="Scope sending rules" data-testid="scope-rules">
    <p class="head">Scope sending rules for {scopeState.account}. After a chat's first message, a small model reads these and picks the scope. The chat moves like a manual move, and you can move it back from the dropdown.</p>
    <textarea class="field focus-ring" rows="9" bind:value={draft} data-testid="scope-rules-field" aria-label="Scope sending rules"></textarea>
    {#if failure}<p class="head" data-testid="scope-rules-error">{failure}</p>{/if}
    <div class="foot">
      <button class="plain press" onclick={() => save('')} disabled={saving} data-testid="scope-rules-reset">Use default</button>
      <button class="go press" onclick={() => save(draft)} disabled={saving} data-testid="scope-rules-save">Save</button>
    </div>
  </div>
{/if}

<style>
  .scope {
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 7px;
    color: var(--ink-dim); font-size: 11.5px; padding: 3px 6px; outline: none;
  }
  .rules {
    border: 1px solid var(--line); border-radius: 7px;
    font-size: 11.5px; padding: 3px 9px; color: var(--ink-faint);
  }
  .scrim { position: fixed; inset: 0; z-index: 20; background: color-mix(in srgb, var(--bg-sunken, #000) 40%, transparent); }
  .sheet {
    position: fixed; z-index: 21; left: 50%; top: 22vh; transform: translateX(-50%);
    width: min(420px, calc(100vw - 32px));
    display: flex; flex-direction: column; gap: 10px; padding: 14px;
    background: var(--bg-raised, #fff); color: var(--ink);
    border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 18px 48px color-mix(in srgb, black 22%, transparent);
  }
  .sheet.wide { width: min(560px, calc(100vw - 32px)); }
  .words { margin: 0; font-size: 13px; line-height: 1.5; }
  .head { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--ink-faint); }
  .field {
    width: 100%; box-sizing: border-box; padding: 9px 10px; font: inherit; font-size: 12.5px; line-height: 1.5;
    color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; resize: vertical;
  }
  .foot { display: flex; align-items: center; gap: 8px; }
  .plain { border: 0; background: none; color: var(--ink-faint); font: inherit; font-size: 12px; cursor: pointer; padding: 4px 0; }
  .plain:hover { color: var(--ink); text-decoration: underline; }
  .go {
    margin-left: auto; border: 0; border-radius: 8px; padding: 6px 14px;
    background: var(--accent-soft, #eee); color: var(--ink); font: inherit; font-size: 12.5px; cursor: pointer;
  }
  .go:disabled, .plain:disabled { opacity: 0.45; cursor: default; }
  @media (max-width: 860px) {
    .scope { max-width: 96px; min-width: 0; font-size: 11px; padding: 3px 2px; text-overflow: ellipsis; }
    .rules { padding: 3px 6px; }
  }
</style>
