import { remoteImageResponse } from '$lib/server/remote-image.js';

// Signed-in only (hooks.server.js: not a public path). The fetch, the guards and the on-disk cache
// are src/lib/server/remote-image.js.
export function GET({ url }) {
  return remoteImageResponse(url.searchParams.get('u'));
}
