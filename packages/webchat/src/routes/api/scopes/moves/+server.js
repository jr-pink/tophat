import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { requireChat, scopeContext } from '$lib/server/scope-guard.js';

// The move log for one chat: who moved it (the owner or the router), between which scopes, each step.
export function GET(event) {
  const ctx = scopeContext(event, app.store, app.runner);
  if (!ctx.enabled) error(404, 'Scopes are not enabled');
  const id = event.url.searchParams.get('conversation') || '';
  requireChat(ctx, app.store.conversation(id));
  return json({ moves: app.store.scopeMoves(id) }, { headers: { 'cache-control': 'no-store' } });
}
