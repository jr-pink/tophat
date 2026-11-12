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
import { createHlc } from './engine/hlc.js';
import { ulid } from './engine/ulid.js';
import { ActionError, ConcurrencyConflictError, InvalidActionError, InvalidTransitionError } from './errors.js';
import { refusalFor, CONFLICT_MODELS, CONFLICT_NOT_EXECUTED, UNDO_MODELS, UNDO_NOT_EXECUTED, registerDeclaration } from './declare-keys.js';
import { uiContract } from './laws-ui/contract.js';
import { undoModel, undoReducer, withUndo, UNDO_ACTION } from './undo.js';
import { createEngineDefaults } from './engine/defaults.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const MAX_TAIL = 200;
const ID_RING = 512; // intent ids remembered past the tail, so a retried dispatch stays a no-op

/** Total order of entries on every device: the hybrid logical clock (ts, then l; lib/engine/hlc.js), then device id,
 *  then device sequence. ts is never raw wall time: a dispatch after an ingest is ordered after what it saw (A8). */
export function compareEntries(a, b) {
  return a.ts - b.ts || (a.l || 0) - (b.l || 0) || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0) || a.seq - b.seq;
}

/** A declaration is data: the kit derives hydrate, persist, undo/replay and sync from it. The key set is closed
 *  (lib/declare-keys.js): an unknown key, or an axis the design names that nothing in the kit executes, is refused here,
 *  as is a malformed UI contract (budget, owner, waits: laws-ui/contract.js uiContract). Every declaration is recorded
 *  for validate() (lib/validate.js), which the deploy gate runs over every app. Declaring a declaration returns it. */
export function declare(spec) {
  if (spec && spec[DECLARED]) return spec;
  const label = spec?.name ?? '(unnamed)';
  for (const k of Object.keys(spec || {})) { const why = refusalFor(k); if (why) throw new Error(`declare ${label}: ${why}`); }
  const d = { scope: 'cloud', version: 1, migrations: {}, ...compile(spec) };
  if (!d.name || typeof d.name !== 'string') throw new Error('declare: name is required (it is the storage key and the Stream id)');
  if (!['cloud', 'local', 'ephemeral'].includes(d.scope)) throw new Error(`declare ${d.name}: scope must be cloud, local or ephemeral`);
  if (!d.actions || !Object.keys(d.actions).length) throw new Error(`declare ${d.name}: actions are required`);
  for (const [k, a] of Object.entries(d.actions)) if (typeof a !== 'function') throw new Error(`declare ${d.name}: action "${k}" needs \`fields\` (it is a set/merge/on/reset shorthand)`);
  if (d.initial === undefined) throw new Error(`declare ${d.name}: initial is required`);
  d.conflict ??= 'lww';
  if (CONFLICT_NOT_EXECUTED[d.conflict]) throw new Error(`declare ${d.name}: conflict "${d.conflict}" is ${CONFLICT_NOT_EXECUTED[d.conflict]}`);
  if (!Object.hasOwn(CONFLICT_MODELS, d.conflict)) throw new Error(`declare ${d.name}: conflict must be ${Object.keys(CONFLICT_MODELS).join(' or ')}`);
  if (d.guards !== undefined) checkGuards(d);
  if (d.states) checkLifecycle(d);
  if (!d.states && (d.transitions || d.terminal || d.stateField)) throw new Error(`declare ${d.name}: transitions, terminal and stateField need states`);
  if (d.undo !== undefined) checkUndo(d);
  uiContract(d); // budget for an undeclared action, owner not an action, waits without a declared exit edge: refused now
  Object.defineProperty(d, DECLARED, { value: true });
  Object.freeze(d);
  registerDeclaration(d);
  return d;
}
const DECLARED = Symbol('docstore-kit.declared');

