// The chat engine as served to tabs: one per browser (engine/worker.js), or in a tab as a last resort. It owns the
// chat store, the core (engine/core.js), the one /api/events connection and the telemetry lane; tabs call its methods
// and receive snapshots and patches (kit lib/engine/host.js).

import { serveEngine } from '../../../../runner/tools/quicklook-kit/lib/engine/host.js';
import { createTelemetryLane } from '../../../../runner/tools/quicklook-kit/lib/engine/lane.js';
import { createDeadlineFetch } from '../../../../runner/tools/quicklook-kit/lib/engine/deadline.js';
import { createEngineCore } from './core.js';
import { openChatStore } from './chat-store.js';
import { importLegacy, importLegacyEvents } from './migrate.js';
import { ulid } from '../../../../runner/tools/quicklook-kit/lib/engine/ulid.js';

export const CHAT_DIFF = Object.freeze({ maps: ['conversations', 'items', 'earlier'], skip: ['seen', 'itemIndex'] });

/** What a tab mirrors: the reducer state without its fold ledgers, plus which chats have earlier history. */
export function projectChat(core) {
  const s = core.state;
  return { version: s.version, cursor: s.cursor, rev: s.rev, conversations: s.conversations, items: s.items, earlier: core.earlierMap(), owed: core.owed() };
}

export function makeChatServer({ fetchImpl, EventSourceImpl = globalThis.EventSource, indexedDB = globalThis.indexedDB, storeImpl = null,
  coreOptions = {}, telemetrySend = null, schedule } = {}) {
  let core = null;
  let booting = null;
  const subs = new Set();
  // Telemetry has its own lane and its own deadline-bound fetch; it shares nothing with the outbox.
  const lagNet = createDeadlineFetch(fetchImpl);
  const lane = createTelemetryLane({
    maxItems: 200,
    send: telemetrySend ?? (async (records) => { await lagNet.fetchWithin('telemetry', '/api/client-lag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records }) }, { key: 'telemetry' }); })
  });
  let migration = null;
  // When each boot step finished, on the epoch clock (performance.timeOrigin + now), so a tab can place them on its own
  // timeline: health().boot. Diagnosis of the cold load (parity coldLoad budget).
  const at = () => (globalThis.performance ? performance.timeOrigin + performance.now() : Date.now());
  const bootAt = { created: at() };

  function boot({ device = null, legacyActions = [] } = {}) {
    if (booting) return booting;
    booting = (async () => {
      bootAt.boot = at();
      const store = storeImpl || await openChatStore({ indexedDB });
      bootAt.store = at();
      // Identity of this browser's origin: the legacy device id when there was one, so device_seq stays one device's.
      let deviceId = await store.getMeta('deviceId', null);
      if (!deviceId) { deviceId = device || ulid(); await store.setMeta('deviceId', deviceId); }
      await store.setMeta('active', true); // the legacy path reads this to know it has actions to take back
      try { migration = await importLegacy({ indexedDB, store, legacyActions, events: false }); }
      catch (cause) { migration = { error: String(cause?.message || cause) }; }
      bootAt.migrated = at();
      // the events follow in the background, newest first, resumable; the chat list and the outbox are already here
      setTimeout(() => {
        importLegacyEvents({ indexedDB, store, onChunk: (p) => { migration = { ...migration, events: p.events, chunks: p.chunks }; } })
          .then((p) => { migration = { ...migration, events: p.events, eventsDone: true }; })
          .catch((cause) => { migration = { ...migration, eventsError: String(cause?.message || cause) }; });
      }, 0);
      core = createEngineCore({ fetchImpl, EventSourceImpl, store, deviceId, onTelemetry: (r) => lane.push(r), ...coreOptions });
      core.subscribe(() => { if (!bootAt.firstPublish) bootAt.firstPublish = at(); for (const f of subs) f(); });
      return core;
    })();
    return booting;
  }

  const timed = (name, fn) => async (...args) => {
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    try { return await fn(...args); }
    finally {
      const ms = (globalThis.performance?.now?.() ?? Date.now()) - t0;
      if (ms > 1000 && name !== 'start' && name !== 'search' && name !== 'loadEarlier' && name !== 'hydrate') lane.push({ kind: 'longtask', source: 'engine', op: name, durationMs: Math.round(ms) });
    }
  };
  const need = async () => core || boot();
  const methods = {
    start: async (opts = {}, boot0 = {}) => { const c = await boot(boot0); await c.start(opts); return { migration }; },
    hydrate: async (id) => (await need()).hydrate(id),
    loadEarlier: async (id) => (await need()).loadEarlier(id),
    loadFullLog: async () => (await need()).loadFullLog(),
    search: async (q, o) => (await need()).search(q, o),
    file: async (p, o) => (await need()).file(p, o),
    flushOutbox: async () => (await need()).flushOutbox(),
    syncWeek: async () => (await need()).syncWeek(),
    dispatch: async (op, id, payload, o) => { await (await need()).dispatch(op, id, payload, o); return true; },
    stageUpload: async (id) => { await (await need()).stageUpload(id); return true; },
    failUpload: async (id, e) => { await (await need()).failUpload(id, e); return true; },
    dropRevoked: async () => (await need()).dropRevoked(),
    setOnline: async (v) => (await need()).setOnline(v),
    tabVisible: async () => (await need()).tabVisible(),
    flushHeaders: async () => (await need()).flushHeaders(),
    usage: async () => (await need()).usage(),
    telemetry: async (records) => { for (const r of records || []) lane.push(r); return lane.counts(); },
    inspect: async (id) => { const c = await need(); return { items: c.state.items[id]?.length ?? 0, seen: c.state.seen.get(id)?.size ?? 0, hydrated: Boolean(c.state.conversations[id]?.hydrated), cursor: c.state.cursor }; },
    health: async () => ({ boot: bootAt, lane: lane.counts(), net: core?.netStats() ?? null, link: core?.link() ?? null, store: core ? await core.usage() : null, migration })
  };
  for (const k of Object.keys(methods)) methods[k] = timed(k, methods[k]);

  const empty = { version: 0, cursor: 0, rev: 0, conversations: {}, items: {}, earlier: {}, owed: { pending: 0, armed: 0, inflight: [], items: [] } };
  return serveEngine({
    methods,
    view: () => (core ? projectChat(core) : empty),
    status: () => core?.status ?? null,
    subscribe: (fn) => subs.add(fn),
    diffOptions: CHAT_DIFF,
    ...(schedule ? { schedule } : {})
  });
}
