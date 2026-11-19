<script>
  // make it not rot. have a sidebar, main area, good instant search.
  //
  // The page this replaced was a stack of forms: a request inbox, then an entry
  // list, then an import box, then an add form, each its own section, nothing
  // selectable and nothing searchable. Three panes instead: what to look at, the
  // list, the thing itself. The pending-request inbox did not get deleted, it
  // became one of the things the sidebar can point at, because asking him to
  // paste a service secret is still how a connector gets its credential.
  import { onMount, tick } from 'svelte';
  import Nav from '$lib/ui/Nav.svelte';
  import SecretForm from '$lib/ui/SecretForm.svelte';
  import { vaultReplica } from '$lib/client/vault-offline.js';
  import { bindGlobalKeys } from '$lib/core/keys.js';
  import { KINDS, KIND_BY_ID, uiKind, visibleGroups, buildEntry, draftFromEntry, describeRevealed, subtitle,
    canEdit, derivedName } from '$lib/core/secret-form.js';
  import { DRAFT_KEY_NEW, editKey } from '$lib/core/secret-draft-state.js';
  import { draft as draftBox, peek as peekBox, restoreDrafts, dirtyKeys } from '$lib/ui/secret-drafts.svelte.js';

  // The panes that replace the list (a vault tool); everything else is the list beside a credential.
  const TOOLS = ['activity', 'requests', 'import', 'devices'];
  const KIND_LABEL = Object.fromEntries(KINDS.map((kind) => [kind.id, kind.plural]));

  let entries = $state([]);
  let history = $state([]);
  let status = $state(null);
  let requests = $state([]);
  let query = $state('');
  // The list and the credential are always side by side; a form for a new or edited credential takes the credential's
  // place and never replaces the list, so searching can never navigate away from it.
  let scope = $state({ type: 'all' });     // all | kind | group | archived | activity | requests | import | devices
  let selectedId = $state(null);
  let revealed = $state(null);             // { id, kind, value }
  let busy = $state(null);
  let error = $state(null);
  let notice = $state('');
  let searchBox;

  // Search is over everything a person would type: the name, the id, the site,
  // the group, the username, the OAuth account and issuer. Substring, not prefix,
  // because he searches for "mercury" in "tophat-mercury-oauth".
  const haystack = (entry) => [
    entry.name, entry.id, entry.issuer, entry.account,
    (entry.origins || []).join(' '), (entry.usernames || []).join(' '), (entry.emails || []).join(' '), (entry.phones || []).join(' '), (entry.groups || []).join(' '),
    (entry.scopes || []).join(' '), KIND_LABEL[uiKind(entry)], KIND_BY_ID[uiKind(entry)]?.label,
  ].filter(Boolean).join(' ').toLowerCase();

  let groups = $derived([...new Set(entries.flatMap((entry) => visibleGroups(entry.groups)))].sort());

  let scoped = $derived(entries.filter((entry) => {
    if (scope.type === 'kind') return uiKind(entry) === scope.id;
    if (scope.type === 'group') return (entry.groups || []).includes(scope.id);
    if (scope.type === 'archived') return entry.archived;
    return !entry.archived;
  }));

  let shown = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const rows = needle ? scoped.filter((entry) => haystack(entry).includes(needle)) : scoped;
    return [...rows].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  });

  // The open credential is whatever he picked, whether or not the filter currently shows it: typing in the search box narrows the
  // list and never closes or changes the credential beside it, and clearing the filter brings its row back.
  let selected = $derived(entries.find((entry) => entry.id === selectedId) || null);
  let entryHistory = $derived(selectedId ? history.filter((event) => event.id === selectedId) : []);

  const when = (at) => {
    if (!at) return '';
    const date = new Date(at);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const expired = (entry) => entry.expiresAt ? Date.parse(entry.expiresAt) <= Date.now() : false;

  // The device's own copy of the vault (lib/client/vault-offline.js): the same sealed records the
  // Mac holds, re-sealed under a key only this device has, in IndexedDB. Reads fall back to it
  // when the Mac is unreachable and writes go through its op log, so a password saved on a plane
  // is in the list at once, survives a reload and reaches the Mac later. With no copy on this
  // device api() is a plain fetch and the page behaves exactly as it did before any of this.
  const replica = typeof window === 'undefined' ? null : vaultReplica();
  let sync = $state({ enrolled: false, deviceId: null, online: true, syncing: false, pending: 0,
    rejected: 0, lastSync: null, locked: false, signedOut: false, revoked: false,
    needsPassphrase: false, entries: 0, keyStorage: null, error: null });
  let condition = $state('not-enrolled');
  let devices = $state([]);
  let localCopy = $state(false);        // the rows on screen came from this device, not the Mac
  let offline = $derived(!sync.online);
  // The Mac's own lock, and this device's copy of the catalog, are different things: a locked Mac
  // does not blank a page that holds the vault itself. The page keeps its own flag because the
  // replica clears its `locked` on any good answer from any route, and /api/secrets answers 200
  // while the vault is locked.
  let macLocked = $state(false);
  let locked = $derived(Boolean(status?.initialized && status.locked) || macLocked || sync.locked);
  let localReadable = $derived(sync.enrolled && entries.length > 0);

  // The service worker answers a navigation out of its cache, so a lapsed session reaches a fully
  // rendered page whose every request 401s. Before this, that looked exactly like an empty vault:
  // zero in every count, no error, no way back to the sign-in. A 401 means sign in again, and it
  // says so. Nothing else does: a 5xx, a dead tunnel or a Cloudflare error page is offline, and
  // vault-offline.js's request() draws that line once for the page and the replica both.
  let signedOut = $state(false);

  /**
   * Every call this page makes. Through the replica when there is one, so the same code path
   * serves a live Mac and a dead one; it throws with `.offline`, `.signedOut`, `.locked`,
   * `.revoked`, `.missing` or `.rejected` set instead of handing back a Response.
   */
  async function api(path, options = {}) {
    if (replica) return replica.api(path, options);
    const response = await fetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const cause = new Error(body.error || `${response.status}`);
      cause.status = response.status;
      if (response.status === 401) cause.signedOut = true;
      else if (response.status === 423) cause.locked = true;
      else if (body.reason === 'unreadable') { cause.unreadable = true; cause.message = body.hint || body.error; }
      else if (response.status >= 500) cause.offline = true;
      throw cause;
    }
    return body;
  }

  /** The four failures told apart. Offline is the pill's job and never an error banner. */
  function failed(cause, message) {
    if (cause?.signedOut) { signedOut = true; return; }
    if (cause?.unreadable) { error = cause.message; return; }
    if (cause?.offline) { if (cause.missing) error = cause.message; return; }
    if (cause?.locked) { macLocked = true; return; }
    if (cause?.notEnrolled) { error = cause.message; return; }
    if (cause?.revoked) { error = 'This device is no longer enrolled; keep a copy again to sync.'; return; }
    if (cause?.rejected) { error = `The vault refused that change: ${cause.message}`; return; }
    error = message || cause?.message || 'Something went wrong.';
  }

  /** The list this device already holds, painted before the Mac is asked and when it never answers. */
  function paintLocal() {
    if (!replica?.enrolled()) return false;
    const rows = replica.list({ archived: true });
    if (!rows) return false;
    entries = rows;
    history = replica.history({ limit: 200 });
    localCopy = true;
    return true;
  }

  async function load() {
    try {
      const body = await api('/api/password-manager?archived=1', { cache: 'no-store' });
      signedOut = false;
      // Only the Mac's own status answers this; a body served from this device says nothing
      // about the Mac's lock, so the last real answer stands.
      if (!body.local) macLocked = Boolean(body.status?.initialized && body.status.locked);
      else if (sync.locked) macLocked = true;
      entries = body.entries || [];
      history = body.history || [];
      localCopy = Boolean(body.local);
      if (body.status) status = body.status;
      if (locked && !localReadable) { revealed = null; }
    } catch (cause) {
      if (cause?.locked) macLocked = true;
      if ((cause?.offline || cause?.locked) && !cause?.unreadable) { paintLocal(); return; }
      failed(cause, 'Could not open the vault.');
    }
  }

  /** After a write: this device's view first, so an offline change is on screen at once. */
  async function refresh() {
    if (offline) paintLocal();
    await load();
  }

  // The request inbox is the Mac's: the connectors that raise a request and the file they land in
  // both live there, so offline this pane says so rather than failing.
  async function loadRequests() {
    if (offline) return;
    try {
      const body = await api('/api/secrets', { cache: 'no-store' });
      requests = (body.requests || []).filter((request) => request.status === 'pending');
    } catch (cause) { if (cause?.signedOut) signedOut = true; }
  }

  onMount(() => {
    let wasOnline = true;
    const stopSync = replica ? replica.subscribe((next) => {
      sync = next;
      condition = replica.condition();
      // The snapshot's list wins when there is one; a browser with no copy keeps what the Mac
      // last listed rather than blanking the pane.
      const known = replica.devices();
      if (known.length) devices = known;
      if (next.signedOut) signedOut = true;
      // Back from the dead: repaint from the Mac, and pick the request inbox back up.
      if (!wasOnline && next.online) { load(); loadRequests(); }
      wasOnline = next.online;
    }) : () => {};
    (async () => {
      if (replica) {
        await replica.ready;
        paintLocal();
        // Only a device that holds a copy has anything to sync; and vault-offline.js's sync()
        // returns early with its `syncing` latch still set when there is no device key, which
        // would make every later sync in this tab a no-op.
        if (replica.enrolled()) replica.start();
      }
      await load();
      await loadRequests();
    })();
    draftBox(DRAFT_KEY_NEW);
    restoreDrafts();
    // "/" jumps to the search box, but never from inside a field (core/keys.js bindGlobalKeys)
    const unbind = bindGlobalKeys({ '/': () => searchBox?.focus() });
    window.addEventListener('beforeunload', beforeUnload);
    const timer = setInterval(() => { load(); loadRequests(); }, 30000);
    return () => { clearInterval(timer); stopSync(); replica?.stop(); unbind(); window.removeEventListener('beforeunload', beforeUnload); clearTimeout(revealTimer); };
  });

  const post = (payload) => api('/api/password-manager', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });

  async function loadDevices() {
    if (offline) return;
    try {
      const body = await api('/api/password-manager/sync', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'devices' }) });
      if (Array.isArray(body.devices)) devices = body.devices;
    } catch (cause) { if (cause?.signedOut) signedOut = true; }
  }

  // ---- this device's copy of the vault ----------------------------------
  // One click, no second confirmation: he is already signed in on a page that can read every
  // credential, so asking twice buys nothing.
  async function enrollDevice() {
    if (!replica) return;
    busy = 'enroll'; error = null; notice = '';
    try {
      await replica.enroll();
      replica.start();
      await loadDevices();
      notice = 'This device keeps a copy of the vault now.';
      paintLocal();
      await load();
    } catch (cause) { failed(cause, 'Could not keep a copy on this device.'); }
    finally { busy = null; }
  }

  /** Revoking stops future snapshots and future writes. It does not reach into what a device holds. */
  async function revokeDevice(device) {
    busy = `revoke:${device.deviceId}`; error = null; notice = '';
    try {
      await api('/api/password-manager/sync', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'revoke', deviceId: device.deviceId }) });
      await replica?.sync();
      await loadDevices();
      notice = `Revoked ${device.label || device.deviceId}.`;
    } catch (cause) { failed(cause, 'Could not revoke that device.'); }
    finally { busy = null; }
  }

  /** Drop this browser's copy. The Mac still lists the device until it is revoked there too. */
  async function forgetThisDevice() {
    if (!replica) return;
    busy = 'forget-device'; error = null;
    try {
      replica.stop();
      await replica.forgetDevice();
      localCopy = false;
      await loadDevices();
      notice = 'This device no longer keeps a copy.';
      await load();
    } catch (cause) { failed(cause, 'Could not drop this copy.'); }
    finally { busy = null; }
  }

  // The passphrase branch: when the vault is passphrase protected this device's key is stored
  // wrapped, so it is typed here as well as on the Mac.
  let devicePassphrase = $state('');
  async function unlockThisDevice() {
    busy = 'device-unlock'; error = null;
    try { await replica.unlockDevice(devicePassphrase); paintLocal(); await load(); }
    catch { error = 'Could not unlock this device. Check the passphrase.'; }
    finally { devicePassphrase = ''; busy = null; }
  }

  // One word, four different things, never collapsed into "error".
  const PILL = {
    'not-enrolled': 'not on this device', passphrase: 'needs unlock', revoked: 'revoked',
    'signed-out': 'signed out', offline: 'offline', locked: 'locked on the Mac',
    syncing: 'syncing', ok: 'online',
  };
  const PILL_WHY = {
    'not-enrolled': 'This browser keeps no copy of the vault, so it needs the Mac for everything.',
    passphrase: "This device's copy is wrapped behind your vault passphrase.",
    revoked: 'This device was revoked; the Mac no longer sends it anything.',
    'signed-out': 'The session expired. Sign in again.',
    offline: "The Mac is not reachable; this is this device's copy of the vault.",
    locked: 'The vault is locked on the Mac.',
    syncing: 'Syncing with the Mac.',
    ok: 'In sync with the Mac.',
  };
  let pill = $derived(sync.pending
    ? `${PILL[condition] || condition}, ${sync.pending} change${sync.pending === 1 ? '' : 's'} queued`
    : (PILL[condition] || condition));


  function select(entry) {
    selectedId = entry.id;
    revealed = null; confirmDelete = false;
    // another credential, not another form: the draft he was typing stays in the store and is flagged in the list
    mode = 'view';
    leaveTool();
  }

  function go(next) {
    scope = next;
    if (next.type === 'devices') loadDevices();
    notice = ''; error = null;
  }

  // Typing in the search box filters the list. From a vault tool (Activity, Import ...) it brings the list back; it never
  // touches the credential or the form beside the list.
  function onSearchInput(event) {
    if (event.currentTarget.value.trim() && TOOLS.includes(scope.type)) go({ type: 'all' });
  }
  function onSearchKeydown(event) {
    if (event.key === 'Escape' && !event.isComposing) { query = ''; event.currentTarget.blur(); }
  }

  // The vault returns one value at a time, on an explicit click. Nothing is
  // prefetched: a list render must never be a reason to decrypt 654 secrets.
  let revealTimer;
  async function reveal(entry) {
    busy = `reveal:${entry.id}`; error = null;
    try {
      revealed = await post({ action: 'reveal', id: entry.id });
      // a revealed value does not stay on screen for good
      clearTimeout(revealTimer);
      revealTimer = setTimeout(() => (revealed = null), 60_000);
    }
    catch (cause) {
      // Offline, a value this device has never synced is the one thing it cannot show.
      if (cause?.missing) error = 'That one is not on this device yet.';
      else if (cause?.signedOut) signedOut = true;
      else error = locked ? 'Unlock the vault first.' : 'Could not read this credential.';
    }
    finally { busy = null; }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); notice = 'Copied.'; setTimeout(() => (notice = ''), 1500); }
    catch { error = 'The browser refused clipboard access.'; }
  }

  async function act(payload, failure) {
    busy = payload.action; error = null;
    try {
      const body = await post(payload);
      await refresh();
      if (body?.queued) notice = 'Saved on this device; it reaches the Mac when it is back.';
    }
    catch (cause) { failed(cause, failure); }
    finally { busy = null; }
  }

  // ---- vault protection -------------------------------------------------
  let passphrase = $state('');
  async function protection(action) {
    if (offline) { error = 'Changing the vault passphrase needs the Mac.'; return; }
    busy = 'protection'; error = null; notice = '';
    try {
      const body = await post({ action, ...(action === 'lock' ? {} : { passphrase }) });
      status = body.status;
      macLocked = Boolean(body.status?.locked);
      notice = action === 'unlock' ? 'Unlocked for 15 minutes.' : action === 'lock' ? 'Locked.' : 'Passphrase protection on.';
      await load();
    } catch (cause) {
      if (cause?.offline) error = 'Changing the vault passphrase needs the Mac.';
      else error = action === 'unlock' ? 'Could not unlock. Check the passphrase.' : 'Could not change protection.';
    }
    finally { passphrase = ''; busy = null; }
  }

  // ---- the credential form (new and edit) ------------------------------------------------------------------------------
  // The form is a view of a draft in the store (core/secret-draft-state.js, lib/ui/secret-drafts.svelte.js). Nothing he types is
  // held by the form, the search box or the list: closing the form, picking another credential, typing in the search box, the
  // 30-second refresh and Tab leave the draft alone, and it comes back on a reload of this tab. Only a successful Save or a
  // confirmed Discard removes it.
  let mode = $state('view');                       // view | new | edit
  let formErrors = $state({});
  let formWarnings = $state([]);
  let formRef = $state(null);
  let formKey = $derived(mode === 'new' ? DRAFT_KEY_NEW : mode === 'edit' && selectedId ? editKey(selectedId) : null);
  let formBox = $derived(formKey ? peekBox(formKey) : peekBox(null));
  let dirtyForms = $derived(new Set(dirtyKeys()));
  let newDirty = $derived(dirtyForms.has(DRAFT_KEY_NEW));
  const takenIds = () => new Set(entries.map((entry) => entry.id));

  function leaveTool() { if (TOOLS.includes(scope.type)) scope = { type: 'all' }; }

  async function startNew(kind) {
    error = null; notice = ''; formErrors = {}; formWarnings = [];
    const box = draftBox(DRAFT_KEY_NEW);
    // an untouched or empty draft starts blank (of the kind asked for); one with content is resumed as it was
    if (!box.dirty) box.set({ kind: kind || box.data.kind || 'login' });
    else if (kind && kind !== box.data.kind) box.patch({ kind });
    revealed = null; leaveTool(); mode = 'new';
    await tick(); formRef?.focusFirst?.();
  }

  async function startEdit(entry) {
    error = null; notice = ''; formErrors = {}; formWarnings = [];
    const box = draftBox(editKey(entry.id));
    if (!box.dirty) {
      busy = `edit:${entry.id}`;
      try {
        const shown = revealed?.id === entry.id ? revealed : await post({ action: 'reveal', id: entry.id });
        const data = draftFromEntry(entry, shown);
        box.set(data, data);
      } catch (cause) {
        busy = null;
        if (cause?.missing) error = 'That one is not on this device yet, so it cannot be edited here.';
        else if (cause?.signedOut) signedOut = true;
        else error = locked ? 'Unlock the vault first.' : 'Could not read this credential to edit it.';
        return;
      }
      busy = null;
    }
    revealed = null; selectedId = entry.id; mode = 'edit';
    await tick(); formRef?.focusFirst?.();
  }

  async function saveForm() {
    const box = formBox;
    if (!box || busy === 'save') return;
    const editing = mode === 'edit';
    const built = buildEntry(box.data, { taken: takenIds(), editId: editing ? selectedId : null });
    formErrors = built.errors; formWarnings = built.warnings;
    if (!built.ok) { await tick(); formRef?.focusFirstInvalid?.(); return; }
    busy = 'save'; error = null; notice = '';
    try {
      const body = await post({ action: 'save', overwrite: editing, entry: built.entry });
      // the vault has it (or this device queued it): only now is the draft done with
      box.clear();
      formErrors = {}; formWarnings = [];
      await refresh();
      selectedId = built.id; mode = 'view'; revealed = null;
      notice = body?.queued ? 'Saved on this device; it reaches the Mac when it is back.' : 'Saved.';
    } catch (cause) { failed(cause, 'Could not save. What you typed is still here.'); }
    finally { busy = null; }
  }

  /** Close the form and keep the draft. */
  function closeForm() { formBox?.flush(); mode = 'view'; }
  /** Throw the draft away (the form asked him first). */
  function discardForm() {
    const box = formBox;
    box?.clear(); formErrors = {}; formWarnings = [];
    mode = 'view';
  }

  // Closing the tab or reloading with an unsaved draft asks first; the draft itself is already written to this tab's
  // sessionStorage (flushed here), so a reload loses nothing and a close is the only way to lose it.
  function beforeUnload(event) {
    if (!dirtyKeys().length) return;
    for (const key of dirtyKeys()) draftBox(key).flush();
    event.preventDefault();
    event.returnValue = '';
  }

  const kindName = (entry) => KIND_BY_ID[uiKind(entry)]?.label || 'Secret';
  let confirmDelete = $state(false);
  async function forget(entry) {
    confirmDelete = false;
    await act({ action: 'forget', id: entry.id }, 'Could not delete.');
    draftBox(editKey(entry.id)).clear();
    if (selectedId === entry.id) { selectedId = null; mode = 'view'; revealed = null; }
  }

  // ---- groups on an existing entry --------------------------------------
  let groupDraft = $state('');
  let editingGroups = $state(false);
  function startGroups(entry) { groupDraft = visibleGroups(entry.groups).join(', '); editingGroups = true; }
  async function commitGroups(entry) {
    // the page's own type tags (kind:card) are not his to edit and are kept
    const tags = (entry.groups || []).filter((g) => g.startsWith('kind:'));
    await act({ action: 'groups', id: entry.id, groups: [...new Set([...groupDraft.split(',').map((v) => v.trim()).filter(Boolean), ...tags])] },
      'Could not change groups.');
    editingGroups = false;
  }

  // ---- import -----------------------------------------------------------
  let importFormat = $state('chrome');
  let importFile = $state(null);
  let importInput = $state(null);
  async function runImport() {
    if (!importFile || offline) return;
    busy = 'import'; error = null; notice = '';
    try {
      let body;
      if (importFormat === '1pux') {
        const response = await fetch('/api/password-manager?format=1pux', {
          method: 'POST', headers: { 'content-type': 'application/octet-stream' },
          body: await importFile.arrayBuffer() });
        body = await response.json();
        if (!response.ok) throw new Error('import');
      } else body = await post({ action: 'import', format: importFormat, text: await importFile.text() });
      notice = `Imported ${body.result.imported}, skipped ${body.result.skipped}.`
        + (body.result.warnings ? ` ${body.result.warnings} warnings.` : '');
      await load();
    } catch { error = 'Could not import. Check the format, the unlock state and the 16 MB limit.'; }
    finally { importFile = null; if (importInput) importInput.value = ''; busy = null; }
  }

  // ---- pending service-secret requests ----------------------------------
  let values = $state({});
  let replace = $state({});
  const field = (id) => values[id] || {};
  function type(id, key, next) { values[id] = { ...(values[id] || {}), [key]: next }; }
  const ready = (request) => request.fields.every((f) => f.optional || (field(request.id)[f.key] || '').trim());

  async function fulfill(request) {
    busy = request.id; error = null;
    try {
      const body = await api('/api/secrets', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'fulfill', id: request.id, values: values[request.id] || {}, overwrite: replace[request.id] }) });
      values[request.id] = {};
      notice = `Saved ${body.name}.`;
      await loadRequests();
    } catch (cause) {
      if (cause?.offline) error = 'Saving a service secret needs the Mac.';
      else failed(cause);
    }
    finally { busy = null; }
  }
  async function dismiss(request) {
    await api('/api/secrets', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', id: request.id }) }).catch(() => {});
    await loadRequests();
  }
</script>

<svelte:head><title>secrets · tophat</title></svelte:head>

<div class="app">
  <aside>
    <div class="brand">
      <h1>secrets</h1>
      <Nav current="none" />
    </div>

    <input class="search" type="search" placeholder="Search  ( / )" spellcheck="false" aria-label="Search credentials"
      autocomplete="off" autocapitalize="off" autocorrect="off"
      bind:this={searchBox} bind:value={query} oninput={onSearchInput} onkeydown={onSearchKeydown} data-testid="search" />

    <!-- One word for where the vault is being read from. Offline carries what is waiting to go. -->
    <div class="pillrow">
      <span class="pill {condition}" data-testid="vault-offline"
        title={`${PILL_WHY[condition] || ''}${localCopy ? ' These rows are this device\u2019s copy.' : ''}`}>{pill}</span>
      {#if condition === 'not-enrolled' && replica}
        <button class="link" data-testid="vault-enroll" disabled={offline || busy === 'enroll'}
          onclick={enrollDevice} title="Copy the vault to this browser so it works with the Mac down">
          {busy === 'enroll' ? 'Copying…' : 'Keep a copy'}
        </button>
      {/if}
    </div>

    <nav>
      <button class:on={scope.type === 'all'} onclick={() => go({ type: 'all' })}>
        All items<span class="count">{entries.filter((e) => !e.archived).length}</span>
      </button>
      {#each KINDS as kind (kind.id)}
        {@const n = entries.filter((e) => !e.archived && uiKind(e) === kind.id).length}
        {#if n}
          <button class:on={scope.type === 'kind' && scope.id === kind.id} onclick={() => go({ type: 'kind', id: kind.id })}>
            {kind.plural}<span class="count">{n}</span>
          </button>
        {/if}
      {/each}

      {#if groups.length}
        <p class="section">Groups</p>
        {#each groups as group (group)}
          <button class:on={scope.type === 'group' && scope.id === group} onclick={() => go({ type: 'group', id: group })}>
            <span class="grp">{group}</span><span class="count">{entries.filter((e) => !e.archived && (e.groups || []).includes(group)).length}</span>
          </button>
        {/each}
      {/if}

      <p class="section">Vault</p>
      <button class:on={scope.type === 'activity'} onclick={() => go({ type: 'activity' })}>Activity</button>
      <button class:on={scope.type === 'archived'} onclick={() => go({ type: 'archived' })}>
        Archived<span class="count">{entries.filter((e) => e.archived).length}</span>
      </button>
      <button class:on={scope.type === 'requests'} onclick={() => go({ type: 'requests' })}>
        Requests{#if requests.length}<span class="count badge">{requests.length}</span>{/if}
      </button>
      <button class:on={scope.type === 'import'} onclick={() => go({ type: 'import' })}>Import</button>
      <button class:on={scope.type === 'devices'} onclick={() => go({ type: 'devices' })} data-testid="devices-tab">
        Devices{#if devices.length}<span class="count">{devices.length}</span>{/if}
      </button>
    </nav>

    <div class="foot">
      <button class="new" data-testid="new-credential" onclick={() => startNew()}>
        New credential{#if newDirty}<span class="dot" title="You have an unsaved new credential" aria-label="unsaved draft"></span>{/if}
      </button>
      {#if status?.keyStorage === 'passphrase-wrapped'}
        <button class="link" onclick={() => protection('lock')} disabled={offline || locked}>
          {offline ? 'Lock needs the Mac' : locked ? 'Locked' : 'Lock now'}</button>
      {/if}
    </div>
  </aside>

  <main>
    {#if error}<p class="error" data-testid="secret-error">{error}</p>{/if}
    {#if notice}<p class="notice" data-testid="saved">{notice}</p>{/if}
    {#if sync.rejected}
      <!-- A change the Mac refused for good is kept on the device and said out loud; it is not
           retried and it is not silently dropped. -->
      <p class="error" data-testid="vault-rejected">The Mac refused {sync.rejected} change{sync.rejected === 1 ? '' : 's'} from this device. They are kept here and not retried.</p>
    {/if}
    {#if locked && localReadable}
      <div class="lockrow" data-testid="vault-locked-banner">
        <span>The vault is locked on the Mac. This is this device's copy.</span>
        <input type="password" placeholder="Passphrase" bind:value={passphrase} autocomplete="off" />
        <button class="secondary" disabled={offline || busy === 'protection' || passphrase.length < 12}
          onclick={() => protection('unlock')}>{busy === 'protection' ? 'Unlocking…' : 'Unlock'}</button>
        {#if offline}<span class="why small">Unlocking needs the Mac.</span>{/if}
      </div>
    {/if}

    {#if signedOut}
      <section class="pane">
        <h2>Signed out</h2>
        <p class="why">The page was served from the offline cache but the session has expired, so the vault refused every request. Sign in and it comes straight back.</p>
        <a class="primary" href="/login" data-testid="signin">Sign in</a>
      </section>

    {:else if sync.needsPassphrase}
      <section class="pane" data-testid="device-locked">
        <h2>Unlock this device's copy</h2>
        <p class="why">This device keeps its copy of the vault wrapped behind your vault passphrase. Type it here to read it; it is never stored, and this works with the Mac unreachable.</p>
        <input type="password" placeholder="Passphrase" bind:value={devicePassphrase} autocomplete="off" />
        <button class="primary" disabled={busy === 'device-unlock' || !devicePassphrase} onclick={unlockThisDevice}>
          {busy === 'device-unlock' ? 'Unlocking…' : 'Unlock'}
        </button>
      </section>

    {:else if locked && !localReadable}
      <section class="pane">
        <h2>Vault locked</h2>
        <p class="why">Your passphrase unwraps the master key for fifteen minutes. It is never stored.</p>
        <input type="password" placeholder="Passphrase" bind:value={passphrase} autocomplete="off" />
        <button class="primary" disabled={offline || busy === 'protection' || passphrase.length < 12} onclick={() => protection('unlock')}>
          {busy === 'protection' ? 'Unlocking…' : 'Unlock'}
        </button>
        {#if offline}<p class="why small" data-testid="online-only-unlock">Unlocking needs the Mac, and this device keeps no copy to read meanwhile.</p>{/if}
      </section>

    {:else if scope.type === 'requests'}
      <section class="pane">
        <h2>Service secret requests</h2>
        <p class="why">A connector needs a credential it cannot get for itself. What you type here goes straight to the keyring and never into chat.</p>
        {#if offline}<p class="why small" data-testid="online-only-requests">Requests need the Mac: they are raised there and the value is written there. This is the list as of the last time it answered.</p>{/if}
        {#each requests as request (request.id)}
          <div class="card" data-testid="request">
            <div class="head"><strong>{request.name}</strong>
              <button class="link" disabled={offline} onclick={() => dismiss(request)}>dismiss</button></div>
            {#if request.why}<p class="why">{request.why}</p>{/if}
            {#if request.exists}
              <label class="check"><input type="checkbox" bind:checked={replace[request.id]} data-testid="replace" /> Replace the existing one</label>
            {/if}
            {#each request.fields as f (f.key)}
              <label class="field"><span>{f.label}{f.optional ? ' (optional)' : ''}</span>
                {#if f.multiline}
                  <textarea rows="4" spellcheck="false" autocomplete="off" data-testid={`field-${f.key}`}
                    value={field(request.id)[f.key] || ''} oninput={(e) => type(request.id, f.key, e.currentTarget.value)}></textarea>
                {:else}
                  <input type="password" spellcheck="false" autocomplete="off" data-testid={`field-${f.key}`}
                    value={field(request.id)[f.key] || ''} oninput={(e) => type(request.id, f.key, e.currentTarget.value)} />
                {/if}
              </label>
            {/each}
            <button class="primary" data-testid="save" disabled={offline || busy === request.id || !ready(request)} onclick={() => fulfill(request)}>
              {busy === request.id ? 'Saving…' : 'Save to keyring'}
            </button>
          </div>
        {:else}
          <p class="empty">Nothing is waiting on you.</p>
        {/each}
      </section>

    {:else if scope.type === 'import'}
      <section class="pane">
        <h2>Import</h2>
        <p class="why">Chrome, Apple Passwords, Bitwarden and 1Password exports, including a real <code>.1pux</code> archive. Existing entries are left alone unless the import replaces them.</p>
        <label class="field"><span>Format</span>
          <select bind:value={importFormat}>
            <option value="chrome">Chrome CSV</option>
            <option value="apple">Apple Passwords CSV</option>
            <option value="bitwarden">Bitwarden JSON</option>
            <option value="bitwarden-csv">Bitwarden CSV</option>
            <option value="1password">1Password JSON</option>
            <option value="1password-csv">1Password CSV</option>
            <option value="1pux">1Password .1pux archive</option>
          </select>
        </label>
        {#if offline}<p class="why small" data-testid="online-only-import">Importing needs the Mac: the parsers run there and the files are too big to carry. Everything else on this page works from this device's copy.</p>{/if}
        <input type="file" disabled={offline} bind:this={importInput} onchange={(e) => (importFile = e.currentTarget.files?.[0] || null)} />
        <button class="primary" disabled={offline || !importFile || busy === 'import'} onclick={runImport}>
          {busy === 'import' ? 'Importing…' : 'Import'}
        </button>
      </section>

    {:else if scope.type === 'devices'}
      <section class="pane">
        <h2>Devices</h2>
        <p class="why">Each enrolled device keeps a full encrypted copy of the vault, so this page lists, searches, reveals and accepts changes with the Mac unreachable. Anyone who can unlock the device and open the page can read every credential, so enrol only devices you would trust with the Mac.</p>
        {#if condition === 'not-enrolled'}
          <button class="primary" data-testid="vault-enroll-pane" disabled={offline || busy === 'enroll'} onclick={enrollDevice}>
            {busy === 'enroll' ? 'Copying…' : 'Keep a copy on this device'}
          </button>
          {#if offline}<p class="why small" data-testid="online-only-enroll">Enrolling needs the Mac, because the key it hands out is minted there.</p>{/if}
        {:else}
          <p class="why small" data-testid="device-self">This device holds {sync.entries} credential{sync.entries === 1 ? '' : 's'}{sync.lastSync ? `, last synced ${when(sync.lastSync)}` : ''}.</p>
          <button class="link danger" data-testid="vault-forget-device" onclick={forgetThisDevice}>Stop keeping a copy here</button>
        {/if}
        {#each devices as device (device.deviceId)}
          <div class="card" data-testid="device">
            <div class="head">
              <strong>{device.label || device.deviceId}{#if device.deviceId === sync.deviceId} · this one{/if}</strong>
              <button class="link danger" data-testid="revoke" onclick={() => revokeDevice(device)}
                disabled={offline || Boolean(device.revokedAt) || busy === `revoke:${device.deviceId}`}>
                {device.revokedAt ? 'revoked' : busy === `revoke:${device.deviceId}` ? 'revoking…' : 'revoke'}
              </button>
            </div>
            <p class="why small">Added {when(device.createdAt)}{device.lastSeen ? ` · last seen ${when(device.lastSeen)}` : ''}</p>
          </div>
        {:else}
          <p class="empty">No device keeps a copy yet.</p>
        {/each}
        {#if offline}<p class="why small" data-testid="online-only-devices">Enrolling and revoking need the Mac. Revoking stops future syncs; it does not reach back into what a device already holds.</p>{/if}
      </section>

    {:else if scope.type === 'activity'}
      <section class="pane">
        <h2>Activity</h2>
        <p class="why">Every change to the vault, newest first. The log holds no values, only what changed.</p>
        {#each history as event (event.revision + event.id + event.action)}
          <div class="event">
            <span class="at">{when(event.at)}</span>
            <span class="action {event.action}">{event.action}</span>
            <button class="link name" onclick={() => { const e = entries.find((x) => x.id === event.id); if (e) select(e); }}>
              {event.name || event.id}
            </button>
            {#if event.action === 'grouped'}<span class="why">{(event.from || []).join(', ') || 'none'} → {(event.to || []).join(', ') || 'none'}</span>{/if}
          </div>
        {:else}
          <p class="empty">No changes recorded yet.</p>
        {/each}
      </section>

    {:else}
      {#if requests.length}
        <p class="notice" data-testid="requests-banner">{requests.length} service secret request{requests.length === 1 ? '' : 's'} waiting.
          <button class="link" onclick={() => go({ type: 'requests' })}>Review</button></p>
      {/if}
      <div class="split">
        <div class="listcol">
          <div class="listhead">
            <span class="why small" data-testid="list-count">{shown.length}{query.trim() || scoped.length !== shown.length ? ` of ${scoped.length}` : ''}</span>
            <button class="link" data-testid="new-in-list" onclick={() => startNew()}>+ New</button>
          </div>
          <ul class="list" data-testid="entries">
            {#if newDirty}
              <li>
                <button class:on={mode === 'new'} onclick={() => startNew()} data-testid="entry-draft-new">
                  <span class="title">{derivedName(peekBox(DRAFT_KEY_NEW).data) || 'New credential'}</span>
                  <span class="sub">Unsaved new {(KIND_BY_ID[peekBox(DRAFT_KEY_NEW).data.kind]?.label || 'credential').toLowerCase()}</span>
                  <span class="tag warn">draft</span>
                </button>
              </li>
            {/if}
            {#each shown as entry (entry.id)}
              <li>
                <button class:on={entry.id === selectedId && mode !== 'new'} onclick={() => select(entry)} data-testid="entry">
                  <span class="title">{entry.name}</span>
                  <span class="sub">{subtitle(entry)}</span>
                  {#if dirtyForms.has(editKey(entry.id))}<span class="tag warn">unsaved edit</span>{/if}
                  {#if entry.archived}<span class="tag">archived</span>{/if}
                  {#if uiKind(entry) === 'oauth' && expired(entry)}<span class="tag warn">expired</span>{/if}
                </button>
              </li>
            {:else}
              {#if !newDirty}
                <li class="empty">
                  {#if query.trim()}Nothing matches “{query}”. <button class="link" onclick={() => (query = '')}>Clear search</button>
                  {:else if scope.type === 'archived'}Nothing is archived.
                  {:else}Nothing here yet. <button class="link" onclick={() => startNew()}>Add a credential</button>{/if}
                </li>
              {/if}
            {/each}
          </ul>
        </div>

        <section class="detail" data-testid="detail">
          {#if mode === 'new' || (mode === 'edit' && selected)}
            <SecretForm bind:this={formRef} draft={formBox} {mode}
              title={mode === 'edit' ? `Edit ${selected.name}` : 'New credential'}
              errors={formErrors} warnings={formWarnings} busy={busy === 'save'} dirty={formBox.dirty}
              onsave={saveForm} onclose={closeForm} ondiscard={discardForm} />
          {:else if !selected}
            <p class="empty">Select a credential, or <button class="link" onclick={() => startNew()}>add a new one</button>.</p>
          {:else}
            <header class="dhead">
              <div>
                <h2>{selected.name}</h2>
                <p class="why">{kindName(selected)} · {selected.id}</p>
              </div>
            </header>

            {#each selected.origins || [] as origin (origin)}
              <p class="row"><span class="label">Website</span><a href={origin} rel="noreferrer noopener" target="_blank">{origin}</a></p>
            {/each}
            {#if selected.kind === 'oauth'}
              {#if selected.issuer}<p class="row"><span class="label">Issuer</span>{selected.issuer}</p>{/if}
              <p class="row"><span class="label">Account</span>{selected.account}</p>
              <p class="row"><span class="label">Scopes</span>{(selected.scopes || []).join(' ') || 'none recorded'}</p>
              <p class="row"><span class="label">Expires</span>{selected.expiresAt || 'no expiry'}
                {#if expired(selected)}<span class="tag warn">expired</span>{/if}</p>
              <p class="row"><span class="label">Refresh</span>{selected.hasRefreshToken ? 'stored' : 'none'}</p>
            {/if}
            {#if selected.kind === 'recovery-codes'}
              <p class="row"><span class="label">Unused</span>{selected.remaining ?? 0}</p>
            {/if}
            <p class="row"><span class="label">Updated</span>{when(selected.updatedAt)}</p>

            <div class="row">
              <span class="label">Groups</span>
              {#if editingGroups}
                <input type="text" bind:value={groupDraft} />
                <button class="secondary" onclick={() => commitGroups(selected)}>Save</button>
                <button class="link" onclick={() => (editingGroups = false)}>cancel</button>
              {:else}
                <span>{visibleGroups(selected.groups).join(', ') || 'none'}</span>
                <button class="link" onclick={() => startGroups(selected)}>edit</button>
              {/if}
            </div>

            <div class="value" data-testid="value">
              {#if revealed?.id === selected.id}
                {#each describeRevealed(selected, revealed) as item (item.label + item.value)}
                  {#if item.block}
                    <div class="valblock"><span class="label">{item.label}</span>
                      <pre class="secret" data-secret>{item.value}</pre>
                      {#if item.copy}<button class="link" onclick={() => copy(item.value)}>copy</button>{/if}</div>
                  {:else}
                    <p class="row"><span class="label">{item.label}</span>
                      {#if item.secret}<code class="secret" class:big={item.big} data-secret>{item.value}</code>{:else}<code>{item.value}</code>{/if}
                      {#if item.copy}<button class="link" onclick={() => copy(item.value)}>copy</button>{/if}</p>
                  {/if}
                {/each}
                <button class="link" onclick={() => (revealed = null)}>hide</button>
              {:else}
                <div class="masked-row">
                  <span class="mask" aria-hidden="true">{uiKind(selected) === 'card' ? '•••• •••• •••• ••••' : '••••••••••••'}</span>
                  <button class="secondary" data-testid="reveal" disabled={busy === `reveal:${selected.id}`} onclick={() => reveal(selected)}>
                    {busy === `reveal:${selected.id}` ? 'Reading…' : selected.kind === 'totp' ? 'Show code' : 'Show'}
                  </button>
                </div>
              {/if}
            </div>

            <div class="row actions">
              {#if canEdit(selected)}
                <button class="secondary" data-testid="edit" disabled={busy === `edit:${selected.id}`} onclick={() => startEdit(selected)}>
                  {dirtyForms.has(editKey(selected.id)) ? 'Resume editing' : busy === `edit:${selected.id}` ? 'Opening…' : 'Edit'}
                </button>
              {/if}
              <button class="secondary" onclick={() => act({ action: 'archive', id: selected.id, archived: !selected.archived }, 'Could not archive.')}>
                {selected.archived ? 'Unarchive' : 'Archive'}
              </button>
              {#if confirmDelete}
                <span class="confirm" role="alert">Delete {selected.name} for good?
                  <button class="link danger" data-testid="delete-yes" onclick={() => forget(selected)}>Delete</button>
                  <button class="link" onclick={() => (confirmDelete = false)}>Keep</button></span>
              {:else}
                <button class="link danger" data-testid="delete" onclick={() => (confirmDelete = true)}>Delete</button>
              {/if}
            </div>

            <h3>History</h3>
            {#each entryHistory as event (event.revision + event.action)}
              <div class="event">
                <span class="at">{when(event.at)}</span>
                <span class="action {event.action}">{event.action}</span>
                {#if event.action === 'grouped'}<span class="why">{(event.from || []).join(', ') || 'none'} → {(event.to || []).join(', ') || 'none'}</span>{/if}
              </div>
            {:else}
              <p class="empty">No recorded changes.</p>
            {/each}
          {/if}
        </section>
      </div>
    {/if}
  </main>
</div>

<style>
  .app { display: grid; grid-template-columns: 248px minmax(0, 1fr); height: 100vh; height: 100dvh; overflow: hidden; }
  aside {
    border-right: 1px solid var(--line); background: var(--bg-sunken);
    display: flex; flex-direction: column; gap: 10px; padding: 16px 12px; overflow-y: auto;
  }
  /* The title and the section pill are two rows. They shared one row, and "secrets" pushed the pill past the sidebar's edge, where the
     list column painted over it and it could not be clicked (2026-11-18). */
  .brand { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-width: 0; }
  .brand :global(.pill) { max-width: 100%; }
  h1 { font-size: 17px; margin: 0; font-weight: 600; }
  h2 { font-size: 15px; margin: 0; font-weight: 600; }
  h3 { font-size: 12px; margin: 14px 0 2px; font-weight: 600; color: var(--ink-faint); text-transform: uppercase; letter-spacing: .04em; }
  .search {
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 8px;
    padding: 7px 10px; color: var(--ink); font-size: 13.5px; outline: none; width: 100%; box-sizing: border-box;
  }
  .search:focus { border-color: var(--accent); }
  nav { display: flex; flex-direction: column; gap: 1px; }
  nav button, .foot .new {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    text-align: left; padding: 6px 9px; border-radius: 7px; font-size: 13.5px;
    color: var(--ink-dim); background: none; border: none; cursor: pointer; width: 100%;
  }
  nav button:hover { background: var(--bg-raised); color: var(--ink); }
  nav button.on { background: var(--accent); color: #14100d; font-weight: 600; }
  .count { font-size: 11.5px; opacity: .7; font-variant-numeric: tabular-nums; }
  .badge { background: var(--warn); color: #14100d; border-radius: 999px; padding: 0 6px; opacity: 1; font-weight: 600; }
  .section { margin: 10px 0 2px; padding: 0 9px; font-size: 11px; text-transform: uppercase;
    letter-spacing: .05em; color: var(--ink-faint); }
  .foot { margin-top: auto; display: flex; flex-direction: column; gap: 6px; padding-top: 10px; }
  .foot .new { justify-content: center; border: 1px solid var(--line); background: var(--bg-raised); color: var(--ink); }

  main { overflow: hidden; display: flex; flex-direction: column; padding: 0; min-width: 0; }
  .split { display: grid; grid-template-columns: minmax(220px, 320px) minmax(0, 1fr); flex: 1; min-height: 0; overflow: hidden; }
  .listcol { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }
  .listhead { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px 0; }
  .list { list-style: none; margin: 0; padding: 8px; overflow-y: auto; flex: 1; min-height: 0; }
  .list li { margin: 0; }
  .list button {
    display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
    width: 100%; text-align: left; padding: 8px 10px; border-radius: 8px;
    background: none; border: none; cursor: pointer; color: var(--ink);
  }
  .list button:hover { background: var(--bg-raised); }
  .list button.on { background: var(--accent); color: #14100d; }
  .title { font-size: 13.5px; font-weight: 500; overflow-wrap: anywhere; }
  .grp { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); display: inline-block; margin-left: 8px; }
  .masked-row { display: flex; align-items: center; gap: 12px; }
  .mask { font-family: var(--mono, ui-monospace, monospace); color: var(--ink-faint); letter-spacing: .08em; }
  .valblock { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; width: 100%; }
  .confirm { font-size: 12.5px; color: var(--ink-dim); display: inline-flex; gap: 8px; align-items: baseline; }
  .sub { font-size: 12px; opacity: .65; overflow-wrap: anywhere; }
  .tag { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  .tag.warn { color: var(--warn); opacity: 1; }

  .detail, .pane { padding: 20px 24px 60px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  .pane { max-width: 560px; }
  .dhead { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  .row { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 13.5px; flex-wrap: wrap; }
  .label { font-size: 12px; color: var(--ink-faint); min-width: 74px; }
  .value { margin: 10px 0; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .secret { font-family: var(--mono, ui-monospace, monospace); background: var(--bg-sunken);
    border: 1px solid var(--line); border-radius: 7px; padding: 5px 9px; overflow-wrap: anywhere; }
  .secret.big { font-size: 22px; letter-spacing: .12em; }
  pre.secret { margin: 0; white-space: pre-wrap; width: 100%; box-sizing: border-box; }
  .actions { margin-top: 6px; }

  .event { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px; color: var(--ink-dim); padding: 3px 0; }
  .at { color: var(--ink-faint); font-variant-numeric: tabular-nums; min-width: 56px; }
  .action { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; min-width: 72px; }
  .action.forgotten, .action.replaced { color: var(--warn); }
  .event .name { color: var(--ink); }

  .card { background: var(--bg-raised); border: 1px solid var(--line); border-radius: 12px;
    padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field span { font-size: 12px; color: var(--ink-faint); }
  .check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-dim); }
  input[type='text'], input[type='password'], input[type='search'], textarea, select {
    background: var(--bg-sunken); border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 10px; color: var(--ink); font-size: 14px; outline: none;
    font-family: var(--mono, ui-monospace, monospace); width: 100%; box-sizing: border-box; resize: vertical;
  }
  .primary { background: var(--accent); color: #14100d; border-radius: 9px; padding: 9px 15px;
    font-size: 13.5px; font-weight: 600; border: none; cursor: pointer; align-self: flex-start; }
  .primary:disabled { background: var(--line); color: var(--ink-faint); }
  a.primary { text-decoration: none; display: inline-block; }
  .why.small { font-size: 12px; color: var(--ink-faint); }
  .secondary { border: 1px solid var(--line); border-radius: 8px; padding: 7px 12px; font-size: 13px;
    background: var(--bg-raised); color: var(--ink); cursor: pointer; }
  .secondary:disabled { opacity: .5; }
  .link { color: var(--ink-faint); font-size: 12.5px; background: none; border: none; cursor: pointer; padding: 0; }
  .link:hover { color: var(--ink-dim); }
  .link.danger:hover { color: var(--warn); }
  .why, .empty { margin: 0; color: var(--ink-dim); font-size: 13px; line-height: 1.5; }
  .empty { color: var(--ink-faint); padding: 10px; }
  .pillrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .pill { font-size: 11px; letter-spacing: .02em; color: var(--ink-faint); user-select: none;
    border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; }
  .pill.offline, .pill.revoked, .pill.locked, .pill.signed-out { color: var(--warn); border-color: var(--warn); }
  .lockrow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px;
    color: var(--ink-dim); margin: 10px 24px 0; }
  .lockrow input { width: auto; flex: 0 1 220px; }
  .error { color: var(--warn); font-size: 13px; margin: 10px 24px 0; }
  .notice { color: var(--ink-dim); font-size: 13px; margin: 10px 24px 0; }
  code { font-family: var(--mono, ui-monospace, monospace); font-size: 12.5px; }
  a { color: var(--accent); }

  @media (max-width: 860px) {
    .app { grid-template-columns: minmax(0, 1fr); height: auto; overflow: visible; }
    aside { border-right: none; border-bottom: 1px solid var(--line); overflow: visible; }
    nav { flex-direction: row; flex-wrap: wrap; gap: 4px; }
    nav button { width: auto; }
    .section { width: 100%; margin: 6px 0 0; }
    .foot { margin-top: 0; }
    main { overflow: visible; }
    .split { grid-template-columns: minmax(0, 1fr); overflow: visible; }
    .listcol { border-right: none; border-bottom: 1px solid var(--line); }
    .list { max-height: 38vh; }
    .detail, .pane { padding: 16px 14px 48px; overflow: visible; }
    .error, .notice, .lockrow { margin-left: 14px; margin-right: 14px; }
  }
</style>
