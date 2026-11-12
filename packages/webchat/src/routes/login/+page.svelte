<script>
  import { onMount } from 'svelte';
  import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

  let enrolled = $state(true);
  let busy = $state(false);
  let error = $state(null);
  let token = $state('');
  // Opened by the desktop app (?desktop=<challenge>): after the passkey, hand a session to the app instead of
  // opening the chat here (src/lib/server/desktop-signin.js).
  const desktop = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('desktop') : null;
  let handedOff = $state(false);

  async function done() {
    if (!desktop) { location.href = '/'; return; }
    await post('/api/auth/desktop', { step: 'grant', challenge: desktop });
    handedOff = true;
    location.href = 'tophat://signed-in';
  }

  onMount(async () => {
    const response = await fetch('/api/auth/status');
    const body = await response.json();
    enrolled = body.enrolled;
    if (body.authenticated) done().catch((cause) => { error = cause.message; });
  });

  async function post(path, payload) {
    const response = await fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  async function signIn() {
    busy = true; error = null;
    try {
      const options = await post('/api/auth/authenticate', { step: 'options' });
      const response = await startAuthentication({ optionsJSON: options });
      await post('/api/auth/authenticate', { step: 'verify', response });
      await done();
    } catch (cause) {
      error = cause.message;
    } finally {
      busy = false;
    }
  }

  async function enroll() {
    busy = true; error = null;
    try {
      const options = await post('/api/auth/register', { step: 'options', token });
      const response = await startRegistration({ optionsJSON: options });
      await post('/api/auth/register', { step: 'verify', response, label: navigator.platform || 'device' });
      await done();
    } catch (cause) {
      error = cause.message;
    } finally {
      busy = false;
    }
  }
</script>

<main>
  <div class="card rise">
    <h1>tophat chat</h1>
    {#if handedOff}
      <p>Signed in. You can close this tab and go back to the Tophat app.</p>
    {:else if enrolled}
      <p>Your AI agents on the Mac mini, from anywhere.</p>
      <button class="primary press focus-ring" onclick={signIn} disabled={busy} data-testid="signin">
        {busy ? 'Waiting for passkey…' : 'Sign in with passkey'}
      </button>
      <button class="link press" onclick={() => (enrolled = false)}>Add a new device</button>
    {:else}
      <p>Enrol this device. The token is in the keyring on the machine.</p>
      <input bind:value={token} placeholder="Enrolment token" type="password" class="focus-ring" data-testid="token" />
      <button class="primary press focus-ring" onclick={enroll} disabled={busy || !token} data-testid="enroll">
        {busy ? 'Waiting for passkey…' : 'Create passkey'}
      </button>
      <button class="link press" onclick={() => (enrolled = true)}>Back to sign in</button>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
  </div>
</main>

<style>
  main { display: grid; place-items: center; min-height: 100dvh; padding: 24px; }
  .card {
    width: min(360px, 100%);
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 28px 24px;
    display: flex; flex-direction: column; gap: 12px;
  }
  h1 { font-size: 19px; margin: 0; font-weight: 600; }
  p { margin: 0; color: var(--ink-dim); font-size: 13.5px; }
  input {
    background: var(--bg-sunken); border: 1px solid var(--line); border-radius: 9px;
    padding: 10px 12px; color: var(--ink); font-size: 16px; outline: none;
  }
  .primary {
    background: var(--accent); color: #14100d;
    border-radius: 10px; padding: 11px; font-size: 14px; font-weight: 600;
  }
  .primary:disabled { background: var(--line); color: var(--ink-faint); }
  .link { color: var(--ink-faint); font-size: 12.5px; }
  .link:hover { color: var(--ink-dim); }
  .error { color: var(--warn); font-size: 12.5px; }
</style>
