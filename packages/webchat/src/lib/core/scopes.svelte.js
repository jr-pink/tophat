// What the page knows about scopes: whether they are on, which the account may open, its sending
// rules. Fetched once from /api/scopes and kept on the device so the dropdown renders offline.

import { LEGACY_SCOPE } from './scopes.js';
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { set } from '../../../../runner/tools/docstore-kit/lib/schema.js';
import { cache } from '../../../../runner/tools/docstore-kit/lib/recipes.js';
import { uiApp } from '../client/ui-app.js';

// The last /api/scopes answer, kept on the device for the offline paint: kit state, hydrated synchronously. The old
// `tophat-scopes-v1` key is imported once, then archived.
export const scopesDecl = declare({
  name: 'scopes',
  scope: 'local',
  fields: { cache: cache() },
  legacy: [{ key: 'tophat-scopes-v1', json: true, into: 'cache', archive: true }],
  actions: { 'cache.set': set('cache', 'body') }
});
const scopesCache = () => { try { return uiApp().use(scopesDecl); } catch { return null; } };

const first = scopesCache()?.get().cache;
export const scopeState = $state({
  enabled: Boolean(first?.enabled),
  account: first?.account ?? null,
  personalScope: first?.personalScope ?? null,
  scopes: first?.scopes ?? [],
  router: first?.router ?? { enabled: false },
  rules: first?.rules ?? null,
  loaded: false
});

let inFlight = null;

export function ensureScopes(fetchImpl = globalThis.fetch, { force = false } = {}) {
  if ((scopeState.loaded && !force) || inFlight) return inFlight;
  if (typeof fetchImpl !== 'function') return null;
  inFlight = fetchImpl('/api/scopes', { headers: { accept: 'application/json' } })
    .then((r) => (r.ok || r.status === 403 ? r.json() : null))
    .then((body) => {
      if (!body) return;
      scopeState.enabled = Boolean(body.enabled);
      scopeState.account = body.account ?? null;
      scopeState.personalScope = body.personalScope ?? null;
      scopeState.scopes = body.scopes ?? [];
      scopeState.router = body.router ?? { enabled: false };
      scopeState.rules = body.rules ?? null;
      scopesCache()?.dispatch('cache.set', { body: { ...body } });
    })
    .catch(() => { /* offline: the cached list stays */ })
    .finally(() => { scopeState.loaded = true; inFlight = null; });
  return inFlight;
}

/** The scope a chat created now goes into: the focused chat's own scope when the account may still open it. */
export function scopeForNewChat(focusedScope) {
  if (!scopeState.enabled) return null;
  if (focusedScope && scopeState.scopes.some((s) => s.id === focusedScope)) return focusedScope;
  return scopeState.personalScope || scopeState.scopes[0]?.id || LEGACY_SCOPE;
}

export async function saveRules(prompt, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('/api/scopes/rules', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt })
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `rules ${response.status}`);
  const body = await response.json();
  scopeState.rules = { ...(scopeState.rules || {}), ...body };
  return body;
}
