// Per-field merge helpers for reducers (Docstore field types). Actions are absolute end states and replicas
// replay them in one total order, so the order itself gives last-writer-wins; these helpers keep a field's
// reducer a one-liner and make "no change" return the SAME reference (so nothing is logged or saved).
//   lww:      a plain `{ ...s, field: value }` already is LWW; `assign` returns s when nothing changes.
//   set:      add-wins-by-order set stored as an object of members, `setMember(map, key, on)`.
//   counter:  per-device increments summed (never lost under concurrent edits), `bump(map, device, by)`.
// CRDT text/list/map fields: the action payload carries the CRDT update bytes (base64) and the reducer merges
// them with the CRDT library inside the pure function; the kit orders and relays, the library merges.
export function assign(s, patch) {
  for (const k of Object.keys(patch)) if (JSON.stringify(s[k]) !== JSON.stringify(patch[k])) return { ...s, ...patch };
  return s;
}
/** Membership as an absolute statement: key is in (on=true) or out (on=false). Members hold `true`. */
export function setMember(map, key, on) {
  if (Boolean(map[key]) === Boolean(on)) return map;
  const next = { ...map };
  if (on) next[key] = true; else delete next[key];
  return next;
}
export const members = (map) => Object.keys(map).filter((k) => map[k]);
export function bump(map, device, by) {
  if (!by) return map;
  return { ...map, [device]: (map[device] || 0) + by };
}
export const total = (map) => Object.values(map).reduce((a, b) => a + b, 0);
