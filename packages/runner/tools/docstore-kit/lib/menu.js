// Context menus, the kit's one model of them. Pure: no DOM, no clock.
//
// An item is { id, label, keys?, disabled?, danger?, checked?, children?: Item[] } or { separator: true }. Items are a
// projection the app computes from the target (they may carry functions, so they are never state); the STATE of an open
// menu is plain data the app declares (scope ephemeral): { x, y, ctx, active } where `active` is the path of
// highlighted indices, one per open level ([2] = third item; [2, 0] = first item of its submenu). Every key is resolved
// here into an absolute next state (a gesture resolved before dispatch, DOCSTORE3-DESIGN §2 A6).

export const isSelectable = (it) => Boolean(it) && !it.separator && !it.disabled;

/** The items of the level `depth` along `active` (0 = the root list). */
export function levelItems(items, active, depth) {
  let list = items || [];
  for (let d = 0; d < depth; d += 1) {
    const it = list[active[d]];
    if (!it?.children?.length) return [];
    list = it.children;
  }
  return list;
}

function step(list, from, dir) {
  const n = list.length;
  if (!n) return -1;
  for (let k = 1; k <= n; k += 1) {
    const i = (((from < 0 ? (dir > 0 ? -1 : 0) : from) + dir * k) % n + n) % n;
    if (isSelectable(list[i])) return i;
  }
  return -1;
}

/**
 * The menu's answer to a key: { active } (move the highlight), { run: item } (activate it), { close: true } (close the
 * whole menu), or null (not a menu key). VS Code's keys: arrows, Home/End, Right/Enter/Space open a submenu, Left/Escape
 * close one level, a letter jumps to the next item whose label starts with it.
 */
export function menuKey(items, active, key) {
  const path = Array.isArray(active) ? active.slice() : [];
  const depth = Math.max(0, path.length - 1);
  const list = levelItems(items, path, depth);
  const cur = path.length ? path[depth] : -1;
  const item = cur >= 0 ? list[cur] : null;
  const at = (i) => [...path.slice(0, depth), i];
  if (key === 'ArrowDown') { const i = step(list, cur, 1); return i < 0 ? null : { active: path.length ? at(i) : [i] }; }
  if (key === 'ArrowUp') { const i = step(list, cur, -1); return i < 0 ? null : { active: path.length ? at(i) : [i] }; }
  if (key === 'Home') { const i = step(list, -1, 1); return i < 0 ? null : { active: at(i) }; }
  if (key === 'End') { const i = step(list, 0, -1); return i < 0 ? null : { active: at(i) }; }
  if (key === 'ArrowRight' || ((key === 'Enter' || key === ' ') && item?.children?.length)) {
    if (!isSelectable(item) || !item.children?.length) return key === 'ArrowRight' ? null : item ? { run: item } : null;
    const first = step(item.children, -1, 1);
    return first < 0 ? null : { active: [...path, first] };
  }
  if (key === 'Enter' || key === ' ') return isSelectable(item) ? { run: item } : null;
  if (key === 'ArrowLeft') return path.length > 1 ? { active: path.slice(0, -1) } : null;
  if (key === 'Escape') return path.length > 1 ? { active: path.slice(0, -1) } : { close: true };
  if (typeof key === 'string' && key.length === 1 && /\S/u.test(key)) {
    const k = key.toLowerCase();
    const n = list.length;
    for (let s = 1; s <= n; s += 1) {
      const i = ((cur < 0 ? -1 : cur) + s + n) % n;
      if (isSelectable(list[i]) && String(list[i].label || '').toLowerCase().startsWith(k)) return { active: path.length ? at(i) : [i] };
    }
    return null;
  }
  return null;
}

/** Where a menu of size w x h opened at (x, y) sits inside a vw x vh viewport: flipped left/up when it would overflow. */
export function placeMenu({ x, y, w, h, vw, vh, margin = 4 }) {
  let left = x, top = y;
  if (left + w + margin > vw) left = Math.max(margin, x - w);
  if (top + h + margin > vh) top = Math.max(margin, vh - h - margin);
  return { left: Math.max(margin, left), top: Math.max(margin, top) };
}

/** Where a submenu sits beside its parent row (a DOMRect-like box): to the right, else to the left. */
export function placeSubmenu({ row, w, h, vw, vh, margin = 4 }) {
  let left = row.right - 2;
  if (left + w + margin > vw) left = Math.max(margin, row.left - w + 2);
  let top = row.top - 4;
  if (top + h + margin > vh) top = Math.max(margin, vh - h - margin);
  return { left, top };
}

/**
 * Where a right-click goes. The target is the nearest element (from the event target up) carrying `data-ctx`; its
 * `data-ctx-*` attributes become the context ({ kind, ...dataset }). Text fields, editable text and an explicit
 * `data-ctx="native"` keep the browser's own menu (spellcheck, paste); so does a click with Shift held (the escape hatch,
 * as in VS Code's webviews).
 */
export function contextOf(target, { shiftKey = false } = {}) {
  if (shiftKey) return null;
  for (let el = target; el && el.nodeType === 1; el = el.parentElement) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return null;
    const kind = el.getAttribute?.('data-ctx');
    if (kind === 'native') return null;
    if (kind) {
      const ctx = { kind };
      for (const { name, value } of el.attributes) if (name.startsWith('data-ctx-')) ctx[name.slice(9).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      return ctx;
    }
  }
  return { kind: 'app' };
}
