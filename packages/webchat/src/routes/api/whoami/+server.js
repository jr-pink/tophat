import { json } from '@sveltejs/kit';

// The account behind this request when scopes are on (config scopes.enabled): its email, account
// id, personal scope and the scope ids it may open. With scopes off there is one owner and no
// account, so the answer is { scoped: false }. hooks.server.js sets locals.scopeContext.
export function GET({ locals }) {
  const ctx = locals.scopeContext;
  return json(ctx ? { scoped: true, ...ctx } : { scoped: false }, { headers: { 'cache-control': 'no-store' } });
}
