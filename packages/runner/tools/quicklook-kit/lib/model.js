// The kit's state core, framework-free (no Svelte, no DOM): one declaration per piece of state, pure
// reducers, a local op log, and Docstore Stream sync. See GUIDE.md "State core" for the contract.
//
//   const sidebar = app.use(declare({
//     name: 'sidebar', version: 1, scope: 'local',            // scope: 'cloud' (default) | 'local' | 'ephemeral'
//     initial: { open: {}, folded: false },
//     actions: {                                              // absolute end-state, pure: (state, payload) => state
//       'folder.open': (s, { key, open }) => (!!s.open[key] === open ? s : { ...s, open: { ...s.open, [key]: open || undefined } }),
//     },
//   }))
//   sidebar.dispatch('folder.open', { key: 'a', open: true });   // view updates now, saved, queued for the cloud
//   (`storage: 'tab'`: this window's sessionStorage instead of the device's localStorage, for a layout a second window must not share)
//   (optional `persist(state) -> state`: what of a local state survives a reload, e.g. drop a pane that cannot exist after one)
//   sidebar.subscribe((s) => ...)                                 // Svelte store contract: `$sidebar` in a component
//
// Replica scheme:
//   confirmed = fold(base, tail)   tail: acked + remote entries in the total order (ts, device, seq)
//   view      = fold(confirmed, pending)   pending: local actions not yet acked by the cloud
// A late remote entry is inserted into the tail by order, confirmed is refolded, pending is re-applied on
// top, so every device converges to fold(all entries sorted). Actions are absolute end states, so the
// order alone gives last-writer-wins per field; the reducer decides the merge type per field
// (lib/fields.js has LWW map, add-wins set and counter helpers). No-op actions (reducer returns the same
// state) are neither logged nor saved nor pushed.

import { compile } from './schema.js';
import { createEngineDefaults } from './engine/defaults.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const MAX_TAIL = 200;

/** Total order of entries on every device: event time, then device id, then device sequence. */
export function compareEntries(a, b) {
  return a.ts - b.ts || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0) || a.seq - b.seq;
}

/** A declaration is data: the kit derives hydrate, persist, undo/replay and sync from it. */
export function declare(spec) {
  const d = { scope: 'cloud', version: 1, migrations: {}, ...compile(spec) };
  if (!d.name || typeof d.name !== 'string') throw new Error('declare: name is required (it is the storage key and the Stream id)');
  if (!['cloud', 'local', 'ephemeral'].includes(d.scope)) throw new Error(`declare ${d.name}: scope must be cloud, local or ephemeral`);
  if (!d.actions || !Object.keys(d.actions).length) throw new Error(`declare ${d.name}: actions are required`);
  for (const [k, a] of Object.entries(d.actions)) if (typeof a !== 'function') throw new Error(`declare ${d.name}: action "${k}" needs \`fields\` (it is a set/merge/on/reset shorthand)`);
  if (d.initial === undefined) throw new Error(`declare ${d.name}: initial is required`);
  d.conflict ??= 'lww';
  if (!['lww', 'log', 'crdt'].includes(d.conflict)) throw new Error(`declare ${d.name}: conflict must be lww, log or crdt`);
  if (d.states) checkLifecycle(d);
  return Object.freeze(d);
}

// Lifecycle (from Docstore's Model.states/transitions/terminal, DOCSTORE.md LifecycleMixin): a declared state machine on one
// field. Every transition goes through `step`, so dispatch refuses an undeclared edge and a replayed log skips it the same
// way on every replica (the order is total, so all replicas skip the same entries and converge).
function checkLifecycle(d) {
  const f = (d.stateField ??= 'state');
  const S = d.states, T = d.transitions || {};
  if (!Array.isArray(S) || !S.length) throw new Error(`declare ${d.name}: states must be a non-empty list`);
  for (const k of S) if (!Array.isArray(T[k])) throw new Error(`declare ${d.name}: transitions must list next states for "${k}"`);
  for (const [k, to] of Object.entries(T)) {
    if (!S.includes(k)) throw new Error(`declare ${d.name}: transitions name unknown state "${k}"`);
    for (const t of to) if (!S.includes(t)) throw new Error(`declare ${d.name}: transition ${k}->${t} names an unknown state`);
  }
  for (const t of d.terminal || []) if (!S.includes(t)) throw new Error(`declare ${d.name}: terminal state "${t}" is not declared`);
  if (!S.includes(d.initial?.[f])) throw new Error(`declare ${d.name}: initial.${f} must be a declared state`);
}

