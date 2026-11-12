// The chat core of the Docstore3 state engine: the same reducers as the server and the legacy tab session
// (core/reducer.js, core/delivery.js; imported, never copied), the one live connection, the durable outbox and
// the replica, run once per browser (engine/worker.js) instead of once per tab (client/session.js).
//
// Behaviour follows client/session.js closely so the pinned-oracle differential (engine/core.diff.test.js) can hold the two to the same
// visible state
// - Identity (A7): every action id is a ULID minted here, and the action is committed to the IndexedDB outbox
//   (kit outbox.js via engine/chat-store.js) BEFORE delivery is told about it, so no POST can precede durability. The id is reused on every
//   retry and restart; the server's applied-action receipt makes a repeat harmless.
// - Backpressure (A9): a full outbox refuses the action before it is applied (status.backpressure, and the call
//   rejects with code 'backpressure'); nothing is dropped.
// - Deadlines (rule 8): every request has a class deadline (kit engine/deadline.js); a send that stalls is aborted
//   and retried under the same id; a newer hydrate or search of the same key supersedes the stalled one.
// - Totality (A4): replayed outbox actions and folded events never throw out of the engine; a bad one is skipped
//   and counted (status.skipped, status.outboxSkipped).
// - Provisional (transient) chats are a tab's own business and live in the tab (engine/host.js), not here.
// - Search falls back to the replica (engine/offline-search.js) when the server cannot answer in time.
// - The background replica fill keeps two weeks (POLICY.windowMs), not one.

import { ACTIONS, makeAction } from '../core/contract.js';
import {
  applyOptimistic, emptyState, evictConversations, foldedItemCount, forgetConversation, hasSeen, setConversationScope,
  LIVE_RUN_STATES, markAllUnhydrated, markHydrated, mergeConversations, mergeSidebar, reconcileLiveness, reduceEvents, seenCount
} from '../core/reducer.js';
import { DELIVERY_EFFECTS, deliveryStep, initialDelivery, pendingUploadsOf, unsentMessages, unsentByConversation, waitingUploadsByConversation } from '../core/delivery.js';
import { fromApp, syncWindow } from '../client/week-sync.js';
import { remoteImageUrl } from '../core/rich-content.js';
import { connection } from '../../../../runner/tools/docstore-kit/lib/components.js';
import { createDeadlineFetch, DEADLINE_MS } from '../../../../runner/tools/docstore-kit/lib/engine/deadline.js';
import { ulid as defaultUlid } from '../../../../runner/tools/docstore-kit/lib/engine/ulid.js';
import { searchReplica } from './offline-search.js';
import { BackpressureError, CHAT_POLICY } from './chat-store.js';

// The chat's deadline classes over the kit's: each request kind of the webchat server, bounded.
export const CHAT_DEADLINES = Object.freeze({ ...DEADLINE_MS, send: 15_000, sync: 20_000, bootstrap: 30_000, hydrate: 20_000, earlier: 20_000, week: 30_000, search: 8_000, file: 15_000 });

const RETRY_MS = [400, 900, 2000, 5000, 12_000];
const HEAL_MS = [20_000, 40_000, 80_000, 160_000, 300_000];
const SSE_SILENCE_MS = 70_000;
const WATCHDOG_MS = 15_000;
const CHUNK = 400;
const ITEM_BUDGET = 40_000;
const ITEM_TARGET = 30_000;
const SWEEP_EVERY = 2_000;
const EVENT_BUDGET = 60_000;
const EVENT_TARGET = 40_000;
const OPEN_KEEP = 12;
const FOLD_BUDGET = 25_000;
const WEEK_EVERY_MS = 10 * 60_000;

const refusedForGood = (code) => code >= 400 && code < 500 && code !== 401 && code !== 408 && code !== 429;

