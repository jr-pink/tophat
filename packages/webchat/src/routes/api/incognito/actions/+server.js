import { json } from '@sveltejs/kit';
import { incognito } from '$lib/server/incognito.js';

// An incognito chat's actions: the same contract as /api/actions, applied to the in-memory store and runner.
export async function POST({ request }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid action: not JSON' }, { status: 400 }); }
  const [status, answer] = (await incognito()).act(body);
  return json(answer, { status, headers: { 'cache-control': 'no-store' } });
}
