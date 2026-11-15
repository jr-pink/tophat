// The scope service: which scopes an account may open, who may read which chat, and the one
// operation that changes a chat's scope.
//
// Everything is behind the `scopes.enabled` config flag (default off). With it off `enabled` is
// false, every check passes, and a deployment behaves exactly as it did before scopes existed.
//
// The registry (src/scopes/registry.mjs) answers who an account is and which scopes it may open.
// This module adds the chat side: access checks on every chat read and write, and `move`, which
// is the single path for the dropdown and for the router. Rules that do not touch storage live in
// core/scopes.js.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as registryModule from '../../../../runner/src/scopes/registry.mjs';
import {
  DEFAULT_SCOPE_RULES, LEGACY_SCOPE, accountOfPersonal, isPersonalScope, isWidening, normalizeRules, opennessOf, personalScopeOf
} from '../core/scopes.js';
import { newId } from '../core/contract.js';

/** A refusal that carries the HTTP status the route should answer with. */
export class ScopeError extends Error {
  constructor(code, message, status = 409, extra = {}) {
    super(message);
    this.name = 'ScopeError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// -- configuration -------------------------------------------------------------------------------

/**
 * `scopes` in the config file, with env overrides for a service plist and for tests:
 *   enabled        WEBCHAT_SCOPES=1                  default off
 *   registryFile   WEBCHAT_SCOPES_REGISTRY           the registry JSON (src/scopes/registry.mjs); also read as registryPath
 *   defaultScope   WEBCHAT_SCOPES_DEFAULT            where chats from before scopes live once it is on
 *   newChatScope   WEBCHAT_SCOPES_NEW                where a new chat starts when none is asked for and the account may open it
 *                                                    (else its personal scope); the router can still move it
 *   router.enabled WEBCHAT_SCOPE_ROUTER=1            the cheap-model router; its own flag, default off
 */
export function scopesConfig({ env = process.env, configFile = null } = {}) {
  let file = {};
  const path = configFile || env.TOPHAT_CONFIG || join(env.HOME || homedir(), '.config/tophat/config.json');
  try { if (existsSync(path)) file = JSON.parse(readFileSync(path, 'utf8'))?.scopes || {}; } catch { file = {}; }
  const flag = (value, fallback) => (value === undefined ? fallback : value === '1' || value === 'true' || value === true);
  return {
    enabled: flag(env.WEBCHAT_SCOPES, Boolean(file.enabled)),
    registryPath: env.WEBCHAT_SCOPES_REGISTRY || file.registryFile || file.registryPath || null,
    defaultScope: env.WEBCHAT_SCOPES_DEFAULT || file.defaultScope || null,
    newChatScope: env.WEBCHAT_SCOPES_NEW || file.newChatScope || null,
    router: { enabled: flag(env.WEBCHAT_SCOPE_ROUTER, Boolean(file.router?.enabled)) }
  };
}

// -- the registry as this module needs it ----------------------------------------------------------

/**
 * Adapts src/scopes/registry.mjs. `loaded` is what loadRegistry returned (the parsed registry); it
 * is where a group's `everyone` and member list come from, which decide how open the scope is.
 */
export function registryApi(source, api = registryModule) {
  // `source` is the parsed registry, or a function returning the current one (reloadingRegistry), so accounts added to the
  // registry file while the server runs are known to this service as they already are to the sign-in gate.
  const current = typeof source === 'function' ? source : () => source;
  const scopeEntry = (id) => current()?.scopes?.[id] || null;
  const opennessFor = (id) => {
    const entry = scopeEntry(id);
    if (!entry) return opennessOf(id);
    if (entry.kind === 'personal') return 0;
    return entry.everyone ? 2 : 1;
  };
  return {
    accountsFor: (identity) => api.accountsFor(identity, current()),
    canAccess: (account, scope) => api.canAccess(account, scope, current()),
    listScopes: (account) => api.listScopes(account, current()).map((entry) => ({ ...entry, openness: opennessFor(entry.id) })),
    opennessOf: opennessFor,
    // One scope's registry entry ({ id, kind, label, everyone, ... }) or null: what a machine caller with no account is checked against.
    entry: (id) => scopeEntry(id)
  };
}

/** The registry file, parsed again whenever its mtime changes (the sign-in gate already does: edge-gate.mjs registryFromFile). */
export function reloadingRegistry(file, api = registryModule) {
  let stamp = null, loaded = null;
  return () => {
    const m = statSync(file).mtimeMs;
    if (!loaded || m !== stamp) { loaded = api.loadRegistry(file); stamp = m; }
    return loaded;
  };
}

// -- the service -----------------------------------------------------------------------------------

/**
 * @param store        the primary store: the move log and the account rules live here
 * @param storeFor     scope id -> the store that holds that scope's chats. One store for every scope
 *                     (the default) makes a move an in-place retag; two stores make it a real copy,
 *                     verify and delete at the source, which is what a per-scope backend gets.
 * @param registry     see registryApi
 * @param hooks        removeDerivedMemory({ conversationId, from, to, moveId, actor }) is the seam for
 *                     the memory layer; until it is wired the move log records that it was not.
 */
export function createScopeService({
  store, storeFor = () => store, registry = null, config = scopesConfig(), hooks = {}, isBusy = () => false,
  now = () => new Date().toISOString(), idFor = newId
} = {}) {
  const enabled = Boolean(config.enabled && registry);
  const defaultScope = config.defaultScope || LEGACY_SCOPE;

  const unknownAccount = () => new ScopeError('denied', 'This account has no access to that scope.', 403);

  /** The caller's account and what it may open, or null when scopes are off. */
  function contextFor(identity) {
    if (!enabled) return null;
    const found = identity ? registry.accountsFor(identity) : null;
    if (!found) return { account: null, personalScope: null, scopes: [], denied: true };
    return {
      account: found.account,
      name: found.name || found.account,
      personalScope: found.personalScope || personalScopeOf(found.account),
      scopes: registry.listScopes(found.account)
    };
  }

  const scopeOf = (conversation) => conversation?.scope || defaultScope;

  function canAccess(identity, scope) {
    if (!enabled) return true;
    const ctx = contextFor(identity);
    return Boolean(ctx?.account) && registry.canAccess(ctx.account, scope);
  }

  /** Can this identity read or write this chat? Always true with scopes off. */
  function canSee(identity, conversation) {
    if (!enabled) return true;
    if (!conversation) return false;
    return canAccess(identity, scopeOf(conversation));
  }

  /** canSee for many chats of one caller: the account is looked up once and each scope's answer is kept, so a batch costs one
   *  registry lookup per distinct scope, not two per row (a store of thousands of chats across hundreds of scopes, as the public demo's
   *  guests make, spent seconds per bootstrap and sync re-scanning every scope for every row). For one batch only: a move changes the answer. */
  function seerFor(identity) {
    if (!enabled) return () => true;
    const account = contextFor(identity)?.account || null;
    const memo = new Map();
    return (conversation) => {
      if (!conversation || !account) return false;
      const scope = scopeOf(conversation);
      let ok = memo.get(scope);
      if (ok === undefined) { ok = registry.canAccess(account, scope); memo.set(scope, ok); }
      return ok;
    };
  }

  function assertCanSee(identity, conversation) {
    if (!canSee(identity, conversation)) throw new ScopeError('denied', 'No access to this chat.', 403);
    return conversation;
  }

  /** Which scope a chat created now goes into: the one asked for when the account may open it, else its personal scope. */
  function scopeForNewChat(identity, requested = null) {
    if (!enabled) return null;
    const ctx = contextFor(identity);
    if (!ctx?.account) throw unknownAccount();
    if (requested && registry.canAccess(ctx.account, requested)) return requested;
    if (requested) throw new ScopeError('denied', 'No access to that scope.', 403);
    if (config.newChatScope && registry.canAccess(ctx.account, config.newChatScope)) return config.newChatScope;
    return ctx.personalScope;
  }

  /** Backfill chats from before scopes into the default scope; idempotent. */
  function backfill() {
    if (!enabled) return 0;
    return store.backfillScope(defaultScope);
  }

  // -- rules the router reads ---------------------------------------------------------------------

  const rulesFor = (identity) => {
    const ctx = contextFor(identity);
    if (!ctx?.account) return { prompt: DEFAULT_SCOPE_RULES, custom: false };
    const own = store.scopeRules(ctx.account);
    return { prompt: own || DEFAULT_SCOPE_RULES, custom: Boolean(own) };
  };

  function setRules(identity, text) {
    const ctx = contextFor(identity);
    if (!ctx?.account) throw unknownAccount();
    const prompt = normalizeRules(text);
    // Writing nothing, or writing the default back, returns the account to the shipped default.
    store.setScopeRules(ctx.account, !prompt || prompt === DEFAULT_SCOPE_RULES ? null : prompt, now());
    return rulesFor(identity);
  }

  // -- the move -----------------------------------------------------------------------------------

  /**
   * Move a chat, and its whole history, to another scope. The same operation whether the owner
   * picks it from the dropdown or the router picks it after the first message; only the owner's
   * widening needs `confirmed`.
   *
   * Steps, each written to the move log as it completes (core/scopes.js MOVE_STEPS):
   *   authorize       the account may open both scopes; a chat mid-run is not moved across stores
   *   snapshot        the history is read once and fingerprinted
   *   copy            into the destination (a retag when both scopes share a store)
   *   verify          the destination's fingerprint equals the snapshot's; a mismatch undoes the copy
   *                   and leaves the source untouched
   *   delete-source   the source copy is removed and confirmed gone (nothing to remove in place)
   *   revoke-shares   moving to a less open scope withdraws the chat's public share links
   *   derived-memory  hooks.removeDerivedMemory (app.js installs scope-memory.js's: memory-cloud primary only, otherwise `skipped`); recorded as not wired when no hook is installed
   *   log             the move row is closed
   * Replaying the same `moveId` returns the finished move, or resumes one that stopped halfway.
   */
  async function move({ identity, conversationId, to, confirmed = false, actor = 'owner', moveId = idFor(), reason = null }) {
    if (!enabled) throw new ScopeError('disabled', 'Scopes are not enabled.', 409);
    const ctx = contextFor(identity);
    if (!ctx?.account) throw unknownAccount();

    const prior = store.scopeMove(moveId);
    if (prior?.state === 'done') return { ok: true, replayed: true, moved: prior.from !== prior.to, moveId, from: prior.from, to: prior.to };

    const found = locate(conversationId, [prior?.from, to, ...ctx.scopes.map((entry) => entry.id)]);
    if (!found) throw new ScopeError('unknown-conversation', 'No such chat.', 404);
    const from = prior?.from || scopeOf(found.conversation);
    if (from === to && !prior) return { ok: true, moved: false, moveId, from, to };

    // authorize
    if (!registry.canAccess(ctx.account, from)) throw new ScopeError('denied', 'No access to this chat.', 403);
    if (!registry.canAccess(ctx.account, to)) throw new ScopeError('denied', 'No access to that scope.', 403);
    const source = storeFor(from);
    const dest = storeFor(to);
    const inPlace = source === dest;
    if (!inPlace && isBusy(conversationId)) throw new ScopeError('busy', 'This chat is answering; move it when it finishes.', 409);
    if (!prior && actor === 'owner' && isWidening(from, to, ctx.scopes) && !confirmed) {
      throw new ScopeError('needs-confirmation', 'Moving to a more open scope needs confirmation.', 409, { widening: true, from, to });
    }

    if (!prior) store.beginScopeMove({ moveId, conversationId, from, to, actor, account: ctx.account, reason, at: now() });
    const step = (name, detail) => store.scopeMoveStep(moveId, name, detail, now());
    if (!prior) step('authorize', { account: ctx.account });
    const fail = (state, code, message) => {
      store.finishScopeMove(moveId, { state, at: now() });
      throw new ScopeError(code, message, 500);
    };

    // snapshot (read from wherever the history is now: the source, or already the destination)
    const holder = source.conversation(conversationId) ? source : dest;
    const bundle = holder.exportConversation(conversationId);
    step('snapshot', { count: bundle.digest.count, digest: bundle.digest.hash });

    // copy
    const marker = { scope: to, scopeMove: { id: moveId, from, to, actor } };
    if (inPlace) {
      if (scopeOf(source.conversation(conversationId)) !== to) source.append(conversationId, 'conversation.meta', marker, { at: now() });
      step('copy', { mode: 'retag' });
    } else {
      if (dest.conversation(conversationId)) {
        // A copy a stopped move left behind: kept when it already matches, rebuilt when it does not.
        if (dest.conversationDigest(conversationId).hash !== bundle.digest.hash) dest.deleteConversation(conversationId);
      }
      if (!dest.conversation(conversationId)) dest.importConversation(bundle, { scope: to });
      step('copy', { mode: 'copy' });
    }

    // verify
    const landed = dest.conversationDigest(conversationId);
    if (landed.hash !== bundle.digest.hash || landed.count !== bundle.digest.count) {
      if (inPlace) {
        // Put the scope back; the marker stays as the record of the attempt.
        source.append(conversationId, 'conversation.meta', { scope: from, scopeMove: { id: `${moveId}:undo`, from: to, to: from, actor } }, { at: now() });
      } else dest.deleteConversation(conversationId);
      fail('failed-verify', 'verify-failed', 'The copy did not match the original, so the chat was not moved.');
    }
    step('verify', { count: landed.count, digest: landed.hash });
    if (!inPlace && scopeOf(dest.conversation(conversationId)) !== to) dest.append(conversationId, 'conversation.meta', marker, { at: now() });

    // delete-source
    if (inPlace) step('delete-source', { mode: 'in-place' });
    else {
      // Whoever could read it there is told it left (the marker), then the copy is removed and checked.
      if (source.conversation(conversationId)) {
        source.append(conversationId, 'conversation.meta', marker, { at: now() });
        source.deleteConversation(conversationId);
      }
      if (source.conversation(conversationId)) fail('failed-delete', 'delete-failed', 'The chat could not be removed from its old scope.');
      step('delete-source', { mode: 'deleted' });
    }

    // revoke-shares: a chat that becomes less open must not stay readable through a public link
    if (!isWidening(from, to, ctx.scopes) && typeof hooks.revokeShares === 'function') {
      try { step('revoke-shares', (await hooks.revokeShares({ conversationId, from, to, moveId })) || { status: 'ok' }); }
      catch (cause) { step('revoke-shares', { error: String(cause?.message || cause) }); }
    }

    // derived-memory
    let memory = { status: 'not-wired' };
    if (typeof hooks.removeDerivedMemory === 'function') {
      try {
        memory = (await hooks.removeDerivedMemory({ conversationId, from, to, moveId, actor })) || { status: 'ok' };
      } catch (cause) {
        step('derived-memory', { error: String(cause?.message || cause) });
        // The history is already where it belongs; what is left is memory derived from it in the old
        // scope. The move stays open and is retried by its id (resumePending).
        store.finishScopeMove(moveId, { state: 'memory-pending', count: landed.count, digest: landed.hash, at: now() });
        return { ok: true, moved: true, moveId, from, to, memoryPending: true };
      }
    }
    step('derived-memory', memory);

    // log
    store.finishScopeMove(moveId, { state: 'done', count: landed.count, digest: landed.hash, at: now() });
    step('log');
    return { ok: true, moved: true, moveId, from, to, memory };
  }

  // Where a chat is now: the stores of the scopes the caller may open, nothing else, so a chat in a
  // scope it cannot open reads as absent.
  function locate(conversationId, scopeIds) {
    const candidates = [...scopeIds, defaultScope].filter(Boolean);
    const seen = new Set();
    for (const scope of candidates) {
      const holder = storeFor(scope);
      if (seen.has(holder)) continue;
      seen.add(holder);
      const conversation = holder.conversation(conversationId);
      if (conversation) return { holder, conversation };
    }
    const own = store.conversation(conversationId);
    return own ? { holder: store, conversation: own } : null;
  }

  /** Retry the derived-memory step of moves that stopped there. */
  async function resumePending() {
    const results = [];
    for (const row of store.scopeMoves().filter((m) => m.state === 'memory-pending')) {
      const account = row.account;
      try {
        const out = await hooks.removeDerivedMemory?.({ conversationId: row.conversationId, from: row.from, to: row.to, moveId: row.moveId, actor: row.actor });
        store.scopeMoveStep(row.moveId, 'derived-memory', out || { status: 'ok' }, now());
        store.finishScopeMove(row.moveId, { state: 'done', count: row.count, digest: row.digest, at: now() });
        results.push({ moveId: row.moveId, account, state: 'done' });
      } catch (cause) {
        results.push({ moveId: row.moveId, account, state: 'memory-pending', error: String(cause?.message || cause) });
      }
    }
    return results;
  }

  return {
    enabled, defaultScope, config,
    contextFor, canAccess, canSee, seerFor, assertCanSee, scopeOf, scopeForNewChat, backfill,
    rulesFor, setRules, move, resumePending,
    scopeEntry: (scope) => (enabled ? registry.entry?.(scope) ?? null : null),
    personalOf: (account) => personalScopeOf(account),
    isPersonal: isPersonalScope,
    accountOfPersonal
  };
}

// -- one service per store -------------------------------------------------------------------------

const services = new WeakMap();

/**
 * The service for a store, built on first use from the config. Routes and applyAction ask for it by
 * store so a hot-swapped or adopted app object needs nothing added to it; with scopes off it is a
 * disabled service whose checks all pass.
 */
export function scopeServiceFor(store, { runner = null, configFile = null, env = process.env, hooks = null } = {}) {
  let service = services.get(store);
  if (service) return service;
  const config = scopesConfig({ env, configFile });
  let registry = null;
  if (config.enabled) {
    if (!config.registryPath) throw new Error('scopes.enabled is on but scopes.registryFile names no registry');
    registry = registryApi(reloadingRegistry(config.registryPath));
  }
  service = createScopeService({
    store, registry, config, hooks: hooks || scopeHooks,
    isBusy: (id) => Boolean(runner?.isBusy?.(id))
  });
  if (service.enabled) service.backfill();
  services.set(store, service);
  return service;
}

/** Hooks the app installs: revokeShares and removeDerivedMemory (app.js). With none installed a move logs the step as not wired. */
export const scopeHooks = {};

/** Tests install their own service for a store. */
export function installScopeService(store, service) { services.set(store, service); return service; }
