import { json } from '@sveltejs/kit';
import { readerStore } from '$lib/server/reader-store.js';
import { chapterHtml, ingestStatus } from '$lib/server/reader-ingest.js';
import { stampFields } from '$lib/server/reader-sync.js';

// One document, ready to render: the section asked for (a blog post has exactly one, a book has a
// chapter per spine entry), the whole section list for the contents rail, the links that page the
// series forward and back, every note on it, and where reading stopped.
//
// A book's chapter HTML is not in the store; it is parsed out of the file when the chapter is
// opened, so the size of a book costs nothing until the chapter is read.
//
// Two flags trim the answer for a client that is only turning a page. notes=section sends the
// notes on the section being opened instead of every note in the book (a well annotated book was
// sending near a megabyte to open one chapter), and sections=skip drops the contents rail the
// client already has. Both are opt in: the default answer is unchanged.
export function GET({ params, url }) {
  const store = readerStore();
  const doc = store.doc(params.id);
  if (!doc) return json({ error: 'no such document' }, { status: 404 });
  const progress = store.progress(doc.id);
  const asked = url.searchParams.get('section');
  const idx = asked === null ? Number(progress.state?.section_idx || 0) : Number(asked) || 0;
  const row = store.section(doc.id, idx) || store.section(doc.id, 0);

  let section = null;
  if (row) {
    let html = row.html;
    let error = null;
    if (!html && doc.kind === 'epub') {
      try { html = chapterHtml(doc.id, row.idx); }
      catch (cause) { error = `could not read that chapter: ${cause.message}`; }
    }
    section = { idx: row.idx, title: row.title, html: html || '', words: row.words, error };
  }

  const scoped = url.searchParams.get('notes') === 'section';
  const highlights = scoped && section
    ? store.highlights(doc.id, { sectionIdx: section.idx })
    : store.highlights(doc.id);

  return json({
    doc: { ...doc, state: progress.state },
    section,
    sections: url.searchParams.get('sections') === 'skip' ? null : store.sectionList(doc.id),
    links: store.links(doc.id),
    highlights,
    notesScope: scoped ? 'section' : 'document',
    noteCount: scoped ? store.countHighlights(doc.id) : highlights.length,
    progress,
    ingest: ingestStatus(doc.id)
  });
}

export async function PATCH({ params, request }) {
  const store = readerStore();
  const body = await request.json().catch(() => ({}));
  if (body.status) store.setStatus(params.id, String(body.status));
  if (body.archived !== undefined) store.archive(params.id, Boolean(body.archived));
  if (body.starred !== undefined) store.star(params.id, Boolean(body.starred));
  // Set aside is "not now" with no date on it; defer carries the hour or the condition that
  // brings it back. A null or empty defer clears it.
  if (body.aside !== undefined) store.setAside(params.id, Boolean(body.aside));
  if (body.defer !== undefined) store.defer(params.id, body.defer || {});
  // Stamp when each flag was set, so an older offline write replayed later cannot undo this one.
  if (store.doc(params.id)) stampFields(store, params.id, body);
  return json({ doc: store.doc(params.id) });
}
