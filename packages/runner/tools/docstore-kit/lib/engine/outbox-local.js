// The synchronous outbox backend: A2's outbox contract (outbox.js: admit, has, size, stats, counter, put, delete, all,
// idle, close; one id per intent, a held id kept as it was, typed BackpressureError) over Web Storage, for an outbox a
// view reads at its first render, before any promise can resolve (a room's unsent messages, a dictation clip waiting to
// upload, a notes edit). Every operation is a read-modify-write of one storage key, so two tabs see each other's rows
// at their next call; the work is synchronous (the `*Sync` methods) and the async methods are the same work, resolved.
//
//   const box = localOutbox({ key: 'qk-outbox:room:lab' })
//   box.putSync([{ id, stream: 'lab', body: { text } }])    // on disk when this returns; createSender(box) delivers
//   box.rows('lab')                                         // [{ seq, id, stream, body, size, at }] in commit order
//   box.patchSync(id, (body) => ({ ...body, attempts: body.attempts + 1 }))
//   box.replaceSync(list)                                   // a caller that owns a whole ordered list
//
// Old keys (`legacy: [{ key, entries(raw) -> [{ id, stream, body }] }]`) are imported once, when this key has never been
// written, and are retired entry by entry: an imported entry stays in its old key until it leaves this outbox
// (delivered or refused), then it is removed there too. A build rolled back mid-flight therefore finds exactly what is
// still owed under its own key: nothing stranded, nothing already delivered to send again. Bodies changed after the
// import (patchSync) are not written back; the old build sees the body as it was imported.
//
// An empty outbox removes its key (`dropEmpty: false` keeps it); it holds nothing an old key could add back, because
// every imported entry was retired from its old key when it left. Storage that refuses a write (quota, private mode) throws from putSync/patchSync/deleteSync: the caller learns the
// row is not durable, as with IndexedDB. Unreadable JSON reads as empty and is kept aside under `__archive__<key>`.

import { BackpressureError, OUTBOX_LIMITS } from './outbox.js';
import { approxSize } from './lane.js';

const EMPTY = () => ({ v: 1, seq: 0, counters: {}, rows: [], imported: [] });

