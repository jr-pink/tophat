import { json } from '@sveltejs/kit';
import { readerStore } from '$lib/server/reader-store.js';

// One conversation per document. The reader asks what chat an article already talks in before it
// starts a new one, so the second note from the same piece lands in the same thread as the first.
// The id lives on doc_state, which a re-save of the document never touches.
export function GET({ url }) {
  const store = readerStore();
  const docId = url.searchParams.get('doc') || url.searchParams.get('docId');
  if (!docId) return json({ error: 'doc is required' }, { status: 400 });
  return json({ chatId: store.docChat(docId) });
}

export async function POST({ request }) {
  const store = readerStore();
  const body = await request.json().catch(() => ({}));
  const docId = body.docId ? String(body.docId) : '';
  if (!docId) return json({ error: 'docId is required' }, { status: 400 });
  // An empty or null chatId forgets the conversation rather than writing the string 'null'.
  return json({ chatId: store.setDocChat(docId, body.chatId ?? null) });
}
