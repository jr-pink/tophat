// Migrate, never lose (A2 requirement 8). The legacy chat replica (IndexedDB `tophat-webchat`, client/replica.js) and
// the legacy outbox (localStorage `tophat-webchat-outbox`, plus the IndexedDB `meta.outbox` fallback) are imported into
// the engine's stores; nothing legacy is deleted or rewritten, so the legacy path can run again on the same data.
//
// importLegacy (engine side) is idempotent and incremental: events resume from the last cursor imported (a duplicate
// is refused by the store), outbox actions are keyed by their own id (an id already held is kept), and the header
// snapshot, lastOpened and synced map are taken only where the engine has none. Running it after a rollback picks up
// whatever the legacy path wrote meanwhile.
//
// rollbackToLegacy (tab side, legacy path) hands the engine's undelivered actions back to the legacy outbox key: the
// legacy entries the engine imported and has since delivered are removed, every action still owed is present once,
// and the engine's newer header snapshot is written into the legacy replica so the first paint shows current placement.

import { done, openExisting, req, walk } from '../../../../runner/tools/docstore-kit/lib/engine/idb.js';
import { readOutboxSync, writeOutboxSync } from '../client/replica.js';

export const LEGACY_DB = 'tophat-webchat';
export const LEGACY_OUTBOX_KEY = 'tophat-webchat-outbox';
export const LEGACY_DEVICE_KEY = 'tophat-webchat-device';

const idOf = (a) => a?.id || a?.action_id || null;

/**
 * The fast part first (headers, cursor, synced, lastOpened, every outbox action), so the engine can start and show the
 * chat list at once; then the events (`events: true`, or `importLegacyEvents` in the background, which is what the
 * engine does: a 658k-event replica must never hold the first paint).
 */
export async function importLegacy({ indexedDB: idb = globalThis.indexedDB, IDBKeyRange: Range = globalThis.IDBKeyRange, store, legacyActions = [], chunk = 5000, legacyName = LEGACY_DB, events = true } = {}) {
  const st = { high: 0, low: null, done: false, events: 0, outboxImported: [], runs: 0, ...(await store.getMeta('migration', {})) };
  const summary = { events: 0, outbox: 0, legacyDb: false, headers: false };
  const legacy = idb ? await openExisting(idb, legacyName) : null;
  // The legacy outbox (localStorage copy first, then the IndexedDB fallback) drains straight into the durable outbox,
  // chunk by chunk; nothing is held in a second list on the way.
  const drain = async (actions) => {
    for (let i = 0; i < (actions?.length || 0); i += 200) {
      const chunkOf = actions.slice(i, i + 200).filter((a) => idOf(a) && a.op && a.conversation_id);
      for (const a of chunkOf) seen.add(idOf(a));
      const fresh = chunkOf.filter((a) => !store.hasOutbox(idOf(a)));
      if (fresh.length) summary.outbox += await store.outboxPut(fresh.map((a) => ({ ...a, id: idOf(a), uploads: a.uploads || a.payload?.uploads || [] })));
    }
  };
  const seen = new Set(st.outboxImported);
  // The archive copy of the legacy outbox key lives in the engine's own store, beside the untouched original.
  if (Array.isArray(legacyActions) && legacyActions.length) await store.setMeta('legacyOutboxArchive', { at: new Date().toISOString(), actions: legacyActions });
  await drain(Array.isArray(legacyActions) ? legacyActions : []);
  if (legacy) {
    summary.legacyDb = legacy.objectStoreNames.contains('events');
    if (legacy.objectStoreNames.contains('meta')) {
      const tx = legacy.transaction('meta', 'readonly');
      const m = tx.objectStore('meta');
      const [headers, cursor, synced, lastOpened, outbox] = await Promise.all(['headers', 'cursor', 'synced', 'lastOpened', 'outbox'].map((k) => req(m.get(k))));
      if (Array.isArray(headers) && headers.length && !(await store.readHeaders()).length) { await store.writeHeaders(headers); summary.headers = true; }
      if (Number.isSafeInteger(cursor)) await store.raiseCursor(cursor);
      if (synced && typeof synced === 'object') {
        const mine = await store.readSynced();
        const merged = { ...synced, ...mine };
        if (Object.keys(merged).length !== Object.keys(mine).length) await store.writeSynced(merged);
      }
      if (lastOpened && !(await store.lastOpened())) await store.setLastOpened(lastOpened);
      if (Array.isArray(outbox)) await drain(outbox);
    }
    legacy.close();
  }
  st.outboxImported = [...seen];
  st.runs += 1;
  st.at = new Date().toISOString();
  await store.setMeta('migration', st);
  if (events) summary.events = (await importLegacyEvents({ indexedDB: idb, IDBKeyRange: Range, store, chunk, legacyName })).events;
  return { ...summary, totalEvents: st.events, outboxImported: st.outboxImported.length };
}

/**
 * Copy the legacy events, newest first (what he reads first is what lands first), one chunk per transaction, resumable
 * (`low` is the frontier), and on later runs only what the legacy path wrote above `high` (after a rollback).
 */
