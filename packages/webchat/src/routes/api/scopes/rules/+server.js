import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { scopeContext } from '$lib/server/scope-guard.js';
import { ScopeError } from '$lib/server/scopes.js';

// The account's own scope sending rules, as the router reads them. Writing nothing restores the default.
export async function PUT(event) {
  const ctx = scopeContext(event, app.store, app.runner);
  if (!ctx.enabled) error(404, 'Scopes are not enabled');
  const body = await event.request.json().catch(() => ({}));
  try {
    return json(ctx.service.setRules(ctx.identity, body.prompt), { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof ScopeError) return json({ error: cause.message, code: cause.code }, { status: cause.status });
    throw cause;
  }
}
