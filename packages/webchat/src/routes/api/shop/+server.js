import { json } from '@sveltejs/kit';
import { search } from '$lib/server/shop.js';

// One query in, a grid's worth of product cards out. GET only: this route reads public search
// pages and writes nothing anywhere but its own cache. ?refresh=1 skips the cache for a query
// whose prices he wants re-read.
export async function GET({ url }) {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) return json({ query: '', results: [], found: 0, shown: 0, sources: [], notes: [] });
  const refresh = url.searchParams.get('refresh') === '1';
  try {
    return json(await search(query, { refresh }));
  } catch (cause) {
    return json({ error: `the search failed: ${cause.message}`, query, results: [], found: 0, shown: 0, sources: [], notes: [] }, { status: 502 });
  }
}
