import { json } from '@sveltejs/kit';
import { appendRows, readFlag, safeToken } from '$lib/server/dictation.js';

const MAX_ROWS = 400;
const MAX_TEXT = 8_000;

const CLASSES = new Set(['typed', 'dictation', 'paste', 'unknown', 'newline', 'delete', 'history', 'devices']);

function clean(row, receivedAt) {
  if (!row || typeof row !== 'object') return null;
  const klass = typeof row.kind === 'string' ? row.kind : row.class;
  if (!CLASSES.has(klass)) return null;

  const clipId = safeToken(row.clip_id);
  const base = {
    session_id: safeToken(row.session_id),
    conversation_id: safeToken(row.conversation_id),
    provenance_class: klass,
    grounds: typeof row.grounds === 'string' ? row.grounds.slice(0, 40) : null,
    
    
    
    
    raw_input_types: Array.isArray(row.raw_input_types)
      ? row.raw_input_types.slice(0, 12).map((t) => (typeof t === 'string' ? t.slice(0, 60) : null))
      : [],
    
    
    text: typeof row.text === 'string' ? row.text.slice(0, MAX_TEXT) : '',
    chars: Number.isFinite(row.chars) ? row.chars : null,
    keystrokes: Number.isFinite(row.keystrokes) ? row.keystrokes : null,
    offset: Number.isFinite(row.offset) ? row.offset : null,
    removed: Number.isFinite(row.removed) ? row.removed : null,
    boundary: typeof row.boundary === 'string' ? row.boundary.slice(0, 40) : null,
    
    
    
    client_at: typeof row.started_at === 'string' ? row.started_at.slice(0, 40) : null,
    client_ended_at: typeof row.ended_at === 'string' ? row.ended_at.slice(0, 40) : null,
    duration_ms: Number.isFinite(row.duration_ms) ? row.duration_ms : null,
    received_at: receivedAt
  };

  if (klass === 'devices') {
    return {
      type: 'provenance',
      ...base,
      text: '',
      
      
      
      
      
      devices: Array.isArray(row.devices) ? row.devices.slice(0, 24) : [],
      labelled: row.labelled === true,
      salt: typeof row.salt === 'string' ? row.salt.slice(0, 20) : null,
      user_agent: typeof row.user_agent === 'string' ? row.user_agent.slice(0, 300) : null
    };
  }

  
  if (clipId) return { type: 'correction', clip_id: clipId, reason: 'provenance', corrected_at: receivedAt, ...base };
  
  return { type: 'provenance', ...base };
}

export function GET() {
  const flag = readFlag();
  return json(
    { enabled: flag.enabled === true && flag.provenance === true },
    { headers: { 'cache-control': 'no-store' } }
  );
}

export async function POST({ request }) {
  const flag = readFlag();
  
  
  
  if (!flag.enabled || flag.provenance !== true) {
    return json({ error: 'Provenance logging is off.', kind: 'disabled' }, { status: 404 });
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Unreadable body.', kind: 'bad-request' }, { status: 400 }); }

  const received = new Date().toISOString();
  const incoming = Array.isArray(body?.rows) ? body.rows.slice(0, MAX_ROWS) : [];
  const rows = incoming.map((row) => clean(row, received)).filter(Boolean);
  if (!rows.length) return json({ rows: 0, skipped: 'nothing usable' }, { headers: { 'cache-control': 'no-store' } });

  const written = appendRows(rows);
  return json({ rows: written, received_at: received }, { headers: { 'cache-control': 'no-store' } });
}
