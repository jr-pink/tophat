import { app } from '$lib/server/app.js';
import { shareRemoteImages } from '$lib/server/share-view.js';
import { remoteImageResponse } from '$lib/server/remote-image.js';

// Public, like the page it belongs to, so it may fetch exactly one thing: a URL that the stored
// messages of THIS share write on an image line of their own. A token alone is not a way to make
// this machine fetch an arbitrary address, and a revoked token serves nothing.
export function GET({ params, url }) {
  const wanted = url.searchParams.get('u') || '';
  const allowed = shareRemoteImages(params.token, { store: app.store });
  if (!allowed.has(wanted)) return new Response('Not in this share', { status: 404, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } });
  return remoteImageResponse(wanted);
}
