import { json } from '@sveltejs/kit';
import { readerStore } from '$lib/server/reader-store.js';
import { browse, keep } from '$lib/server/reader-browse.js';

// Keep a page: add to library. The extraction he was just reading is reused when it is still in
// the browse cache, so what is saved is the page he saw, not a second fetch of it; only a URL he
// has never opened is fetched here. Re-saving a page he already has refreshes the text and the
// navigation links and leaves his notes and his progress alone.
export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const target = String(body.url || '').trim();
  if (!target) return json({ error: 'a url is required' }, { status: 400 });

  let page;
  try {
    page = await browse(target);
  } catch (cause) {
    return json({ error: `could not fetch that page: ${cause.message}` }, { status: cause.status || 502 });
  }

  const store = readerStore();
  const id = keep(store, page);
  return json({ id, doc: store.doc(id), links: store.links(id) });
}
