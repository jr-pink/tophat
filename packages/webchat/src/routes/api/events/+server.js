import { app } from '$lib/server/app.js';
import { eventStream } from '$lib/server/sse.js';
import { scopeContext, scopedStore } from '$lib/server/scope-guard.js';

export function GET(event) {
  const { url } = event;
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
