import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { resolveConversation, settle, settleSafely } from '$lib/server/ff.js';
import { localRefusalAsync } from '$lib/server/local-gate.js';

// The machine door for an arrival that needs a turn: loopback, not through the tunnel (cloudflared
// delivers a remote request as a local socket, so a forwarding header is the tell), and the service
// token, compared in constant time. That rule has ONE owner, $lib/server/local-gate.js. The async
// form is used because a synchronous token read on the HTTP thread waits on the disk like any other,
// and this is the path that wakes a chat.
//
// Every refusal is a 404: a machine surface does not tell a stranger it is there.

export async function POST(event) {
  const { request } = event;
  if (await localRefusalAsync(event, { token: true })) return json({ error: 'not found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const text = String(body.text || '').trim();
  if (!text) return json({ error: 'Nothing to send' }, { status: 400 });

  // A caller that retries must not deliver twice, so an arrival carrying a native message id is
  // remembered as an applied action and a repeat answers with the chat it already reached.
  // The idempotency key is namespaced by the caller: Discord's inbound pipe sends no source and
  // keeps its historical "discord:" keys; push wakes (rev5/wake.py) send source "push".
  const ns = /^[a-z][a-z0-9-]{0,30}$/u.test(String(body.source || '')) ? body.source : 'discord';
  const actionId = body.messageId ? `${ns}:${body.messageId}` : null;
  if (actionId) {
    const seen = app.store.appliedAction(actionId);
    if (seen) return json({ id: seen.conversation_id, duplicate: true }, { headers: { 'cache-control': 'no-store' } });
  }

  // An explicitly named chat must exist, by conversation id or runner session id. An unknown one
  // is refused before anything is accepted: never a silent new chat.
  let conversationId = null;
  if (body.conversationId) {
    conversationId = resolveConversation(app.store, String(body.conversationId));
    if (!conversationId) {
      return json({ error: `unknown conversation ${body.conversationId}`, code: 'unknown-conversation' },
        { status: 409, headers: { 'cache-control': 'no-store' } });
    }
  }

  const id = app.store.ffAccept(text);
  if (actionId) {
    const cursor = app.store.cursor();
    app.store.markApplied({ actionId, conversationId: id, op: `${ns}.inbound`, cursorBefore: cursor, cursorAfter: cursor });
  }
  // `title` is the push plane's "Who: what" for the chat a wake opens (rev6/push/wake.mjs); ff.js
  // derives one from the text when it is absent, and ignores it when the chat already exists.
  const options = { text, wire: String(body.wire || '') || text, context: body.context || null, conversationId, title: typeof body.title === 'string' ? body.title : null };
  if (conversationId) {
    // Nothing to route, so the delivery is synchronous and the caller learns where it went and
    // whether it steered a running turn.
    try {
      const sent = await settle(id, options);
      return json({ id, conversationId: sent.conversationId, injected: sent.injected },
        { headers: { 'cache-control': 'no-store' } });
    } catch (cause) {
      try { app.store.ffSettle(id, { state: 'failed', error: String(cause?.message ?? cause).slice(0, 300) }); } catch {}
      return json({ id, error: String(cause?.message ?? cause) }, { status: 500, headers: { 'cache-control': 'no-store' } });
    }
  }
  settleSafely(id, options);
  return json({ id }, { headers: { 'cache-control': 'no-store' } });
}
