import { json } from '@sveltejs/kit';
import { CAPABILITIES } from '$lib/server/app.js';
import { incognito } from '$lib/server/incognito.js';

export async function GET({ url }) {
  const tab = url.searchParams.get('tab') || '';
  if (!/^[0-9a-f]{8,32}$/.test(tab)) return json({ error: 'tab required' }, { status: 400 });
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  return json((await incognito()).sync(tab, after, CAPABILITIES), { headers: { 'cache-control': 'no-store' } });
}
