import { app } from '$lib/server/app.js';
import { eventStream } from '$lib/server/sse.js';
import { scopeContext, scopedStore } from '$lib/server/scope-guard.js';

export function GET(event) {
  const { url } = event;
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  const { stream } = eventStream({ store: scopedStore(scopeContext(event, app.store, app.runner), app.store), after });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
}
