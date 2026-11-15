import { json } from '@sveltejs/kit';
import { ACTIONS, validateAction } from '$lib/core/contract.js';
import { app, applyAction } from '$lib/server/app.js';
import { coreActionOf, observe } from '$lib/server/extensions.js';
import { extensions } from '$lib/server/extensions-boot.js';
import { isIncognito } from '$lib/core/incognito.js';
import { filterEvents, scopeContext, scopeHttpError } from '$lib/server/scope-guard.js';
import { PEER_OPS, peerCaller, peerSendOf } from '$lib/server/peer-actions.js';

export async function POST(event) {
  const { request } = event;
  // A peer host (peer-actions.js) posts the same action a browser does; it is not a scoped account, so scopes do not apply to it.
  const { peer, refused } = await peerCaller(event);
  if (refused) return json({ error: 'not found' }, { status: 404 });
  let action;
  try { action = validateAction(await request.json()); }
  catch (cause) { return json({ error: `Invalid action: ${cause.message}` }, { status: 400 }); }
  // A peer may send, fork and stop a chat that runs on this host, and nothing else; a send must carry the fields that say the home host prepared it.
  if (peer) {
    if (!PEER_OPS.includes(action.op)) return json({ error: `${action.op} is not available to a peer host` }, { status: 403 });
    if (action.op !== ACTIONS.INTERRUPT && !peerSendOf(action.payload)) return json({ error: 'a peer send carries wire and writer' }, { status: 400 });
  }
  // An incognito chat never reaches the durable store: its actions go to /api/incognito/actions
  // (src/lib/server/incognito.js). One that arrives here is refused, not quietly written to events.sqlite.
  if (isIncognito(action.conversation_id) || isIncognito(action.payload?.parentId)) {
    return json({ error: 'incognito chats are not stored; send to /api/incognito/actions' }, { status: 400 });
  }

  // Scopes (src/lib/server/scopes.js): with them on, every action on an existing chat is checked
  // against the caller's account first, and a chat in a scope the account cannot open answers as if
  // it did not exist. Off, ctx.enabled is false and nothing below changes behaviour.
  const ctx = peer ? { enabled: false, service: null, identity: null, store: app.store } : scopeContext(event, app.store, app.runner);
  if (ctx.enabled) {
    const me = ctx.service.contextFor(ctx.identity);
    if (!me?.account) return json({ error: 'Sign in with an account that has a scope.', code: 'denied' }, { status: 403 });
    const target = app.store.conversation(action.conversation_id);
    const parent = action.payload?.parentId ? app.store.conversation(action.payload.parentId) : null;
    if ((target && !ctx.service.canSee(ctx.identity, target)) || (parent && !ctx.service.canSee(ctx.identity, parent))
        || (action.payload?.parentId && !parent)) {
      return json({ error: 'Unknown conversation', code: 'unknown-conversation' }, { status: 404 });
    }
    if (action.op === ACTIONS.MOVE_SCOPE && !target) return json({ error: 'Unknown conversation', code: 'unknown-conversation' }, { status: 404 });
  }

  const seen = app.store.appliedAction(action.action_id);
  if (seen) {
    return json({ events: peer ? [] : filterEvents(ctx, app.store, app.store.between(seen.cursor_before, seen.cursor_after)), cursor: app.store.cursor(), replayed: true },
      { headers: { 'cache-control': 'no-store' } });
  }

  const before = app.store.cursor();
  try {
    if (action.op === ACTIONS.MOVE_SCOPE) {
      // The dropdown and the router are one operation (scopes.move). A widening move needs the
      // owner's confirmation in the payload; the screen that asks is the client's, the check is here.
      await ctx.service.move({
        identity: ctx.identity,
        conversationId: action.conversation_id,
        to: String(action.payload?.to || ''),
        confirmed: action.payload?.confirmed === true,
        actor: 'owner',
        moveId: action.action_id
      });
    } else {
      applyAction(action, { identity: ctx.identity, attribution: { actor: 'human', basis: 'interactive-owner-channel', source: 'webchat-action', deviceId: action.device_id, authorVerified: false } });
    }
  } catch (cause) {
    const scoped = scopeHttpError(cause);
    if (scoped) return json(scoped.body, { status: scoped.status });
    return json({ error: cause.message }, { status: 409 });
  }
  app.store.markApplied({
    actionId: action.action_id,
    conversationId: action.conversation_id,
    op: action.op,
    cursorBefore: before,
    cursorAfter: app.store.cursor(),
  });
  // Extensions observe the owner's live actions (never a replayed one: the replay branch above returned already). A rule's
  // failure is logged and never fails his action.
  if (process.env.TOPHAT_EXTENSIONS_FILE) {
    const live = coreActionOf(action, 'user');
    if (live) extensions().then((host) => observe(host, live)).then((rs) => { for (const r of rs || []) if (!r.ok) console.error(`[extensions] ${r.ext}/${r.rule}: ${r.error}`); }).catch((e) => console.error(`[extensions] observe: ${e.message}`));
  }
  
  
  // A peer takes the chat from its feed (/api/sync, /api/events), by event id; the reply is only the acknowledgement.
  return json({ events: peer ? [] : filterEvents(ctx, app.store, app.store.since(before)), cursor: app.store.cursor() },
    { headers: { 'cache-control': 'no-store' } });
}
