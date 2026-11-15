import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { eventStream } from '$lib/server/sse.js';
import { conversationEventStream, SSE_HEADERS } from '$lib/server/conversation-stream.js';
import { peerCaller } from '$lib/server/peer-actions.js';
import { scopeContext, scopedStore } from '$lib/server/scope-guard.js';

export async function GET(event) {
  const { url } = event;
  // A peer host attaching a chat that runs here reads that one chat's feed in the app's own frames (peer-actions.js), resumable by cursor.
  const { peer, refused } = await peerCaller(event);
  if (refused) return json({ error: 'not found' }, { status: 404 });
  if (peer) {
    const id = String(url.searchParams.get('conversation') || '');
    if (!app.store.conversation(id)) return json({ error: `no conversation ${id}` }, { status: 404 });
    const { stream } = conversationEventStream({ store: app.store, id, after: url.searchParams.get('after') });
    return new Response(stream, { headers: SSE_HEADERS });
  }
  const store = scopedStore(scopeContext(event, app.store, app.runner), app.store);
  // tail=1: from the head as it stands now (a cold boot opens the stream while its first snapshot loads; client/session.js holds what arrives)
  const after = url.searchParams.get('tail') === '1' ? app.store.cursor() : Math.max(0, Number(url.searchParams.get('after') || 0));
  const { stream } = eventStream({ store, after });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
}
