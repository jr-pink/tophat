import { incognito } from '$lib/server/incognito.js';
import { eventStream } from '$lib/server/sse.js';

// One tab's incognito chats as an event stream: the /api/events stream over the in-memory store, filtered to the
// chats whose id carries this tab's key. While it is open the tab counts as present and its chats are kept.
export async function GET({ url }) {
  const tab = url.searchParams.get('tab') || '';
  if (!/^[0-9a-f]{8,32}$/.test(tab)) return new Response('tab required', { status: 400 });
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  const { stream } = eventStream({ store: (await incognito()).streamStore(tab), after });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' }
  });
}
