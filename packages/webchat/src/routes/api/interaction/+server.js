import { json } from '@sveltejs/kit';
import { saveObservations } from '$lib/server/interaction.js';

export async function POST({ request }) {
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'body required' }, { status: 400 });
  let bytes = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1_000_000) { await reader.cancel(); return json({ error: 'batch too large' }, { status: 413 }); }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return json({ acknowledged: await saveObservations(body.rows) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof SyntaxError || /expected|invalid observation/.test(error.message)) return json({ error: 'invalid batch' }, { status: 400 });
    throw error; 
  }
}