// The undo axis (lib/undo.js): 'compensating' records the inverse of every dispatch by value and applies it as a new
// action (UNDO_ACTION) through compare-and-set; it is refused with a lifecycle (an inverse would walk an edge backwards).
function checkUndo(d) {
  const m = undoModel(d.undo);
  if (m && UNDO_NOT_EXECUTED[m]) throw new Error(`declare ${d.name}: undo "${m}" is ${UNDO_NOT_EXECUTED[m]}`);
  if (!UNDO_MODELS.includes(m)) throw new Error(`declare ${d.name}: undo must be ${UNDO_MODELS.join(' or ')} (or { model: 'compensating', limit })`);
  if (d.undo !== null && typeof d.undo === 'object') {
    for (const k of Object.keys(d.undo)) if (!['model', 'limit'].includes(k)) throw new Error(`declare ${d.name}: undo takes { model, limit }, not "${k}"`);
    if (d.undo.limit !== undefined && !(Number.isInteger(d.undo.limit) && d.undo.limit > 0)) throw new Error(`declare ${d.name}: undo.limit must be a positive integer`);
  }
  if (m === 'none') return;
  if (d.states) throw new Error(`declare ${d.name}: undo with a lifecycle is not executed (an inverse would take a lifecycle edge backwards); declare the undoable fields in their own state`);
  if (d.initial === null || typeof d.initial !== 'object' || Array.isArray(d.initial)) throw new Error(`declare ${d.name}: undo needs an object state (fields are compared by value)`);
  if (d.actions[UNDO_ACTION]) throw new Error(`declare ${d.name}: action "${UNDO_ACTION}" is reserved for the undo axis`);
  d.actions = { ...d.actions, [UNDO_ACTION]: undoReducer(d.initial) };
}

// Guards (DOCSTORE3-DESIGN section 7, P1:314-334, py l2/guards.py): pure (state, { type, payload, actor }) -> refusal | null per
// action, run in declaration order at dispatch before the reducer; the first refusal wins and dispatch throws it as an
// ActionError { code, message, context, resolution }. Guards decide at acceptance only: a fold never runs them (a guard
// reading the outside world would make replicas disagree), so an accepted entry replays everywhere.
function checkGuards(d) {
  if (!d.guards || typeof d.guards !== 'object' || Array.isArray(d.guards)) throw new Error(`declare ${d.name}: guards must be { action: [guard, ...] }`);
  for (const [k, list] of Object.entries(d.guards)) {
    if (!d.actions[k]) throw new Error(`declare ${d.name}: guards name undeclared action "${k}"`);
    if (!Array.isArray(list) || !list.length || list.some((g) => typeof g !== 'function')) throw new Error(`declare ${d.name}: guards.${k} must be a non-empty list of functions`);
  }
}
/** The first guard refusal for `type` against `state`, as an ActionError, or null. A guard returns null/undefined to
 *  pass, or an ActionError, `{ code, message?, context?, resolution? }` or a code string to refuse. */
