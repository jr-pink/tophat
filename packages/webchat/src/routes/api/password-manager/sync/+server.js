import { json } from '@sveltejs/kit';
import { passwordManager } from '$lib/server/password-manager.js';
import { handleSyncGet, handleSyncPost } from '$lib/server/vault-sync.js';

// The device replica's one endpoint. GET answers this device's re-sealed snapshot (304 while its
// etag holds, 403 unknown or revoked, 423 while the Mac's vault is locked); POST enrols a device,
// replays its op log, lists devices or revokes one. All the judgement lives in
// $lib/server/vault-sync.js, which the node tests drive directly; this file is the HTTP skin.
//
// App authentication is enforced by hooks.server.js before either handler: /api/* without a
// session is a 401, which is what tells the page it is signed out rather than offline.

const respond = ({ status, headers, body }) =>
  (body === null ? new Response(null, { status, headers }) : json(body, { status, headers }));

const deviceOf = (request) => request.headers.get('x-tophat-device');

export function GET({ request }) {
  return respond(handleSyncGet({ manager: passwordManager(), deviceId: deviceOf(request),
    ifNoneMatch: request.headers.get('if-none-match') }));
}

export async function POST({ request, url }) {
  const body = await request.json().catch(() => ({}));
  return respond(handleSyncPost({ manager: passwordManager(), deviceId: deviceOf(request), body,
    sameOrigin: request.headers.get('origin') === url.origin }));
}
