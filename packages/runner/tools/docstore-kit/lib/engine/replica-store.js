// An IndexedDB replica of an append-only record log with a declared budget (Docstore3 section 8; perf doctrine
// rules 1 and 5). The engine is its only writer, so accounting lives in memory and in a `parts` store, updated per
// write; nothing ever scans the records to measure them.
//
// Records are immutable once written (a log keyed by a server-assigned position): a key already held is refused
// by the store and counted as a duplicate, so a re-delivered page can never inflate the totals. Records are grouped
// by a partition field (a chat, a document, a stream); eviction drops whole partitions, least recently active
// first, never one inside `windowMs` unless the window alone is over budget (then counted as `windowBreached`).
// Eviction is single-flight and dirty-coalesced (jobs.js), one partition per short transaction.
//
//   const store = await openReplicaStore({ name: 'notes-replica', key: 'pos', partition: 'doc', time: 'at',
//                                          policy: { budgetBytes: 200e6, windowMs: 14 * 864e5 } })
//   await store.append(records)                           // one transaction per writer turn, coalesced
//   const page = await store.readLatest('doc-1', 100)     // newest 100 of a partition, in order
//   store.meta.set('headers', rows)                       // small app metadata, never evicted

import { done, req, walk, writerChain } from './idb.js';
import { approxSize } from './lane.js';
import { createJobs, ledger } from './jobs.js';

export const REPLICA_POLICY = Object.freeze({ budgetBytes: 1_000_000_000, windowMs: 14 * 24 * 60 * 60 * 1000, evictTo: 0.8, blobBudgetBytes: 150_000_000 });

const at = (obj, path) => obj?.[path];

