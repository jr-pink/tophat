import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { scopeContext } from '$lib/server/scope-guard.js';
import { DEFAULT_SCOPE_RULES } from '$lib/core/scopes.js';

// The caller's account, the scopes it may open, its sending rules and whether the router is on.
// With scopes off the answer is `{ enabled: false }` and the page shows no dropdown.
export function GET(event) {
  const ctx = scopeContext(event, app.store, app.runner);
  if (!ctx.enabled) return json({ enabled: false }, { headers: { 'cache-control': 'no-store' } });
  const me = ctx.service.contextFor(ctx.identity);
  if (!me?.account) return json({ enabled: true, account: null, scopes: [] }, { status: 403, headers: { 'cache-control': 'no-store' } });
  return json({
    enabled: true,
    account: me.account,
    name: me.name,
    personalScope: me.personalScope,
    defaultScope: ctx.service.defaultScope,
    scopes: me.scopes,
    router: { enabled: Boolean(ctx.service.config.router?.enabled) },
    rules: { ...ctx.service.rulesFor(ctx.identity), default: DEFAULT_SCOPE_RULES }
  }, { headers: { 'cache-control': 'no-store' } });
}
