import { json } from '@sveltejs/kit';
import { isIncognito } from '$lib/core/incognito.js';
import { incognito } from '$lib/server/incognito.js';

// Ends incognito chats now: { ids: [...] } for named chats, { tab } for every chat of a tab that is going away.
// Sent with navigator.sendBeacon on pagehide, so the body may arrive as text/plain.
export async function POST({ request }) {
  let body = {};
  try { body = JSON.parse(await request.text() || '{}'); } catch { return json({ error: 'not JSON' }, { status: 400 }); }
  const inc = await incognito();
  const discarded = [];
  for (const id of Array.isArray(body.ids) ? body.ids : []) if (isIncognito(id) && inc.discard(id)) discarded.push(id);
  if (typeof body.tab === 'string' && /^[0-9a-f]{8,32}$/.test(body.tab)) discarded.push(...inc.discardTab(body.tab));
  return json({ discarded }, { headers: { 'cache-control': 'no-store' } });
}
