// Scope enforcement at the HTTP edge: who is asking, which chats they may see, and the filter every
// route that returns chat events or rows passes its answer through.
//
// With scopes off every function here is a pass-through, so the routes read the same as before.

import { error } from '@sveltejs/kit';
import { ScopeError, scopeServiceFor } from './scopes.js';

/**
 * Who is asking. Sign-in (hooks.server.js through src/scopes/edge-gate.mjs) puts the verified account on
 * `event.locals.scopeContext`, whose email is the identity the registry maps to an account; `event.locals.identity`
 * is accepted too. A test server (WEBCHAT_SCOPES_TEST_IDENTITY=1) may also name one in the
 * `x-test-identity` header; a production process never reads it.
 */
export function identityOf(event, env = process.env) {
  const verified = event?.locals?.identity || event?.locals?.scopeContext?.email;
  if (verified) return verified;
  if (env.WEBCHAT_SCOPES_TEST_IDENTITY === '1') return event?.request?.headers?.get('x-test-identity') || null;
  return null;
}

/** The scope service and the caller, for a route. `enabled` false means nothing below restricts anything. */
export function scopeContext(event, store, runner = null) {
  const service = scopeServiceFor(store, { runner });
  return { service, enabled: service.enabled, identity: identityOf(event), store };
}

/** Throw the HTTP error for a chat the caller may not open. A chat that does not exist is a 404, never a hint. */
export function requireChat(ctx, conversation) {
  if (!ctx.enabled) return conversation;
  if (!conversation) error(404, 'Unknown conversation');
  // A chat in a scope the caller cannot open answers as if it did not exist.
  if (!ctx.service.canSee(ctx.identity, conversation)) error(404, 'Unknown conversation');
  return conversation;
}

/** Event rows the caller may see, plus a sanitized "this left your scope" marker for chats that just moved away. */
export function eventFilter(ctx, store, { cached = true } = {}) {
  if (!ctx.enabled) return null;
  // One batch may remember its answers; a live stream may not, because a move changes them mid-stream.
  const cache = cached ? new Map() : null;
  const see = cached && ctx.service.seerFor ? ctx.service.seerFor(ctx.identity) : (conversation) => ctx.service.canSee(ctx.identity, conversation);
  const check = (conversationId) => see(store.conversation(conversationId));
  const visible = (conversationId) => {
    if (!cache) return check(conversationId);
    if (!cache.has(conversationId)) cache.set(conversationId, check(conversationId));
    return cache.get(conversationId);
  };
  return (event) => {
    if (visible(event.conversation_id)) return event;
    // The move marker is the only event of a chat the caller cannot see that reaches them, stripped
    // of where the chat went, so a tab holding the chat knows to drop it.
    if (event.kind === 'conversation.meta' && event.content?.scopeMove) {
      return { ...event, content: { revoked: true } };
    }
    return null;
  };
}

export function filterEvents(ctx, store, events) {
  const filter = eventFilter(ctx, store);
  return filter ? events.map(filter).filter(Boolean) : events;
}

export function filterRows(ctx, rows) {
  if (!ctx.enabled) return rows;
  const see = ctx.service.seerFor ? ctx.service.seerFor(ctx.identity) : (row) => ctx.service.canSee(ctx.identity, row);
  return rows.filter(see);
}

/** A store view for the event stream: subscribe and since() deliver only what the caller may see. */
export function scopedStore(ctx, store) {
  if (!ctx.enabled) return store;
  const live = eventFilter(ctx, store, { cached: false });
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'since') return (...args) => { const batch = eventFilter(ctx, store); return target.since(...args).map(batch).filter(Boolean); };
      if (prop === 'subscribe') {
        return (listener) => target.subscribe((event) => { const out = live(event); if (out) listener(out); });
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/** Map a ScopeError thrown below a route to its HTTP answer. */
export function scopeHttpError(cause) {
  if (cause instanceof ScopeError) return { status: cause.status, body: { error: cause.message, code: cause.code, ...(cause.widening ? { widening: true, from: cause.from, to: cause.to } : {}) } };
  return null;
}
