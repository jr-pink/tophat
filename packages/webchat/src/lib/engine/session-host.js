// The tab's side of the chat engine: the createSession() API (client/session.js) over a connection to the one
// engine per browser. It renders and handles input only (A11): no reducer fold of server events, no IndexedDB, no
// EventSource. It keeps two things of its own, because they belong to this tab:
// - provisional chats (core/transient.js: the empty chat a tab opens into, which no other tab and no server knows), and
// - the optimistic echo of its own actions until the engine's patch carries them, so a send shows the instant it is
//   made, exactly as the legacy session showed it. The id of each action is minted here (a ULID) and is the one the
//   engine persists and sends, so a call re-sent after an engine hand-over is the same intent, deduplicated.

import { ACTIONS, makeAction, newId } from '../core/contract.js';
import { applyOptimistic, emptyState, forgetConversation, mergeConversations, setConversationScope } from '../core/reducer.js';
import { isIncognito } from '../core/incognito.js';
import { connectEngine } from '../../../../runner/tools/docstore-kit/lib/engine/host.js';
import { ulid } from '../../../../runner/tools/docstore-kit/lib/engine/ulid.js';
import { openExisting, req } from '../../../../runner/tools/docstore-kit/lib/engine/idb.js';
import { makeChatServer } from './chat-engine.js';
import { ENGINE_DB } from './chat-store.js';
import { readLegacyLocal } from './migrate.js';

function defaultConnect(options = {}) {
  return connectEngine({
    name: 'tophat-chat',
    shared: () => new SharedWorker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'tophat-chat-engine' }),
    dedicated: () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'tophat-chat-engine' }),
    local: () => makeChatServer(options.serverOptions || {}),
    ...options
  });
}

/** The engine's stored chat list, read by the tab itself, read only, so the first paint does not wait for the worker to
 * start. The same header snapshot the engine's start() paints from (engine/core.js), with the cursor it reflects.
 * Never creates the database (openExisting), holds its connection only for one read transaction, and closes it at once
 * if the engine asks for an upgrade. Resolves `{ headers, cursor }` or null (no engine database, no snapshot yet, any
 * error).
 */
export async function peekHeaders({ indexedDB: idb = globalThis.indexedDB, name = ENGINE_DB } = {}) {
  if (!idb) return null;
  const db = await openExisting(idb, name);
  if (!db) return null;
  db.onversionchange = () => db.close();
  try {
    if (!db.objectStoreNames.contains('meta')) return null;
    const meta = db.transaction('meta', 'readonly').objectStore('meta');
    const [headers, reflects, high] = await Promise.all([req(meta.get('headers')), req(meta.get('headersCursor')), req(meta.get('__high'))]);
    if (!Array.isArray(headers) || !headers.length) return null;
    const top = Number.isSafeInteger(high) ? high : 0;
    return { headers, cursor: Number.isSafeInteger(reflects) ? Math.min(reflects, top) : top };
  } catch { return null; } finally { db.close(); }
}

