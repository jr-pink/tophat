import { json } from '@sveltejs/kit';
import {
  MAX_CLIP_BYTES, MIN_CLIP_BYTES, appendRows, readFlag, runEngine, storeClip
} from '$lib/services/voice/server/dictation.js';
import { hypothesisRow } from '$lib/services/voice/core/dictation.js';

export async function POST({ request }) {
  const flag = readFlag();
  if (!flag.enabled) return json({ error: 'Dictation is off.', kind: 'disabled' }, { status: 404 });

  let meta = {};
  const header = request.headers.get('x-clip-meta');
  if (header) {
    try { meta = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
    catch { return json({ error: 'Unreadable clip metadata.', kind: 'bad-request' }, { status: 400 }); }
  }

  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > MAX_CLIP_BYTES) {
    return json({
      error: `That recording is ${Math.round(declared / 1048576)} MB, over the ${MAX_CLIP_BYTES / 1048576} MB limit.`,
      kind: 'too-large'
    }, { status: 413 });
  }

  let bytes;
  try { bytes = Buffer.from(await request.arrayBuffer()); }
  catch (cause) { return json({ error: `Could not read the recording: ${cause.message}`, kind: 'bad-request' }, { status: 400 }); }
  if (bytes.length < MIN_CLIP_BYTES) {
    return json({ error: 'That recording is empty.', kind: 'empty' }, { status: 400 });
  }
  if (bytes.length > MAX_CLIP_BYTES) {
    return json({ error: 'That recording is too long.', kind: 'too-large' }, { status: 413 });
  }

  let row;
  try {
    row = storeClip(bytes, { ...meta, userAgent: request.headers.get('user-agent') });
  } catch (cause) {
    
    
    return json({ error: cause.message, kind: 'store-failed' }, { status: cause.status || 500 });
  }

  const engine = typeof meta.engine === 'string' && meta.engine ? meta.engine : null;

  
  
  
  
  
  
  
  
  // The live path decodes out of audio this machine already held, so by the
  // time the clip arrives for the record its transcript usually exists.
  const carried = meta.asr && typeof meta.asr.text === 'string' && meta.asr.text.trim()
    ? {
      text: meta.asr.text,
      engine: typeof meta.asr.engine === 'string' ? meta.asr.engine : 'whisper-local',
      model: typeof meta.asr.model === 'string' ? meta.asr.model : null,
      latencyMs: Number.isFinite(meta.asr.latencyMs) ? meta.asr.latencyMs : null
    }
    : null;

  let result = carried;
  try {
    if (!result) result = await runEngine(bytes, { engine });
  } catch (cause) {
    if (!cause.status || cause.status >= 500) console.error('[dictation] transcribe failed:', cause.message);
    
    
    
    
    try {
      appendRows([{
        type: 'correction',
        clip_id: row.clip_id,
        reason: 'asr-failed',
        corrected_at: new Date().toISOString(),
        asr_error: String(cause.message).slice(0, 300)
      }]);
    } catch (writeCause) {
      console.error('[dictation] could not record the failure:', writeCause.message);
    }
    
    
    
    return json({
      stored: true,
      clip_id: row.clip_id,
      path: row.path,
      duration_sec: row.duration_sec,
      text: null,
      error: cause.message,
      kind: cause.status === 503 ? 'unavailable' : 'asr-failed'
    }, { headers: { 'cache-control': 'no-store' } });
  }

  
  
  
  
  
  
  
  let recorded = true;
  try {
    appendRows([hypothesisRow({
      clipId: row.clip_id,
      asrText: result.text,
      engine: result.engine,
      engineModel: result.model,
      latencyMs: result.latencyMs,
      at: new Date().toISOString()
    })]);
  } catch (cause) {
    
    
    
    recorded = false;
    console.error('[dictation] hypothesis not recorded:', cause.message);
  }

  
  
  
  return json({
    stored: true,
    clip_id: row.clip_id,
    path: row.path,
    duration_sec: row.duration_sec,
    text: result.text,
    empty: !result.text,
    engine: result.engine,
    model: result.model,
    latency_ms: result.latencyMs,
    recorded
  }, { headers: { 'cache-control': 'no-store' } });
}
