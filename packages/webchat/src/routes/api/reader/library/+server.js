import { json } from '@sveltejs/kit';
import { readerStore } from '$lib/server/reader-store.js';

// The shelf, and the one search box over it: documents by reading state, plus full text hits in
// what has been saved and in the notes taken on it.
export function GET({ url }) {
  const store = readerStore();
  const query = (url.searchParams.get('q') || '').trim();
  const status = url.searchParams.get('status') || null;
  const limit = Math.min(500, Number(url.searchParams.get('limit') || 200) || 200);
  // The shelf he is looking at: what is live, what he starred, what he archived away, and the
  // two trays under the shelf, what he set aside and what he deferred. A deferred document whose
  // hour has passed is not in the deferred answer; the store decides that by the clock.
  const view = url.searchParams.get('view') || 'live';
  const tray = view === 'aside' || view === 'deferred';
  const library = store.library({
    status,
    limit,
    starred: view === 'starred',
    archived: view === 'archived',
    aside: view === 'aside',
    deferred: view === 'deferred'
  });
  const found = query ? store.search(query, { limit: 40 }) : { docs: [], notes: [] };
  return json({
    view,
    docs: library,
    search: query ? { query, ...found } : null,
    // The recent-notes rail belongs to the shelf; a tray is read beside it and would pay for
    // that join twice more on every refresh.
    notes: query || tray ? [] : store.recentHighlights({ limit: 30 })
  });
}
