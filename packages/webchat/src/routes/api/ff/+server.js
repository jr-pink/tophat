import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { settleSafely } from '$lib/server/ff.js';

const SUFFIX = '[Sent from fire-and-forget: User is asleep and will not read a reply. Handle it. Do not ask a clarifying question; make the most reasonable call, do the work, and say what you assumed. If it genuinely cannot be done without him, leave it in knowledge/memory/todos.md rather than waiting.]';

export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || '').trim();
  if (!text) return json({ error: 'Nothing to send' }, { status: 400 });

  const id = app.store.ffAccept(text);
  settleSafely(id, { text, wire: `${text}\n\n${SUFFIX}`, automated: false });
  return json({ id }, { headers: { 'cache-control': 'no-store' } });
}

export async function GET({ url }) {
  const since = url.searchParams.get('since') || new Date(Date.now() - 7 * 86_400_000).toISOString();
  return json({ messages: app.store.ffSince(since) }, { headers: { 'cache-control': 'no-store' } });
}
