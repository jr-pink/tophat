import { json } from '@sveltejs/kit';
import { readerStore } from '$lib/server/reader-store.js';
import { chapterHtml } from '$lib/server/reader-ingest.js';
import { bodies } from '$lib/server/reader-sync.js';

// Whole documents for the device's offline copy: every section's HTML (a book's chapters parsed
// out of the file), links, note threads, positions, and the book-internal assets to fetch.
export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 40);
  return json({ docs: bodies(readerStore(), ids, { chapterHtml }) }, { headers: { 'cache-control': 'no-store' } });
}
