// A room's feed in the app's own shapes, so a room tab runs the app's client session unchanged
// (src/lib/client/mp-session.js rewrites the session's requests onto these).
//
//   /bootstrap            the app's /api/bootstrap: the room conversation's header, the cursor
//   /sync?after=          the app's /api/sync: gated events after a cursor, at most 2000
//   /conversation/<id>    the app's /api/conversation/<id>: newest, before, after; only the room's id
//   /events?v=2           the app's /api/events: {hello}, then {events:[...]} batches; presence is
//                         a named `here` event the session's onmessage never sees
//   /actions              the app's /api/actions: message.send and interrupt, labelled with the
//                         tab's identity by mp.js say(); reading and touching are accepted as no-ops
//
// Every route reads only the gated projection (mp.js feedAfter), never the store's own events,
// and answers 404 for a token the owner never minted (mp-routes.js roomKey). Nothing here returns
// a store event: an action's reply carries no events, the room's own stream delivers the gated
// form of what it caused.
import { error, json } from '@sveltejs/kit';
import { ACTIONS } from '../core/contract.js';
import { app, liveConversations } from './app.js';
import { addReader, ensureRoom, feedAfter, here, interrupt, roomInfo, say, settled, touch } from './mp.js';
import { roomKey } from './mp-routes.js';
import { SESSION_COOKIE } from './auth.js';

const NO_STORE = { 'cache-control': 'no-store' };
const SYNC_LIMIT = 2000;
const PAGE_LIMIT = 1500;
const STREAM_BATCH = 400;
const HEARTBEAT_MS = 15_000;
const ACTION_ID = /^[A-Za-z0-9_-]{8,80}$/u;

function room(params) {
  const key = roomKey(params);
  const conversationId = ensureRoom({ room: key });
  if (!conversationId) error(404, 'No such room');
  return { key, conversationId };
}

const lastCursor = (events) => (events.length ? events[events.length - 1].cursor : 0);
const feedCursor = (key) => feedAfter(0, key).reduce((max, event) => Math.max(max, event.cursor || 0), 0);

function liveFor(conversationId) {
  try { return liveConversations().includes(conversationId) ? [conversationId] : []; }
  catch { return []; }
}

/** The room conversation's header: nothing but what the room already shows. */
function header(key, conversationId) {
  const feed = feedAfter(0, key);
  const first = feed[0]?.at || null;
  const last = feed.at(-1)?.at || first;
  return { id: conversationId, title: roomInfo(key)?.title ?? null, createdAt: first, updatedAt: last, activeAt: last };
}

export async function bootstrapGET({ url, params }) {
  const { key, conversationId } = room(params);
  touch(String(url.searchParams.get('client') || ''), key);
  await settled(key);
  return json({
    conversations: [header(key, conversationId)],
    events: [],
    cursor: feedCursor(key),
    live: liveFor(conversationId),
    capabilities: {}
  }, { headers: NO_STORE });
}

export async function syncGET({ url, params }) {
  const { key, conversationId } = room(params);
  touch(String(url.searchParams.get('client') || ''), key);
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  const all = feedAfter(after, key);
  const events = all.slice(0, SYNC_LIMIT);
  const truncated = all.length > SYNC_LIMIT;
  return json({ events, truncated, cursor: truncated ? lastCursor(events) : Math.max(after, feedCursor(key)),
    live: liveFor(conversationId) }, { headers: NO_STORE });
}

export async function conversationGET({ url, params }) {
  const { key, conversationId } = room(params);
  if (params.id !== conversationId) error(404, 'No such conversation');
  await settled(key);
  const limit = Math.min(PAGE_LIMIT, Math.max(1, Number(url.searchParams.get('limit') || PAGE_LIMIT)));
  const feed = feedAfter(Math.max(0, Number(url.searchParams.get('after') || 0)), key);
  let events;
  if (url.searchParams.has('before')) {
    const before = Number(url.searchParams.get('before'));
    events = feed.filter((event) => event.cursor < before).slice(-limit);
  } else if (url.searchParams.get('newest') === '1') events = feed.slice(-limit);
  else events = feed.slice(0, limit);
  return json({ events, cursor: feedCursor(key) }, { headers: NO_STORE });
}

