import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';

export function GET() {
  const positions = app.store.reading(200);
  
  
  return json({ latest: positions[0] || null, positions });
}

export async function POST({ request }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'expected json' }, { status: 400 }); }

  const conversationId = String(body?.conversationId || '');
  const deviceId = String(body?.deviceId || '');
  if (!conversationId || !deviceId) {
    return json({ error: 'conversationId and deviceId are required' }, { status: 400 });
  }
  
  
  if (!app.store.conversation(conversationId)) {
    return json({ error: 'unknown conversation' }, { status: 404 });
  }

  const ratio = Number(body?.ratio);
  app.store.markReading({
    conversationId,
    itemId: body?.itemId ? String(body.itemId) : null,
    
    ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0,
    deviceId,
    
    
    
    at: new Date().toISOString()
  });
  return json({ ok: true });
}