export async function importLegacyEvents({ indexedDB: idb = globalThis.indexedDB, IDBKeyRange: Range = globalThis.IDBKeyRange, store, chunk = 5000, legacyName = LEGACY_DB, onChunk = () => {} } = {}) {
  const out = { events: 0, chunks: 0 };
  const legacy = idb ? await openExisting(idb, legacyName) : null;
  if (!legacy || !legacy.objectStoreNames.contains('events')) { legacy?.close(); return out; }
  const st = { high: 0, low: null, done: false, events: 0, ...(await store.getMeta('migration', {})) };
  const save = () => store.setMeta('migration', { ...(st), at: new Date().toISOString() });
  try {
    // above what was imported before (the legacy path ran again in between)
    if (st.done) {
      for (;;) {
        const rows = [];
        await walk(legacy.transaction('events', 'readonly').objectStore('events').openCursor(Range.lowerBound(st.high, true)), (c) => { rows.push(c.value); return rows.length < chunk; });
        if (!rows.length) break;
        const added = await store.append(rows);
        out.events += added; st.events += added; st.high = rows[rows.length - 1].cursor; out.chunks += 1;
        await save(); onChunk(out);
        if (rows.length < chunk) break;
      }
      return out;
    }
    for (;;) {
      const rows = [];
      const range = st.low === null ? null : Range.upperBound(st.low, true);
      await walk(legacy.transaction('events', 'readonly').objectStore('events').openCursor(range, 'prev'), (c) => { rows.push(c.value); return rows.length < chunk; });
      if (!rows.length) { st.done = true; await save(); break; }
      const added = await store.append(rows);
      out.events += added; st.events += added; out.chunks += 1;
      if (st.low === null) st.high = rows[0].cursor;
      st.low = rows[rows.length - 1].cursor;
      await save(); onChunk(out);
      if (rows.length < chunk) { st.done = true; await save(); break; }
    }
  } finally { legacy.close(); }
  return out;
}

/** Tab side, before the first engine start: what only a window can read (a worker has no localStorage). Read only. */
export function readLegacyLocal(storage = globalThis.localStorage) {
  let device = null;
  try { device = storage?.getItem(LEGACY_DEVICE_KEY) || null; } catch { device = null; }
  const actions = storage === globalThis.localStorage ? readOutboxSync(LEGACY_OUTBOX_KEY) : (() => { try { const v = JSON.parse(storage?.getItem(LEGACY_OUTBOX_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })();
  return { actions, device };
}

/** Legacy path, before its start(): put every action the engine still owes back where the legacy outbox reads. */
// Engine activity is recorded in the engine's own meta (`active`), not in localStorage: the legacy path asks the engine
// database whether there is anything to hand back. With no engine database this opens nothing and returns at once.
export async function rollbackToLegacy({ indexedDB: idb = globalThis.indexedDB, engineName = 'tophat-engine' } = {}) {
  const report = { restored: 0, dropped: 0, kept: 0, headers: false, ran: false };
  if (!idb) return report;
  const engineDb = await openExisting(idb, engineName);
  if (!engineDb) return report;
  let active = false;
  try { active = engineDb.objectStoreNames.contains('meta') && (await req(engineDb.transaction('meta', 'readonly').objectStore('meta').get('active'))) === true; } catch { active = false; }
  if (!active) { engineDb.close(); return report; }
  report.ran = true;
  const box = await openExisting(idb, `${engineName}-outbox`);
  try {
    const owed = box && box.objectStoreNames.contains('outbox')
      ? ((await req(box.transaction('outbox', 'readonly').objectStore('outbox').getAll())) || []).sort((a, b) => a.seq - b.seq).map((r) => r.body)
      : [];
    let imported = new Set(), headers = null, lastOpened = null;
    if (engineDb && engineDb.objectStoreNames.contains('meta')) {
      const m = engineDb.transaction('meta', 'readonly').objectStore('meta');
      imported = new Set((await req(m.get('migration')))?.outboxImported || []);
      headers = await req(engineDb.transaction('meta', 'readonly').objectStore('meta').get('headers'));
      lastOpened = await req(engineDb.transaction('meta', 'readonly').objectStore('meta').get('lastOpened'));
    }
    const legacy = readOutboxSync(LEGACY_OUTBOX_KEY);
    const owedIds = new Set(owed.map(idOf));
    // A legacy entry the engine imported and no longer owes was delivered by the engine: sending it again would only be
    // answered by the server's receipt, but it is not owed. Anything the engine never saw stays.
    const kept = legacy.filter((a) => !imported.has(idOf(a)) || owedIds.has(idOf(a)));
    report.dropped = legacy.length - kept.length;
    const keptIds = new Set(kept.map(idOf));
    const restored = owed.filter((a) => !keptIds.has(idOf(a)));
    const merged = [...kept.map((a) => (owedIds.has(idOf(a)) ? owed.find((o) => idOf(o) === idOf(a)) : a)), ...restored];
    report.restored = restored.length; report.kept = kept.length;
    if (!writeOutboxSync(merged, LEGACY_OUTBOX_KEY)) throw new Error('legacy outbox not writable; the engine still holds every action');
    if (Array.isArray(headers) && headers.length) {
      const legacyDb = await openExisting(idb, LEGACY_DB);
      if (legacyDb && legacyDb.objectStoreNames.contains('meta')) {
        const tx = legacyDb.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(headers, 'headers');
        if (lastOpened) tx.objectStore('meta').put(lastOpened, 'lastOpened');
        await done(tx);
        report.headers = true;
      }
      legacyDb?.close();
    }
    const tx = engineDb.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(false, 'active');
    tx.objectStore('meta').put(new Date().toISOString(), 'rolledBackAt');
    await done(tx);
  } finally { box?.close(); engineDb?.close(); }
  return report;
}