export async function actionsPOST({ request, url, params, cookies }) {
  const { key, conversationId } = room(params);
  const clientId = String(url.searchParams.get('client') || '');
  const who = { label: String(url.searchParams.get('as') || ''), owner: Boolean(cookies && app.auth.valid(cookies.get(SESSION_COOKIE))) };
  const action = await request.json().catch(() => null);
  if (!action || typeof action !== 'object') return json({ error: 'invalid action' }, { status: 400 });
  const ok = (extra = {}) => json({ events: [], cursor: feedCursor(key), ...extra }, { headers: NO_STORE });
  switch (action.op) {
    case ACTIONS.SEND: {
      // A send is stored and acknowledged before anything else, whatever the tab's state: a stale
      // conversation id lands in this room's own conversation (never another), an unknown client is
      // taken in, the privacy gate only governs the projection out. A retry lands once.
      const actionId = ACTION_ID.test(String(action.action_id || '')) ? String(action.action_id) : null;
      const seen = actionId ? app.store.appliedAction?.(actionId) : null;
      if (seen) return ok({ replayed: true });
      const before = app.store.cursor?.() ?? 0;
      const result = say(clientId, action.payload?.text, key, { actionId, ...who });
      if (result.error) return json({ error: result.error }, { status: result.status || 400 });
      if (actionId) app.store.markApplied?.({ actionId, conversationId, op: action.op, cursorBefore: before, cursorAfter: app.store.cursor?.() ?? before });
      return ok({ identity: result.identity });
    }
    case ACTIONS.INTERRUPT: {
      const result = interrupt(clientId, key, who);
      if (result.error) return json({ error: result.error }, { status: result.status || 400 });
      return ok();
    }
    case ACTIONS.READ:
    case ACTIONS.TOUCH:
      // His read marks and opens belong to his own chat list, which a room tab has no part in.
      return ok();
    default:
      return json({ error: `${action.op} is not available in a room` }, { status: 403 });
  }
}

/**
 * The room's stream in the app's framing. Catch-up goes out in batches rather than one frame per
 * event, and live events that arrive in the same tick share a frame, so the session folds them in
 * one pass exactly as it folds the app's /api/events.
 */
export function eventsV2GET({ url, params }) {
  const { key } = room(params);
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  const clientId = String(url.searchParams.get('client') || '');
  let drop = () => {};
  let beat = null;
  let pending = [];
  let flushTimer = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (text) => {
        try { controller.enqueue(encoder.encode(text)); return true; } catch { close(); return false; }
      };
      const send = (payload) => write(`data: ${JSON.stringify(payload)}\n\n`);
      const presence = () => write(`event: here\ndata: ${JSON.stringify({ here: here(key) })}\n\n`);
      const flush = () => {
        flushTimer = null;
        const batch = pending;
        pending = [];
        if (batch.length) send({ events: batch });
      };
      const close = () => {
        drop();
        if (beat !== null) clearInterval(beat);
        if (flushTimer !== null) clearTimeout(flushTimer);
        beat = null;
        try { controller.close(); } catch {}
      };
      touch(clientId, key);
      const backlog = feedAfter(after, key);
      send({ hello: true, cursor: lastCursor(backlog) || after });
      for (let at = 0; at < backlog.length; at += STREAM_BATCH) send({ events: backlog.slice(at, at + STREAM_BATCH) });
      presence();
      drop = addReader((event) => {
        pending.push(event);
        if (flushTimer === null) flushTimer = setTimeout(flush, 0);
      }, key);
      beat = setInterval(() => {
        touch(clientId, key);
        if (write(`: beat\n\n`)) presence();
      }, HEARTBEAT_MS);
    },
    cancel() {
      drop();
      if (beat !== null) clearInterval(beat);
      if (flushTimer !== null) clearTimeout(flushTimer);
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
