import { json } from '@sveltejs/kit';
import { MAX_AUDIO_BYTES, transcribe, transcriptionReady } from '$lib/server/voice.js';

export async function POST({ request }) {
  if (!transcriptionReady()) {
    return json({
      error: 'No transcription engine on this machine. Use a browser with speech recognition, or install whisper-cli and a ggml model.',
      kind: 'unavailable'
    }, { status: 503 });
  }
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > MAX_AUDIO_BYTES) {
    return json({
      error: `Recording too long: ${Math.round(declared / 1048576)} MB against a limit of ${MAX_AUDIO_BYTES / 1048576} MB.`,
      kind: 'too-large'
    }, { status: 413 });
  }
  let bytes;
  try {
    bytes = Buffer.from(await request.arrayBuffer());
  } catch (cause) {
    return json({ error: `Could not read the recording: ${cause.message}`, kind: 'bad-request' }, { status: 400 });
  }
  try {
    const text = await transcribe(bytes, { mime: request.headers.get('content-type') || 'audio/webm' });
    
    
    
    return json({ text, empty: !text }, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    if (!cause.status || cause.status >= 500) console.error('[webchat] transcribe failed:', cause.message);
    return json({ error: cause.message, kind: cause.status === 503 ? 'unavailable' : 'error' }, { status: cause.status || 500 });
  }
}
