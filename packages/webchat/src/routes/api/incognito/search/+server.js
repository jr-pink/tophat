import { json } from '@sveltejs/kit';

// Cross-chat search never covers incognito chats, and an incognito pane's in-chat search is the find bar.
export function GET({ url }) {
  const query = url.searchParams.get('q') || '';
  return json({ query, mode: 'exact', expanded: [], results: [] }, { headers: { 'cache-control': 'no-store' } });
}
