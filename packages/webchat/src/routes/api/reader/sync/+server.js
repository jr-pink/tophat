import { json } from '@sveltejs/kit';
import { readerStore } from '$lib/server/reader-store.js';
import { applyOps, manifest } from '$lib/server/reader-sync.js';

// The offline set and the op log. GET answers every document's row and version, with the past
// week, the starred and the live shelf (the reader's inbox) marked as the set a device keeps;
// since=<etag> answers {unchanged:true} when nothing moved. POST replays a device's ops in order,
// idempotently, under the merge rules in $lib/server/reader-sync.js.
export function GET({ url }) {
  return json(manifest(readerStore(), { since: url.searchParams.get('since') || null }),
    { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const ops = Array.isArray(body.ops) ? body.ops.slice(0, 200) : [];
  return json({ results: applyOps(readerStore(), ops, { device: body.device ? String(body.device) : null }) });
}
