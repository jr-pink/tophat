import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { requireChat, scopeContext } from '$lib/server/scope-guard.js';
import { conversationWindow } from '$lib/core/conversation-window.js';

// One page of a chat's transcript.
export function GET(event) {
  const { params, url } = event;
  const conversation = app.store.conversation(params.id);
  if (!conversation) error(404, 'Unknown conversation');
  requireChat(scopeContext(event, app.store, app.runner), conversation);
  const events = app.store.conversationEvents(params.id, conversationWindow(url));
  return json({ conversation, events }, { headers: { 'cache-control': 'no-store' } });
}
