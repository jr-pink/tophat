// Declared-state recipes: the shapes webchat kept hand-writing (phase 4 and 6 of the UI-state migration), as one-line
// fields, actions and families. Framework-free; built only on lib/schema.js and lib/model.js. GUIDE section 4d.
//
//   range(1, 0.85, 1.5)          a number kept inside [min, max]; anything else is the default (a text size)
//   counter()                    a non-negative integer (a device sequence)
//   cache()                      an opaque server answer kept for the offline paint, replaced whole
//   advance('seq')               action: the counter moves to payload.to, never back (a replay or stale tab is a no-op)
//   mint(replica, 'seq', 'seq.advance')   next number, minted once, on disk before it is returned (declare `durable`)
//   marker('landed', { storage: 'tab' })   when something was last done (a day, a version); marked(r, today)
//   onceId('device', { legacyKey })   an id minted once (first writer wins across tabs); idOf(r, make)
//   keyed('draft', spec)         a family of per-key states (one record per chat): decl(key), use(app, key), keys(storage)
import { declare } from './model.js';
import { field, on, set } from './schema.js';

/** A number inside [min, max] (a numeric string counts); anything else is `d`. */
export const range = (d, min, max) => field(d, (v) => { const n = typeof v === 'string' && !v.trim() ? NaN : Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : d; });

/** An opaque cached server answer: any plain object (or array), else null. A cache is replaced whole (`set('f')`). */
export const cache = () => field(null, (v) => (v && typeof v === 'object' ? v : null));

const whole = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
/** A non-negative integer, 0 by default (a numeric string counts). */
export const counter = () => field(0, whole);
/** Action: counter field `f` moves to `payload.to` if that is ahead; otherwise nothing changes (same reference). */
export const advance = (f) => on(f, (n, { to } = {}) => Math.max(n, whole(to)));

/**
 * The next value of counter `f`, minted once: dispatched through `action` (an `advance`) and read back from what was
 * saved. Declare the state `durable` so two tabs never mint the same number and the number is on disk before the
 * caller uses it. If storage could not keep it, `fallback()` (default: a clock value), so a reload never reuses one.
 */
export function mint(replica, f, action, fallback = () => Date.now() % 1_000_000) {
  const next = replica.get()[f] + 1;
  replica.dispatch(action, { to: next });
  return replica.saved?.base?.[f] === next ? next : fallback();
}

/**
 * A marker: when (which day, which version) something was last done, e.g. "this tab already landed today". One string
 * field `at`, one action `mark {at}`. `storage: 'tab'` for once per window; `legacyKey` imports (and archives) the old
 * hand-rolled key, read from the same storage. `done(replica, at)` asks whether it is marked for `at`.
 */
export function marker(name, { storage, legacyKey } = {}) {
  return declare({
    name, scope: 'local', ...(storage ? { storage } : {}),
    fields: { at: field(null, (v) => (typeof v === 'string' && v ? v : null)) },
    ...(legacyKey ? { legacy: [{ key: legacyKey, into: 'at', archive: true }] } : {}),
    actions: { mark: set('at', 'at') },
  });
}
export const marked = (replica, at) => replica.get().at === at;

/**
 * An id minted once and kept (a device id, a tab's session id): `durable`, so two tabs racing to mint agree on the
 * first one written. `legacyKey` imports an old hand-rolled id; `keepLegacy` (default true) leaves that key in place so
 * a rolled-back build still finds the same id. `idOf(replica, make)` returns the id, minting with `make()` if absent.
 */
export function onceId(name, { storage, legacyKey, keepLegacy = true } = {}) {
  return declare({
    name, scope: 'local', durable: true, ...(storage ? { storage } : {}),
    fields: { id: field(null, (v) => (typeof v === 'string' && v ? v : null)) },
    ...(legacyKey ? { legacy: [{ key: legacyKey, into: 'id', archive: !keepLegacy }] } : {}),
    actions: { mint: on('id', (id, { id: fresh } = {}) => id || (typeof fresh === 'string' && fresh ? fresh : null)) },
  });
}
export function idOf(replica, make) {
  const held = replica.get().id;
  if (held) return held;
  replica.dispatch('mint', { id: make() });
  return replica.get().id;
}

/** Every key of a Storage-like object (real Storage has key(i); a test double may be a plain object of items). */
export function storageKeys(storage) {
  if (!storage) return [];
  try {
    if (typeof storage.key === 'function' && typeof storage.length === 'number') return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k) => k != null);
    return Object.keys(storage.m || storage).filter((k) => typeof (storage.m || storage)[k] === 'string');
  } catch { return []; }
}

/**
 * A family of per-key local states: one record `qk:<base>:<key>` per key, removed when the state is back to its
 * initial value (`dropEmpty`), re-read when another tab writes it (`crossTab`). `spec` is a `declare` spec without
 * `name`; `legacy(key)` gives that key's old-key imports, and `legacyPrefix` names the old key family so `keys()` lists
 * keys not yet imported. Declarations are cached per key, so asking again is a map lookup.
 */
export function keyed(base, { legacy, legacyPrefix = null, ...spec }) {
  const decls = new Map();
  const prefix = `qk:${base}:`;
  // the family's shape, declared once now: a bad spec is refused at import, and validate() (the deploy gate) checks the
  // family's laws through this template even when no key has been used yet
  declare({ scope: 'local', dropEmpty: true, crossTab: true, ...spec, name: `${base}:*` });
  const decl = (key) => {
    let d = decls.get(key);
    if (!d) { d = declare({ scope: 'local', dropEmpty: true, crossTab: true, ...spec, name: `${base}:${key}`, ...(legacy ? { legacy: legacy(key) } : {}) }); decls.set(key, d); }
    return d;
  };
  return {
    decl,
    use: (app, key) => app.use(decl(key)),
    /** Keys with a saved record (or an old record not yet imported), in storage order. Flush the app first. */
    keys(storage) {
      const out = new Set();
      for (const k of storageKeys(storage)) {
        if (k.startsWith(prefix)) out.add(k.slice(prefix.length));
        else if (legacyPrefix && k.startsWith(legacyPrefix) && storage.getItem(k)) out.add(k.slice(legacyPrefix.length));
      }
      return [...out];
    }
  };
}
