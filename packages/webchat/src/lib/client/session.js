

import { ACTIONS, makeAction, newId } from '../core/contract.js';
import { applyOptimistic, emptyState, evictConversations, foldedItemCount, forgetConversation, hasSeen, setConversationScope, LIVE_RUN_STATES, markAllUnhydrated, markHydrated, mergeConversations, mergeSidebar, reconcileLiveness, reduceEvents, seenCount } from '../core/reducer.js';
import { openReplica } from './replica.js';
import { isIncognito } from '../core/incognito.js';
import { remoteImageUrl } from '../core/rich-content.js';
import { fromApp, syncWindow } from './week-sync.js';
import {
  DELIVERY_EFFECTS, deliveryStep, initialDelivery, pendingUploadsOf,
  unsentMessages, unsentByConversation, waitingUploadsByConversation
} from '../core/delivery.js';
import { createEngineSession } from '../engine/session-host.js';
import { engineSelected, isAppSession } from '../engine/flag.js';
import { rollbackToLegacy } from '../engine/migrate.js';
import { installParityProbe, installStateDump } from '../engine/state-dump.js';

const RETRY_MS = [400, 900, 2000, 5000, 12_000];

const HEAL_MS = [20_000, 40_000, 80_000, 160_000, 300_000];

const SSE_SILENCE_MS = 70_000;

const WATCHDOG_MS = 15_000;

const now = () => (globalThis.performance?.now?.() ?? Date.now());

function idle(task) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(task, { timeout: 2000 });
  else setTimeout(task, 200);
}

// `accepts` says which conversation ids this session holds. The app's session holds every chat but an incognito one, which
// belongs to its own session over an in-memory replica (client/incognito.js): an id it does not accept is never hydrated,
// dispatched, cached or sent from here, whatever pane or shortcut asks. `newIdImpl` mints new chat ids. A multiplayer room
// (client/mp-session.js) runs this same session over its own feed: `replicaOptions` names its own IndexedDB database and
// outbox, `deviceKey` its own device id, and `weekSync: false` keeps the background copy of his week (which reads the
// app's endpoints) out of a room tab. Only the app's own session switches. Coming back to legacy after the engine ran
// hands the engine's undelivered actions back to the legacy outbox first.
export function createSession(options = {}) {
  const app = isAppSession(options) && typeof window !== 'undefined';
  if (app && engineSelected()) {
    const session = createEngineSession(options);
    if (!window.__tophatState) { installStateDump(session, { core: 'docstore' }); installParityProbe(session); }
    return session;
  }
  const session = createLegacySession(options);
  if (app) {
    if (!window.__tophatState) installStateDump(session, { core: 'legacy' });
    // Hands back only if the engine ran (its own meta says so); otherwise one existence probe and nothing else.
    const legacyStart = session.start;
    session.start = async (...args) => { try { await rollbackToLegacy(); } catch { /* the legacy outbox is as it was */ } return legacyStart(...args); };
  }
  return session;
}

