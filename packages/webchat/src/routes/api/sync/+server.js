import { json } from '@sveltejs/kit';
import { app, CAPABILITIES, busyConversations, liveConversations, sidebarSnapshot } from '$lib/server/app.js';
import { filterEvents, filterRows, scopeContext } from '$lib/server/scope-guard.js';
import { liveFor } from '$lib/server/scope-routes.js';

export function GET(event) {
  const { url } = event;
  const ctx = scopeContext(event, app.store, app.runner);
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  const LIMIT = 2000;
  const raw = app.store.since(after, LIMIT);
  const events = filterEvents(ctx, app.store, raw);
  
  
  
  
  
  
  const sidebar = sidebarSnapshot();
  if (ctx.enabled) sidebar.rows = filterRows(ctx, sidebar.rows);
  return json({ events, truncated: raw.length >= LIMIT, cursor: app.store.cursor(), sidebar, live: liveFor(ctx, liveConversations()), busy: liveFor(ctx, busyConversations()), capabilities: CAPABILITIES }, { headers: { 'cache-control': 'no-store' } });
}
