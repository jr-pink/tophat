import { json } from '@sveltejs/kit';
import { readTitleStyle, setTitleStyle } from '$lib/server/autotitle.js';
import { TITLE_STYLES } from '$lib/core/title.js';

// GET: which titles the titler writes ({ style, at }). POST { style, at }: his choice from the menu (the newest `at`
// wins, so an offline replay changes nothing newer). Behind the same sign-in as the page.
export function GET() {
  return json(readTitleStyle(), { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const saved = setTitleStyle(body?.style, { at: typeof body?.at === 'string' ? body.at : null });
  if (!saved) return json({ error: `style is one of ${TITLE_STYLES.join(', ')}` }, { status: 400 });
  return json(saved, { headers: { 'cache-control': 'no-store' } });
}
