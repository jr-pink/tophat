// The four room endpoints, written once and served twice: under /api/mp/* for the legacy room and
// under /api/mp/<token>/* for a minted room. A token the owner never minted is a 404 here, before
// anything touches room state, so a guessed URL can neither read a room nor bring one into being.
import { error, json } from '@sveltejs/kit';
import { app } from './app.js';
import { SESSION_COOKIE } from './auth.js';
import { addReader, ensureRoom, feedAfter, hasRoom, here, interrupt, join, LEGACY, roomInfo, say, settled, touch } from './mp.js';

const HEARTBEAT_MS = 15_000;
const NO_STORE = { 'cache-control': 'no-store' };

/** The room key for a request, or a 404 for a token that was never minted. */
export function roomKey(params = {}) {
  if (params.token === undefined) return LEGACY;
  if (!hasRoom(params.token)) error(404, 'No such room');
  return params.token;
}

// One SSE stream per room tab, carrying the gated feed. It opens with everything after the
// client's cursor, so a tab that joins late, or reconnects, catches up without a refetch.
export function eventsGET({ url, params }) {
  const key = roomKey(params);
  if (!ensureRoom({ room: key })) error(404, 'No such room');
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  const clientId = String(url.searchParams.get('client') || '');
  let drop = () => {};
  let beat = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (payload) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); }
        catch { close(); }
      };
      const close = () => {
        drop();
        if (beat !== null) clearInterval(beat);
        beat = null;
        try { controller.close(); } catch {}
      };
      for (const event of feedAfter(after, key)) send({ event });
      drop = addReader((event) => send({ event }), key);
      beat = setInterval(() => {
        touch(clientId, key);
        try { controller.enqueue(encoder.encode(`: beat\n\n`)); } catch { close(); }
        send({ here: here(key) });
      }, HEARTBEAT_MS);
    },
    cancel() {
      drop();
      if (beat !== null) clearInterval(beat);
      beat = null;
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
}

// A tab holding a valid webchat session is the owner; everything else is a stranger. The identity
// is handed back once and the tab keeps it in sessionStorage, so a second tab of his own browser
// joins as its own anonymous participant.
export async function joinPOST({ request, cookies, params }) {
  const key = roomKey(params);
  const body = await request.json().catch(() => ({}));
  const authenticated = app.auth.valid(cookies.get(SESSION_COOKIE));
  const owner = authenticated && body.as !== 'anon';
  const conversationId = ensureRoom({ room: key });
  if (!conversationId) error(404, 'No such room');
  const { clientId, identity, participantId } = join({ owner, room: key });
  return json({ clientId, identity, participantId, conversationId, authenticated, here: here(key), title: roomInfo(key)?.title ?? null },
    { headers: NO_STORE });
}

// A participant's message goes in as an ordinary message.send on the room conversation, so the
// runner starts the moment it lands, exactly as it does for his own chats.
export async function sayPOST({ request, params, cookies }) {
  const key = roomKey(params);
  const body = await request.json().catch(() => ({}));
  const clientId = String(body.clientId || '');
  const who = { label: String(body.as || ''), owner: Boolean(cookies && app.auth.valid(cookies.get(SESSION_COOKIE))) };
  const result = body.op === 'interrupt' ? interrupt(clientId, key, who) : say(clientId, body.text, key, who);
  if (result.error) return json({ error: result.error }, { status: result.status || 400 });
  return json(result, { headers: NO_STORE });
}

// Hydration for a room tab: the gated feed from a cursor, in store order. The same shape the main
// client gets from /api/conversation/<id>, so the same reducer folds it.
export async function stateGET({ url, params }) {
  const key = roomKey(params);
  const conversationId = ensureRoom({ room: key });
  if (!conversationId) error(404, 'No such room');
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  touch(String(url.searchParams.get('client') || ''), key);
  // Finish the already queued history once, then paint it in one fold instead of replaying it.
  await settled(key);
  return json({ conversationId, events: feedAfter(after, key), here: here(key), title: roomInfo(key)?.title ?? null },
    { headers: NO_STORE });
}
