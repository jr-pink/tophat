// Compare-and-set undo for row stores (any kit app whose document is rows patched by { id, set }: lib/engine/rows.js).
//   - overwrote a newer edit another device made to the same line, or revived a line another device deleted, and
//   - duplicated text (fuzz seeds 302, 754, 7504; regressions in tests/history.test.js).
// The rule: an undo or redo step is an all-or-nothing compare-and-set BY VALUE against the row as it is now (`get`, which
// must also return tombstoned rows, e.g. rows.peek). Every field the step would write must still hold the value the step
// being undone (or redone) left there, a field it did not change must still hold its old value, and a row it edited live
// must still be live. If any check fails the whole step is skipped (conflict: true), the remote change wins, and the step
// is DROPPED from history (not moved to the other stack: its change is still in the document, so a later redo would apply
// it twice). There is no text rebase. Removal inverses carry the row's `carry` fields (the reference notes app: its words), so a redo that
// would remove a row is refused once someone has written to it since.
//
// Options (shared by inverse, casStep and createCasHistory):
//   tombstone  'deleted_at'     the soft-delete field (a truthy value means deleted)
//   stamp      'updated_at'     a field every put refreshes; never compared, rewritten to now() on every step
//   derived    []               fields computed from others (the reference notes app: indent from body); never compared
//   carry      []               fields a removal's inverse carries even though the removal did not write them
//   now        () => Date.now() the clock (ms) for `stamp` and for a created row's inverse tombstone

const DEFAULTS = { tombstone: 'deleted_at', stamp: 'updated_at', derived: [], carry: [] };
const opt = (o = {}) => ({ ...DEFAULTS, now: () => Date.now(), ...o });
const iso = (ms) => new Date(ms).toISOString();
const same = (a, b) => (a ?? null) === (b ?? null);

/** The inverse of `puts` against the rows as they were (`before(id)`: the live row or undefined). Absolute values, so
 *  undo and redo replay. Undoing a created row tombstones it; a removal's inverse also carries the `carry` fields. */
export function inverse(before, puts, o) {
  const { tombstone, stamp, carry, now } = opt(o);
  return puts.map((p) => {
    const old = before(p.id);
    const set = {};
    for (const f of Object.keys(p.set)) set[f] = old ? (old[f] ?? null) : f === tombstone ? null : p.set[f];
    if (!old) set[tombstone] = p.set[stamp] || iso(now()); // undoing a created row deletes it
    // a removal depends on what the row held (a merge copied its words into the row above): the inverse carries it, so
    // a redo is refused when the row has been written to since (the reference notes app causal fuzz seed 7504)
    if (old && p.set[tombstone]) for (const f of carry) if (!(f in set)) set[f] = old[f] ?? null;
    return { id: p.id, set };
  });
}

/** One step as a compare-and-set by value, all or nothing. `puts`: what the step writes; `expected`: the puts of the step
 *  it reverses (what they left in each field). Returns { puts: [], conflict: true } when any guarded field moved, else
 *  { puts } with `stamp` refreshed. Without `get` there is nothing to compare: the step applies unguarded. */
export function casStep(puts, expected, get, o) {
  const { tombstone, stamp, derived, now } = opt(o);
  const fresh = () => { const at = iso(now()); return puts.map((p) => ({ id: p.id, set: stamp ? { ...p.set, [stamp]: at } : { ...p.set } })); };
  if (!get) return { puts: fresh() };
  const skip = new Set([stamp, ...derived]);
  const exp = new Map(expected.map((p) => [p.id, p.set]));
  for (const p of puts) {
    const row = get(p.id), e = exp.get(p.id);
    if (!row || !e) continue;
    // the tombstone is always checked: a row the step edited live must still be live (another device's delete wins)
    for (const f of new Set([...Object.keys(p.set), ...Object.keys(e), tombstone])) {
      if (skip.has(f)) continue;
      const want = f in e ? e[f] : f in p.set ? p.set[f] : null; // a field the step did not change must still hold its value
      if (!same(row[f], want)) return { puts: [], conflict: true };
    }
  }
  return { puts: fresh() };
}

/** Undo history of compare-and-set steps. Entries are { op, back, forward } (back = inverse(...) of forward).
 *  record(inv, puts, { typing, id }) -> the op id of the entry it landed in. A typing burst on one row (under burstMs
 *    apart) extends the previous entry. `id`: the caller's op id; a seen id is a no-op (duplicate delivery).
 *  undo(get) / redo(get) -> { op, puts, conflict? } or null. Synchronous; they touch nothing but the two stacks, so a
 *    doubled undo steps back exactly twice and nothing is applied later. The caller applies `puts` (empty on conflict).
 *  sizes -> { undo, redo }. */
export function createCasHistory({ limit = 500, burstMs = 1500, ...o } = {}) {
  const cas = opt(o);
  const undos = [], redos = [], seen = new Map(); // seen: caller id -> op id (bounded, insertion order)
  let burst = null, seq = 0;
  const step = (e, puts, expected, get) => ({ op: e.op, ...casStep(puts, expected, get, cas) });
  return {
    record(inv, puts, { typing = false, id = null } = {}) {
      if (id != null && seen.has(id)) return seen.get(id);
      const t = cas.now(), row = puts[0]?.id;
      if (typing && burst && burst.row === row && t - burst.at < burstMs && undos[undos.length - 1] === burst.entry) {
        burst.entry.forward = puts; burst.at = t;
      } else {
        const entry = { op: `h${++seq}`, back: inv, forward: puts };
        undos.push(entry); if (undos.length > limit) undos.shift();
        burst = typing ? { row, at: t, entry } : null;
      }
      redos.length = 0;
      const op = undos[undos.length - 1].op;
      if (id != null) { seen.set(id, op); if (seen.size > limit * 4) seen.delete(seen.keys().next().value); }
      return op;
    },
    undo(get) { const e = undos.pop(); if (!e) return null; burst = null; const r = step(e, e.back, e.forward, get); if (!r.conflict) redos.push(e); return r; },
    redo(get) { const e = redos.pop(); if (!e) return null; burst = null; const r = step(e, e.forward, e.back, get); if (!r.conflict) undos.push(e); return r; },
    get sizes() { return { undo: undos.length, redo: redos.length }; },
  };
}
