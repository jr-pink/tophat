import { json } from '@sveltejs/kit';
import { reserveUpload } from '$lib/server/uploads.js';

export async function POST({ request }) {
  const body = await request.json().catch(() => null);
  const names = Array.isArray(body?.names) ? body.names : [];
  if (!names.length) return json({ error: 'Expected names' }, { status: 400 });
  const files = [];
  for (const name of names.slice(0, 20)) files.push(await reserveUpload({ name: String(name) }));
  return json({ files }, { headers: { 'cache-control': 'no-store' } });
}
