import { json } from '@sveltejs/kit';
import { CAPABILITIES } from '$lib/server/app.js';
import { incognito } from '$lib/server/incognito.js';

export async function GET({ url }) {
  const tab = url.searchParams.get('tab') || '';
  if (!/^[0-9a-f]{8,32}$/.test(tab)) return json({ error: 'tab required' }, { status: 400 });
  return json((await incognito()).bootstrap(tab, CAPABILITIES), { headers: { 'cache-control': 'no-store' } });
}
