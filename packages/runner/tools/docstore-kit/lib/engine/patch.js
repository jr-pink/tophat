// Snapshots and patches between the state engine and its tabs. The engine's reducers are immutable (a changed record
// is a new object, an unchanged one keeps its reference), so a diff is reference comparison: top-level keys, then per
// entry of each declared map, and for an entry that is an array, one splice (common prefix and suffix by reference).
//
//   const p = diff(lastSent, next, { maps: ['conversations', 'items'], skip: ['seen'] })   // engine side
//   state = apply(state, p)                                                                   // tab side, O(changes)

export function diff(prev, next, { maps = [], skip = [] } = {}) {
  if (prev === next) return null;
  const set = {}, mp = {};
  let any = false;
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  for (const k of keys) {
    if (skip.includes(k)) continue;
    const a = prev?.[k], b = next?.[k];
    if (a === b) continue;
    if (maps.includes(k) && a && b && typeof a === 'object' && typeof b === 'object') {
      const put = {}, splice = {}, del = [];
      let changed = false;
      for (const id of Object.keys(b)) {
        const x = a[id], y = b[id];
        if (x === y) continue;
        changed = true;
        if (Array.isArray(x) && Array.isArray(y)) splice[id] = spliceOf(x, y);
        else put[id] = y;
      }
      for (const id of Object.keys(a)) if (!(id in b)) { del.push(id); changed = true; }
      if (changed) { mp[k] = { put, splice, del }; any = true; }
      continue;
    }
    set[k] = b === undefined ? { $undefined: true } : b;
    any = true;
  }
  return any ? { set, maps: mp } : null;
}

function spliceOf(a, b) {
  let pre = 0;
  const max = Math.min(a.length, b.length);
  while (pre < max && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [pre, suf, b.slice(pre, b.length - suf)];
}

export function apply(state, patch) {
  if (!patch) return state;
  const next = { ...state };
  for (const [k, v] of Object.entries(patch.set || {})) {
    if (v && typeof v === 'object' && v.$undefined === true && Object.keys(v).length === 1) delete next[k];
    else next[k] = v;
  }
  for (const [k, { put = {}, splice = {}, del = [] }] of Object.entries(patch.maps || {})) {
    const m = { ...(state[k] || {}) };
    for (const [id, v] of Object.entries(put)) m[id] = v;
    for (const [id, [pre, suf, mid]] of Object.entries(splice)) {
      const old = Array.isArray(m[id]) ? m[id] : [];
      m[id] = [...old.slice(0, pre), ...mid, ...old.slice(old.length - suf)];
    }
    for (const id of del) delete m[id];
    next[k] = m;
  }
  return next;
}
