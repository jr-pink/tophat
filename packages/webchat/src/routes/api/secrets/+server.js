import { json } from '@sveltejs/kit';
import {
  cancelRequest, createRequest, fulfillRequest, listRequests, secretBytes, secretPresent, writeSecret
} from '$lib/server/secrets.js';

export function GET() {
  const requests = listRequests()
    .filter((request) => request.status === 'pending' || Date.parse(request.filled_at || 0) > Date.now() - 600_000)
    .map((request) => ({ ...request, exists: secretPresent(request.name), bytes: secretBytes(request.name) }));
  return json({ requests }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, { status: 400 }); }
  try {
    if (body.action === 'fulfill') {
      const saved = fulfillRequest(String(body.id || ''), body.values || {}, { overwrite: Boolean(body.overwrite) });
      return json({ ok: true, ...saved });
    }
    if (body.action === 'save') {
      
      const saved = writeSecret(String(body.name || ''), String(body.value || ''), { overwrite: Boolean(body.overwrite) });
      return json({ ok: true, ...saved });
    }
    if (body.action === 'cancel') {
      cancelRequest(String(body.id || ''));
      return json({ ok: true });
    }
    if (body.action === 'request') {
      
      
      const created = createRequest(body);
      return json({ ok: true, request: created });
    }
    return json({ error: 'unknown action' }, { status: 400 });
  } catch (cause) {
    
    
    return json({ error: cause.message || 'failed' }, { status: 400 });
  }
}
