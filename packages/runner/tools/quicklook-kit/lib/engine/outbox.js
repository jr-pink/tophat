// The durable outbox (Docstore3 A7 and A9, durable-user queue class). An intent gets one id (a ULID) once; the
// record is committed to IndexedDB before any network attempt; the same id is sent on every retry, after every
// reload and restart; nothing is ever dropped (a refusal is typed: BackpressureError when full, and a server's
// permanent refusal is handed to `onRefused` with the action, still in hand). It lives in its own database so no
// event append, eviction or telemetry write can sit in front of it.
//
//   const box = await openOutbox()                                    // IndexedDB, or memoryOutbox() without it
//   const sender = createSender({ outbox: box, send: (e) => fetch('/api/actions', { method: 'POST', body: JSON.stringify(e.body) }) })
//   const id = await sender.enqueue('chat', { op: 'send', text })     // durable when this resolves; delivery follows
//
// `send` resolves with a Response-like ({ ok, status }) or throws. 2xx: delivered, the record is deleted. A 4xx other
// than 401/408/409(retry)/429 is a verdict on the body: refused, handed to onRefused, deleted (the caller keeps it).
// Anything else (a throw, 5xx, a deadline) is the moment: retried with capped backoff under the same id.

import { done, req, writerChain } from './idb.js';
import { approxSize } from './lane.js';
import { ulid as defaultUlid } from './ulid.js';

export class BackpressureError extends Error {
  constructor(detail) { super(`outbox full: ${detail}`); this.name = 'BackpressureError'; this.code = 'backpressure'; }
}

export const OUTBOX_LIMITS = Object.freeze({ maxItems: 2_000, maxBytes: 64_000_000 });

function index(rows) {
  const ids = new Map();
  let bytes = 0, seq = 0;
  for (const r of rows) { ids.set(r.id, { seq: r.seq, size: r.size || 0, stream: r.stream }); bytes += r.size || 0; seq = Math.max(seq, r.seq); }
  return { ids, bytes, seq };
}

function common(state, limits, stats) {
  return {
    admit(size = 0) {
      if (state.ids.size + 1 > limits.maxItems) { stats.refused += 1; throw new BackpressureError(`${state.ids.size} items`); }
      if (state.bytes + size > limits.maxBytes) { stats.refused += 1; throw new BackpressureError(`${state.bytes} bytes`); }
    },
    has: (id) => state.ids.has(id),
    size: () => ({ items: state.ids.size, bytes: state.bytes }),
    stats: () => ({ ...stats, items: state.ids.size, bytes: state.bytes })
  };
}

/** IndexedDB outbox. Records `{ seq, id, stream, body, size, at }`; `counter(name)` is a persisted monotonic number. */
export async function openOutbox({ indexedDB: idb = globalThis.indexedDB, name = 'qk-outbox', limits = {}, now = () => Date.now() } = {}) {
  if (!idb) return memoryOutbox({ limits });
  const L = { ...OUTBOX_LIMITS, ...limits };
  const open = idb.open(name, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('outbox', { keyPath: 'seq' }).createIndex('id', 'id', { unique: true });
    db.createObjectStore('counters', { keyPath: 'name' });
  };
  const db = await req(open);
  const tx0 = db.transaction(['outbox', 'counters'], 'readonly');
  const rows = (await req(tx0.objectStore('outbox').getAll())) || [];
  const counters = Object.fromEntries(((await req(tx0.objectStore('counters').getAll())) || []).map((c) => [c.name, c.value]));
  const state = index(rows);
  state.seq = Math.max(state.seq, counters.__seq || 0);
  const stats = { put: 0, deleted: 0, refused: 0, duplicates: 0 };
  const chain = writerChain();
  return {
    kind: 'indexeddb', db,
    ...common(state, L, stats),
    counter(nameOf) { counters[nameOf] = (counters[nameOf] || 0) + 1; return counters[nameOf]; },
    /** Commit `entries` ([{ id, stream, body }]); resolves once on disk. An id already held is kept as it was. */
    put(entries) {
      return chain.run(async () => {
        const tx = db.transaction(['outbox', 'counters'], 'readwrite');
        const store = tx.objectStore('outbox');
        const fresh = [];
        for (const e of entries) {
          if (!e?.id || state.ids.has(e.id) || fresh.some(([id]) => id === e.id)) { stats.duplicates += 1; continue; }
          const seq = ++state.seq;
          const size = approxSize(e.body);
          store.put({ seq, id: e.id, stream: e.stream ?? '', body: e.body, size, at: now() });
          fresh.push([e.id, { seq, size, stream: e.stream ?? '' }]);
        }
        const c = tx.objectStore('counters');
        c.put({ name: '__seq', value: state.seq });
        for (const [k, v] of Object.entries(counters)) if (k !== '__seq') c.put({ name: k, value: v });
        await done(tx);
        for (const [id, entry] of fresh) { state.ids.set(id, entry); state.bytes += entry.size; }
        stats.put += fresh.length;
        return fresh.length;
      });
    },
    delete(ids) {
      const held = ids.filter((id) => state.ids.has(id));
      if (!held.length) return Promise.resolve(0);
      return chain.run(async () => {
        const tx = db.transaction('outbox', 'readwrite');
        for (const id of held) { const e = state.ids.get(id); if (e) tx.objectStore('outbox').delete(e.seq); }
        await done(tx);
        for (const id of held) { const e = state.ids.get(id); if (e) { state.bytes -= e.size; state.ids.delete(id); } }
        stats.deleted += held.length;
        return held.length;
      });
    },
    /** Every held record in commit order, optionally one stream's. */
    async all(stream = null) {
      const list = ((await req(db.transaction('outbox', 'readonly').objectStore('outbox').getAll())) || []).sort((a, b) => a.seq - b.seq);
      return stream == null ? list : list.filter((r) => r.stream === stream);
    },
    idle: () => chain.idle(),
    close() { try { db.close(); } catch { /* gone */ } }
  };
}

