import { error } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { shareView } from '$lib/server/share-view.js';

export function load({ params, setHeaders }) {
  const view = shareView(params.token, { store: app.store });
  if (!view) error(404, 'This link is not live');
  // A share link is the credential; nothing about it should sit in a shared cache, and no
  // referrer should carry the token to whatever is linked from inside the page.
  setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  return { view, token: params.token };
}
