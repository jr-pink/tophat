import { json } from '@sveltejs/kit';
import { saveClientLag, validateClientLag } from '$lib/server/client-lag.js';

// A tab's freeze watchdog (src/lib/client/freeze-watch.js) reports here: long tasks over 1 s, main-thread
// gaps over 5 s, and stretches when it could not reach this server. Lands in client-lag.jsonl beside lag.jsonl.
export async function POST({ request }) {
  const text = await request.text();
  if (text.length > 400_000) return json({ error: 'batch too large' }, { status: 413 });
  let records;
  try { records = validateClientLag(JSON.parse(text).records); }
  catch { return json({ error: 'invalid batch' }, { status: 400 }); }
  const saved = records.length ? await saveClientLag(records, { userAgent: request.headers.get('user-agent')?.slice(0, 200) || null }) : 0;
  return json({ saved }, { headers: { 'cache-control': 'no-store' } });
}
