import { json } from '@sveltejs/kit';
import { MAX_SPEAK_CHARS, speak } from '$lib/server/voice.js';

export async function GET({ url, request }) {
  const text = url.searchParams.get('text') || '';
  if (!text.trim()) return json({ error: 'No text to speak', kind: 'bad-request' }, { status: 400 });
  if (text.length > MAX_SPEAK_CHARS) {
    return json({
      error: `Too long to speak in one piece: ${text.length} characters against a limit of ${MAX_SPEAK_CHARS}. Chunk it by sentence.`,
      kind: 'too-large'
    }, { status: 413 });
  }
  const speed = Number(url.searchParams.get('speed') || '1') || 1;
  const voice = url.searchParams.get('voice') || null;
  const prefer = url.searchParams.get('engine') || null;

  try {
    
    
    
    const { body, type, engine, tried } = await speak({ text, speed, voice, prefer, signal: request.signal });
    return new Response(body, {
      headers: {
        'content-type': type,
        'cache-control': 'no-store',
        
        
        'x-voice-engine': engine,
        ...(tried?.length ? { 'x-voice-fell-back': tried.join('; ').slice(0, 400) } : {})
      }
    });
  } catch (cause) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (!cause.status || cause.status >= 500) console.error('[webchat] speak failed:', cause.message);
    return json({ error: cause.message, kind: cause.status === 503 ? 'unavailable' : 'error' }, { status: cause.status || 500 });
  }
}