export function localOutbox({ storage = globalThis.localStorage, key, limits = {}, legacy = [], now = () => Date.now(), dropEmpty = true } = {}) {
  if (!key) throw new Error('localOutbox: key is required');
  const L = { ...OUTBOX_LIMITS, ...limits };
  const stats = { put: 0, deleted: 0, refused: 0, duplicates: 0, imported: 0 };

  function read() {
    let raw = null;
    try { raw = storage?.getItem(key) ?? null; } catch { return EMPTY(); }
    if (raw == null) return importLegacy();
    try {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.rows)) return { ...EMPTY(), ...s };
    } catch { /* below */ }
    try { storage.setItem(`__archive__${key}__${now()}`, raw); } catch { /* quota */ }
    return EMPTY();
  }
  function write(s) {
    if (dropEmpty && !s.rows.length && !Object.keys(s.counters).length) { storage.removeItem(key); return; }
    storage.setItem(key, JSON.stringify(s));
  }
  function importLegacy() {
    const s = EMPTY();
    for (const old of legacy) {
      let raw = null;
      try { raw = storage?.getItem(old.key) ?? null; } catch { raw = null; }
      if (raw == null) continue;
      let entries = [];
      try { entries = old.entries(raw) || []; } catch { entries = []; }
      for (const e of entries) {
        if (!e?.id || s.rows.some((r) => r.id === e.id)) continue;
        const body = e.body ?? null;
        s.rows.push({ seq: ++s.seq, id: e.id, stream: e.stream ?? '', body, size: approxSize(body), at: now() });
        s.imported.push({ id: e.id, key: old.key });
        stats.imported += 1;
      }
    }
    if (s.rows.length) { try { write(s); } catch { /* still served from memory this call */ } }
    return s;
  }
  // An entry leaving this outbox leaves the old key it came from (on-ack retirement).
  function retire(s, ids) {
    const gone = new Set(ids);
    const byKey = new Map();
    for (const imp of s.imported) if (gone.has(imp.id)) (byKey.get(imp.key) || byKey.set(imp.key, new Set()).get(imp.key)).add(imp.id);
    s.imported = s.imported.filter((imp) => !gone.has(imp.id));
    for (const [k, idsOf] of byKey) {
      const old = legacy.find((x) => x.key === k);
      if (!old) continue;
      try {
        const raw = storage.getItem(k);
        if (raw == null) continue;
        const kept = old.remove ? old.remove(raw, idsOf) : null;
        if (kept == null || kept === '') storage.removeItem(k); else storage.setItem(k, kept);
      } catch { /* the old key is best effort; this outbox is the record */ }
    }
  }
  const bytes = (s) => s.rows.reduce((n, r) => n + (r.size || 0), 0);

  const box = {
    kind: 'localstorage', key,
    admit(size = 0) {
      const s = read();
      if (s.rows.length + 1 > L.maxItems) { stats.refused += 1; throw new BackpressureError(`${s.rows.length} items`); }
      if (bytes(s) + size > L.maxBytes) { stats.refused += 1; throw new BackpressureError(`${bytes(s)} bytes`); }
    },
    has: (id) => read().rows.some((r) => r.id === id),
    size: () => { const s = read(); return { items: s.rows.length, bytes: bytes(s) }; },
    stats: () => { const s = read(); return { ...stats, items: s.rows.length, bytes: bytes(s) }; },
    counter(name) { const s = read(); s.counters[name] = (s.counters[name] || 0) + 1; write(s); return s.counters[name]; },
    /** Every held row in commit order, optionally one stream's. Synchronous. */
    rows(stream = null) { const list = read().rows; return stream == null ? list : list.filter((r) => r.stream === stream); },
    /** Commit entries ([{ id, stream, body }]); returns how many were new. A held id is kept as it was. */
    putSync(entries) {
      const s = read();
      let n = 0;
      for (const e of entries) {
        if (!e?.id || s.rows.some((r) => r.id === e.id)) { stats.duplicates += 1; continue; }
        const body = e.body ?? null;
        s.rows.push({ seq: ++s.seq, id: e.id, stream: e.stream ?? '', body: JSON.parse(JSON.stringify(body)), size: approxSize(body), at: now() });
        n += 1;
      }
      if (n) write(s);
      stats.put += n;
      return n;
    },
    /** Replace one held row's body (an attempt count, a transcript). Returns false when the id is not held. */
    patchSync(id, fn) {
      const s = read();
      const row = s.rows.find((r) => r.id === id);
      if (!row) return false;
      const body = fn(row.body);
      if (body === row.body) return true;
      row.body = JSON.parse(JSON.stringify(body ?? null));
      row.size = approxSize(row.body);
      write(s);
      return true;
    },
    deleteSync(ids) {
      const s = read();
      const gone = new Set(ids);
      const before = s.rows.length;
      s.rows = s.rows.filter((r) => !gone.has(r.id));
      const n = before - s.rows.length;
      if (!n) return 0;
      retire(s, ids);
      write(s);
      stats.deleted += n;
      return n;
    },
    /** The held set becomes exactly `entries`, in this order (a caller that owns a list: a room's unsent messages). Rows
     *  no longer listed leave (and are retired from an old key); a listed id already held keeps its row, takes the new
     *  body and the listed position; a new id is committed. One write. Returns { put, deleted }. */
    replaceSync(entries) {
      const s = read();
      const byId = new Map(s.rows.map((r) => [r.id, r]));
      const want = [];
      const seen = new Set();
      for (const e of entries) { if (!e?.id || seen.has(e.id)) { stats.duplicates += 1; continue; } seen.add(e.id); want.push(e); }
      const gone = s.rows.filter((r) => !seen.has(r.id)).map((r) => r.id);
      let put = 0;
      const rows = want.map((e) => {
        const body = JSON.parse(JSON.stringify(e.body ?? null));
        const held = byId.get(e.id);
        if (held) return { ...held, stream: e.stream ?? held.stream, body, size: approxSize(body) };
        put += 1;
        return { seq: ++s.seq, id: e.id, stream: e.stream ?? '', body, size: approxSize(body), at: now() };
      });
      const changed = gone.length || put || JSON.stringify(rows) !== JSON.stringify(s.rows);
      if (!changed) return { put: 0, deleted: 0 };
      s.rows = rows;
      if (gone.length) retire(s, gone);
      write(s);
      stats.put += put; stats.deleted += gone.length;
      return { put, deleted: gone.length };
    },
    put(entries) { try { return Promise.resolve(box.putSync(entries)); } catch (e) { return Promise.reject(e); } },
    delete(ids) { try { return Promise.resolve(box.deleteSync(ids)); } catch (e) { return Promise.reject(e); } },
    all: (stream = null) => Promise.resolve(box.rows(stream)),
    idle: async () => {},
    close() {}
  };
  return box;
}