/** Why `next` may not follow `prev` under the declaration's lifecycle, or null. A self-transition is always allowed. */
export function transitionError(decl, prev, next) {
  if (!decl.states) return null;
  const f = decl.stateField || 'state', from = prev?.[f], to = next?.[f];
  if (from === to) return null;
  if (!decl.states.includes(to)) return 'InvalidTransition';
  if ((decl.terminal || []).includes(from)) return 'TerminalState';
  return (decl.transitions[from] || []).includes(to) ? null : 'InvalidTransition';
}

/** One reducer step, the only place an action meets a state: action, normalize, lifecycle check.
 *  Returns { state, error }; on an error the state is the input, unchanged. */
export function step(decl, state, type, payload) {
  const fn = decl.actions[type];
  if (!fn) return { state, error: 'UnknownAction' };
  let next = fn(state, clone(payload));
  if (decl.normalize) next = decl.normalize(next);
  const error = transitionError(decl, state, next);
  return error ? { state, error } : { state: next, error: null };
}

/** Pure fold of entries onto a state. Unknown action types and undeclared lifecycle edges are skipped (an older build
 *  reading a newer log; a remote entry whose transition no longer holds after a rebase). */
export function fold(decl, state, entries) {
  let s = state;
  for (const e of entries) s = step(decl, s, e.type, e.payload).state;
  return s;
}

/** The Stream entry for an action: one-to-one with L1 `PUT /v1/streams/{stream}/entries/{entry-id}`. */
export const toStreamEntry = (e) => ({ entry_id: `${e.device}:${e.seq}`, device_id: e.device, device_seq: e.seq, event_time: new Date(e.ts).toISOString(), payload: { type: e.type, payload: e.payload } });
export const fromStreamEntry = (r) => ({ device: r.device_id, seq: r.device_seq, ts: Date.parse(r.event_time), type: r.payload.type, payload: r.payload.payload });