export async function openReplicaStore({ indexedDB: idb = globalThis.indexedDB, IDBKeyRange: Range = globalThis.IDBKeyRange, name = 'qk-replica',
  key = 'key', partition = 'part', time = 'at', sizeOf = (r) => approxSize(r) + 64, policy = {}, now = () => Date.now(), jobs = createJobs() } = {}) {
  if (!idb) return memoryReplicaStore({ key, partition, time, policy });
  const P = { ...REPLICA_POLICY, ...policy };
  const open = idb.open(name, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    const records = db.createObjectStore('records', { keyPath: key });
    records.createIndex('part', partition);
    records.createIndex('part_key', [partition, key]);
    db.createObjectStore('parts', { keyPath: 'id' });
    db.createObjectStore('meta');
    db.createObjectStore('blobs', { keyPath: 'key' }).createIndex('touched', 'touched');
  };
  const db = await req(open);
  const tx0 = db.transaction(['parts', 'meta'], 'readonly');
  const book = ledger((await req(tx0.objectStore('parts').getAll())) || []);
  let high = (await req(tx0.objectStore('meta').get('__high'))) ?? 0;
  let blobBytes = (await req(tx0.objectStore('meta').get('__blobBytes'))) ?? 0;
  const writer = writerChain();
  const stats = { appended: 0, duplicates: 0, invalid: 0, appendTx: 0, evictedParts: 0, windowBreached: 0, blobEvictions: 0 };
  let keep = () => false;
  const valid = (r) => r && typeof r === 'object' && (typeof at(r, key) === 'number' || typeof at(r, key) === 'string') && at(r, partition) != null && at(r, partition) !== '';

  // ---- append, coalesced ----
  let batch = null;
  function append(list) {
    const good = [];
    for (const r of list || []) { if (valid(r)) good.push(r); else stats.invalid += 1; }
    if (!good.length) return Promise.resolve(0);
    if (!batch) {
      const b = { records: [] };
      b.promise = writer.run(() => { if (batch === b) batch = null; return writeBatch(b.records); });
      batch = b;
    }
    batch.records.push(...good);
    return batch.promise;
  }
  async function writeBatch(list) {
    stats.appendTx += 1;
    const tx = db.transaction(['records', 'parts', 'meta'], 'readwrite');
    const store = tx.objectStore('records');
    const delta = new Map();
    let top = high, added = 0, dups = 0;
    await new Promise((resolve) => {
      let pending = list.length;
      const settle = () => { if (--pending === 0) resolve(); };
      for (const r of list) {
        const k = at(r, key);
        const q = store.add(r);
        q.onsuccess = () => {
          const p = String(at(r, partition)), d = delta.get(p) || { bytes: 0, count: 0, last: '' }, t = String(at(r, time) ?? '');
          d.bytes += sizeOf(r); d.count += 1; if (t > d.last) d.last = t;
          delta.set(p, d); added += 1;
          if (typeof k === 'number' && k > top) top = k;
          settle();
        };
        q.onerror = (ev) => { ev.preventDefault?.(); ev.stopPropagation?.(); dups += 1; if (typeof k === 'number' && k > top) top = k; settle(); };
      }
    });
    const rows = [];
    for (const [p, d] of delta) {
      const prior = book.get(p) || { id: p, bytes: 0, count: 0, last: '' };
      const row = { id: p, bytes: prior.bytes + d.bytes, count: prior.count + d.count, last: d.last > prior.last ? d.last : prior.last };
      tx.objectStore('parts').put(row);
      rows.push([row, d]);
    }
    if (top !== high) tx.objectStore('meta').put(top, '__high');
    await done(tx);
    for (const [row, d] of rows) book.add(row.id, d.bytes, d.count, row.last);
    high = top;
    stats.appended += added; stats.duplicates += dups;
    if (book.total() > P.budgetBytes) evict();
    return added;
  }

  // ---- eviction ----
  function evict(budget = P.budgetBytes) {
    return jobs.run(`evict:${name}`, async (tick) => {
      const target = budget * P.evictTo;
      if (book.total() <= target) return [];
      const cutoff = new Date(now() - P.windowMs).toISOString();
      const dropped = [];
      for (const part of book.evictionOrder({ keepAfter: cutoff, keep })) {
        if (book.total() <= target) break;
        if (part.inWindow) stats.windowBreached += 1;
        await writer.run(() => dropPart(part.id));
        dropped.push(part.id);
        await tick();
      }
      return dropped;
    });
  }
  async function dropPart(id) {
    if (!book.get(id)) return;
    const tx = db.transaction(['records', 'parts'], 'readwrite');
    const store = tx.objectStore('records');
    await walk(store.index('part').openKeyCursor(Range.only(id)), (c) => { store.delete(c.primaryKey); });
    tx.objectStore('parts').delete(id);
    await done(tx);
    book.remove(id);
    stats.evictedParts += 1;
    for (const fn of onDrop) { try { await fn(id); } catch { /* the listener's problem */ } }
  }
  const onDrop = new Set();

  // ---- reads ----
  const range = (p, lo, hi, loOpen = false, hiOpen = false) => Range.bound([p, lo], [p, hi], loOpen, hiOpen);
  const LOW = -Infinity, HIGH = []; // IndexedDB key order: number < date < string < binary < array
  async function newest(r, limit) {
    const rows = [];
    try { await walk(db.transaction('records', 'readonly').objectStore('records').index('part_key').openCursor(r, 'prev'), (c) => { rows.push(c.value); return rows.length < limit; }); } catch { return []; }
    return rows.reverse();
  }

  // ---- meta and blobs ----
  const meta = {
    async get(k, fallback) { try { return (await req(db.transaction('meta', 'readonly').objectStore('meta').get(k))) ?? fallback; } catch { return fallback; } },
    set(k, v) { return writer.run(async () => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(v, k); await done(tx); }); },
    /** Read-modify-write on the writer chain (no lost update between two writers of the same key). */
    update(k, fn, fallback) { return writer.run(async () => { const tx = db.transaction('meta', 'readwrite'); const s = tx.objectStore('meta'); const v = fn((await req(s.get(k))) ?? fallback); s.put(v, k); await done(tx); return v; }); }
  };
  function evictBlobs(budget = P.blobBudgetBytes) {
    return jobs.run(`blobs:${name}`, () => writer.run(async () => {
      const target = budget * P.evictTo;
      if (blobBytes <= target) return;
      stats.blobEvictions += 1;
      const tx = db.transaction(['blobs', 'meta'], 'readwrite');
      let total = blobBytes;
      await walk(tx.objectStore('blobs').index('touched').openCursor(), (c) => { if (total <= target) return false; total -= c.value.bytes || 0; c.delete(); return true; });
      tx.objectStore('meta').put(total, '__blobBytes');
      await done(tx);
      blobBytes = total;
    }));
  }

  return {
    kind: 'indexeddb', db, policy: P,
    stats: () => ({ ...stats, bytes: book.total(), records: book.count(), parts: book.size(), blobBytes, writerDepth: writer.depth() }),
    setKeep(fn) { keep = typeof fn === 'function' ? fn : () => false; },
    onDrop(fn) { onDrop.add(fn); return () => onDrop.delete(fn); },
    idle: () => writer.idle(),
    high: () => high,
    raiseHigh(v) { if (typeof v !== 'number' || v <= high) return Promise.resolve(high); return writer.run(async () => { const tx = db.transaction('meta', 'readwrite'); high = Math.max(high, v); tx.objectStore('meta').put(high, '__high'); await done(tx); return high; }); },
    usage: () => ({ bytes: book.total(), records: book.count(), parts: book.size(), blobs: blobBytes, windowBreached: stats.windowBreached }),
    parts: () => book.rows(),
    append, evict,
    readLatest: (p, limit = 400) => newest(range(p, LOW, HIGH), limit),
    readBefore: (p, before, limit = 400) => newest(range(p, LOW, before, false, true), limit),
    async readPartition(p) { try { return (await req(db.transaction('records', 'readonly').objectStore('records').index('part_key').getAll(range(p, LOW, HIGH)))) || []; } catch { return []; } },
    async keysOf(p) { try { return (await req(db.transaction('records', 'readonly').objectStore('records').index('part').getAllKeys(Range.only(p)))) || []; } catch { return []; } },
    async readRecent(limit = 25_000) {
      const rows = [];
      if (limit <= 0) return rows;
      try { await walk(db.transaction('records', 'readonly').objectStore('records').openCursor(null, 'prev'), (c) => { rows.push(c.value); return rows.length < limit; }); } catch { /* partial */ }
      return rows.reverse();
    },
    /** Walk records newest first; `step(record)` returns false to stop. */
    async scanNewest(step) { try { await walk(db.transaction('records', 'readonly').objectStore('records').openCursor(null, 'prev'), (c) => step(c.value)); } catch { /* partial */ } },
    meta,
    async readBlob(k) {
      try {
        const rec = await req(db.transaction('blobs', 'readonly').objectStore('blobs').get(k));
        if (!rec) return null;
        writer.run(async () => { const tx = db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').put({ ...rec, touched: now() }); await done(tx); }).catch(() => {});
        return rec.value;
      } catch { return null; }
    },
    writeBlob(k, value, bytes = 0) {
      return writer.run(async () => {
        const tx = db.transaction(['blobs', 'meta'], 'readwrite');
        const s = tx.objectStore('blobs');
        const prior = await req(s.get(k));
        s.put({ key: k, value, bytes, touched: now() });
        const total = blobBytes - (prior?.bytes || 0) + bytes;
        tx.objectStore('meta').put(total, '__blobBytes');
        await done(tx);
        blobBytes = total;
      }).then(() => (blobBytes > P.blobBudgetBytes ? evictBlobs() : undefined)).catch(() => {});
    },
    evictBlobs,
    close() { try { db.close(); } catch { /* gone */ } }
  };
}

/** The same API in memory (tests; a browser without IndexedDB). Budget and window are enforced the same way. */
export function memoryReplicaStore({ key = 'key', partition = 'part', time = 'at', sizeOf = (r) => approxSize(r) + 64, policy = {}, now = () => Date.now() } = {}) {
  const P = { ...REPLICA_POLICY, ...policy };
  const records = new Map();
  const book = ledger();
  const meta = new Map();
  const blobs = new Map();
  let high = 0, keep = () => false;
  const stats = { appended: 0, duplicates: 0, invalid: 0, evictedParts: 0, windowBreached: 0 };
  const onDrop = new Set();
  const byPart = (p) => [...records.values()].filter((r) => r[partition] === p).sort((a, b) => (a[key] < b[key] ? -1 : 1));
  const api = {
    kind: 'memory', policy: P,
    stats: () => ({ ...stats, bytes: book.total(), records: book.count(), parts: book.size() }),
    setKeep(fn) { keep = fn; }, onDrop(fn) { onDrop.add(fn); return () => onDrop.delete(fn); }, idle: async () => {},
    high: () => high, async raiseHigh(v) { if (typeof v === 'number' && v > high) high = v; return high; },
    usage: () => ({ bytes: book.total(), records: book.count(), parts: book.size(), blobs: 0, windowBreached: stats.windowBreached }),
    parts: () => book.rows(),
    async append(list) {
      let n = 0;
      for (const r of list || []) {
        if (!r || r[key] == null || r[partition] == null) { stats.invalid += 1; continue; }
        if (records.has(r[key])) { stats.duplicates += 1; continue; }
        records.set(r[key], r); book.add(String(r[partition]), sizeOf(r), 1, String(r[time] ?? '')); n += 1;
        if (typeof r[key] === 'number' && r[key] > high) high = r[key];
      }
      stats.appended += n;
      if (book.total() > P.budgetBytes) await api.evict();
      return n;
    },
    async evict(budget = P.budgetBytes) {
      const target = budget * P.evictTo, cutoff = new Date(now() - P.windowMs).toISOString(), dropped = [];
      for (const part of book.evictionOrder({ keepAfter: cutoff, keep })) {
        if (book.total() <= target) break;
        if (part.inWindow) stats.windowBreached += 1;
        for (const [k, r] of records) if (String(r[partition]) === part.id) records.delete(k);
        book.remove(part.id); stats.evictedParts += 1; dropped.push(part.id);
        for (const fn of onDrop) await fn(part.id);
      }
      return dropped;
    },
    async readLatest(p, limit = 400) { return byPart(p).slice(-limit); },
    async readBefore(p, before, limit = 400) { return byPart(p).filter((r) => r[key] < before).slice(-limit); },
    async readPartition(p) { return byPart(p); },
    async keysOf(p) { return byPart(p).map((r) => r[key]); },
    async readRecent(limit = 25_000) { return [...records.values()].sort((a, b) => (a[key] < b[key] ? -1 : 1)).slice(-limit); },
    async scanNewest(step) { for (const r of [...records.values()].sort((a, b) => (a[key] < b[key] ? 1 : -1))) if (step(r) === false) return; },
    meta: { async get(k, f) { return meta.has(k) ? meta.get(k) : f; }, async set(k, v) { meta.set(k, v); }, async update(k, fn, f) { const v = fn(meta.has(k) ? meta.get(k) : f); meta.set(k, v); return v; } },
    async readBlob(k) { return blobs.get(k) ?? null; }, async writeBlob(k, v) { blobs.set(k, v); }, async evictBlobs() {},
    close() {}
  };
  return api;
}
