import { json } from '@sveltejs/kit';
import { app, CAPABILITIES, busyConversations, liveConversations, sidebarSnapshot } from '$lib/server/app.js';
import { filterEvents, filterRows, scopeContext } from '$lib/server/scope-guard.js';
import { liveFor } from '$lib/server/scope-routes.js';
import { peerCaller } from '$lib/server/peer-actions.js';

export async function GET(event) {
  const { url } = event;
  // A peer host catching one chat up by cursor (peer-actions.js): that chat's events after `after`, and whether the host's run is busy.
  const { peer, refused } = await peerCaller(event);
  if (refused) return json({ error: 'not found' }, { status: 404 });
  if (peer) {
    const id = String(url.searchParams.get('conversation') || '');
    if (!app.store.conversation(id)) return json({ error: `no conversation ${id}` }, { status: 404 });
    const limit = 2000;
    const events = app.store.conversationEvents(id, { after: Math.max(0, Number(url.searchParams.get('after') || 0)), limit });
    return json({ events, truncated: events.length >= limit, cursor: app.store.cursor(), busy: app.runner.isBusy(id), phase: app.runner.phase(id) }, { headers: { 'cache-control': 'no-store' } });
  }
  const ctx = scopeContext(event, app.store, app.runner);
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  const LIMIT = 2000;
  const raw = app.store.since(after, LIMIT);
  const events = filterEvents(ctx, app.store, raw);
  
  
  
  
  
  
  const sidebar = sidebarSnapshot();
  if (ctx.enabled) sidebar.rows = filterRows(ctx, sidebar.rows);
  return json({ events, truncated: raw.length >= LIMIT, cursor: app.store.cursor(), sidebar, live: liveFor(ctx, liveConversations()), busy: liveFor(ctx, busyConversations()), capabilities: CAPABILITIES }, { headers: { 'cache-control': 'no-store' } });
}