function readRecord(storage, key) {
  try { const raw = storage?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function createReplica(decl, { storage, device, now = Date.now, schedule = (f) => setTimeout(f, 0), transport = null, onSaveError = () => {} }) {
  const key = `qk:${decl.name}`;
  const persists = decl.scope !== 'ephemeral';
  let wire = transport; // the sink: replaceable, a component that unmounts hands the next one a fresh closure
  const syncs = () => decl.scope === 'cloud' && Boolean(wire);
  const subs = new Set();
  let base = clone(decl.initial), tail = [], pending = [], seq = 0, lastTs = 0, cursor = null, aborted = null, legacyFound = false;
  // `durable` (local): an outbox. Every dispatch first adopts what storage holds (another tab may have written), and
  // the record is on disk before dispatch returns, so whatever the caller does next (a send) happens after the write.
  // `dropEmpty` (local): a state equal to its initial value has no record (the key is removed), as `if (v) setItem
  // else removeItem` did, so a per-chat state leaves nothing behind once it is empty.
  const durable = Boolean(decl.durable) && decl.scope === 'local';
  const dropEmpty = Boolean(decl.dropEmpty) && decl.scope === 'local';

  // ---- sync hydrate: initial <- legacy import <- saved record (upcast), never clobber unreadable bytes ----
  if (persists) {
    const rec = readRecord(storage, key);
    if (rec) {
      try {
        let v = rec.version || 1;
        base = clone(rec.base ?? rec.state ?? base); tail = rec.tail || []; pending = rec.pending || [];
        seq = rec.seq || 0; lastTs = rec.lastTs || 0; cursor = rec.cursor ?? null;
        if (v < decl.version) {
          // upcast: fold what the old shape knew into base, then migrate; unpushed entries are baked in (flush before upgrading)
          try { storage.setItem(`__archive__${key}__${Date.now()}`, JSON.stringify(rec)); } catch { /* quota */ }
          let s = fold(decl, fold(decl, base, tail), pending);
          while (v < decl.version) { const up = decl.migrations[v + 1]; if (!up) throw new Error(`no upcaster for v${v + 1}`); s = up(s); v++; }
          base = s; tail = []; pending = [];
        }
        base = { ...clone(decl.initial), ...base };
        if (decl.normalize) base = decl.normalize(base);
      } catch (e) { aborted = e.message; base = clone(decl.initial); tail = []; pending = []; }
    } else if (decl.legacy) {
      try { const old = decl.legacy(storage); if (old) { base = { ...base, ...old }; legacyFound = true; } if (decl.normalize) base = decl.normalize(base); } catch { /* ignore a bad legacy value */ }
    }
  }
  let confirmed = fold(decl, base, tail);
  let view = fold(decl, confirmed, pending);
  let dirty = false, scheduled = false;

  const emit = () => { for (const f of [...subs]) f(view); };
  const record = () => (decl.scope === 'local'
    ? { version: decl.version, savedAt: now(), base: decl.persist ? decl.persist(view) : view }
    : { version: decl.version, savedAt: now(), base, tail, pending, seq, lastTs, cursor });
  const projected = (s) => JSON.stringify(decl.persist ? decl.persist(s) : s);
  const emptyText = dropEmpty ? projected(clone(decl.initial)) : null;
  function save() {
    scheduled = false;
    if (!dirty || !persists || aborted) return;
    dirty = false;
    try {
      if (dropEmpty && projected(view) === emptyText) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify(record()));
    } catch (e) { dirty = true; onSaveError(e); }
  }
  /** What storage holds now, as this state (a dropped record is the initial value); null when unreadable. */
  function stored() {
    const rec = readRecord(storage, key);
    if (!rec) return dropEmpty || durable ? (decl.normalize ? decl.normalize(clone(decl.initial)) : clone(decl.initial)) : null;
    if ((rec.version || 1) !== decl.version) return null;
    let next = { ...clone(decl.initial), ...clone(rec.base ?? rec.state) };
    if (decl.normalize) next = decl.normalize(next);
    return next;
  }
  /** Adopt the stored record without notifying (durable read-modify-write). */
  function adopt() {
    if (dirty || aborted) return false; // an unsaved change of ours is newer than the disk
    const next = stored();
    if (!next || JSON.stringify(next) === JSON.stringify(view)) return false;
    base = next; confirmed = next; view = next;
    return true;
  }
  function touch() {
    dirty = true;
    if (!scheduled) { scheduled = true; schedule(save); }
  }

  function dispatch(type, payload = {}) {
    if (!decl.actions[type]) throw new Error(`${decl.name}: unknown action "${type}"`);
    if (durable) adopt();
    const { state: next, error } = step(decl, view, type, payload);
    if (error) throw Object.assign(new Error(`${decl.name}: ${error} for "${type}" from ${JSON.stringify(view[decl.stateField])}`), { code: error });
    if (next === view) return null; // idempotent no-op: nothing logged, saved, pushed
    const ts = Math.max(now(), lastTs);
    lastTs = ts;
    const entry = { device, seq: ++seq, ts, type, payload: clone(payload) };
    view = next;
    if (decl.scope === 'cloud') pending.push(entry); // local and ephemeral state have no log to replay elsewhere
    if (durable) { dirty = true; save(); } else touch();
    emit();
    return entry;
  }

  // a local state imported from old keys marked `archive`: saved now, then each old key is copied to `__archive__<key>`
  // and removed (only once the record is on disk; a failed save leaves the old keys where they were)
  // A durable state reads the disk on every use, so its import must be on disk at once too (or the next read would
  // see no record and forget it).
  if (persists && legacyFound && (decl.legacyArchive?.length || durable) && !aborted) {
    dirty = true; save();
    if (!dirty) for (const k of decl.legacyArchive || []) {
      try { const raw = storage.getItem(k); if (raw != null) { storage.setItem(`__archive__${k}`, raw); storage.removeItem(k); } } catch { /* quota */ }
    }
  }

  // an old outbox becomes actions in the op log (delivered like any other), then its key is archived and removed
  if (persists && decl.scope === 'cloud' && decl.legacyReplay && !aborted) {
    try {
      const old = decl.legacyReplay(storage);
      if (old) {
        for (const a of old.actions) dispatch(a.type, a.payload);
        dirty = true; save();
        if (!dirty) for (const k of old.keys) { try { storage.setItem(`__archive__${k}`, storage.getItem(k)); storage.removeItem(k); } catch { /* quota */ } }
      }
    } catch { /* leave the old keys in place */ }
  }

  function insertTail(entries) {
    const have = new Set(tail.map((e) => `${e.device}:${e.seq}`));
    let changed = false;
    for (const e of entries) { const id = `${e.device}:${e.seq}`; if (!have.has(id)) { tail.push(e); have.add(id); changed = true; } }
    if (!changed) return false;
    tail.sort(compareEntries);
    if (tail.length > MAX_TAIL) { const old = tail.splice(0, tail.length - MAX_TAIL); base = fold(decl, base, old); }
    return true;
  }
  function recompute() {
    confirmed = fold(decl, base, tail);
    const next = fold(decl, confirmed, pending);
    const changed = JSON.stringify(next) !== JSON.stringify(view);
    view = next;
    return changed;
  }

  /** Another tab of this device saved this local state (a `storage` event): adopt its record. Only `crossTab` local states. */
  function refresh() {
    if (!decl.crossTab || decl.scope !== 'local' || aborted) return false;
    const next = stored();
    if (!next || JSON.stringify(next) === JSON.stringify(view)) return false;
    base = next; confirmed = next; view = next; dirty = false;
    emit();
    return true;
  }

  /** Remote entries (already Stream entries) enter the tail by order; local pending is re-applied on top. */
  function ingest(rows) {
    const entries = rows.map(fromStreamEntry);
    const mine = new Set(entries.filter((e) => e.device === device).map((e) => e.seq));
    if (mine.size) pending = pending.filter((e) => !mine.has(e.seq));
    if (!insertTail(entries) && !mine.size) return false;
    const changed = recompute();
    touch();
    if (changed) emit();
    return changed;
  }

  async function sync() {
    if (!syncs()) return { pushed: 0, pulled: 0 };
    save(); // the op log is on disk before it leaves the device
    let pushed = 0, pulled = 0;
    if (pending.length) {
      const batch = pending.slice();
      await wire.push(decl.name, batch.map(toStreamEntry));
      pending = pending.filter((e) => !batch.includes(e));
      insertTail(batch);
      pushed = batch.length;
    }
    for (;;) {
      const page = await wire.pull(decl.name, cursor);
      cursor = page.cursor ?? cursor;
      const before = tail.length;
      ingest(page.entries);
      pulled += page.entries.length;
      if (!page.more || (!page.entries.length && tail.length === before)) break;
    }
    recompute(); touch(); emit();
    return { pushed, pulled };
  }

  /** Entries this device logged that the record lost (a cleared or clobbered localStorage record) come back from the
   *  durable outbox (lib/engine/defaults.js): each one not already in the log rejoins `pending`, in order. */
  function adoptPending(entries) {
    const have = new Set([...tail, ...pending].map((e) => `${e.device}:${e.seq}`));
    let n = 0;
    for (const e of entries || []) {
      if (!e || typeof e.type !== 'string' || !Number.isInteger(e.seq) || have.has(`${e.device}:${e.seq}`)) continue;
      pending.push(clone(e)); have.add(`${e.device}:${e.seq}`); n += 1;
      if (e.device === device && e.seq > seq) seq = e.seq;
      if (e.ts > lastTs) lastTs = e.ts;
    }
    if (!n) return 0;
    pending.sort(compareEntries);
    const changed = recompute();
    touch();
    if (changed) emit();
    return n;
  }

  return {
    name: decl.name, decl, adoptPending,
    get: () => { if (durable) adopt(); return view; }, // a durable state reads the disk, as the old outbox modules did
    subscribe(fn) { subs.add(fn); fn(view); return () => subs.delete(fn); }, // Svelte store contract
    dispatch, sync, ingest, refresh, flush: save, setTransport(t) { wire = t; },
    get pending() { return pending.slice(); },
    get log() { return [...tail, ...pending].sort(compareEntries); },
    get aborted() { return aborted; },
    get saved() { return readRecord(storage, key); },
  };
}

const tabBox = () => { try { return globalThis.sessionStorage; } catch { return undefined; } };

/** One app: a device id, a storage, an optional Stream transport, and the replicas declared against it. */
// `engine`: the robust defaults for `scope: 'cloud'` (lib/engine/defaults.js): a durable IndexedDB outbox that restores
// what a lost record forgot, deadline-bound push/pull with latest-wins, automatic single-flight sync with backoff that
// never drops, a drop-oldest telemetry lane (`app.telemetry`) and cross-tab pull. 'auto' (the default) turns it on
// wherever IndexedDB exists (every browser); `false` turns it off; an object passes options ({ indexedDB, ... }).
export function createApp({ storage = globalThis.localStorage, tabStorage = tabBox(), device = null, transport = null, now = Date.now, schedule, engine = 'auto' } = {}) {
  const id = device || (() => { const k = 'qk:device'; try { let d = storage?.getItem(k); if (!d) { d = Math.random().toString(36).slice(2, 10); storage?.setItem(k, d); } return d; } catch { return 'dev'; } })();
  const replicas = new Map();
  const robust = engine === false ? null : engine === 'auto' ? (globalThis.indexedDB ? createEngineDefaults({}) : null) : createEngineDefaults(engine);
  const app = {
    device: id,
    /** The one-liner: declare (or fetch) a piece of state; hydrates synchronously. `opts.scope` overrides the declared scope. */
    use(decl, opts = {}) { // a state may bring its own transport (a sink for just that stream); asking again rebinds it
      if (opts.scope && opts.scope !== decl.scope) {
        if (!['cloud', 'local', 'ephemeral'].includes(opts.scope)) throw new Error(`use ${decl.name}: scope must be cloud, local or ephemeral`);
        decl = Object.freeze({ ...decl, scope: opts.scope });
      }
      const own = opts.transport ?? transport;
      const cloud = decl.scope === 'cloud' && robust;
      const wire = (t) => (cloud && t ? robust.guard(t) : t);
      if (replicas.has(decl.name)) { if (opts.transport) replicas.get(decl.name).setTransport(wire(opts.transport)); }
      else {
        const replica = createReplica(decl, { storage: decl.storage === 'tab' ? tabStorage : storage, device: id, now, schedule, transport: wire(own) });
        replicas.set(decl.name, replica);
        if (cloud) robust.attach(replica, decl);
      }
      return replicas.get(decl.name);
    },
    /** The telemetry lane (bounded, drop-oldest; never shares anything with the outbox). Null without the engine. */
    telemetry: robust?.lane ?? null,
    engine: robust,
    flush() { for (const r of replicas.values()) r.flush(); },
    async sync() { for (const r of replicas.values()) await r.sync(); },
    /** Save on the way out; call once at boot with `window`. Returns the detach function. */
    attachLifecycle(win = globalThis) {
      const out = () => app.flush();
      win.addEventListener?.('pagehide', out);
      win.addEventListener?.('visibilitychange', out);
      const other = (e) => { for (const r of replicas.values()) if (e.key === `qk:${r.name}`) r.refresh(); };
      win.addEventListener?.('storage', other);
      return () => { win.removeEventListener?.('pagehide', out); win.removeEventListener?.('visibilitychange', out); win.removeEventListener?.('storage', other); };
    },
  };
  return app;
}
