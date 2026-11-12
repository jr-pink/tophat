// Client side of the extension slots: fetch the contributions once per page (kept in ext-state.js, on disk for offline),
// and run a command by name with an intent id minted once per press (EXTENSIONS-V1 section 7: one command = one action).
import { extDecl } from '$lib/core/ext-state.js';
import { uiApp } from '$lib/client/ui-app.js';
import { createDeadlineFetch } from '../../../../runner/tools/docstore-kit/lib/engine/deadline.js';

const net = createDeadlineFetch();

let loading = null;

export function extStore() { return uiApp().use(extDecl); }

/** Refresh the contributions from the server; offline or an old server leaves the stored ones. */
export function refreshContributions(fetcher = (url, init) => net.fetchWithin('read', url, init)) {
  if (loading) return loading;
  loading = fetcher('/api/ext/contributions', { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => { if (body) extStore().dispatch('contributions.set', { menus: body.menus, commands: body.commands }); })
    .catch(() => {})
    .finally(() => { loading = null; });
  return loading;
}

const mint = () => `cmd-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('')}`;

/** Run a command (an extension's own or a core action a menu item names). Resolves to the server's answer. */
// v1 sends the press straight to the server (idempotent by `id`); a press made offline is not queued yet: the gap is in
// EXTENSIONS-V1 section 13 (a command should be a dispatch on a cloud-scope declaration, so the kit's outbox carries it).
export async function runExtCommand(command, args = {}, { fetcher = (url, init) => net.fetchWithin('send', url, init), id = mint() } = {}) {
  const r = await fetcher('/api/ext/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, args, id }) });
  const body = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  return body;
}
