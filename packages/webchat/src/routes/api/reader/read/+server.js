import { json } from '@sveltejs/kit';
import { browse, cached, warm } from '$lib/server/reader-browse.js';
import { readerStore } from '$lib/server/reader-store.js';

// Read a page without keeping it. If he already has it in the library, that copy is what opens,
// with its notes and its place; otherwise this is a look, and nothing is written.
//
// Warming is the same act started early: GET, or POST with warm, kicks off the fetch and the
// extraction for a url he has pasted but not yet entered, and answers immediately. The POST that
// follows then finds the page in the browse cache instead of waiting a second time for the site.
// Warming writes nothing either, and refuses the same hosts a fetch refuses.
export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const target = String(body.url || '').trim();
  if (!target) return json({ error: 'a url is required' }, { status: 400 });

  const store = readerStore();
  const existing = store.docByUrl(target);
  if (body.warm) return startWarming(target, existing);
  if (existing && !body.refresh) return json({ saved: true, id: existing.id });

  try {
    const page = await browse(target, { refresh: Boolean(body.refresh) });
    return json({ saved: false, page });
  } catch (cause) {
    return json({ error: `could not fetch that page: ${cause.message}` }, { status: cause.status || 502 });
  }
}

export function GET({ url }) {
  const target = String(url.searchParams.get('url') || '').trim();
  if (!target) return json({ error: 'a url is required' }, { status: 400 });
  return startWarming(target, readerStore().docByUrl(target));
}

function startWarming(target, existing) {
  // A page already on the shelf needs no fetch at all; the client can open it straight away.
  if (existing) return json({ saved: true, id: existing.id, warming: false, cached: true });
  try {
    const state = warm(target);
    return json({ saved: false, ...state }, { status: state.cached ? 200 : 202 });
  } catch (cause) {
    return json({ error: cause.message, warming: false, cached: Boolean(cached(target)) }, { status: 400 });
  }
}
