// The robust defaults every `scope: 'cloud'` state gets from createApp, with no code from the app author
// (GUIDE section 7). Composed from the engine modules, nothing new:
// - durable outbox (outbox.js): every logged entry is also committed to IndexedDB under its Stream entry id
//   (`device:seq`, one identity per intent). A record that lost entries (cleared storage, a tab that saved over
//   another's) gets them back at the next `use`. Entries leave the outbox only once the Stream acknowledged them.
// - deadlines (deadline.js): push and pull are bounded by class; a newer pull of the same stream supersedes a stalled
//   one; a hung transport can never wedge sync.
// - sync (jobs.js): every dispatch kicks a single-flight sync per state; a failure keeps every entry and retries with
//   capped backoff; a 409 (a conflict or gap, not the moment) stops retrying, keeps the entries, reports it on the lane
//   and in `status()`, and tries again at the next dispatch, `online`, or `retry()`.
// - telemetry lane (lane.js): `app.telemetry`, drop-oldest, separate from all of the above.
// - tabs: after a push, other tabs of the same origin are told (BroadcastChannel) and pull.

import { createDeadlineFetch } from './deadline.js';
import { createJobs } from './jobs.js';
import { createTelemetryLane } from './lane.js';
import { memoryOutbox, openOutbox } from './outbox.js';

const RETRY_MS = [500, 1000, 2000, 5000, 15_000, 30_000];

export function createEngineDefaults({ indexedDB = globalThis.indexedDB, Broadcast = globalThis.BroadcastChannel, win = globalThis,
  outboxName = 'qk-outbox', deadlines, retryMs = RETRY_MS, setTimer = (...a) => globalThis.setTimeout(...a), clearTimer = (...a) => globalThis.clearTimeout(...a),
  lane = createTelemetryLane({ maxItems: 500 }), autoSync = true } = {}) {
  const net = createDeadlineFetch(undefined, { ...(deadlines ? { deadlines } : {}), setTimer, clearTimer });
  const jobs = createJobs();
  const outbox = indexedDB ? openOutbox({ indexedDB, name: outboxName }).catch(() => memoryOutbox()) : Promise.resolve(memoryOutbox());
  const states = new Map(); // name -> { replica, attempts, timer, blocked, lastError, synced }
  let bc = null;
  try { bc = Broadcast ? new Broadcast('qk-engine-sync') : null; } catch { bc = null; }
  if (bc) bc.onmessage = (e) => { const s = states.get(e.data?.name); if (s) kick(s, 'peer'); };
  win?.addEventListener?.('online', () => { for (const s of states.values()) { s.blocked = null; kick(s, 'online'); } });

  const entryId = (e) => `${e.device}:${e.seq}`;

  function guard(t) {
    return {
      push: (stream, rows) => net.within('push', () => t.push(stream, rows), { key: `push:${stream}` }),
      pull: (stream, cursor) => net.within('pull', () => t.pull(stream, cursor), { key: `pull:${stream}` })
    };
  }

  function kick(s, why = 'dispatch') {
    if (!autoSync) return Promise.resolve();
    if (s.blocked && why === 'retry-timer') return Promise.resolve();
    return jobs.run(`sync:${s.replica.name}`, async () => {
      const box = await outbox;
      await box.idle();
      try {
        const r = await s.serial(s.rawSync);
        s.attempts = 0; s.blocked = null; s.lastError = null; s.synced += 1;
        clearTimer(s.timer); s.timer = null;
        const still = new Set(s.replica.pending.map(entryId));
        const held = (await box.all(s.replica.name)).filter((row) => !still.has(row.id)).map((row) => row.id);
        if (held.length) await box.delete(held);
        if (r.pushed && bc) { try { bc.postMessage({ name: s.replica.name }); } catch { /* closed */ } }
      } catch (cause) {
        s.lastError = String(cause?.message || cause);
        if (cause?.status === 409) {
          s.blocked = { status: 409, message: s.lastError, expected: cause.expected ?? null };
          lane.push({ kind: 'sync_blocked', stream: s.replica.name, status: 409, message: s.lastError });
          return;
        }
        lane.push({ kind: 'sync_failed', stream: s.replica.name, error: cause?.name || 'Error', attempt: s.attempts + 1 });
        s.attempts += 1;
        if (!s.timer) {
          s.timer = setTimer(() => { s.timer = null; kick(s, 'retry-timer'); }, retryMs[Math.min(s.attempts - 1, retryMs.length - 1)]);
          s.timer?.unref?.();
        }
      }
    });
  }

  function attach(replica, decl) {
    const s = { replica, attempts: 0, timer: null, blocked: null, lastError: null, synced: 0, restored: 0, rawSync: replica.sync };
    states.set(decl.name, s);
    // An app's own sync() call joins the same single-flight job as the automatic one (never two pushes of one batch at
    // once), and still rejects to its caller when it fails.
    s.tail = Promise.resolve();
    s.serial = (fn) => { const r = s.tail.then(() => fn()); s.tail = r.catch(() => {}); return r; };
    replica.sync = () => s.serial(s.rawSync);
    const dispatch = replica.dispatch;
    replica.dispatch = (type, payload) => {
      const entry = dispatch(type, payload);
      if (entry) {
        s.blocked = null;
        outbox.then((box) => box.put([{ id: entryId(entry), stream: decl.name, body: entry }])).then(() => kick(s)).catch(() => {});
      }
      return entry;
    };
    replica.retry = () => { s.blocked = null; return kick(s, 'retry'); };
    replica.status = () => ({ pending: replica.pending.length, attempts: s.attempts, blocked: s.blocked, lastError: s.lastError, synced: s.synced, restored: s.restored });
    s.ready = outbox.then(async (box) => {
      // anything this device logged that the record does not have (and anything it has that the outbox lacks)
      const rows = await box.all(decl.name);
      if (rows.length && replica.adoptPending) s.restored = replica.adoptPending(rows.map((r) => r.body));
      const held = new Set(rows.map((r) => r.id));
      const missing = replica.pending.filter((e) => !held.has(entryId(e)));
      if (missing.length) await box.put(missing.map((e) => ({ id: entryId(e), stream: decl.name, body: e })));
      if (replica.pending.length) await kick(s, 'restore');
    }).catch(() => {});
    replica.ready = s.ready;
    return replica;
  }

  return {
    guard, attach, lane, jobs, outbox,
    status: () => Object.fromEntries([...states].map(([k, s]) => [k, s.replica.status()])),
    idle: async () => { await outbox; for (const s of states.values()) { await s.ready; } },
    close() { try { bc?.close(); } catch { /* gone */ } for (const s of states.values()) clearTimer(s.timer); }
  };
}