export function createEngineCore({
  fetchImpl, EventSourceImpl = globalThis.EventSource, store, deviceId, hydrateEvents, uploadPatienceMs = null,
  accepts = () => true, mintId = defaultUlid, weekSync = true, windowMs = CHAT_POLICY.windowMs,
  onTelemetry = () => {}, commitMs = 4000, online = () => globalThis.navigator?.onLine !== false,
  setTimer = (...a) => globalThis.setTimeout(...a), clearTimer = (...a) => globalThis.clearTimeout(...a),
  clock = () => (globalThis.performance?.now?.() ?? Date.now()), yieldNow = () => new Promise((r) => setTimeout(r, 0))
} = {}) {
  // Every request goes through the deadline classes; the default fetch is supplied by the kit's createDeadlineFetch.
  const net = createDeadlineFetch(fetchImpl, { deadlines: CHAT_DEADLINES, setTimer, clearTimer });
  const fetchWithin = net.fetchWithin;
  const HYDRATE_EVENTS = hydrateEvents || 1500;

  let state = emptyState();
  let source = null;
  let lastMessageAt = null;
  let watchdogTimer = null;
  let retries = 0;
  const subscribers = new Set();
  const hydrating = new Set();
  let fullLogLoaded = false;
  let delivery = initialDelivery();
  const uploadErrors = new Map();
  let flushing = null;
  const patienceTimers = new Map();
  let retryTimer = null;
  let lastLive = null;
  let healStep = 0;
  let healTimer = null;
  let started = null;
  // The live connection's lifecycle as kit component state (absolute actions; attempt is absolute).
  const conn = connection();
  let link = conn.initial;
  const linkStep = (type, payload) => { const f = conn.actions[type]; if (f) link = f(link, payload); };
  let status = { online: true, reachable: true, offline: false, connected: false, syncing: false, cached: false, fullyCached: false, error: null };

  function publish() { for (const fn of subscribers) { try { fn(state, status); } catch { /* one view's bug */ } } }
  function setStatus(patch) {
    status = { ...status, ...patch };
    status.offline = status.online === false || status.reachable === false;
    publish();
  }
  function heard(response) {
    const ok = fromApp(response);
    if (ok && status.reachable === false) { setStatus({ reachable: true, error: null, transcriptError: null }); scheduleWeekSync(500); }
    else if (!ok && status.reachable !== false) setStatus({ reachable: false, connected: false });
    return ok;
  }
  function unheard() { if (status.reachable !== false) setStatus({ reachable: false, connected: false }); }

  // ---- folding (total: a bad event is skipped and counted, never thrown) ----
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
      if (at + CHUNK < events.length) await yieldNow();
    }
    if (changed && !progressive && !silent) publish();
    return changed;
  }

  let foldedSinceSweep = 0;
  let openRecent = [];
  function markOpen(id) { if (id) openRecent = [id, ...openRecent.filter((x) => x !== id)].slice(0, OPEN_KEEP); }
  store?.setKeep?.((id) => openRecent.includes(id) || LIVE_RUN_STATES.has(state.conversations[id]?.runState));

  function enforceItemBudget() {
    let total = foldedItemCount(state);
    let events = seenCount(state);
    if (total <= ITEM_BUDGET && events <= EVENT_BUDGET) return;
    const keep = new Set(openRecent);
    for (const [id, c] of Object.entries(state.conversations)) if (LIVE_RUN_STATES.has(c.runState)) keep.add(id);
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
    status.foldedItems = total;
    status.evicted = (status.evicted || 0) + drop.length;
  }

  let quarantined = 0;
  function foldWithQuarantine(events) {
    let next = state;
    const accepted = [];
    for (const event of events) {
      try { next = reduceEvents(next, [event]); accepted.push(event); }
      catch (cause) {
        quarantined += 1;
        status = { ...status, skipped: quarantined, skipReason: String(cause?.message || cause) };
        if (Number.isSafeInteger(event?.cursor) && event.cursor > next.cursor) next = { ...next, cursor: event.cursor };
      }
    }
    return [next, accepted];
  }

  function absorb(events, { persist = true, quiet = false } = {}) {
    if (!events?.length) return false;
    let next;
    let accepted = events;
    let skipped = false;
    try { next = reduceEvents(state, events); }
    catch { [next, accepted] = foldWithQuarantine(events); skipped = true; }
    if (next === state) { if (skipped && !quiet) publish(); return false; }
    state = next;
    if (persist && store && accepted.length) store.append(accepted).catch(() => {});
    foldedSinceSweep += events.length;
    if (foldedSinceSweep >= SWEEP_EVERY) { foldedSinceSweep = 0; enforceItemBudget(); }
    scheduleHeaderSnapshot();
    if (!quiet) publish();
    return true;
  }

  // ---- header snapshot ----
  let headerTimer = null;
  let knownConversations = 0;
  // The snapshot is written with the cursor it reflects, and a start resumes the delta from there (never from a later
  // replica high): an engine that dies inside the debounce (the last tab closed; a SharedWorker goes with it) leaves an
  // older snapshot but a newer event store, and resuming from the store's high would skip, for good, the sidebar events
  // the snapshot never saw (parity seed 4: a remote archive undone by a discard).
  function writeHeaderSnapshot() {
    const durable = Object.values(state.conversations);
    knownConversations = durable.length;
    const reflects = state.cursor;
    return store.writeHeaders(durable.map((c) => ({
      id: c.id, title: c.title, preview: c.preview, pinned: c.pinned, archived: c.archived, aside: c.aside,
      workspace: c.workspace ?? null, host: c.host ?? null, deferUntil: c.deferUntil, deferCondition: c.deferCondition, deferredAt: c.deferredAt,
      createdAt: c.createdAt, updatedAt: c.updatedAt, activeAt: c.activeAt || c.updatedAt, lastOpened: c.lastOpened,
      opens: c.opens, turns: c.turns, toolCalls: c.toolCalls, parentId: c.parentId, sidechat: c.sidechat, automated: c.automated,
      settings: c.settings, sessionId: c.sessionId, notableCursor: c.notableCursor, readCursor: c.readCursor,
      forcedUnread: c.forcedUnread, mutedRun: c.mutedRun, snapshotCursor: c.snapshotCursor
    }))).then(() => store.setMeta?.('headersCursor', reflects)).catch(() => {});
  }
  function scheduleHeaderSnapshot() {
    if (!store) return;
    if (Object.keys(state.conversations).length !== knownConversations) {
      clearTimer(headerTimer); headerTimer = null; writeHeaderSnapshot(); return;
    }
    if (headerTimer) return;
    headerTimer = setTimer(() => { headerTimer = null; writeHeaderSnapshot(); }, 1200);
    headerTimer?.unref?.();
  }
  function flushHeaders() { if (headerTimer) { clearTimer(headerTimer); headerTimer = null; return writeHeaderSnapshot(); } return Promise.resolve(); }

  // ---- start ----
  async function start({ open = null, fullLog = true, hydrate: hydrateCount = 8 } = {}) {
    if (started) { if (open) hydrate(open); return started; }
    started = (async () => {
      const t0 = clock();
      const headers = await store.readHeaders();
      if (headers.length) {
        state = mergeConversations(state, headers);
        const high = await store.cursor();
        const reflects = await store.getMeta?.('headersCursor', null);
        state = { ...state, cursor: Number.isSafeInteger(reflects) ? Math.min(reflects, high) : high };
        setStatus({ cached: true, firstPaintMs: clock() - t0 });
      }
      const focus = open || (await store.lastOpened());
      if (focus) {
        markOpen(focus);
        let tail = [];
        try { tail = await store.readLatest(focus, 300); } catch { tail = []; }
        if (tail.length) absorb(tail, { persist: false });
      }
      setStatus({ readyMs: clock() - t0 });
      publish();

      const persisted = await store.outboxAll();
      rehydrateOutbox(persisted); // delivery owns the list of what is owed; the store is its durable copy
      replayOutbox();
      scheduleFlushRetry();
      status.online = online();
      status.offline = status.online === false || status.reachable === false;

      if (headers.length) { bootstrapDelta().then(connect); } else { await bootstrap(hydrateCount); connect(); }
      scheduleHeal();
      scheduleWatchdog();
      flushOutbox();
      if (fullLog) setTimer(() => loadFullLog(), 200);
      scheduleWeekSync(4000);
    })();
    return started;
  }

  let outboxSkipped = 0;
  const owedActions = () => delivery.outbox.map((a) => a.wire || a);
  function replayOutbox() {
    if (!delivery.outbox.length) return;
    let next = state;
    for (const action of owedActions()) {
      try { next = applyOptimistic(next, action); }
      catch { outboxSkipped += 1; status = { ...status, outboxSkipped }; }
    }
    if (next === state) return;
    state = next;
    publish();
  }

  function rehydrateOutbox(actions) {
    const owed = [];
    for (const action of actions || []) {
      const id = action?.id || action?.action_id;
      if (!id) continue;
      storedIds.add(id); // it came off the store, so an ack must take it off again
      const uploads = action.uploads || action.payload?.uploads || [];
      applyDelivery({ type: 'dispatch', action: { ...action, id, uploads } });
      if (uploads.length) owed.push(id);
    }
    for (const id of owed) applyDelivery({ type: 'release_action', id });
  }

  async function loadFullLog(budget = FOLD_BUDGET) {
    if (fullLogLoaded || !store) return;
    fullLogLoaded = true;
    const recent = await store.readRecent(budget);
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
      try { response = await fetchWithin('bootstrap', `/api/bootstrap?days=31&hydrate=${hydrateCount}`, {}, { key: 'bootstrap' }); }
      catch (cause) { unheard(); throw cause; }
      if (!heard(response)) throw new Error('server unreachable');
      if (!response.ok) throw new Error(`bootstrap ${response.status}`);
      const body = await response.json();
      state = mergeConversations(state, body.conversations || []);
      scheduleHeaderSnapshot();
      await absorbLarge(body.events || [], { progressive: true });
      if (Number.isSafeInteger(body.cursor) && body.cursor > state.cursor) state = { ...state, cursor: body.cursor };
      lastLive = body.live || [];
      state = reconcileLiveness(state, lastLive);
      state = mergeSidebar(state, body.sidebar);
      scheduleHeaderSnapshot();
      replayOutbox();
      setStatus({ syncing: false, error: null, capabilities: body.capabilities });
    } catch (cause) {
      setStatus({ syncing: false, error: status.cached || status.reachable === false ? null : cause.message });
    }
  }

  // ---- the one live connection ----
  const streamIsDead = () => !source || source.readyState === 2;
  function dropStream() {
    try { source?.close(); } catch { /* gone */ }
    source = null;
    lastMessageAt = null;
    linkStep('closed', {});
    setStatus({ connected: false });
  }
  const streamIsSilent = () => lastMessageAt !== null && clock() - lastMessageAt > SSE_SILENCE_MS;
  function ensureStream() {
    if (!status.online) return;
    if (streamIsDead() || streamIsSilent()) { dropStream(); connect(); }
  }
  function scheduleWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setTimer(() => { watchdogTimer = null; if (visibleTabs > 0 || visibleTabs === null) ensureStream(); scheduleWatchdog(); }, WATCHDOG_MS);
    watchdogTimer?.unref?.();
  }
  function connect() {
    if (!EventSourceImpl) return;
    if (source && !streamIsDead()) return;
    if (source) dropStream();
    const url = `/api/events?after=${state.cursor}`;
    try { source = new EventSourceImpl(url); } catch { return; }
    linkStep('connect', { url, attempt: link.attempt_count + 1 });
    lastMessageAt = clock();
    const es = source;
    es.onopen = () => {
      if (source !== es) return;
      retries = 0;
      lastMessageAt = clock();
      linkStep('opened', {});
      setStatus({ connected: true, reachable: true, error: null });
      applyDelivery({ type: 'connected' });
      scheduleWeekSync(2000);
      flushOutbox();
    };
    es.onmessage = ({ data }) => {
      if (source !== es) return;
      lastMessageAt = clock();
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.resync) {
        if (Number.isSafeInteger(message.cursor) && message.cursor > state.cursor) state = { ...state, cursor: message.cursor };
        const open = openRecent[0] || null;
        state = markAllUnhydrated(state);
        bootstrap(0).then(() => { if (!open) return publish(); hydrating.delete(open); return hydrate(open); });
        return;
      }
      if (Array.isArray(message.events)) {
        if (message.events.length > CHUNK) absorbLarge(message.events);
        else absorb(message.events);
      }
      if (message.hello) setStatus({ connected: true });
    };
    es.onerror = () => {
      if (source !== es) return;
      linkStep('errored', { msg: 'stream error' });
      dropStream();
      const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
      retries += 1;
      setTimer(() => { if (status.online) bootstrapDelta().then(connect); }, wait);
    };
  }

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
      const response = await fetchWithin('sync', `/api/sync?after=${state.cursor}`, {}, { key: 'sync' });
      if (!heard(response) || !response.ok) return;
      body = await response.json();
    } catch (cause) {
      if (cause?.name !== 'SupersededError') unheard();
      return;
    }
    try {
      await absorbLarge(body.events || [], { progressive: false });
      if (!body.truncated && Number.isSafeInteger(body.cursor) && body.cursor > state.cursor) state = { ...state, cursor: body.cursor };
      lastLive = body.live || lastLive;
      state = reconcileLiveness(state, lastLive);
      state = mergeSidebar(state, body.sidebar);
      scheduleHeaderSnapshot();
      replayOutbox();
      publish();
    } catch (cause) {
      setStatus({ syncing: false, error: `sync failed: ${cause.message}`, resyncs: (status.resyncs || 0) + 1 });
      await fullResync();
    }
  }

  function anyLive() { for (const c of Object.values(state.conversations)) if (LIVE_RUN_STATES.has(c.runState)) return true; return false; }
  async function healLiveness() {
    if (!anyLive() || !status.online) { healStep = 0; return; }
    healStep = Math.min(healStep + 1, HEAL_MS.length - 1);
    await bootstrapDelta();
  }
  function scheduleHeal() {
    if (healTimer) return;
    healTimer = setTimer(() => { healTimer = null; healLiveness().finally(scheduleHeal); }, HEAL_MS[healStep]);
    healTimer?.unref?.();
  }

  // ---- hydrate / earlier ----
  const createStillQueued = (id) => delivery.outbox.some((a) => a?.op === ACTIONS.CREATE && a?.conversation_id === id);
  const earlier = new Map();

  async function hydrate(conversationId) {
    if (!conversationId || hydrating.has(conversationId) || !accepts(conversationId)) return;
    markOpen(conversationId);
    const conversation = state.conversations[conversationId];
    if (conversation?.hydrated) return;
    hydrating.add(conversationId);
    store?.setLastOpened(conversationId).catch?.(() => {});
    let cached = [];
    try { cached = store ? await store.readLatest(conversationId, HYDRATE_EVENTS) : []; } catch { cached = []; }
    if (cached.length) await absorbLarge(cached, { persist: false });
    let loaded = false;
    try {
      const response = await fetchWithin('hydrate', `/api/conversation/${conversationId}?newest=1&limit=${HYDRATE_EVENTS}`, {}, { key: `hydrate:${conversationId}` });
      if (!heard(response)) {
        if (!cached.length && !createStillQueued(conversationId)) setStatus({ transcriptError: `server unreachable (${response.status}), and this chat is not saved on this device yet` });
      } else if (response.ok) {
        const body = await response.json();
        const events = body.events || [];
        earlier.set(conversationId, { more: events.length >= HYDRATE_EVENTS, loading: false });
        await absorbLarge(events, { progressive: false });
        loaded = true;
      } else if (!createStillQueued(conversationId)) {
        setStatus({ transcriptError: `could not load this chat (${response.status})` });
      }
    } catch {
      unheard();
      if (!cached.length && !createStillQueued(conversationId)) setStatus({ transcriptError: 'offline, and this chat is not saved on this device yet' });
    }
    if (!loaded && !earlier.has(conversationId)) earlier.set(conversationId, { more: true, loading: false });
    if ((loaded || cached.length) && status.transcriptError) setStatus({ transcriptError: null });
    if (loaded || cached.length || createStillQueued(conversationId)) state = markHydrated(state, conversationId);
    if (lastLive) state = reconcileLiveness(state, lastLive, { only: conversationId });
    hydrating.delete(conversationId);
    publish();
  }

  const heldCursors = (id) => (state.items[id] || []).map((item) => item.cursor)
    .filter((c) => Number.isSafeInteger(c) && c > 0 && c < Number.MAX_SAFE_INTEGER);

  async function loadEarlier(conversationId) {
    const record = earlier.get(conversationId);
    if (!record?.more || record.loading) return { loaded: 0, more: record?.more ?? false };
    const cursors = heldCursors(conversationId);
    if (!cursors.length) return { loaded: 0, more: true };
    record.loading = true;
    try {
      const before = Math.min(...cursors);
      let response = null;
      try { response = await fetchWithin('earlier', `/api/conversation/${conversationId}?before=${before}&limit=${HYDRATE_EVENTS}`, {}, { key: `earlier:${conversationId}` }); }
      catch { unheard(); }
      if (!response || !heard(response)) return earlierFromReplica(conversationId, before);
      if (!response.ok) return { loaded: 0, more: true };
      const body = await response.json();
      const events = body.events || [];
      await absorbLarge(events, { progressive: true });
      record.more = events.length >= HYDRATE_EVENTS;
      publish();
      return { loaded: events.length, more: record.more };
    } catch { return { loaded: 0, more: true }; }
    finally { record.loading = false; }
  }
  async function earlierFromReplica(conversationId, before) {
    const rows = store?.readBefore ? await store.readBefore(conversationId, before, HYDRATE_EVENTS) : [];
    if (!rows.length) return { loaded: 0, more: true };
    await absorbLarge(rows, { progressive: true, persist: false });
    publish();
    return { loaded: rows.length, more: true, offline: true };
  }
  const canLoadEarlier = (id) => Boolean(earlier.get(id)?.more);

  // ---- the offline window ----
  let weekTimer = null;
  let weekRun = null;
  function scheduleWeekSync(delay = WEEK_EVERY_MS) {
    if (!weekSync || !store?.readSynced) return;
    if (weekTimer) clearTimer(weekTimer);
    weekTimer = setTimer(() => { weekTimer = null; syncWeek().finally(() => scheduleWeekSync()); }, delay);
    weekTimer?.unref?.();
  }
  async function syncWeek() {
    if (!weekSync || weekRun || !store?.readSynced || status.offline) return weekRun;
    weekRun = (async () => {
      try {
        const result = await syncWindow({
          fetchImpl: (url, init) => fetchWithin('week', url, init),
          replica: store, conversations: Object.values(state.conversations), provisional: () => false, windowMs
        });
        if (result.unreachable) unheard();
        setStatus({ weekSync: { ...result, windowDays: Math.round(windowMs / 86_400_000), at: new Date().toISOString() } });
        return result;
      } catch (cause) {
        setStatus({ weekSync: { error: String(cause?.message || cause), at: new Date().toISOString() } });
        return null;
      } finally { weekRun = null; }
    })();
    return weekRun;
  }

  // ---- dispatch and the durable outbox ----
  // When each in-flight POST started, on the wall clock (the one clock a worker and a tab share), for the parity probe.
  const inflightSince = new Map();
  let owedMemo = { delivery: null, value: null };
  /** What is owed, for the tab's probe: changes identity only when delivery changes. */
  function owedView() {
    if (owedMemo.delivery === delivery) return owedMemo.value;
    const items = delivery.outbox.map((a) => ({ id: a.id, op: a.op, conversationId: a.conversation_id, text: a.payload?.text ?? null }));
    const inflight = Object.values(delivery.inflight).map((id) => ({ id, since: inflightSince.get(id) ?? null }));
    owedMemo = { delivery, value: { pending: items.length, messages: unsentMessages(delivery), byConversation: unsentByConversation(delivery), armed: Object.keys(delivery.retryArmed).length, inflight, items } };
    return owedMemo.value;
  }
  let storedIds = new Set();
  function persistOutbox() {
    // The delivery state says what is still owed; anything the store holds that it no longer owes was acknowledged
    // (or refused for good) and comes off disk. New actions were committed before delivery heard of them.
    const owed = new Set(delivery.outbox.map((a) => a.id));
    const gone = [...storedIds].filter((id) => !owed.has(id));
    for (const id of gone) storedIds.delete(id);
    if (gone.length) store.outboxDelete(gone).catch(() => {});
  }

  // A commit to the durable outbox is bounded: IndexedDB can stall (a blocked upgrade, a connection closed under a worker the laptop
  // slept through) and a commit that never settles used to hold the whole dispatch, so the action was neither stored nor sent and the
  // tab's call never returned. Delivery no longer waits on the disk: a commit that fails or runs past the bound is reported
  // (status.outboxError, a `delivery` telemetry record), the action is delivered from memory, and the commit is tried again on every
  // flush. `dispatch` answers `durable` so the tab keeps its own copy (session-host.js journal) until it is true.
  const COMMIT_MS = commitMs;
  const commits = new Map();
  const lateCommits = new Set(); // actions delivered before their commit settled
  function commitWire(wire) {
    // one commit per action in flight: a retry while the first has not settled waits on it instead of queueing behind it on the writer chain
    let put = commits.get(wire.id);
    if (!put) {
      put = Promise.resolve().then(() => store.outboxPut([wire]));
      commits.set(wire.id, put);
      const forget = () => { if (commits.get(wire.id) === put) commits.delete(wire.id); };
      put.then(() => {
        forget();
        storedIds.add(wire.id);
        if (status.outboxError?.id === wire.id) setStatus({ outboxError: null });
        // delivered and acknowledged while the disk was still taking it: take it straight off again
        if (lateCommits.has(wire.id) && !delivery.outbox.some((a) => a.id === wire.id)) { lateCommits.delete(wire.id); persistOutbox(); }
      }, forget);
    }
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimer(() => {
        if (settled) return;
        settled = true;
        setStatus({ outboxError: { at: new Date().toISOString(), id: wire.id, reason: `outbox commit still pending after ${COMMIT_MS} ms` } });
        onTelemetry({ kind: 'delivery', event: 'commit_stalled', durationMs: COMMIT_MS, id: wire.id, op: wire.op, conversation: wire.conversation_id });
        resolve(false);
      }, COMMIT_MS);
      timer?.unref?.();
      put.then(() => { if (settled) return; settled = true; clearTimer(timer); resolve(true); }, (cause) => {
        if (settled) return;
        settled = true; clearTimer(timer);
        setStatus({ outboxError: { at: new Date().toISOString(), id: wire.id, reason: String(cause?.message || cause) } });
        onTelemetry({ kind: 'delivery', event: 'commit_failed', durationMs: 0, id: wire.id, op: wire.op, conversation: wire.conversation_id, error: String(cause?.message || cause) });
        resolve(false);
      });
    });
  }
  /** True when the store holds the action, or nothing owes it any more (delivered, or refused for good). */
  const isDurable = (id) => storedIds.has(id) || !delivery.outbox.some((a) => a.id === id);

  async function dispatch(op, conversationId, payload = {}, { actionId = null, at = null } = {}) {
    if (!accepts(conversationId)) return undefined;
    if (actionId) {
      const held = delivery.outbox.find((a) => a.id === actionId);
      // The same intent again (the tab re-sent it): already owed. Whatever the disk has not yet taken is committed now.
      if (held) { if (!storedIds.has(actionId)) await commitWire(held); return undefined; }
    }
    markOpen(conversationId);
    const id = actionId || mintId();
    const deviceSeq = store.nextDeviceSeq();
    const action = makeAction({ op, conversationId, payload, deviceId, deviceSeq, at: at || new Date().toISOString(), actionId: id });
    const wire = { ...action, id: action.action_id, uploads: payload?.uploads || [] };
    try { store.admit(store.sizeOf ? store.sizeOf(wire) : JSON.stringify(wire).length); }
    catch (cause) {
      if (cause instanceof BackpressureError) {
        setStatus({ backpressure: { at: new Date().toISOString(), op, conversationId, reason: cause.message, ...store.outboxSize() } });
      }
      throw cause;
    }
    state = applyOptimistic(state, action);
    publish();
    scheduleHeaderSnapshot();
    // Durable first (A7): the record is committed before delivery can emit the POST, unless the disk will not take it in
    // time; then it is delivered from memory and `durable` is false until a later commit lands.
    const durable = await commitWire(wire);
    if (!durable) lateCommits.add(wire.id);
    if (status.backpressure) setStatus({ backpressure: null });
    return applyDelivery({ type: 'dispatch', action: wire });
  }

  function applyDelivery(event) {
    const [next, effects] = deliveryStep(delivery, event);
    delivery = next;
    const posts = [];
    for (const e of effects) {
      switch (e.type) {
        case DELIVERY_EFFECTS.PERSIST_OUTBOX: persistOutbox(); publishQueue(); break;
        case DELIVERY_EFFECTS.POST: inflightSince.set(e.action.id, Date.now()); posts.push(post(outgoing(e.action)).finally(() => inflightSince.delete(e.action.id))); break;
        case DELIVERY_EFFECTS.ARM_RETRY: scheduleFlushRetry(); setStatus({ queued: delivery.outbox.length, unsentMessages: unsentMessages(delivery), unsentByConversation: unsentByConversation(delivery) }); break;
        case DELIVERY_EFFECTS.CLEAR_RETRY:
          if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
          if (Object.keys(delivery.retryArmed).length) scheduleFlushRetry();
          break;
        case DELIVERY_EFFECTS.ARM_UPLOAD_PATIENCE: armPatience(e.actionId, uploadPatienceMs ?? e.ms); break;
        case DELIVERY_EFFECTS.CLEAR_UPLOAD_PATIENCE: clearPatience(e.actionId); break;
        case DELIVERY_EFFECTS.APPLY_EVENTS: absorb(e.events); break;
        default: break;
      }
    }
    if (effects.some((e) => e.type === DELIVERY_EFFECTS.ARM_UPLOAD_PATIENCE || e.type === DELIVERY_EFFECTS.CLEAR_UPLOAD_PATIENCE)) publishQueue();
    return Promise.all(posts);
  }
  function publishQueue() { setStatus({ queued: delivery.outbox.length, unsentMessages: unsentMessages(delivery), unsentByConversation: unsentByConversation(delivery), waitingUploads: waitingUploadsByConversation(delivery) }); }
  function outgoing(action) {
    if (!delivery.released.includes(action.id)) return action;
    const waiting = pendingUploadsOf(delivery, action).map((u) => (delivery.failedUploads.includes(u.id) ? { ...u, failed: true, error: uploadErrors.get(u.id) || 'the upload failed' } : u));
    if (!waiting.length) return action;
    return { ...action, payload: { ...action.payload, pending_uploads: waiting } };
  }
  function armPatience(actionId, ms) {
    if (patienceTimers.has(actionId)) return;
    const timer = setTimer(() => { patienceTimers.delete(actionId); applyDelivery({ type: 'release_action', id: actionId }); }, ms);
    timer?.unref?.();
    patienceTimers.set(actionId, timer);
  }
  function clearPatience(actionId) { const t = patienceTimers.get(actionId); if (t) clearTimer(t); patienceTimers.delete(actionId); }

  async function post(action) {
    try {
      const response = await fetchWithin('send', '/api/actions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action)
      }, { key: `send:${action.id}` });
      if (!heard(response)) throw new Error('offline');
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const reason = body.error || `action ${response.status}`;
        if (refusedForGood(response.status)) {
          setStatus({ error: reason, rejected: [...(status.rejected || []), { id: action.id, op: action.op, conversationId: action.conversation_id, text: action.payload?.text ?? null, status: response.status, reason }] });
          if (action.op === ACTIONS.MOVE_SCOPE) { state = setConversationScope(state, action.conversation_id, action.payload?.from ?? null); publish(); }
          await applyDelivery({ type: 'send_rejected', id: action.id });
          return;
        }
        throw new Error(reason);
      }
      const body = await response.json();
      await applyDelivery({ type: 'send_ok', id: action.id, events: body.events || [] });
    } catch (cause) {
      if (cause?.name === 'TypeError' || cause?.name === 'DeadlineError') unheard();
      setStatus({ sendError: cause?.message || String(cause) });
      await applyDelivery({ type: 'send_failed', id: action.id });
    }
  }
  async function flushOutbox() {
    if (!delivery.outbox.length) return;
    // actions the disk has not taken yet are committed again at every flush (a stalled commit is retried, not forgotten)
    for (const held of delivery.outbox) if (!storedIds.has(held.id)) commitWire(held);
    if (flushing) return flushing;
    flushing = applyDelivery({ type: 'retry_fired' }).finally(() => { flushing = null; });
    return flushing;
  }
  function scheduleFlushRetry() {
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    if (!delivery.outbox.length) return;
    retryTimer = setTimer(() => { retryTimer = null; flushOutbox(); }, 5000);
    retryTimer?.unref?.();
  }

  // ---- search and files ----
  async function search(query, { mode = 'smart', conversation = null } = {}) {
    // The server is asked whenever the browser has a network, even after it last failed to answer: `reachable` is what
    // the last request learned, and this request is the probe that updates it (the search deadline bounds the cost).
    // Gating on it served the replica's answer for as long as the event stream's reconnect backoff ran after a server
    // restart.
    if (status.online !== false) {
      const params = new URLSearchParams({ q: query, mode });
      if (conversation) params.set('conversation', conversation);
      try {
        const response = await fetchWithin('search', `/api/search?${params}`, {}, { key: 'search' });
        if (heard(response) && response.ok) return response.json();
        if (heard(response)) throw new Error('search failed');
      } catch (cause) {
        if (cause?.name === 'SupersededError') throw cause;
        if (cause?.message === 'search failed') throw cause;
        if (cause?.name === 'TypeError' || cause?.name === 'DeadlineError') unheard();
      }
    }
    const headers = Object.values(state.conversations);
    return searchReplica(store, headers, query, { mode, conversation });
  }

  async function file(path, { conversationId = null } = {}) {
    if (/^https?:\/\//iu.test(String(path || ''))) {
      const last = String(path).split(/[?#]/u)[0].split('/').filter(Boolean).pop() || path;
      let name = last;
      try { name = decodeURIComponent(last); } catch { /* keep */ }
      return { path, name, remote: true, binary: true, url: remoteImageUrl(path) };
    }
    const key = `${conversationId || ''}::${path}`;
    const params = new URLSearchParams({ path });
    if (conversationId) params.set('conversation', conversationId);
    try {
      const response = await fetchWithin('file', `/api/file?${params}`, {}, { key: `file:${key}` });
      if (!response.ok) throw new Error(`${response.status}`);
      const body = await response.json();
      store?.writeBlob(key, body, (body.text || '').length + 256);
      return body;
    } catch (cause) {
      const cached = store ? await store.readBlob(key) : null;
      if (cached) return { ...cached, stale: true };
      throw cause;
    }
  }

  // ---- host signals (a tab forwards what only a window can see) ----
  let visibleTabs = null; // null: unknown (tests, a lone tab); else how many tabs are visible
  function setOnline(value) {
    if (value) { setStatus({ online: true }); applyDelivery({ type: 'online' }); ensureStream(); }
    else { setStatus({ online: false, connected: false }); applyDelivery({ type: 'offline' }); }
  }
  function tabVisible(count = null) {
    visibleTabs = count;
    healStep = 0;
    retries = 0;
    return bootstrapDelta().then(ensureStream);
  }

  return {
    start, hydrate, loadEarlier, canLoadEarlier, loadFullLog, search, file, flushOutbox, syncWeek, dispatch, isDurable,
    stageUpload: (id) => applyDelivery({ type: 'upload_staged', id }),
    failUpload: (id, error = null) => { if (error) uploadErrors.set(id, String(error)); return applyDelivery({ type: 'upload_failed', id }); },
    dropRevoked() {
      const gone = Object.values(state.conversations).filter((c) => c.revoked).map((c) => c.id);
      if (!gone.length) return gone;
      for (const id of gone) state = forgetConversation(state, id);
      openRecent = openRecent.filter((id) => !gone.includes(id));
      publish();
      return gone;
    },
    setOnline, tabVisible, flushHeaders,
    earlierFor: (id) => (earlier.has(id) ? { ...earlier.get(id) } : null),
    owed: () => owedView(),
    earlierMap: () => Object.fromEntries([...earlier].map(([k, v]) => [k, Boolean(v.more)])),
    link: () => link,
    netStats: () => net.stats(),
    get state() { return state; },
    get status() { return status; },
    get outbox() { return owedActions(); },
    get delivery() { return delivery; },
    usage: () => (store ? store.usage() : Promise.resolve({ events: 0, blobs: 0 })),
    subscribe(fn) { subscribers.add(fn); fn(state, status); return () => subscribers.delete(fn); },
    telemetry: onTelemetry
  };
}
