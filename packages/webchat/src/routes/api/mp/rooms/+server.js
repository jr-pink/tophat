import { error, json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { SESSION_COOKIE } from '$lib/server/auth.js';
import { createRoom } from '$lib/server/mp.js';

// Minting a room is the owner's alone. hooks.server.js keeps this path behind the session check
// (it is the one /api/mp/ path not exempted), and the handler checks again so that a change to
// the exemption cannot open it. Body: { title?, seed? }; answers { token, url, title }.
export async function POST({ request, cookies, url }) {
  if (!app.auth.valid(cookies.get(SESSION_COOKIE))) error(401, 'Sign in required');
  const body = await request.json().catch(() => ({}));
  const room = createRoom({ title: body.title, seed: body.seed });
  return json({ token: room.token, url: `${url.origin}${room.url}`, path: room.url, title: room.title },
    { status: 201, headers: { 'cache-control': 'no-store' } });
}
