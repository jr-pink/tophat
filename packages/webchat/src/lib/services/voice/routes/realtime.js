import { json } from '@sveltejs/kit';
import { mintRealtimeSecret } from '$lib/services/voice/server/realtime.js';

// Opening voice mode asks for a client secret; the page then talks to the transcription service directly.
export async function POST({ request }) {
  try {
    return json(await mintRealtimeSecret({ signal: request.signal }), { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    if (!cause.status || cause.status >= 500) console.error('[webchat] realtime secret failed:', cause.message);
    return json({ error: cause.message, kind: cause.status === 503 ? 'unavailable' : 'error' }, { status: cause.status || 500, headers: { 'cache-control': 'no-store' } });
  }
}
