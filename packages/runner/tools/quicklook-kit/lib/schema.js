// Declaring a state's shape: typed fields (default + repair), legacy-key imports, and one-line actions. Framework-free.
// A field is its default and the function that repairs whatever storage or a payload hands it, so a slice never writes
// `initial`, `normalize` or "the same object back when clean" by hand; `declare` (lib/model.js) derives them.
//
//   declare({ name: 'prefs', scope: 'local',
//     fields: { voice: shape({ speed: num(1.1), handsFree: bool(true) }) },
//     legacy: [{ key: 'tophat.voice', json: true, into: 'voice' }],       // one-time import of an old hand-rolled key
//     actions: { 'voice.set': merge('voice') } })                         // state.voice = {...state.voice, ...payload}, repaired
//
// Action shorthands (each expands to a pure reducer; "nothing changed" returns the same reference):
//   set('width', 'px')        state.width <- clean(payload.px)         (no key: the whole payload)
//   merge('voice')            state.voice <- clean({...state.voice, ...payload})
//   on('layout', (l, p, s) => l2)   a pure function of one field; an equal result is a no-op
//   reset('layout', 'transient')    those fields back to their defaults (none named: all)
import { assign } from './fields.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const mapObj = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v, k)]));

/** A field: its default `init`, `clean(v)` (undefined -> default), and `{ ephemeral }` (never saved) or `{ save(v, state) }` (what of it is saved). */
export const field = (init, clean = (v) => v, opts = {}) => ({ init, ...opts, clean: (v) => (v === undefined ? init : clean(v)) });
export const bool = (d = false) => field(d, Boolean);
/** A positive number (a numeric string counts); anything else is the default. */
export const num = (d = null, { int = false } = {}) => field(d, (v) => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return Number.isFinite(n) && n > 0 ? (int ? Math.round(n) : n) : d; });
/** A list without duplicates or empties; each item is repaired by `item` (a repaired-away item is dropped). */
export const list = (item = (v) => v) => field([], (v) => (Array.isArray(v) ? [...new Set(v.map(item).filter(Boolean))] : []));
/** A set of members stored as an object of truthy values. */
export const flags = () => field({}, (v) => Object.fromEntries(Object.entries(plain(v)).filter(([, on]) => on)));
/** A fixed object of fields; unknown keys are dropped. */
export const shape = (fields) => field(mapObj(fields, (f) => f.init), (v) => mapObj(fields, (f, k) => f.clean(plain(v)[k])));
/** Lives in memory only: the saved copy always has the default. */
export const scratch = (init = null) => field(init, (v) => v ?? init, { ephemeral: true });

export const set = (f, key) => ({ act: 'set', f, key });
export const merge = (f) => ({ act: 'merge', f });
export const on = (f, fn) => ({ act: 'on', f, fn });
export const reset = (...fs) => ({ act: 'reset', fs });

const expand = (F, a) => {
  if (typeof a === 'function') return a;
  if (a.f && !F[a.f]) throw new Error(`action refers to unknown field "${a.f}"`);
  if (a.act === 'set') return (s, p) => assign(s, { [a.f]: F[a.f].clean(a.key ? p[a.key] : p) });
  if (a.act === 'merge') return (s, p) => assign(s, { [a.f]: F[a.f].clean({ ...s[a.f], ...p }) });
  if (a.act === 'on') return (s, p) => { const v = a.fn(s[a.f], p, s); return same(v, s[a.f]) ? s : { ...s, [a.f]: v }; };
  const names = a.fs.length ? a.fs : Object.keys(F);
  return (s) => assign(s, Object.fromEntries(names.map((k) => [k, F[k].init])));
};

/** `legacy: [{ key, json?, into?, read?, archive? }]` -> `(storage) => partial state | null`: each present old key contributes its part.
 *  `archive: true` (a local state): once the imported record is saved the old key is moved to `__archive__<key>`. */
const compileLegacy = (entries) => (storage) => {
  const out = {};
  let found = false;
  for (const { key, json, into, read } of entries) {
    const raw = storage.getItem(key);
    if (raw == null) continue;
    try {
      const v = json ? JSON.parse(raw) : raw;
      const part = read ? read(v) : { [into]: v };
      if (part) { Object.assign(out, part); found = true; }
    } catch { /* a bad old value is ignored */ }
  }
  return found ? out : null;
};

/** `legacy: [{ key, json?, actions: (v) => [[type, payload], ...] }]`: an old hand-rolled OUTBOX becomes actions replayed through
 *  the reducers (so they enter the op log and are delivered), and the old key is archived and removed once they are saved. */
const compileReplay = (entries) => (storage) => {
  const out = { actions: [], keys: [] };
  for (const { key, json, actions } of entries) {
    const raw = storage.getItem(key);
    if (raw == null) continue;
    out.keys.push(key);
    try { for (const [type, payload] of actions(json ? JSON.parse(raw) : raw)) out.actions.push({ type, payload }); } catch { /* a bad old value is ignored */ }
  }
  return out.keys.length ? out : null;
};

/** Turn a spec with `fields` into the spec the replica runs: initial, normalize, persist, actions, legacy. */
export function compile(spec) {
  const d = { ...spec };
  const F = d.fields;
  if (F) {
    d.initial ??= mapObj(F, (f) => f.init);
    const tidy = (s) => { const next = mapObj(F, (f, k) => f.clean(s[k])); return same(next, s) ? s : next; };
    d.normalize = spec.normalize ? (s) => spec.normalize(tidy(s)) : tidy;
    if (!spec.persist && Object.values(F).some((f) => f.ephemeral || f.save)) {
      d.persist = (s) => mapObj(F, (f, k) => (f.ephemeral ? f.init : f.save ? f.save(s[k], s) : s[k]));
    }
    if (d.actions) d.actions = mapObj(d.actions, (a) => expand(F, a));
  }
  if (Array.isArray(d.legacy)) {
    const archive = d.legacy.filter((e) => e.archive && !e.actions).map((e) => e.key);
    if (archive.length) d.legacyArchive = archive;
    const replay = d.legacy.filter((e) => e.actions);
    if (replay.length) d.legacyReplay = compileReplay(replay);
    const plain = d.legacy.filter((e) => !e.actions);
    d.legacy = plain.length ? compileLegacy(plain) : undefined;
  }
  return d;
}