/** The same contract in memory (tests; a browser without IndexedDB, where it is honest about not surviving a reload). */
export function memoryOutbox({ limits = {} } = {}) {
  const L = { ...OUTBOX_LIMITS, ...limits };
  const rows = new Map();
  const state = index([]);
  const counters = {};
  const stats = { put: 0, deleted: 0, refused: 0, duplicates: 0 };
  return {
    kind: 'memory',
    ...common(state, L, stats),
    counter(n) { counters[n] = (counters[n] || 0) + 1; return counters[n]; },
    async put(entries) {
      let n = 0;
      for (const e of entries) {
        if (!e?.id || state.ids.has(e.id)) { stats.duplicates += 1; continue; }
        const seq = ++state.seq, size = approxSize(e.body);
        rows.set(e.id, { seq, id: e.id, stream: e.stream ?? '', body: JSON.parse(JSON.stringify(e.body ?? null)), size, at: 0 });
        state.ids.set(e.id, { seq, size, stream: e.stream ?? '' }); state.bytes += size; n += 1;
      }
      stats.put += n;
      return n;
    },
    async delete(ids) { let n = 0; for (const id of ids) { const e = state.ids.get(id); if (e) { state.ids.delete(id); state.bytes -= e.size; rows.delete(id); n += 1; } } stats.deleted += n; return n; },
    async all(stream = null) { const list = [...rows.values()].sort((a, b) => a.seq - b.seq); return stream == null ? list : list.filter((r) => r.stream === stream); },
    idle: async () => {},
    close() {}
  };
}

const RETRY_MS = [400, 900, 2000, 5000, 12_000, 30_000];
export const refusedForGood = (status) => status >= 400 && status < 500 && ![401, 408, 409, 429].includes(status);

/**
 * Delivery from an outbox: per-stream FIFO, one in flight per stream, retry forever with capped backoff under the
 * same id. Single-flight flush; `kick()` after reconnect. `enqueue` is the only way in: admit, commit, then send.
 */
export function createSender({ outbox, send, mintId = defaultUlid, onRefused = () => {}, onDelivered = () => {}, retryMs = RETRY_MS,
  setTimer = (...a) => globalThis.setTimeout(...a), clearTimer = (...a) => globalThis.clearTimeout(...a) } = {}) {
  const attempts = new Map(); // id -> attempts so far
  let flushing = null, again = false, timer = null;
  const stats = { sent: 0, retried: 0, refused: 0, attempts: 0 };

  async function enqueue(stream, body, { id = null } = {}) {
    const key = id || mintId();
    if (outbox.has(key)) return key; // the same intent, again: already durable
    outbox.admit(approxSize(body));
    await outbox.put([{ id: key, stream, body }]);
    kick();
    return key;
  }

  function kick() {
    if (flushing) { again = true; return flushing; }
    flushing = (async () => {
      do { again = false; await flushOnce(); } while (again);
    })().finally(() => { flushing = null; });
    return flushing;
  }

  async function flushOnce() {
    const rows = await outbox.all();
    const heads = new Map();
    for (const r of rows) if (!heads.has(r.stream)) heads.set(r.stream, r);
    let failed = false;
    await Promise.all([...heads.values()].map(async (row) => {
      // one stream's head at a time; the rest of the stream waits behind it, other streams do not
      let current = row;
      while (current) {
        const n = (attempts.get(current.id) || 0) + 1;
        attempts.set(current.id, n);
        stats.attempts += 1;
        if (n > 1) stats.retried += 1;
        let response = null, error = null;
        try { response = await send({ id: current.id, stream: current.stream, body: current.body, attempt: n }); } catch (cause) { error = cause; }
        if (response && response.ok) { await outbox.delete([current.id]); attempts.delete(current.id); stats.sent += 1; onDelivered(current, response); }
        else if (response && refusedForGood(response.status)) { await outbox.delete([current.id]); attempts.delete(current.id); stats.refused += 1; onRefused(current, response); }
        else { failed = true; void error; return; }
        const rest = (await outbox.all(current.stream));
        current = rest[0] || null;
      }
    }));
    if (failed) arm();
  }

  function arm() {
    if (timer) return;
    const worst = Math.max(0, ...attempts.values());
    timer = setTimer(() => { timer = null; kick(); }, retryMs[Math.min(Math.max(worst - 1, 0), retryMs.length - 1)]);
    timer?.unref?.();
  }

  return { enqueue, kick, stop() { clearTimer(timer); timer = null; }, stats: () => ({ ...stats, pending: outbox.size().items }) };
}