export function guardError(decl, state, type, payload, { actor = null } = {}) {
  for (const g of decl.guards?.[type] || []) {
    let r;
    try { r = g(state, { type, payload, actor }); } catch (e) { r = { code: 'GUARD_THREW', message: String(e?.message || e) }; }
    if (r == null || r === true) continue;
    if (r instanceof ActionError) return r;
    if (typeof r === 'string') return new ActionError({ code: r });
    if (r === false) return new ActionError({ code: 'REFUSED' });
    return new ActionError({ code: String(r.code || 'REFUSED'), message: r.message || '', context: r.context || {}, resolution: r.resolution || null });
  }
  return null;
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
// The HLC's logical part `l` and the intent id `id` ride inside the (encrypted) payload envelope; an entry from an older build
// has neither (l = 0, no id) and orders by event time as before. absent on older entries.
export const toStreamEntry = (e) => ({ entry_id: `${e.device}:${e.seq}`, device_id: e.device, device_seq: e.seq, event_time: new Date(e.ts).toISOString(), payload: { type: e.type, payload: e.payload, ...(e.l ? { l: e.l } : {}), ...(e.id ? { id: e.id } : {}), ...(e.actor ? { actor: e.actor } : {}), ...(e.caused_by ? { caused_by: e.caused_by } : {}) } });
export const fromStreamEntry = (r) => ({ ...(r.payload.id ? { id: r.payload.id } : {}), device: r.device_id, seq: r.device_seq, ts: Date.parse(r.event_time), ...(Number.isInteger(r.payload.l) && r.payload.l > 0 ? { l: r.payload.l } : {}), ...(typeof r.payload.actor === 'string' ? { actor: r.payload.actor } : {}), ...(typeof r.payload.caused_by === 'string' ? { caused_by: r.payload.caused_by } : {}), type: r.payload.type, payload: r.payload.payload });

function readRecord(storage, key) {
  try { const raw = storage?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function createReplica(decl, { storage, device, now = Date.now, schedule = (f) => setTimeout(f, 0), transport = null, onSaveError = () => {}, clock = createHlc }) {
  const key = `qk:${decl.name}`;
  const persists = decl.scope !== 'ephemeral';
  let wire = transport; // the sink: replaceable, a component that unmounts hands the next one a fresh closure
  const syncs = () => decl.scope === 'cloud' && Boolean(wire);
  const subs = new Set();
  let base = clone(decl.initial), tail = [], pending = [], seq = 0, clockAt = null, cursor = null, aborted = null, legacyFound = false;
  // version (assert_version, snapshot cursors): cloud = entries folded (baseN folded into base + tail + pending), equal on
  // converged replicas; local/ephemeral = accepted changes on this device. ids: recent intent ids (idempotent dispatch).
  let baseN = 0, changes = 0, ids = [];
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
        seq = rec.seq || 0; clockAt = { ts: rec.lastTs || 0, l: rec.lastL || 0 }; cursor = rec.cursor ?? null;
        baseN = rec.baseN || 0; changes = rec.changes || 0; ids = Array.isArray(rec.ids) ? rec.ids.slice(-ID_RING) : [];
        if (v < decl.version) {
          // upcast: fold what the old shape knew into base, then migrate; unpushed entries are baked in (flush before upgrading)
          try { storage.setItem(`__archive__${key}__${Date.now()}`, JSON.stringify(rec)); } catch { /* quota */ }
          let s = fold(decl, fold(decl, base, tail), pending);
          while (v < decl.version) { const up = decl.migrations[v + 1]; if (!up) throw new Error(`no upcaster for v${v + 1}`); s = up(s); v++; }
          baseN += tail.length + pending.length; base = s; tail = []; pending = [];
        }
        base = { ...clone(decl.initial), ...base };
        if (decl.normalize) base = decl.normalize(base);
      } catch (e) { aborted = e.message; base = clone(decl.initial); tail = []; pending = []; }
    } else if (decl.legacy) {
      try { const old = decl.legacy(storage); if (old) { base = { ...base, ...old }; legacyFound = true; } if (decl.normalize) base = decl.normalize(base); } catch { /* ignore a bad legacy value */ }
    }
  }
  // the one order source: restored from the record, and lifted past every entry the record holds (by construction a
  // dispatch after a reload is later than everything this device logged or saw)
  const hlc = clock({ now, last: clockAt }); // `clock`: the HLC factory (tests plant a broken one to prove the order laws)
  for (const e of tail) hlc.observe(e);
  for (const e of pending) hlc.observe(e);
  const version = () => (decl.scope === 'cloud' ? baseN + tail.length + pending.length : changes);
  const known = new Set(ids);
  const remember = (id) => { if (!id || known.has(id)) return; known.add(id); ids.push(id); if (ids.length > ID_RING) known.delete(ids.shift()); };
  for (const e of [...tail, ...pending]) remember(e.id);
  let confirmed = fold(decl, base, tail);
  let view = fold(decl, confirmed, pending);
  let dirty = false, scheduled = false;

  const emit = () => { for (const f of [...subs]) f(view); };
  const record = () => (decl.scope === 'local'
    ? { version: decl.version, savedAt: now(), base: decl.persist ? decl.persist(view) : view, changes }
    : { version: decl.version, savedAt: now(), base, tail, pending, seq, lastTs: hlc.peek().ts, lastL: hlc.peek().l, cursor, baseN, ids });
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
    base = next; confirmed = next; view = next; changes += 1;
    return true;
  }
  function touch() {
    dirty = true;
    if (!scheduled) { scheduled = true; schedule(save); }
  }

  /** dispatch(type, payload, { id, assertVersion, actor, causedBy }) -> the logged entry, or null for a no-op.
   *  - actor (row #13) is stored on the entry and on the Stream; causedBy (row #14) is the trigger's intent id.
   *  Order (py ActionBus): idempotent return for an id already logged, version, guards, reducer + lifecycle.
   *  - id: the intent id (a ULID minted once at the gesture, A7). Omitted: minted here. A retried id returns the entry it
   *    logged (or null once it left the log) and changes nothing.
   *  - assertVersion: optimistic concurrency (P1:445): refused with ConcurrencyConflictError unless it equals `version`.
   *  Refusals are typed (lib/errors.js): InvalidActionError, ConcurrencyConflictError, ActionError (a guard),
   *  InvalidTransitionError (code InvalidTransition | TerminalState); nothing is logged, saved or pushed. */
  function dispatch(type, payload = {}, opts = {}) {
    if (!decl.actions[type]) throw new InvalidActionError({ op: type, entity_type: decl.name, valid_ops: Object.keys(decl.actions) }, { message: `${decl.name}: unknown action "${type}"` });
    const id = opts?.id ?? null;
    if (id !== null) {
      if (typeof id !== 'string' || !id) throw new TypeError(`${decl.name}: an intent id is a non-empty string`);
      if (known.has(id)) return [...pending, ...tail].find((e) => e.id === id) || null;
    }
    if (durable) adopt();
    if (opts?.assertVersion !== undefined && opts.assertVersion !== version()) {
      throw new ConcurrencyConflictError({ entity_type: decl.name, entity_id: decl.name, expected_version: opts.assertVersion, actual_version: version() });
    }
    const refusal = decl.guards ? guardError(decl, view, type, payload, { actor: opts?.actor ?? null }) : null;
    if (refusal) throw refusal;
    const { state: next, error } = step(decl, view, type, payload);
    if (error) {
      const f = decl.stateField || 'state', from = view?.[f];
      let to = null; try { to = decl.actions[type](view, clone(payload))?.[f] ?? null; } catch { /* the reducer is total */ }
      throw new InvalidTransitionError({ from_state: from ?? null, to_state: to, valid_next: (decl.terminal || []).includes(from) ? [] : (decl.transitions?.[from] || []) },
        { code: error, message: `${decl.name}: ${error} for "${type}" from ${JSON.stringify(from)}` });
    }
    if (next === view) return null; // idempotent no-op: nothing logged, saved, pushed
    const t = hlc.tick();
    const actor = typeof opts?.actor === 'string' && opts.actor ? opts.actor : null;
    const causedBy = typeof opts?.causedBy === 'string' && opts.causedBy ? opts.causedBy : null;
    const entry = { id: id ?? ulid(), device, seq: ++seq, ts: t.ts, ...(t.l ? { l: t.l } : {}), ...(actor ? { actor } : {}), ...(causedBy ? { caused_by: causedBy } : {}), type, payload: clone(payload) };
    remember(entry.id);
    changes += 1;
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
    if (tail.length > MAX_TAIL) { const old = tail.splice(0, tail.length - MAX_TAIL); baseN += old.length; base = fold(decl, base, old); }
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
    base = next; confirmed = next; view = next; dirty = false; changes += 1;
    emit();
    return true;
  }

  /** Remote entries (already Stream entries) enter the tail by order; local pending is re-applied on top. */
  function ingest(rows) {
    const entries = rows.map(fromStreamEntry);
    for (const e of entries) { hlc.observe(e); remember(e.id); } // advance on ingest: the next dispatch orders after what arrived
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
      hlc.observe(e); remember(e.id);
    }
    if (!n) return 0;
    pending.sort(compareEntries);
    const changed = recompute();
    touch();
    if (changed) emit();
    return n;
  }

  const api = {
    name: decl.name, decl, adoptPending,
    get: () => { if (durable) adopt(); return view; }, // a durable state reads the disk, as the old outbox modules did
    subscribe(fn) { subs.add(fn); fn(view); return () => subs.delete(fn); }, // Svelte store contract
    dispatch, sync, ingest, refresh, flush: save, setTransport(t) { wire = t; },
    get pending() { return pending.slice(); },
    get log() { return [...tail, ...pending].sort(compareEntries); },
    get aborted() { return aborted; },
    /** The optimistic-concurrency version (dispatch's assertVersion) and the cursor a derived snapshot is stamped with. */
    get version() { return version(); },
    /** The replica's hybrid logical clock: the latest { ts, l } issued or observed. */
    get clock() { return hlc.peek(); },
    get saved() { return readRecord(storage, key); },
  };
  return withUndo(api, decl); // the undo axis (lib/undo.js); the same object when the declaration has none
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
