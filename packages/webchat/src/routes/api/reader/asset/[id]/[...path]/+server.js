import { error } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { bookPath, handleFor } from '$lib/server/reader-ingest.js';

// Images inside a book. A chapter's <img src="epub:OEBPS/images/fig1.png"> is rewritten by the
// client to this route, which reads that one entry through the open handle: one byte range off
// the disk, not the book.
export function GET({ params }) {
  if (!/^[a-z]_[0-9a-f]{8,}$/u.test(params.id) || !existsSync(bookPath(params.id))) error(404, 'no such book');
  let entry;
  try {
    entry = handleFor(params.id).entry(params.path);
  } catch (cause) {
    error(500, `could not read that entry: ${cause.message}`);
  }
  if (!entry) error(404, 'no such entry');
  return new Response(entry.bytes, {
    headers: {
      'content-type': entry.mediaType || 'application/octet-stream',
      'cache-control': 'private, max-age=86400'
    }
  });
}
