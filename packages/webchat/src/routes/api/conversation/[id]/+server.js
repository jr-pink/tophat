import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { requireChat, scopeContext } from '$lib/server/scope-guard.js';

const MAX_LIMIT = 20000;
const DEFAULT_LIMIT = 20000;

const bounded = (raw, fallback) => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), MAX_LIMIT);
};


export function GET(event) {
  const { params, url } = event;
  const conversation = app.store.conversation(params.id);
  if (!conversation) error(404, 'Unknown conversation');
  requireChat(scopeContext(event, app.store, app.runner), conversation);
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  const limit = bounded(url.searchParams.get('limit'), DEFAULT_LIMIT);
  
  
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam == null ? null : Math.max(0, Number(beforeParam) || 0);
  const newest = url.searchParams.get('newest') === '1' || before != null;
  const events = app.store.conversationEvents(params.id, { after, before, limit, newest });
  return json({ conversation, events }, { headers: { 'cache-control': 'no-store' } });
}
