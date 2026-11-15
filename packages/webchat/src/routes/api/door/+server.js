import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { peerCaller } from '$lib/server/peer-actions.js';
import { doorWork } from '$lib/server/door-work.js';
import { runnerLedgerPath } from '$lib/server/translate.js';

// A member's home host asking whether work of one door grant still runs in a chat here (door-work.js; docs/HOST-DESIGN.md item 5). Peers
// only (the service token on loopback, as /api/sync); a browser gets a 404.
export async function GET(event) {
  const { peer, refused } = await peerCaller(event);
  if (!peer || refused) return json({ error: 'not found' }, { status: 404 });
  const id = String(event.url.searchParams.get('conversation') || '');
  const grant = String(event.url.searchParams.get('grant') || '');
  const conversation = app.store.conversation(id);
  if (!conversation) return json({ error: `no conversation ${id}` }, { status: 404 });
  if (!/^[A-Za-z0-9]{1,64}$/u.test(grant)) return json({ error: 'a grant id is required' }, { status: 400 });
  const out = doorWork({ ledgerPath: runnerLedgerPath(), sessionId: conversation.sessionId || null, grant, busy: app.runner.isBusy(id) });
  return json(out, { headers: { 'cache-control': 'no-store' } });
}
