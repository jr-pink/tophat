// The chat replica schema on the kit engine: what is chat-specific about storing chats, and nothing else.
// The generic parts (single writer, incremental accounting, declared budget and window, single-flight eviction,
// durable outbox with typed backpressure) are tools/quicklook-kit/lib/engine/replica-store.js and outbox.js.
//
// Schema: records are server events keyed by `cursor`, partitioned by `conversation_id`, timed by `at`; metadata
// is the header snapshot (`headers`, never evicted), `lastOpened`, and `synced` (how far each chat is held
// contiguously, week-sync.js), which loses a chat's entry when eviction drops it. Outbox records are the wire actions
// client/session.js has always queued (`{...action, id, uploads}`), so a rollback can hand them back unchanged.
//
// The adapter speaks the replica interface engine/core.js and client/week-sync.js already use.

import { openReplicaStore, memoryReplicaStore, REPLICA_POLICY } from '../../../../runner/tools/quicklook-kit/lib/engine/replica-store.js';
import { openOutbox, memoryOutbox, BackpressureError } from '../../../../runner/tools/quicklook-kit/lib/engine/outbox.js';
import { approxSize } from '../../../../runner/tools/quicklook-kit/lib/engine/lane.js';

export { BackpressureError };
export const ENGINE_DB = 'tophat-engine';
export const ENGINE_OUTBOX_DB = 'tophat-engine-outbox';
// the owner's bar: two weeks to a month of chats readable offline. Two weeks is the declared default; the byte budget
// is the legacy replica's (1 GB, replica.js), which the 11-07 measurement put at about twice a week's window.
export const CHAT_POLICY = Object.freeze({ ...REPLICA_POLICY, windowMs: 14 * 24 * 60 * 60 * 1000, budgetBytes: 1_000_000_000 });

export async function openChatStore({ indexedDB: idb = globalThis.indexedDB, IDBKeyRange: Range = globalThis.IDBKeyRange, policy = {}, outboxLimits = {}, now = () => Date.now(), name = ENGINE_DB } = {}) {
  const P = { ...CHAT_POLICY, ...policy };
  const records = idb
    ? await openReplicaStore({ indexedDB: idb, IDBKeyRange: Range, name, key: 'cursor', partition: 'conversation_id', time: 'at', policy: P, now })
    : memoryReplicaStore({ key: 'cursor', partition: 'conversation_id', time: 'at', policy: P, now });
  const outbox = idb ? await openOutbox({ indexedDB: idb, name: `${name}-outbox`, limits: outboxLimits, now }) : memoryOutbox({ limits: outboxLimits });
  return chatStore(records, outbox);
}

export function chatStore(records, outbox) {
  // A dropped chat is no longer held, so the background fill must start it from the beginning again.
  records.onDrop((id) => records.meta.update('synced', (m) => { if (!(id in m)) return m; const n = { ...m }; delete n[id]; return n; }, {}));
  return {
    kind: `chat-${records.kind}`,
    records, outbox,
    policy: records.policy,
    setKeep: (fn) => records.setKeep(fn),
    idle: async () => { await records.idle(); await outbox.idle(); },
    stats: () => ({ ...records.stats(), outbox: outbox.stats() }),

    async cursor() { return records.high(); },
    raiseCursor: (c) => records.raiseHigh(c),
    async usage() { const u = records.usage(); return { events: u.bytes, blobs: u.blobs, conversations: u.parts, records: u.records, windowBreached: u.windowBreached, outbox: outbox.size() }; },
    append: (events) => records.append(events),
    evictEvents: (budget) => records.evict(budget),
    readLatest: (id, limit) => records.readLatest(id, limit),
    readBefore: (id, before, limit) => records.readBefore(id, before, limit),
    readConversation: (id) => records.readPartition(id),
    readRecent: (limit) => records.readRecent(limit),
    conversationCursors: (id) => records.keysOf(id),
    scanNewest: (step) => records.scanNewest(step),
    readHeaders: () => records.meta.get('headers', []),
    writeHeaders: (h) => records.meta.set('headers', h),
    lastOpened: () => records.meta.get('lastOpened', null),
    setLastOpened: (id) => records.meta.set('lastOpened', id),
    readSynced: () => records.meta.get('synced', {}),
    writeSynced: (m) => records.meta.set('synced', m),
    getMeta: (k, f) => records.meta.get(k, f),
    setMeta: (k, v) => records.meta.set(k, v),
    readBlob: (k) => records.readBlob(k),
    writeBlob: (k, v, bytes) => records.writeBlob(k, v, bytes),

    // ---- the durable outbox (kit outbox.js), chat wire actions as bodies ----
    admit: (size) => outbox.admit(size),
    hasOutbox: (id) => outbox.has(id),
    outboxSize: () => outbox.size(),
    nextDeviceSeq: () => outbox.counter('deviceSeq'),
    outboxPut: (actions) => outbox.put(actions.map((a) => ({ id: a.id || a.action_id, stream: String(a.conversation_id ?? ''), body: a }))),
    outboxDelete: (ids) => outbox.delete(ids),
    async outboxAll() { return (await outbox.all()).map((r) => r.body); },
    sizeOf: approxSize,
    close() { records.close(); outbox.close(); }
  };
}

export async function memoryChatStore(options = {}) { return openChatStore({ ...options, indexedDB: null }); }
