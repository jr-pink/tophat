import { json } from '@sveltejs/kit';
import { contributions } from '$lib/server/extensions.js';
import { extensions } from '$lib/server/extensions-boot.js';

// The UI contributions of the instance's extensions, as data (menu items and palette commands; EXTENSIONS-V1 section 6).
// Behind the session like every /api route; an instance without extensions answers empty lists.
export async function GET() {
  const host = process.env.TOPHAT_EXTENSIONS_FILE ? await extensions() : null;
  return json(contributions(host), { headers: { 'cache-control': 'no-store' } });
}
