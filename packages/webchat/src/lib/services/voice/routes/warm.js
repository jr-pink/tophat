import { json } from '@sveltejs/kit';
import { warm } from '$lib/services/voice/server/whisper-service.js';

// Opening voice mode starts the decoders. Loading the weights takes about
// twelve seconds, and that wait belongs before his first sentence rather than
// inside it; the call returns at once and the servers come up behind it.
export async function POST() {
  warm();
  return json({ warming: true }, { headers: { 'cache-control': 'no-store' } });
}
