import { json } from '@sveltejs/kit';
import { readAll, setArchived, setManual, setMuted, setParent } from '$lib/server/folder-descriptions.js';

// GET: every folder's metadata ({ key: { name, text, source, parent } }). POST { name, text, at } or { name, parent, at }: his edit.
// An empty text returns the folder to the daily generator. Behind the same sign-in as the page.
export function GET() {
  return json(readAll(), { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  if (!body?.name) return json({ error: 'a folder name is required' }, { status: 400 });
  const at = typeof body.at === 'string' ? body.at : null;
  // { name, parent, at }: where the folder sits ('' top level). Text and place are separate edits, each newest-wins.
  if ('parent' in body) { setParent(String(body.name), typeof body.parent === 'string' ? body.parent : '', undefined, { at }); return json(readAll(), { headers: { 'cache-control': 'no-store' } }); }
  // { name, archived, at }: the folder's archive flag, orthogonal to its place; newest-wins.
  if ('archived' in body) { setArchived(String(body.name), body.archived === true, undefined, { at }); return json(readAll(), { headers: { 'cache-control': 'no-store' } }); }
  // { name, muted, at }: the folder's Mute When Collapsed flag; newest-wins, a false is the tombstone.
  if ('muted' in body) { setMuted(String(body.name), body.muted === true, undefined, { at }); return json(readAll(), { headers: { 'cache-control': 'no-store' } }); }
  setManual(String(body.name), String(body.text ?? ''), undefined, { at });
  return json(readAll(), { headers: { 'cache-control': 'no-store' } });
}
