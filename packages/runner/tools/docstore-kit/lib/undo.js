// The undo axis of `declare` (DOCSTORE3-DESIGN §12, conformance row #26): `declare({ ..., undo: 'compensating' })` gives the
// replica `undo()`, `redo()`, `seek(position)` and `history`. The executor is lib/history.js createCasHistory, unchanged:
// the state is one row whose fields are the state's top-level keys, each compared by value (canonical JSON), so
//   - an undo is a NEW absolute action (UNDO_ACTION, `{set, unset}` of the fields it restores), logged and synced forward
//     like any other; history is never edited;
//   - an undo or redo step is all-or-nothing compare-and-set by value: if another device (or tab) changed a field the
//     step would write since, the step is skipped and dropped (the remote change wins; a later redo cannot apply it twice);
//   - `seek(position)` is absolute (position = steps applied, 0 = nothing): a doubled press of an undo button that
//     resolved `seek(seen - 1)` from what the user saw lands one step back, not two. undo()/redo() are the relative
//     gestures, resolved against the current position.
// History is per replica (one tab), in memory, bounded (`limit`, default 500), deduped by entry id (`device:seq`).
// Model 'none' is the same as omitting the axis. Lifecycle declarations refuse undo at declare (an inverse would have
// to take a lifecycle edge backwards).
import { createCasHistory, inverse } from './history.js';
import { canonical } from './canonical.js';

export const UNDO_ACTION = '$undo';
const ROW = '$state';
const TOMB = '\u0000tombstone'; // no state field has this name: history.js always checks the tombstone, here it is always absent
const CAS = { tombstone: TOMB, stamp: null, derived: [], carry: [] };

const plainObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** The reducer of UNDO_ACTION: total, pure, same reference when nothing changes; only keys of the state or `initial`. */
export function undoReducer(initial) {
  const known = (s, k) => Object.hasOwn(s, k) || Object.hasOwn(initial || {}, k);
  return (s, p) => {
    if (!plainObj(s) || !plainObj(p)) return s;
    const set = plainObj(p.set) ? p.set : {}, unset = Array.isArray(p.unset) ? p.unset.filter((k) => typeof k === 'string') : [];
    let next = s;
    for (const [k, v] of Object.entries(set)) {
      if (!known(s, k) || v === undefined || canonical(s[k]) === canonical(v)) continue;
      if (next === s) next = { ...s };
      next[k] = v;
    }
    for (const k of unset) {
      if (!Object.hasOwn(next, k)) continue;
      if (next === s) next = { ...s };
      delete next[k];
    }
    return next;
  };
}

export const undoModel = (undo) => (undo == null ? 'none' : typeof undo === 'string' ? undo : undo.model ?? 'compensating');

/** Wrap a replica's dispatch to record undo steps, and add undo/redo/seek/history. Returns the same object. */
export function withUndo(api, decl) {
  if (undoModel(decl.undo) === 'none') return api;
  const limit = (typeof decl.undo === 'object' && decl.undo.limit) || 500;
  const h = createCasHistory({ ...CAS, limit, now: () => 0 });
  const inner = api.dispatch;
  const rowOf = (s) => { const r = {}; for (const k of Object.keys(s || {})) r[k] = canonical(s[k]); return r; };
  const get = (id) => (id === ROW ? rowOf(api.get()) : undefined);

  function dispatch(type, payload, opts) {
    if (type === UNDO_ACTION) return inner(type, payload, opts); // an undo is applied by undo/redo/seek, never recorded
    const before = rowOf(api.get());
    const entry = inner(type, payload, opts);
    if (!entry) return entry;
    const after = rowOf(api.get());
    const set = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[k] !== after[k]) set[k] = after[k] ?? null;
    if (Object.keys(set).length) {
      const puts = [{ id: ROW, set }];
      h.record(inverse((id) => (id === ROW ? before : undefined), puts, CAS), puts, { id: `${entry.device}:${entry.seq}` });
    }
    return entry;
  }
  function apply(puts) {
    const s = puts[0]?.set || {};
    const set = {}, unset = [];
    for (const [k, v] of Object.entries(s)) if (v == null) unset.push(k); else set[k] = JSON.parse(v);
    inner(UNDO_ACTION, { set, unset });
  }
  function seek(position) {
    const total = h.sizes.undo + h.sizes.redo;
    const p = Math.max(0, Math.min(total, Math.trunc(Number(position)) || 0));
    let conflicts = 0;
    while (h.sizes.undo > p) { const r = h.undo(get); if (!r) break; if (r.conflict) conflicts++; else apply(r.puts); }
    while (h.sizes.undo < p && h.sizes.redo > 0) { const r = h.redo(get); if (!r) break; if (r.conflict) conflicts++; else apply(r.puts); }
    return { position: h.sizes.undo, length: h.sizes.undo + h.sizes.redo, conflicts };
  }
  api.dispatch = dispatch;
  api.seek = seek;
  api.undo = () => seek(h.sizes.undo - 1);
  api.redo = () => seek(h.sizes.undo + 1);
  Object.defineProperty(api, 'history', { enumerable: true, get: () => ({ position: h.sizes.undo, length: h.sizes.undo + h.sizes.redo }) });
  return api;
}
