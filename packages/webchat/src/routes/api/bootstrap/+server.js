import { json } from '@sveltejs/kit';
import { app, CAPABILITIES, liveConversations, sidebarSnapshot } from '$lib/server/app.js';
import { filterEvents, filterRows, scopeContext } from '$lib/server/scope-guard.js';
import { liveFor } from '$lib/server/scope-routes.js';

export function GET(event) {
  const { url } = event;
  const ctx = scopeContext(event, app.store, app.runner);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') || 31)));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const payload = app.store.recent({ since, hydrate: Number(url.searchParams.get('hydrate') || 12) });
  const sidebar = sidebarSnapshot({ since });
  if (ctx.enabled) {
    // Hydration reads the newest chats first; with scopes on, only the ones this account may open.
    payload.conversations = filterRows(ctx, payload.conversations);
    payload.events = filterEvents(ctx, app.store, payload.events).filter((e) => !e.content?.revoked);
    sidebar.rows = filterRows(ctx, sidebar.rows);
  }
  return json({ ...payload, sidebar, live: liveFor(ctx, liveConversations()), capabilities: CAPABILITIES, ...(ctx.enabled ? { scopes: ctx.service.contextFor(ctx.identity) } : {}) }, { headers: { 'cache-control': 'no-store' } });
}
