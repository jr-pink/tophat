import { json } from '@sveltejs/kit';
import { readerStore } from '$lib/server/reader-store.js';

// How much of it he has read. The client sends the furthest point reached in the current section
// and the scroll position to come back to; the store keeps the maximum and works out the
// whole-document percent weighted by section length.
export async function POST({ request }) {
  const store = readerStore();
  const body = await request.json().catch(() => ({}));
  if (!body.docId) return json({ error: 'docId is required' }, { status: 400 });
  if (!store.doc(body.docId)) return json({ error: 'no such document' }, { status: 404 });
  const result = store.markProgress({
    docId: String(body.docId),
    sectionIdx: Number(body.sectionIdx || 0),
    ratio: Number(body.ratio || 0),
    scrollTop: Number(body.scrollTop || 0),
    seconds: Number(body.seconds || 0)
  });
  return json(result);
}