export function createEngineSession({ connect = defaultConnect, connectOptions = {}, accepts = (id) => !isIncognito(id), newIdImpl = newId,
  mintId = ulid, storage = globalThis.localStorage, win = globalThis.window, doc = globalThis.document,
  peek = connect === defaultConnect ? () => peekHeaders() : null } = {}) {
  const mark = (name) => { try { globalThis.performance?.mark?.(name); } catch { /* no user timing */ } };
  mark('engine:connect');
  const client = connect(connectOptions);
  const subscribers = new Set();
  const provisional = new Map();
  const mine = new Map(); // action id -> action, until the engine's reply (its patch arrived first)
  const dropped = new Set(); // revoked chats this tab already dropped, until the engine's state agrees
  let base = emptyState();
  // Until the engine has published a chat list (or its start() resolved), the tab shows the stored list it read itself
  // (peekHeaders); from then on only the engine's state, so nothing of the peek outlives the engine's first word.
  let engineListed = false;
  let peeked = null;
  let engineStatus = null;
  let state = base;
  let status = { online: true, reachable: true, offline: false, connected: false, syncing: false, cached: false, fullyCached: false, error: null, engine: client.kind };
  const cost = { handlers: 0, totalMs: 0, worstMs: 0, over16: 0 };
  const clock = () => (globalThis.performance?.now?.() ?? Date.now());

  function recompute() {
    const t0 = clock();
    let s = base;
    for (const [id, payload] of provisional) {
      if (!s.conversations[id]) s = applyOptimistic(s, { op: ACTIONS.CREATE, conversation_id: id, payload, at: payload.__at, action_id: `provisional-${id}` });
    }
    for (const action of mine.values()) { try { s = applyOptimistic(s, action); } catch { /* total */ } }
    for (const id of dropped) { if (s.conversations[id]) s = forgetConversation(s, id); else dropped.delete(id); }
    state = s;
    status = { ...(engineStatus || status), engine: client.kind };
    // The outbox note counts this tab's sends the moment they are made, as the legacy session did (it set `queued`
    // synchronously at dispatch): what the engine owes plus what this tab sent that the engine has not yet shown.
    const owed = base.owed;
    if (owed) {
      const known = new Set(owed.items.map((o) => o.id));
      let local = 0; let localMessages = 0;
      const byChat = { ...(owed.byConversation || {}) };
      for (const [id, action] of mine) if (!known.has(id)) { local += 1; if (action.op === ACTIONS.SEND) { localMessages += 1; const cid = String(action.conversation_id ?? action.conversationId ?? ''); byChat[cid] = (byChat[cid] || 0) + 1; } }
      status.unsentByConversation = byChat;
      if (local || owed.pending !== (status.queued || 0)) status.queued = owed.pending + local;
      if (localMessages || (owed.messages ?? 0) !== (status.unsentMessages || 0)) status.unsentMessages = (owed.messages ?? 0) + localMessages;
    }
    for (const fn of subscribers) fn(state, status);
    const ms = clock() - t0;
    cost.handlers += 1; cost.totalMs += ms; cost.worstMs = Math.max(cost.worstMs, ms); if (ms > 16) cost.over16 += 1;
  }

  let engineView = null; // the engine's last state, kept while the peek is shown
  const fromEngine = () => { base = { ...emptyState(), ...(engineView || {}), seen: base.seen, itemIndex: base.itemIndex }; };
  client.subscribe((s, st) => {
    if (!engineListed && s && Object.keys(s.conversations || {}).length) { engineListed = true; peeked = null; mark('engine:first-list'); }
    engineView = s;
    engineStatus = st || engineStatus;
    if (!engineListed && peeked) return; // the worker's hello snapshot (empty, before its boot) must not blank the peek
    fromEngine();
    recompute();
  });
  if (typeof peek === 'function') {
    Promise.resolve().then(peek).then((got) => {
      if (!got || engineListed || !got.headers?.length) return;
      peeked = got;
      base = { ...mergeConversations(emptyState(), got.headers), cursor: got.cursor };
      mark('engine:peek-list');
      recompute();
    }).catch(() => {});
  }
  function engineSpeaks() {
    if (engineListed) return;
    engineListed = true;
    if (peeked) { peeked = null; fromEngine(); recompute(); }
  }

  const call = (m, ...a) => client.call(m, ...a);

  async function dispatch(op, conversationId, payload = {}, { actionId = null } = {}) {
    if (!accepts(conversationId)) return undefined;
    if (provisional.has(conversationId) && op !== ACTIONS.CREATE) {
      if (op === ACTIONS.TOUCH || op === ACTIONS.READ) return undefined;
      commitProvisional(conversationId);
    }
    const id = actionId || mintId();
    if (mine.has(id)) return undefined;
    const action = makeAction({ op, conversationId, payload, deviceId: 'tab', deviceSeq: 1, at: new Date().toISOString(), actionId: id });
    mine.set(id, action);
    recompute();
    try { return await call('dispatch', op, conversationId, payload, { actionId: id }); }
    finally { mine.delete(id); recompute(); }
  }

  function createProvisional(conversationId, payload = {}) {
    if (!conversationId || state.conversations[conversationId] || !accepts(conversationId)) return false;
    provisional.set(conversationId, { ...payload, __at: new Date().toISOString() });
    recompute();
    return true;
  }
  function commitProvisional(conversationId) {
    const held = provisional.get(conversationId);
    if (held === undefined) return false;
    provisional.delete(conversationId);
    const { __at, ...payload } = held;
    dispatch(ACTIONS.CREATE, conversationId, payload);
    return true;
  }
  function discardProvisional(conversationId) {
    if (!provisional.has(conversationId)) return false;
    provisional.delete(conversationId);
    recompute();
    return true;
  }

  let wired = false;
  function wireWindow() {
    if (wired || !win?.addEventListener) return;
    wired = true;
    win.addEventListener('online', () => call('setOnline', true).catch(() => {}));
    win.addEventListener('offline', () => call('setOnline', false).catch(() => {}));
    const flush = () => call('flushHeaders').catch(() => {});
    win.addEventListener('pagehide', () => { flush(); client.close?.(); });
    doc?.addEventListener?.('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') flush();
      else call('tabVisible').catch(() => {});
    });
  }

  async function start(opts = {}) {
    wireWindow();
    mark('engine:start');
    const legacy = readLegacyLocal(storage);
    const t0 = clock();
    const result = await call('start', opts, { device: legacy.device, legacyActions: legacy.actions });
    await client.ready;
    engineSpeaks(); // the engine has started: its state is the truth, even an empty list
    status = { ...status, engineStartMs: clock() - t0, migration: result?.migration ?? null };
    recompute();
    return result;
  }

  return {
    start,
    hydrate: (id) => (accepts(id) && !provisional.has(id) ? call('hydrate', id) : Promise.resolve()),
    loadEarlier: (id) => call('loadEarlier', id),
    canLoadEarlier: (id) => Boolean(base.earlier?.[id]),
    loadFullLog: () => call('loadFullLog'),
    search: (query, options) => call('search', query, options),
    file: (path, options) => call('file', path, options),
    flushOutbox: () => call('flushOutbox'),
    syncWeek: () => call('syncWeek'),
    get state() { return state; },
    get status() { return status; },
    get outbox() { return [...mine.values()]; },
    usage: () => call('usage'),
    health: () => call('health'),
    inspect: (id) => call('inspect', id),
    /** The parity harness's probe (docs/parity-harness.md): what the engine owes, read from the last patch. Sync. */
    probe() {
      const owed = base.owed || { pending: 0, armed: 0, inflight: [], items: [] };
      const local = [...mine.values()].filter((a) => !owed.items.some((o) => o.id === a.action_id));
      return {
        outboxDepth: () => owed.pending + local.length,
        outboxTexts: () => [...owed.items.map((o) => o.text), ...local.map((a) => a.payload?.text ?? null)].filter((t) => typeof t === 'string'),
        engine: () => ({ t: Date.now(), pending: owed.pending + local.length, armed: owed.armed, inflight: owed.inflight.map((x) => ({ since: x.since ?? Date.now() })) })
      };
    },
    mainThreadCost: () => ({ ...cost, client: client.stats?.() ?? null }),
    engineKind: () => client.kind,
    subscribe(fn) { subscribers.add(fn); fn(state, status); return () => subscribers.delete(fn); },
    newConversationId: () => newIdImpl(),
    create: (id, payload) => dispatch(ACTIONS.CREATE, id, payload),
    createProvisional, commitProvisional, discardProvisional,
    isProvisional: (id) => provisional.has(id),
    fork: (id, payload) => dispatch(ACTIONS.FORK, id, payload),
    send: (id, text, uploads = [], options = {}) => dispatch(ACTIONS.SEND, id, { text, uploads }, options),
    stageUpload: (id) => call('stageUpload', id),
    failUpload: (id, error = null) => call('failUpload', id, error),
    interrupt: (id) => dispatch(ACTIONS.INTERRUPT, id, {}),
    rename: (id, title) => dispatch(ACTIONS.RENAME, id, { title }),
    pin: (id, pinned) => dispatch(ACTIONS.PIN, id, { pinned }),
    archive: (id, archived) => dispatch(ACTIONS.ARCHIVE, id, { archived }),
    setAside: (id, aside) => dispatch(ACTIONS.ASIDE, id, { aside }),
    setWorkspace: (id, workspace) => dispatch(ACTIONS.WORKSPACE, id, { workspace: workspace || null }),
    setHost: (id, host) => dispatch(ACTIONS.HOST, id, { host: host || null }),
    defer: (id, { until = null, condition = null } = {}) => dispatch(ACTIONS.DEFER, id, { until, condition }),
    touch: (id) => dispatch(ACTIONS.TOUCH, id, {}),
    markRead: (id, read = true, { mute = true } = {}) => dispatch(ACTIONS.READ, id, { read, mute, seenCursor: mute === false ? (state.cursor ?? null) : null }),
    settings: (id, settings) => dispatch(ACTIONS.SETTINGS, id, { settings }),
    dropRevoked: () => {
      const gone = Object.values(state.conversations).filter((c) => c.revoked && !provisional.has(c.id)).map((c) => c.id);
      if (!gone.length) return gone;
      for (const id of gone) dropped.add(id);
      recompute();
      call('dropRevoked').catch(() => {});
      return gone;
    },
    moveScope: (id, to, { confirmed = false, from = null } = {}) => {
      if (provisional.has(id)) {
        provisional.set(id, { ...provisional.get(id), scope: to, scopeChosen: true });
        state = setConversationScope(state, id, to);
        recompute();
        return undefined;
      }
      return dispatch(ACTIONS.MOVE_SCOPE, id, { to, confirmed, from });
    }
  };
}
