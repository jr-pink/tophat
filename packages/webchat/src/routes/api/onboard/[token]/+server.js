import { app } from '$lib/server/app.js';
import { resolveConversation, settle } from '$lib/server/ff.js';
import { accept, lookup, USAGE, MAX_BYTES } from '$lib/server/onboard.js';

// The one-time onboarding channel (src/lib/server/onboard.js, minted by tools/tophat-onboard).
// Public by public-paths.js; the token in the path is the whole credential and is checked here.
// Delivery is the /api/inbound path for a named chat: ffAccept, then settle() into that chat as an
// automated event, so a running turn is steered and an idle chat starts one.

const headers = { 'cache-control': 'no-store' };
const notFound = () => new Response('not found\n', { status: 404, headers: { ...headers, 'content-type': 'text/plain' } });
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json' } });

async function deliver(chat, text) {
  const conversationId = resolveConversation(app.store, chat);
  if (!conversationId) throw new Error('bound chat is gone');
  const id = app.store.ffAccept(text);
  try {
    await settle(id, { text, wire: text, conversationId, automated: true });
  } catch (cause) {
    try { app.store.ffSettle(id, { state: 'failed', error: String(cause?.message ?? cause).slice(0, 300) }); } catch {}
    throw cause;
  }
}

export function GET({ params }) {
  if (!lookup(params.token).row) return notFound();
  return new Response(USAGE, { headers: { ...headers, 'content-type': 'text/plain' } });
}

export async function POST({ params, request }) {
  if (!lookup(params.token).row) return notFound();
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BYTES * 2) return reply(413, { error: 'too large' });
  const raw = await request.text();
  let text = raw;
  if ((request.headers.get('content-type') || '').includes('application/json')) {
    try { text = String(JSON.parse(raw)?.text ?? ''); } catch { return reply(400, { error: 'bad json' }); }
  }
  try {
    const out = await accept(params.token, text, { deliver });
    return out.status === 404 ? notFound() : reply(out.status, out.body);
  } catch (cause) {
    console.error('[webchat] onboard delivery failed:', cause?.message);
    return reply(500, { error: 'delivery failed' });
  }
}

export const fallback = () => notFound();
