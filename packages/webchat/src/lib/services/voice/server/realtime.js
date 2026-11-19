// A short-lived client secret for the browser's Realtime transcription session. The API key stays in the vault and
// on this process; the page gets a secret that opens one session, configured here, and expires in minutes.
// Turn detection is the model's own (semantic voice activity detection): it reads the words to decide he has
// finished, so a pause mid-sentence does not end the turn the way a silence timer does.

import { readSecret } from '../../../server/auth.js';

export const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
export const SECRET_URL = 'https://api.openai.com/v1/realtime/client_secrets';
export const TRANSCRIBE_MODEL = process.env.TOPHAT_VOICE_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
export const SECRET_TTL_SECONDS = 600;

export function openaiKey() {
  return readSecret('openai-api-key', 'OPENAI_API_KEY');
}

export function sessionConfig({ model = TRANSCRIBE_MODEL, language = 'en' } = {}) {
  return {
    expires_after: { anchor: 'created_at', seconds: SECRET_TTL_SECONDS },
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription: { model, language },
          noise_reduction: { type: 'near_field' },
          turn_detection: { type: 'semantic_vad', eagerness: 'medium' }
        }
      }
    }
  };
}

export async function mintRealtimeSecret({ fetchImpl = fetch, key = openaiKey(), signal = null } = {}) {
  if (!key) throw Object.assign(new Error('No OpenAI key is stored for voice transcription (vault name openai-api-key).'), { status: 503 });
  let response;
  try {
    response = await fetchImpl(SECRET_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(sessionConfig()),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000)
    });
  } catch (cause) {
    throw Object.assign(new Error(`The transcription service is not reachable: ${cause?.message || cause}`), { status: 502 });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw Object.assign(new Error(`The transcription service refused a session (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`), { status: 502 });
  }
  const body = await response.json();
  if (!body?.value) throw Object.assign(new Error('The transcription service returned no client secret.'), { status: 502 });
  return { secret: body.value, expiresAt: body.expires_at ?? null, url: REALTIME_URL, model: TRANSCRIBE_MODEL };
}
