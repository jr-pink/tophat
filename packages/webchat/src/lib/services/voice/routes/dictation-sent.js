import { json } from '@sveltejs/kit';
import { appendRows, hypothesesFor, readFlag, safeToken } from '$lib/services/voice/server/dictation.js';
import { rowsForSend } from '$lib/services/voice/core/dictation.js';

export async function POST({ request }) {
  const flag = readFlag();
  if (!flag.enabled) return json({ error: 'Dictation is off.', kind: 'disabled' }, { status: 404 });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Unreadable body.', kind: 'bad-request' }, { status: 400 }); }

  const clips = Array.isArray(body?.clips) ? body.clips.slice(0, 64) : [];
  const ids = clips.map((c) => safeToken(c?.id)).filter(Boolean);
  if (!ids.length) return json({ rows: 0, skipped: 'nothing dictated' });

  
  
  const recorded = hypothesesFor(ids);
  const utterances = clips
    .filter((c) => safeToken(c?.id) && recorded.has(safeToken(c.id)))
    .map((c) => ({
      id: safeToken(c.id),
      asr: recorded.get(safeToken(c.id)) ?? String(c.asr ?? ''),
      
      
      
      
      
      
      shown: typeof c?.shown === 'string' && c.shown.trim() ? c.shown.slice(0, 4_000) : null,
      shownEngine: 'whisper-live'
    }));
  if (!utterances.length) {
    return json({ rows: 0, skipped: 'no such clips', kind: 'unknown-clips' });
  }

  const at = new Date().toISOString();
  const rows = rowsForSend({
    utterances,
    finalText: String(body?.text ?? ''),
    at,
    sentAt: typeof body?.sent_at === 'string' ? body.sent_at : at
  });

  
  
  
  
  
  
  
  
  
  if (rows.length) rows[0] = { ...rows[0], message_raw: String(body?.text ?? '') };

  const trace = Array.isArray(body?.trace) ? body.trace.slice(-200) : [];
  if (trace.length && rows.length) {
    rows[0] = {
      ...rows[0],
      edit_trace: trace
        .filter((step) => step && typeof step.text === 'string')
        .map((step) => ({ t: Number(step.t) || 0, text: String(step.text).slice(0, 4_000) }))
    };
  }

  const written = appendRows(rows);
  return json({ rows: written, clips: utterances.length }, { headers: { 'cache-control': 'no-store' } });
}
