<script>
  // The launch prompt for a public document: "what should people call you?", and optionally a
  // passkey so the name is bound and follows the guest to their other devices.
  //
  // A plain name is a label kept in the one `docs` state (docs-state.js, read by DocPage too)
  // and trusted by the server only as a label: anyone can type anyone's name. "Save passkey" goes
  // through /api/docs/guest/register/{begin,finish} (server: doc-guests.js); the server stores
  // the credential with the name and sets the HttpOnly docs_guest cookie on /docs and /api/docs,
  // after which the name shown for this guest is the stored one. "I have a passkey" signs in with
  // one made earlier and adopts its name. The passkey calls are the login page's own helpers,
  // startRegistration / startAuthentication from @simplewebauthn/browser.
  //
  // Props:
  //   open          show the dialog
  //   bound         true when this browser already holds a guest passkey session
  //   allowCancel   show "cancel" (false on first launch, when a name is required)
  //   onsave({ name, bound, guestToken? })   after a name is set; guestToken only if the route
  //                 chose to return it (the cookie is the credential either way)
  //   oncancel()
  import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
  import { uiApp } from '$lib/client/ui-app.js';
  import { docsDecl } from '$lib/core/docs-state.js';

  const docs = uiApp().use(docsDecl);
  let { open = false, bound = false, allowCancel = false, onsave = () => {}, oncancel = () => {} } = $props();

  const MAX = 40;

  let draft = $state('');
  let busy = $state(false);
  let error = $state(null);
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) { draft = docs.get().name; error = null; }
    wasOpen = open;
  });

  const passkeysAvailable = typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';

  // The client half of doc-guests.js sanitizeName: the server cleans again and is authoritative.
  function clean(raw) {
    const value = String(raw ?? '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu, '')
      .replace(/<\/?[A-Za-z!][^>]*>/gu, '').replace(/[<>]/gu, '')
      .replace(/\s+/gu, ' ').trim();
    return [...value].slice(0, MAX).join('').trim();
  }

  async function post(path, payload) {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {})
    });
    let body = {};
    try { body = await response.json(); } catch { /* an HTML error page */ }
    if (!response.ok) throw new Error(body.error || body.message || (response.status >= 500 ? 'Offline; try again' : 'Request failed'));
    return body;
  }

  function finish(result) {
    docs.dispatch('name.set', { name: result.name });
    onsave({ name: result.name, bound: Boolean(result.bound), ...(result.guestToken ? { guestToken: result.guestToken } : {}) });
  }

  // Just a name. A bound guest renaming goes to the server so the stored name changes too.
  async function saveName() {
    const value = clean(draft);
    if (!value) return;
    if (!bound) { finish({ name: value, bound: false }); return; }
    busy = true; error = null;
    try {
      const body = await post('/api/docs/guest/rename', { name: value });
      finish({ name: body.name, bound: true });
    } catch (cause) {
      error = cause.message;
    } finally { busy = false; }
  }

  async function savePasskey() {
    const value = clean(draft);
    if (!value) return;
    busy = true; error = null;
    try {
      const options = await post('/api/docs/guest/register/begin', { name: value });
      const response = await startRegistration({ optionsJSON: options });
      const body = await post('/api/docs/guest/register/finish', { response });
      finish({ name: body.name, bound: true, guestToken: body.sessionToken });
    } catch (cause) {
      error = cause?.name === 'NotAllowedError' ? 'Passkey cancelled' : cause.message;
    } finally { busy = false; }
  }

  async function usePasskey() {
    busy = true; error = null;
    try {
      const options = await post('/api/docs/guest/authenticate/begin', {});
      const response = await startAuthentication({ optionsJSON: options });
      const body = await post('/api/docs/guest/authenticate/finish', { response });
      finish({ name: body.name, bound: true, guestToken: body.sessionToken });
    } catch (cause) {
      error = cause?.name === 'NotAllowedError' ? 'Passkey cancelled' : cause.message;
    } finally { busy = false; }
  }
</script>

{#if open}
  <div class="ask" role="dialog" aria-modal="true" aria-labelledby="doc-guest-name-title" data-testid="doc-guest-dialog">
    <form class="card" onsubmit={(event) => { event.preventDefault(); saveName(); }}>
      <h2 id="doc-guest-name-title">What should people call you?</h2>
      <p>Your name shows beside what you write and on your comments in this document.</p>
      <!-- svelte-ignore a11y_autofocus -->
      <input bind:value={draft} maxlength={MAX} placeholder="Your name" autofocus disabled={busy} data-testid="doc-guest-name-input" />
      {#if passkeysAvailable && !bound}
        <button type="button" class="link" onclick={savePasskey} disabled={busy || !clean(draft)} data-testid="doc-guest-passkey-save">
          {busy ? 'Waiting for passkey…' : 'Save passkey so this name follows you'}
        </button>
        <button type="button" class="link dim" onclick={usePasskey} disabled={busy} data-testid="doc-guest-passkey-use">I already have a passkey</button>
      {:else if bound}
        <p class="note">Your name is saved with your passkey.</p>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="row">
        {#if allowCancel}<button type="button" class="chip" onclick={() => oncancel()} disabled={busy}>cancel</button>{/if}
        <button type="submit" class="go" disabled={busy || !clean(draft)} data-testid="doc-guest-name-save">Continue</button>
      </div>
    </form>
  </div>
{/if}

<style>
  .ask { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); display: grid; place-items: center; z-index: 50; }
  .card {
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 14px; padding: 20px;
    width: min(92vw, 24rem); display: flex; flex-direction: column; gap: 10px;
  }
  h2 { margin: 0; font-size: 16px; }
  p { margin: 0; font-size: 13px; color: var(--ink-dim); }
  .note { color: var(--ink-faint); font-size: 12px; }
  .error { color: var(--warn); font-size: 12.5px; }
  input {
    font: inherit; font-size: 16px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--bg); color: var(--ink);
  }
  .link { background: none; border: 0; padding: 2px 0; text-align: left; color: var(--accent); font-size: 13px; cursor: pointer; }
  .link.dim { color: var(--ink-faint); font-size: 12px; }
  .link:disabled { opacity: 0.5; cursor: default; }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  .chip {
    border: 1px solid var(--line); border-radius: 999px; background: var(--bg-raised);
    color: var(--ink-dim); font-size: 12px; padding: 5px 11px; cursor: pointer;
  }
  .go { border: 0; border-radius: 999px; background: var(--accent); color: #14100d; font-weight: 600; padding: 6px 14px; cursor: pointer; }
  .go:disabled { opacity: 0.5; cursor: default; }
</style>
