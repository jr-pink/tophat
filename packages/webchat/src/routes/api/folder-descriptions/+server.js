import { json } from '@sveltejs/kit';
import { readAll, setManual } from '$lib/server/folder-descriptions.js';

// GET: every folder description ({ key: { name, text, source } }). POST { name, text }: his edit
// (an empty text returns the folder to the daily generator). Behind the same sign-in as the page.
export function GET() {
  return json(readAll(), { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  if (!body?.name) return json({ error: 'a folder name is required' }, { status: 400 });
  setManual(String(body.name), String(body.text ?? ''), undefined, { at: typeof body.at === 'string' ? body.at : null });
  return json(readAll(), { headers: { 'cache-control': 'no-store' } });
}
