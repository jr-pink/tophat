import { json } from '@sveltejs/kit';
import { conversationOfDoc, readerStore } from '$lib/server/reader-store.js';

// Notes and highlights. Every write here lands in the append-only journal before the row, and a
// delete is a soft delete; nothing in this route can destroy the text of a note.
//
// A note is a thread: the root carries the quote and the anchor, and its replies hang off it with
// parentId. Only roots are ever returned as notes; the replies travel inside them.
export function GET({ url }) {
  const store = readerStore();
  const docId = url.searchParams.get('doc');
  if (docId) return json({ highlights: store.highlights(docId) });
  return json({ highlights: store.recentHighlights({ limit: Number(url.searchParams.get('limit') || 100) }) });
}

/** A reply as the card shows it, plus where it belongs. */
const replyOf = (saved) => ({
  id: saved.id,
  note: saved.note,
  author: saved.author,
  createdAt: saved.createdAt,
  updatedAt: saved.updatedAt,
  parentId: saved.parentId,
  docId: saved.docId
});

export async function POST({ request }) {
  const store = readerStore();
  const body = await request.json().catch(() => ({}));

  // A reply: the document, the section, the quote and the anchor all come from the root note.
  const parentId = body.parentId ? String(body.parentId) : null;
  if (parentId) {
    const text = String(body.note ?? '').trim();
    if (!text) return json({ error: 'a reply needs text' }, { status: 400 });
    const saved = store.saveHighlight({
      id: body.id || null,
      parentId,
      note: text,
      author: body.author,
      tags: body.tags
    });
    if (!saved) return json({ error: 'no note to reply to' }, { status: 404 });
    return json({ highlight: store.thread(saved.id), reply: replyOf(saved) });
  }

  if (!body.docId) return json({ error: 'docId is required' }, { status: 400 });
  if (!body.id && !String(body.quote || '').trim()) return json({ error: 'a quote is required' }, { status: 400 });
  // A note taken on a transcript is a note on a document whose document is a conversation, so the
  // docs row is made on first write rather than by a separate registration step. Everything after
  // this line is the same code a book's notes take.
  const conversationId = conversationOfDoc(body.docId);
  if (conversationId) store.ensureChatDoc(conversationId, body.docTitle);
  const saved = store.saveHighlight({
    id: body.id || null,
    docId: String(body.docId),
    sectionIdx: Number(body.sectionIdx || 0),
    anchorKey: body.anchorKey ?? null,
    kind: body.kind || (body.note ? 'note' : 'highlight'),
    color: body.color || 'yellow',
    quote: body.quote,
    prefix: body.prefix,
    suffix: body.suffix,
    start: body.start,
    end: body.end,
    note: body.note,
    tags: body.tags,
    author: body.author
  });
  return json({ highlight: saved });
}

export async function DELETE({ url, request }) {
  const store = readerStore();
  const body = await request.json().catch(() => ({}));
  const id = url.searchParams.get('id') || body.id;
  if (!id) return json({ error: 'id is required' }, { status: 400 });

  // Deleting a root hides its replies with it; deleting a reply leaves the rest of the thread.
  const before = store.highlight(id);
  if (body.restore) {
    const restored = store.restoreHighlight(id);
    if (!restored) return json({ error: 'no such note' }, { status: 404 });
    if (!restored.parentId) return json({ highlight: restored });
    return json({ highlight: store.thread(id), reply: replyOf(restored) });
  }
  const ok = store.deleteHighlight(id);
  if (ok && before?.parentId) return json({ ok, highlight: store.thread(before.parentId) });
  return json({ ok });
}
