import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { scopeContext } from '$lib/server/scope-guard.js';

export async function GET(event) {
  const { url } = event;
  const ctx = scopeContext(event, app.store, app.runner);
  const query = url.searchParams.get('q') || '';
  const mode = url.searchParams.get('mode') === 'smart' ? 'smart' : 'exact';
  const scope = url.searchParams.get('conversation');
  let results = await (app.store.searchAsync ? app.store.searchAsync(query, { mode, limit: 60 }) : app.store.search(query, { mode, limit: 60 }));
  if (scope) results = results.filter((result) => result.conversationId === scope);
  // Only chats in scopes this account may open; the snippet of any other chat never leaves.
  if (ctx.enabled) results = results.filter((result) => ctx.service.canSee(ctx.identity, app.store.conversation(result.conversationId)));
  return json({ query, mode, expanded: mode === 'smart' ? await (app.store.expandAsync ? app.store.expandAsync(query) : app.store.expand(query)) : [], results },
    { headers: { 'cache-control': 'no-store' } });
}
