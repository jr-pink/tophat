import { json, error } from '@sveltejs/kit';
import { incognito } from '$lib/server/incognito.js';
import { conversationWindow } from '$lib/core/conversation-window.js';

// One page of an incognito chat's transcript, out of the in-memory store
// (src/lib/server/incognito.js). The window is the same rule the durable route uses, read from the
// one place that states it.
export async function GET({ params, url }) {
  const found = (await incognito()).conversation(params.id, conversationWindow(url));
  if (!found) error(404, 'Unknown conversation');
  return json(found, { headers: { 'cache-control': 'no-store' } });
}