function createLegacySession({ fetchImpl, replicaImpl, eventSourceImpl, hydrateEvents, uploadPatienceMs,
  accepts = (id) => !isIncognito(id), newIdImpl = newId, replicaOptions = undefined,
  deviceKey = 'tophat-webchat-device', weekSync = true } = {}) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const EventSourceCtor = eventSourceImpl ?? globalThis.EventSource;

  let state = emptyState();
  let replica = null;
  let source = null;
  // A cold boot opens the live stream from the server's head while the first snapshot loads, instead of after it; what the
  // stream delivers meanwhile is held and folded once the snapshot has landed (events at or below its cursor are skipped by the reducer).
  let streamHold = null, streamFromTail = false;
  
  
  
  
  
  
  
  
  let lastMessageAt = null;
  let watchdogTimer = null;
  let retries = 0;
  let outbox = [];
  let deviceSeq = 0;
  const deviceId = readDeviceId(deviceKey);
  const subscribers = new Set();
  const hydrating = new Set();

  let fullLogLoaded = false;
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  let delivery = initialDelivery();
  // Why each failed upload failed, as the client saw it. The delivery state keeps only the ids
  // (its invariants are about which, not why); the reason rides on the outgoing action so the
  // model is told "failed: <reason>" instead of "still uploading".
  const uploadErrors = new Map();
  let flushing = null;
  
  
  
  
  
  
  
  
  
  const patienceMs = uploadPatienceMs ?? globalThis.__WEBCHAT_UPLOAD_PATIENCE_MS ?? null;
  const patienceTimers = new Map();
  
  
  let retryTimer = null;
  
  
  
  
  
  
  
  
  let lastLive = null;
  // Chats this tab is holding that no server has heard of: the transient chat the app opens
  // into (core/transient.js). Each value is the conversation.create payload to dispatch if and
  // when something commits it. Until then it is in `state` for the pane to render, out of the
  // replica headers, and out of the outbox.
  const provisional = new Map();
  let healStep = 0;
  let healTimer = null;
  // `online` is the browser's word (navigator.onLine); `reachable` is ours, and false whenever the
  // server could not be asked: no connection, a tunnel answering 502/530 with its own HTML page, a
  // captive portal. The phone is usually online while the server is down, so `online` alone never
  // said anything. `offline` is the one the UI reads: either of the two.
  let status = { online: true, reachable: true, offline: false, connected: false, syncing: false, cached: false, fullyCached: false, error: null };

  function publish() {
    for (const subscriber of subscribers) subscriber(state, status);
  }

  function setStatus(patch) {
    status = { ...status, ...patch };
    status.offline = status.online === false || status.reachable === false;
    publish();
  }

  // The server answered as itself, or something else answered for it.
  function heard(response) {
    const ok = fromApp(response);
    if (ok && status.reachable === false) {
      setStatus({ reachable: true, error: null, transcriptError: null });
      scheduleWeekSync(500);
    } else if (!ok && status.reachable !== false) setStatus({ reachable: false, connected: false });
    return ok;
  }
  function unheard() {
    if (status.reachable !== false) setStatus({ reachable: false, connected: false });
  }

  
  
  
  
  const CHUNK = 400;

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
  
  const yielders = [];
  if (channel) {
    channel.port1.onmessage = () => { yielders.shift()?.(); };
    channel.port1.start?.();
  }

  function yieldToMain() {
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    if (visible || !channel) return new Promise((resolve) => setTimeout(resolve, 0));
    return new Promise((resolve) => {
      yielders.push(resolve);
      channel.port2.postMessage(0);
    });
  }

  
  
  
  
  
  
  
  
  
  
  let folding = Promise.resolve();

  function absorbLarge(events, options) {
    const run = folding.then(() => foldChunks(events, options));
    folding = run.then(() => {}, () => {});
    return run;
  }

  async function foldChunks(events, { progressive = false, silent = false, ...options } = {}) {
    let changed = false;
    for (let at = 0; at < events.length; at += CHUNK) {
      
      
      
      changed = absorb(events.slice(at, at + CHUNK), { ...options, quiet: !progressive }) || changed;
      if (at + CHUNK < events.length) await yieldToMain();
    }
    if (changed && !progressive && !silent) publish();
    return changed;
  }

  
  
  
  
  
  
  
  
  
  
  
  
  
  const ITEM_BUDGET = 40_000;
  const ITEM_TARGET = 30_000;
  
  
  const SWEEP_EVERY = 2_000;
  let foldedSinceSweep = 0;

  
  
  
  
  const OPEN_KEEP = 12;
  let openRecent = [];

  function markOpen(conversationId) {
    if (!conversationId) return;
    openRecent = [conversationId, ...openRecent.filter((id) => id !== conversationId)].slice(0, OPEN_KEEP);
  }

  
  
  
  
  // The ledger of folded event ids (`state.seen`) is one string per event and is never pruned by
  // anything but eviction, while a delta folds into a row that already exists and so adds nothing
  // to the item count. Events are budgeted beside rows, and the same eviction answers both: the
  // conversation is re-read from the replica or the server when it is opened.
  const EVENT_BUDGET = 60_000;
  const EVENT_TARGET = 40_000;

  function enforceItemBudget() {
    let total = foldedItemCount(state);
    let events = seenCount(state);
    if (total <= ITEM_BUDGET && events <= EVENT_BUDGET) return;
    const keep = new Set(openRecent);
    for (const [id, conversation] of Object.entries(state.conversations)) {
      if (LIVE_RUN_STATES.has(conversation.runState)) keep.add(id);
    }
    const candidates = [...new Set([...Object.keys(state.items), ...state.seen.keys()])]
      .filter((id) => !keep.has(id) && (state.items[id]?.length || state.seen.get(id)?.size))
      .sort((a, b) => String(state.conversations[a]?.activeAt ?? '').localeCompare(String(state.conversations[b]?.activeAt ?? '')));
    const drop = [];
    for (const id of candidates) {
      if (total <= ITEM_TARGET && events <= EVENT_TARGET) break;
      total -= state.items[id]?.length || 0;
      events -= state.seen.get(id)?.size || 0;
      drop.push(id);
    }
    if (!drop.length) return;
    state = evictConversations(state, drop);
    // What the page reads: rows that remain, not rows plus ids.
    status.foldedItems = total;
    status.evicted = (status.evicted || 0) + drop.length;
  }

  // How many events this build could not fold, and why the last one failed.
  //
  // `reduceEvents` is strict on purpose: an unknown kind, an envelope from another contract
  // version and a run state outside RUN_STATES all throw (core/contract.js validateEvent,
  // core/reducer.js 'run.status'). Strictness inside a live stream used to be fatal, though --
  // the throw escaped `source.onmessage`, the whole frame died with it including the good events
  // beside the bad one, and `state.cursor` never moved, so every reconnect asked for the same
  // span and died on it again. One event a newer server added was enough to kill the tab in
  // silence.
  let quarantined = 0;

  function foldWithQuarantine(events) {
    let next = state;
    const accepted = [];
    for (const event of events) {
      try {
        next = reduceEvents(next, [event]);
        accepted.push(event);
      } catch (cause) {
        quarantined += 1;
        // A new object, not a mutation: the page compares identity to decide it has news.
        // The publish that ends `absorb` carries it, so a quiet chunked fold stays quiet.
        status = { ...status, skipped: quarantined, skipReason: cause.message };
        // Step over it, or the cursor sticks here for the life of the tab and every
        // reconnect asks the server for the same poisoned span.
        if (Number.isSafeInteger(event?.cursor) && event.cursor > next.cursor) {
          next = { ...next, cursor: event.cursor };
        }
      }
    }
    return [next, accepted];
  }

  function absorb(events, { persist = true, quiet = false } = {}) {
    if (!events?.length) return false;
    let next;
    let accepted = events;
    let skipped = false;
    try {
      next = reduceEvents(state, events);
    } catch {
      [next, accepted] = foldWithQuarantine(events);
      skipped = true;
    }
    if (next === state) {
      // Nothing folded and the cursor did not move (an event with no usable cursor at all),
      // but the reader is still owed the news that something was dropped.
      if (skipped && !quiet) publish();
      return false;
    }
    state = next;
    // Only what folded goes to disk. A poisoned event written to the replica comes back at
    // every cold boot, and start() folds that tail before anything else runs.
    if (persist && replica && accepted.length) replica.append(accepted);
    foldedSinceSweep += events.length;
    if (foldedSinceSweep >= SWEEP_EVERY) {
      foldedSinceSweep = 0;
      enforceItemBudget();
    }
    scheduleHeaderSnapshot();
    if (!quiet) publish();
    return true;
  }

  
  
  
  
  
  
  
  
  
  
  
  let headerTimer = null;
  let knownConversations = 0;

  function writeHeaderSnapshot() {
    const durable = Object.values(state.conversations).filter((c) => !provisional.has(c.id));
    knownConversations = durable.length;
    return replica.writeHeaders(durable.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        preview: conversation.preview,
        pinned: conversation.pinned,
        archived: conversation.archived,
        aside: conversation.aside,
        workspace: conversation.workspace ?? null,
        host: conversation.host ?? null,
        deferUntil: conversation.deferUntil,
        deferCondition: conversation.deferCondition,
        deferredAt: conversation.deferredAt,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        activeAt: conversation.activeAt || conversation.updatedAt,
        lastOpened: conversation.lastOpened,
        opens: conversation.opens,
        turns: conversation.turns,
        toolCalls: conversation.toolCalls,
        parentId: conversation.parentId,
        // A side thread is not a row of the list: a snapshot without this flag paints it as a loose chat until the server's row
        // arrives and removes it (the Inbox count dropped 10 -> 6, 2.1 s after a force reload; research/flash).
        sidechat: conversation.sidechat,
        automated: conversation.automated,
        settings: conversation.settings,
        sessionId: conversation.sessionId,
        
        
        
        
        notableCursor: conversation.notableCursor,
        readCursor: conversation.readCursor,
        forcedUnread: conversation.forcedUnread,
        mutedRun: conversation.mutedRun,
        snapshotCursor: conversation.snapshotCursor
      })));
  }

  function scheduleHeaderSnapshot() {
    if (!replica) return;
    const durableCount = Object.keys(state.conversations).length - provisional.size;
    if (durableCount !== knownConversations) {
      clearTimeout(headerTimer);
      headerTimer = null;
      writeHeaderSnapshot();
      return;
    }
    if (headerTimer) return;
    headerTimer = setTimeout(() => {
      headerTimer = null;
      writeHeaderSnapshot();
    }, 1200);
    headerTimer.unref?.();
  }

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  async function start({ open = null, fullLog = true, hydrate: hydrateCount = 8 } = {}) {
    const t0 = now();
    replica = replicaImpl || (await openReplica(globalThis.indexedDB, replicaOptions));

    const headers = await replica.readHeaders();
    if (headers.length) {
      state = mergeConversations(state, headers);
      state = { ...state, cursor: await replica.cursor() };
      setStatus({ cached: true, firstPaintMs: now() - t0 });
    }

    const focus = open || (await replica.lastOpened());
    if (focus) {
      markOpen(focus);
      
      
      
      
      let tail = [];
      try { tail = await replica.readLatest(focus, 300); } catch { tail = []; }
      // Through `absorb`, never `reduceEvents` directly. A single cached event this build
      // cannot fold -- one written by a newer tab, or by a build before a contract bump, since
      // the replica has no schema migration -- used to reject start() here, before anything
      // opened the stream: the app sat there dead and every reload replayed the same poison.
      // The cache is a convenience; it may never stop the app from starting.
      if (tail.length) absorb(tail, { persist: false });
    }
    setStatus({ readyMs: now() - t0 });
    publish();

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    const persisted = await replica.readOutbox();
    outbox = persisted;
    replayOutbox();
    rehydrateOutbox(persisted);
    scheduleFlushRetry();

    if (typeof window !== 'undefined') {
      status.online = navigator.onLine !== false;
      status.offline = status.online === false || status.reachable === false;
      // Ask the browser not to evict the replica under storage pressure: it is the copy he reads
      // when the server is down. Best effort; Safari and some Chromes decline silently.
      try { navigator.storage?.persist?.().catch(() => {}); } catch {  }
      window.addEventListener('online', () => {
        setStatus({ online: true });
        applyDelivery({ type: 'online' });
        
        
        
        
        ensureStream();
      });
      window.addEventListener('offline', () => {
        setStatus({ online: false, connected: false });
        applyDelivery({ type: 'offline' });
      });
      
      
      // A force reload inside the 1.2 s debounce used to lose the newest placement: write it as the page goes away.
      const flushHeaders = () => { if (headerTimer) { clearTimeout(headerTimer); headerTimer = null; writeHeaderSnapshot(); } };
      window.addEventListener('pagehide', flushHeaders);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushHeaders(); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        
        
        
        
        healStep = 0;
        
        
        
        retries = 0;
        
        
        
        
        
        
        
        
        
        
        
        bootstrapDelta().then(ensureStream);
      });
    }

    
    if (headers.length) { bootstrapDelta().then(connect); } else {
      streamHold = []; streamFromTail = true; connect(); streamFromTail = false;
      try { await bootstrap(hydrateCount); } finally { const held = streamHold || []; streamHold = null; if (held.length) absorb(held); }
      connect();
    }
    scheduleHeal();
    scheduleWatchdog();
    flushOutbox();
    if (fullLog) idle(() => loadFullLog());
    scheduleWeekSync(4000);
  }

  
  
  
  
  
  
  
  
  
  
  
  function replayOutbox() {
    if (!outbox.length) return;
    let next = state;
    for (const action of outbox) next = applyOptimistic(next, action);
    if (next === state) return;
    state = next;
    publish();
  }

  

  function rehydrateOutbox(actions) {
    const owed = [];
    for (const action of actions || []) {
      const id = action?.id || action?.action_id;
      if (!id) continue;
      const uploads = action.uploads || action.payload?.uploads || [];
      applyDelivery({ type: 'dispatch', action: { ...action, id, uploads } });
      if (uploads.length) owed.push(id);
    }
    
    
    for (const id of owed) applyDelivery({ type: 'release_action', id });
  }

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const FOLD_BUDGET = 25_000;

  
  
  
  async function loadFullLog(budget = FOLD_BUDGET) {
    if (fullLogLoaded || !replica) return;
    fullLogLoaded = true;
    const recent = replica.readRecent
      ? await replica.readRecent(budget)
      : (await replica.readAll()).slice(-budget);
    const unseen = recent.filter((event) => !hasSeen(state, event.conversation_id, event.event_id));
    if (unseen.length) {
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      await absorbLarge(unseen, { persist: false, silent: true });
      if (status.online) await bootstrapDelta();
      else if (lastLive) state = reconcileLiveness(state, lastLive);
      publish();
    }
    
    setStatus({ fullyCached: true, foldedEvents: seenCount(state) });
  }

  
  
  
  
  async function bootstrap(hydrateCount = 8) {
    setStatus({ syncing: true });
    try {
      let response;
      try { response = await doFetch(`/api/bootstrap?days=31&hydrate=${hydrateCount}`); }
      catch (cause) { unheard(); throw cause; }
      if (!heard(response)) throw new Error('server unreachable');
      if (!response.ok) throw new Error(`bootstrap ${response.status}`);
      const body = await response.json();
      state = mergeConversations(state, body.conversations || []);
      scheduleHeaderSnapshot();
      for (const conversation of body.conversations || []) {
        
        
        
        
        
        
      }
      await absorbLarge(body.events || [], { progressive: true });
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      if (Number.isSafeInteger(body.cursor) && body.cursor > state.cursor) {
        state = { ...state, cursor: body.cursor };
      }
      lastLive = body.live || [];
      state = reconcileLiveness(state, lastLive);
      
      
      
      
      
      state = mergeSidebar(state, body.sidebar);
      scheduleHeaderSnapshot(); // sidebar rows (folder, archive, aside) change without an event: persist them or the next reload paints the old placement
      replayOutbox();
      setStatus({ syncing: false, error: null, capabilities: body.capabilities });
    } catch (cause) {
      setStatus({ syncing: false, error: status.cached || status.reachable === false ? null : cause.message });
    }
  }

  
  
  
  
  
  function streamIsDead() {
    return !source || source.readyState === 2;
  }

  
  
  function dropStream() {
    try { source?.close(); } catch {  }
    source = null;
    
    
    
    lastMessageAt = null;
    setStatus({ connected: false });
  }

  
  
  
  function streamIsSilent() {
    return lastMessageAt !== null && now() - lastMessageAt > SSE_SILENCE_MS;
  }

  
  
  
  
  function ensureStream() {
    if (!status.online) return;
    if (streamIsDead() || streamIsSilent()) { dropStream(); connect(); }
  }

  function scheduleWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      
      
      
      
      if (typeof document === 'undefined' || document.visibilityState === 'visible') ensureStream();
      scheduleWatchdog();
    }, WATCHDOG_MS);
    watchdogTimer?.unref?.();
  }

  function connect() {
    if (!EventSourceCtor) return;
    
    
    
    
    
    
    
    
    
    
    if (source && !streamIsDead()) return;
    if (source) dropStream();
    try {
      source = new EventSourceCtor(streamFromTail ? '/api/events?tail=1' : `/api/events?after=${state.cursor}`);
    } catch { return; }
    
    
    
    lastMessageAt = now();
    
    
    
    
    source.onopen = () => {
      retries = 0;
      lastMessageAt = now();
      setStatus({ connected: true, reachable: true, error: null });
      applyDelivery({ type: 'connected' });
      scheduleWeekSync(2000);
      flushOutbox();
    };
    source.onmessage = ({ data }) => {
      
      
      
      
      lastMessageAt = now();
      let message;
      try { message = JSON.parse(data); } catch { return; }
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      if (message.resync) {
        if (Number.isSafeInteger(message.cursor) && message.cursor > state.cursor) {
          state = { ...state, cursor: message.cursor };
        }
        
        
        
        
        const open = openRecent[0] || null;
        state = markAllUnhydrated(state);
        bootstrap(0).then(() => {
          if (!open) return publish();
          hydrating.delete(open);
          return hydrate(open);
        });
        return;
      }
      if (message.events && streamHold) { streamHold.push(...message.events); return; }
      if (message.resync && streamHold) return;
      if (message.events) {
        if (message.events.length > CHUNK) absorbLarge(message.events);
        else absorb(message.events);
      }
      if (message.hello) setStatus({ connected: true });
    };
    source.onerror = () => {
      dropStream();
      const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
      retries += 1;
      setTimeout(() => { if (status.online) { bootstrapDelta().then(connect); } }, wait);
    };
  }

  // Everything the reader is owed after a gap: a fresh snapshot, every transcript marked
  // unhydrated because the skipped span could be inside any of them, and the chat he is
  // actually looking at read back in. The same three steps the server's own resync asks for.
  async function fullResync() {
    const open = openRecent[0] || null;
    state = markAllUnhydrated(state);
    await bootstrap(0);
    if (!open) { publish(); return; }
    hydrating.delete(open);
    await hydrate(open);
  }

  async function bootstrapDelta() {
    let body;
    try {
      const response = await doFetch(`/api/sync?after=${state.cursor}`);
      if (!heard(response) || !response.ok) return;
      body = await response.json();
    } catch {
      unheard();
      // The request never landed. Nothing is known to be missing, and the watchdog and the
      // heal ladder already own asking again; a reconnect storm is not a repair.
      return;
    }
    try {
      await absorbLarge(body.events || [], { progressive: false });
      
      
      
      
      
      
      if (!body.truncated && Number.isSafeInteger(body.cursor) && body.cursor > state.cursor) {
        state = { ...state, cursor: body.cursor };
      }
      lastLive = body.live || lastLive;
      state = reconcileLiveness(state, lastLive);
      state = mergeSidebar(state, body.sidebar);
      scheduleHeaderSnapshot();
      replayOutbox();
      publish();
    } catch (cause) {
      // The delta arrived and could not be applied. This is the healer -- the watchdog, the
      // refocus handler and the stream's own error path all come through here -- so swallowing
      // meant the one mechanism that repairs a gap gave up without a word: the cursor stopped,
      // every later event was invisible, and the page still looked connected. Say it, and ask
      // for a whole new snapshot rather than pretend nothing happened.
      // `error` is the live complaint and a successful bootstrap below clears it, which is
      // right -- a repaired gap should not keep shouting. `resyncs` is the durable count that
      // survives the repair, so a tab quietly losing sync all day is still countable.
      setStatus({
        syncing: false,
        error: `sync failed: ${cause.message}`,
        resyncs: (status.resyncs || 0) + 1
      });
      await fullResync();
    }
  }

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  function anyLive() {
    for (const conversation of Object.values(state.conversations)) {
      if (LIVE_RUN_STATES.has(conversation.runState)) return true;
    }
    return false;
  }

  async function healLiveness() {
    if (!anyLive() || !status.online) { healStep = 0; return; }
    healStep = Math.min(healStep + 1, HEAL_MS.length - 1);
    await bootstrapDelta();
  }

  function scheduleHeal() {
    if (healTimer) return;
    healTimer = setTimeout(() => {
      healTimer = null;
      healLiveness().finally(scheduleHeal);
    }, HEAL_MS[healStep]);
    healTimer?.unref?.();
  }

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const HYDRATE_EVENTS = hydrateEvents || 1500;

  
  // A conversation whose own `conversation.create` is still sitting in the outbox exists
  // nowhere but on this device. The server has never heard of it, so a read of it that fails --
  // offline, or a 404 -- is not a transcript that went missing; there was nothing on the far
  // end to find. durability.spec.js:73 caught exactly that, on the reload after a send whose
  // chat was created a moment before the network went.
  const createStillQueued = (conversationId) => outbox.some(
    (action) => action?.op === ACTIONS.CREATE && action?.conversation_id === conversationId
  );

  async function hydrate(conversationId) {
    if (!conversationId || hydrating.has(conversationId) || !accepts(conversationId)) return;
    // Nothing to fetch for a chat the server has never been told about.
    if (provisional.has(conversationId)) return;
    
    
    markOpen(conversationId);
    const conversation = state.conversations[conversationId];
    if (conversation?.hydrated) return;
    hydrating.add(conversationId);
    replica?.setLastOpened(conversationId);
    let cached = [];
    try { cached = replica ? await replica.readLatest(conversationId, HYDRATE_EVENTS) : []; } catch { cached = []; }
    if (cached.length) await absorbLarge(cached, { persist: false });
    // Whether the transcript this pane is about to show actually arrived. A failed read used to
    // be indistinguishable from an empty chat: the conversation was marked hydrated regardless,
    // the guard above then turned every later open into a no-op, and the pane stayed blank for
    // the life of the tab with nothing on screen saying why.
    let loaded = false;
    try {
      const response = await doFetch(
        `/api/conversation/${conversationId}?newest=1&limit=${HYDRATE_EVENTS}`);
      if (!heard(response)) {
        // The tunnel or a proxy answered, not the app. What the device holds is the transcript.
        if (!cached.length && !createStillQueued(conversationId)) {
          setStatus({ transcriptError: `server unreachable (${response.status}), and this chat is not saved on this device yet` });
        }
      } else if (response.ok) {
        const body = await response.json();
        const events = body.events || [];
        
        
        earlier.set(conversationId, { more: events.length >= HYDRATE_EVENTS, loading: false });
        // One insertion, not one per chunk. A progressive fold published a chunk at a
      // time, and every publish inserted rows above a reader who is by definition
      // sitting below them: on a phone that is four separate reflows under his finger
      // while the page lands.
      await absorbLarge(events, { progressive: false });
        loaded = true;
      } else if (!createStillQueued(conversationId)) {
        setStatus({ transcriptError: `could not load this chat (${response.status})` });
      }
    } catch (cause) {
      unheard();
      if (!cached.length && !createStillQueued(conversationId)) {
        setStatus({ transcriptError: 'offline, and this chat is not saved on this device yet' });
      }
    }
    // A transcript that never arrived leaves the door open: `more: true` so the reader still has
    // the one affordance that reaches the rest of the history, and no hydration mark so the next
    // open asks again instead of showing an empty room.
    if (!loaded && !earlier.has(conversationId)) earlier.set(conversationId, { more: true, loading: false });
    if ((loaded || cached.length) && status.transcriptError) setStatus({ transcriptError: null });
    // A chat that is still waiting to be created is whole here or nowhere: what the outbox
    // replayed is the entire transcript, so the pane shows it instead of an error about a
    // history the server was never given.
    if (loaded || cached.length || createStillQueued(conversationId)) {
      state = markHydrated(state, conversationId);
    }
    
    
    
    
    
    
    
    
    
    
    
    if (lastLive) state = reconcileLiveness(state, lastLive, { only: conversationId });
    hydrating.delete(conversationId);
    publish();
  }

  
  
  
  const earlier = new Map();

  const heldCursors = (conversationId) => (state.items[conversationId] || [])
    .map((item) => item.cursor)
    .filter((cursor) => Number.isSafeInteger(cursor) && cursor > 0 && cursor < Number.MAX_SAFE_INTEGER);

  
  
  
  
  
  async function loadEarlier(conversationId) {
    const record = earlier.get(conversationId);
    if (!record?.more || record.loading) return { loaded: 0, more: record?.more ?? false };
    const cursors = heldCursors(conversationId);
    if (!cursors.length) return { loaded: 0, more: true };
    record.loading = true;
    try {
      const before = Math.min(...cursors);
      let response = null;
      try {
        response = await doFetch(
          `/api/conversation/${conversationId}?before=${before}&limit=${HYDRATE_EVENTS}`);
      } catch { unheard(); }
      if (!response || !heard(response)) return earlierFromReplica(conversationId, before, record);
      if (!response.ok) return { loaded: 0, more: true };
      const body = await response.json();
      const events = body.events || [];
      await absorbLarge(events, { progressive: true });
      record.more = events.length >= HYDRATE_EVENTS;
      publish();
      return { loaded: events.length, more: record.more };
    } catch {
      
      
      return { loaded: 0, more: true };
    } finally {
      record.loading = false;
    }
  }

  // With the server out of reach, the older part of a transcript comes off the device, where the
  // background sync put it.
  async function earlierFromReplica(conversationId, before, record) {
    const rows = replica?.readBefore ? await replica.readBefore(conversationId, before, HYDRATE_EVENTS) : [];
    if (!rows.length) return { loaded: 0, more: true };
    await absorbLarge(rows, { progressive: true, persist: false });
    publish();
    return { loaded: rows.length, more: true, offline: true };
  }

  const canLoadEarlier = (conversationId) => Boolean(earlier.get(conversationId)?.more);

  // -- the week on the device ------------------------------------------------------------------
  let weekTimer = null;
  let weekRun = null;
  const WEEK_EVERY_MS = 10 * 60_000;
  function scheduleWeekSync(delay = WEEK_EVERY_MS) {
    if (!weekSync || !replica?.readSynced || typeof window === 'undefined') return;
    if (weekTimer) clearTimeout(weekTimer);
    weekTimer = setTimeout(() => { weekTimer = null; idle(() => { syncWeek().finally(() => scheduleWeekSync()); }); }, delay);
    weekTimer?.unref?.();
  }
  async function syncWeek() {
    if (!weekSync || weekRun || !replica?.readSynced || status.offline) return weekRun;
    weekRun = (async () => {
      try {
        const result = await syncWindow({
          fetchImpl: doFetch,
          replica,
          conversations: Object.values(state.conversations),
          provisional: (id) => provisional.has(id)
        });
        if (result.unreachable) unheard();
        setStatus({ weekSync: { ...result, at: new Date().toISOString() } });
        return result;
      } catch (cause) {
        setStatus({ weekSync: { error: String(cause?.message || cause), at: new Date().toISOString() } });
        return null;
      } finally { weekRun = null; }
    })();
    return weekRun;
  }

  async function persistOutbox() {
    if (replica) await replica.writeOutbox(outbox);
  }

  
  
  function createProvisional(conversationId, payload = {}) {
    if (!conversationId || state.conversations[conversationId] || !accepts(conversationId)) return false;
    provisional.set(conversationId, payload);
    markOpen(conversationId);
    state = applyOptimistic(state, {
      op: ACTIONS.CREATE,
      conversation_id: conversationId,
      payload,
      at: new Date().toISOString(),
      action_id: `provisional-${conversationId}`
    });
    publish();
    return true;
  }

  function commitProvisional(conversationId) {
    const payload = provisional.get(conversationId);
    if (payload === undefined) return false;
    provisional.delete(conversationId);
    dispatch(ACTIONS.CREATE, conversationId, payload);
    return true;
  }

  function discardProvisional(conversationId) {
    if (!provisional.has(conversationId)) return false;
    provisional.delete(conversationId);
    state = forgetConversation(state, conversationId);
    openRecent = openRecent.filter((id) => id !== conversationId);
    publish();
    return true;
  }

  async function dispatch(op, conversationId, payload = {}, { actionId = null } = {}) {
    if (!accepts(conversationId)) return undefined;
    // A caller that owns the id (the room tab's persisted outbox) replays idempotently: an id already
    // waiting in the outbox is the same send, not a second one.
    if (actionId && delivery.outbox.some((a) => a.id === actionId)) return undefined;
    // Anything with content behind it turns the transient chat into a real one first, so the
    // server sees conversation.create before the message that needs it. Opening and reading are
    // not content: there is nothing on the far end to touch, and touching it would create the
    // empty chat this whole mechanism exists to avoid.
    if (provisional.has(conversationId) && op !== ACTIONS.CREATE) {
      if (op === ACTIONS.TOUCH || op === ACTIONS.READ) return;
      commitProvisional(conversationId);
    }
    markOpen(conversationId);
    deviceSeq += 1;
    const action = makeAction({ op, conversationId, payload, deviceId, deviceSeq, at: new Date().toISOString(), ...(actionId ? { actionId } : {}) });
    state = applyOptimistic(state, action);
    publish();
    
    
    
    
    scheduleHeaderSnapshot();
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    return applyDelivery({
      type: 'dispatch',
      action: { ...action, id: action.action_id, uploads: payload?.uploads || [] },
    });
  }

  

  function applyDelivery(event) {
    const [next, effects] = deliveryStep(delivery, event);
    delivery = next;
    
    outbox = delivery.outbox.map((a) => a.wire || a);
    
    
    
    
    
    
    const posts = [];
    for (const e of effects) {
      switch (e.type) {
        case DELIVERY_EFFECTS.PERSIST_OUTBOX:
          persistOutbox();
          publishQueue();
          break;
        case DELIVERY_EFFECTS.POST:
          posts.push(post(outgoing(e.action)));
          break;
        case DELIVERY_EFFECTS.ARM_RETRY:
          scheduleFlushRetry();
          // No `error: null` here. An armed retry is not evidence that nothing is wrong; it
          // used to wipe the one field that could have told him the send was in trouble, so a
          // chat that could not deliver a word looked exactly like a chat with nothing to say.
          setStatus({ queued: delivery.outbox.length, unsentMessages: unsentMessages(delivery) });
          break;
        case DELIVERY_EFFECTS.CLEAR_RETRY:
          
          
          
          
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
          if (Object.keys(delivery.retryArmed).length) scheduleFlushRetry();
          break;
        case DELIVERY_EFFECTS.ARM_UPLOAD_PATIENCE:
          armPatience(e.actionId, patienceMs ?? e.ms);
          break;
        case DELIVERY_EFFECTS.CLEAR_UPLOAD_PATIENCE:
          clearPatience(e.actionId);
          break;
        case DELIVERY_EFFECTS.APPLY_EVENTS:
          absorb(e.events);
          break;
        default:
          break;
      }
    }
    if (effects.some((e) => e.type === DELIVERY_EFFECTS.ARM_UPLOAD_PATIENCE
      || e.type === DELIVERY_EFFECTS.CLEAR_UPLOAD_PATIENCE)) publishQueue();
    return Promise.all(posts);
  }

  
  
  
  function publishQueue() {
    setStatus({ queued: delivery.outbox.length, unsentMessages: unsentMessages(delivery), unsentByConversation: unsentByConversation(delivery), waitingUploads: waitingUploadsByConversation(delivery) });
  }

  

  function outgoing(action) {
    if (!delivery.released.includes(action.id)) return action;
    const waiting = pendingUploadsOf(delivery, action).map((upload) => (delivery.failedUploads.includes(upload.id)
      ? { ...upload, failed: true, error: uploadErrors.get(upload.id) || 'the upload failed' }
      : upload));
    if (!waiting.length) return action;
    return { ...action, payload: { ...action.payload, pending_uploads: waiting } };
  }

  function armPatience(actionId, ms) {
    if (patienceTimers.has(actionId)) return;
    const timer = setTimeout(() => {
      patienceTimers.delete(actionId);
      applyDelivery({ type: 'release_action', id: actionId });
    }, ms);
    timer?.unref?.();
    patienceTimers.set(actionId, timer);
  }

  function clearPatience(actionId) {
    const timer = patienceTimers.get(actionId);
    if (timer) clearTimeout(timer);
    patienceTimers.delete(actionId);
  }

  
  // Whether the server refusing this body is a verdict on the body or on the moment. 4xx is the
  // verdict: /api/actions answers 400 for an action it will not validate and 409 for one it
  // cannot apply, and the same bytes will get the same answer at every retry. 408 and 429 are
  // the exceptions -- both are the server asking for the request again, later. Everything else
  // (5xx, a dropped socket, a proxy eating the response) is the moment, and the outbox exists
  // for exactly that.
  // 401 is the moment too: a session that lapsed is fixed by signing in again, and the message he
  // typed must still be there when he has.
  const refusedForGood = (code) => code >= 400 && code < 500 && code !== 401 && code !== 408 && code !== 429;

  async function post(action) {
    try {
      const response = await doFetch('/api/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action)
      });
      if (!heard(response)) throw new Error('offline');
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const reason = body.error || `action ${response.status}`;
        if (refusedForGood(response.status)) {
          // Keep the server's own words. They used to be read and thrown away one line later,
          // which is why a 400 looked like silence. `rejected` is what the composer can offer
          // back to him as re-send or discard; `error` is what any surface can show now.
          setStatus({
            error: reason,
            rejected: [...(status.rejected || []), {
              id: action.id,
              op: action.op,
              conversationId: action.conversation_id,
              text: action.payload?.text ?? null,
              status: response.status,
              reason
            }]
          });
          // A scope move the server refused: the dropdown goes back to where the chat still is.
          if (action.op === ACTIONS.MOVE_SCOPE) { state = setConversationScope(state, action.conversation_id, action.payload?.from ?? null); publish(); }
          await applyDelivery({ type: 'send_rejected', id: action.id });
          return;
        }
        throw new Error(reason);
      }
      const body = await response.json();
      await applyDelivery({ type: 'send_ok', id: action.id, events: body.events || [] });
    } catch (cause) {
      // A transport failure keeps the action and keeps retrying -- that is what the outbox is
      // for -- but it is still worth a word, on a separate field so it cannot be mistaken for
      // a refusal the reader has to act on.
      if (cause?.name === 'TypeError') unheard();
      setStatus({ sendError: cause.message });
      await applyDelivery({ type: 'send_failed', id: action.id });
    }
  }

  

  async function flushOutbox() {
    if (!delivery.outbox.length) return;
    if (flushing) return flushing;
    flushing = applyDelivery({ type: 'retry_fired' }).finally(() => { flushing = null; });
    return flushing;
  }

  function scheduleFlushRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (!delivery.outbox.length) return;
    retryTimer = setTimeout(() => { retryTimer = null; flushOutbox(); }, 5000);
    retryTimer.unref?.();
  }

  async function search(query, { mode = 'smart', conversation = null } = {}) {
    const params = new URLSearchParams({ q: query, mode });
    if (conversation) params.set('conversation', conversation);
    const response = await doFetch(`/api/search?${params}`);
    if (!response.ok) throw new Error('search failed');
    return response.json();
  }

  
  
  async function file(path, { conversationId = null } = {}) {
    // A web image opens in the preview through the server's image proxy (fetched, guarded and cached
    // there), never by asking /api/file for a URL.
    if (/^https?:\/\//iu.test(String(path || ''))) {
      const last = String(path).split(/[?#]/u)[0].split('/').filter(Boolean).pop() || path;
      let name = last;
      try { name = decodeURIComponent(last); } catch {  }
      return { path, name, remote: true, binary: true, url: remoteImageUrl(path) };
    }
    const key = `${conversationId || ''}::${path}`;
    const params = new URLSearchParams({ path });
    if (conversationId) params.set('conversation', conversationId);
    try {
      const response = await doFetch(`/api/file?${params}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const body = await response.json();
      if (replica) replica.writeBlob(key, body, (body.text || '').length + 256);
      return body;
    } catch (cause) {
      const cached = replica ? await replica.readBlob(key) : null;
      if (cached) return { ...cached, stale: true };
      throw cause;
    }
  }

  return {
    start,
    hydrate,
    loadEarlier,
    canLoadEarlier,
    loadFullLog,
    search,
    file,
    flushOutbox,
    syncWeek,
    get state() { return state; },
    get status() { return status; },
    get outbox() { return outbox; },
    usage: () => (replica ? replica.usage() : Promise.resolve({ events: 0, blobs: 0 })),
    subscribe(subscriber) {
      subscribers.add(subscriber);
      subscriber(state, status);
      return () => subscribers.delete(subscriber);
    },
    newConversationId: () => newIdImpl(),
    create: (conversationId, payload) => dispatch(ACTIONS.CREATE, conversationId, payload),
    createProvisional,
    commitProvisional,
    discardProvisional,
    isProvisional: (conversationId) => provisional.has(conversationId),
    fork: (conversationId, payload) => dispatch(ACTIONS.FORK, conversationId, payload),
    send: (conversationId, text, uploads = [], options = {}) => dispatch(ACTIONS.SEND, conversationId, { text, uploads }, options),
    
    
    stageUpload: (id) => applyDelivery({ type: 'upload_staged', id }),
    
    
    
    
    failUpload: (id, error = null) => {
      if (error) uploadErrors.set(id, String(error));
      return applyDelivery({ type: 'upload_failed', id });
    },
    interrupt: (conversationId) => dispatch(ACTIONS.INTERRUPT, conversationId, {}),
    rename: (conversationId, title) => dispatch(ACTIONS.RENAME, conversationId, { title }),
    pin: (conversationId, pinned) => dispatch(ACTIONS.PIN, conversationId, { pinned }),
    archive: (conversationId, archived) => dispatch(ACTIONS.ARCHIVE, conversationId, { archived }),
    setAside: (conversationId, aside) => dispatch(ACTIONS.ASIDE, conversationId, { aside }),
    setWorkspace: (conversationId, workspace) => dispatch(ACTIONS.WORKSPACE, conversationId, { workspace: workspace || null }),
    setHost: (conversationId, host) => dispatch(ACTIONS.HOST, conversationId, { host: host || null }),
    defer: (conversationId, { until = null, condition = null } = {}) =>
      dispatch(ACTIONS.DEFER, conversationId, { until, condition }),
    touch: (conversationId) => dispatch(ACTIONS.TOUCH, conversationId, {}),
    
    
    
    
    
    
    
    
    
    
    
    markRead: (conversationId, read = true, { mute = true } = {}) => dispatch(ACTIONS.READ, conversationId, {
      read,
      mute,
      seenCursor: mute === false ? (state.cursor ?? null) : null
    }),
    settings: (conversationId, settings) => dispatch(ACTIONS.SETTINGS, conversationId, { settings }),
    // Move the chat, with its whole history, to another scope. `from` rides along only so a refusal can put
    // the dropdown back; the server reads the chat's own scope. A widening move names `confirmed: true`, set
    // by the confirm screen. An empty chat that has not been sent yet just takes the scope into its create.
    // A chat that moved to a scope this account cannot open leaves the tab: the row, the transcript, the folds.
    // Returns the ids dropped so the page can close their panes.
    dropRevoked: () => {
      const gone = Object.values(state.conversations).filter((c) => c.revoked && !provisional.has(c.id)).map((c) => c.id);
      if (!gone.length) return gone;
      for (const id of gone) state = forgetConversation(state, id);
      openRecent = openRecent.filter((id) => !gone.includes(id));
      publish();
      return gone;
    },
    moveScope: (conversationId, to, { confirmed = false, from = null } = {}) => {
      if (provisional.has(conversationId)) {
        provisional.set(conversationId, { ...provisional.get(conversationId), scope: to, scopeChosen: true });
        state = setConversationScope(state, conversationId, to);
        publish();
        return undefined;
      }
      return dispatch(ACTIONS.MOVE_SCOPE, conversationId, { to, confirmed, from });
    }
  };
}

function readDeviceId(key = 'tophat-webchat-device') {
  try {
    const saved = globalThis.localStorage?.getItem(key);
    if (saved) return saved;
    const created = newId();
    globalThis.localStorage?.setItem(key, created);
    return created;
  } catch {
    return newId();
  }
}
