// Reusable state components (Docstore L2), for chat webapps and editors alike. GUIDE.md "State components".
//
// A component is DATA: { kind, initial, actions, gestures, conflict, states?, transitions?, terminal?, stateField? }.
//   actions   the log vocabulary: absolute end states, pure (state, payload) => state, TOTAL (a payload that makes no
//             sense is a no-op, never a throw, so a replayed log from another build cannot wedge a replica), and the SAME
//             reference when nothing changes (so nothing is logged, saved or pushed). Under conflict 'lww' every action
//             is idempotent: a(a(s)) === a(s).
//   gestures what a key or a click means: (state, payload) => [op, payload] | null.
//             the
//             relative form never enters the log, so a rebase or a duplicate delivery cannot flip it twice.
//   states    an optional lifecycle (declare enforces it through model.js `step`).
// Use one with declare (model.js):  app.use(declare({ name: 'conn', scope: 'ephemeral', ...connection() }))
// or on a quicklook store path:     store.component('list', inPlace(listSelect()))
// A gesture:                         gesture(replica, conn, 'connect', { url })   // dispatches ['connect', {url, attempt}]
// Keys and modes:                    keymap([...layers]) below; modes(['normal', 'insert']) is a lifecycle component.
//
// Ported from ~/projects/docstore src/docstore_core/l2/components.py (the Python is the reference these were learned from;
// the kit is canonical). Differences from it, each deliberate, are listed in GUIDE.md "State components". modal,
// splitPane, sort and pagination (with sortedView, heightIndex and windowFor) were designed from webchat's real use
// instead (GUIDE.md 3c); their Python namesakes are projections of them.

import { canonical } from './canonical.js';
import { parseSpec, matches } from './keys.js';

const same = (a, b) => canonical(a) === canonical(b);
const isInt = (v) => Number.isInteger(v);
const isNat = (v) => Number.isInteger(v) && v >= 0;
const isStr = (v) => typeof v === 'string';
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
/** `next` when it differs from `s`, else `s` itself (the kit's no-op contract). */
const keep = (s, next) => (same(s, next) ? s : next);
/** Actions and gestures see an object payload whatever arrives (null, a number, a string from another build's log), so a
 *  destructuring default can never throw mid-fold. Wraps every component below. */
const total = (fns) => Object.fromEntries(Object.entries(fns || {}).map(([k, f]) => [k, (s, p) => f(s, p && typeof p === 'object' && !Array.isArray(p) ? p : {})]));
const component = (c) => ({ ...c, actions: total(c.actions), gestures: total(c.gestures) });

// ---------------------------------------------------------------------------------------------------------------------
// selection: the quicklook host's id selection (mutates in place; used by store.component). Unchanged.
export const selection = () => ({
  initial: { ids: [], picks: [] }, // picks: the last two clicked ids, for "path between two clicks"
  actions: {
    set: (s, { ids, picks }) => { s.ids = [...new Set(ids)]; if (picks) s.picks = picks.slice(-2) },
    // gestures read the current slice and send absolute ids: toggle is expressed as set by callers; this
    // one exists for the "shift-click" gesture and is itself absolute about the id's membership
    include: (s, { id, on }) => { const has = s.ids.includes(id); if (on && !has) s.ids.push(id); if (!on && has) s.ids.splice(s.ids.indexOf(id), 1) },
    clear: (s) => { s.ids = []; s.picks = [] },
  },
})

// ---------------------------------------------------------------------------------------------------------------------
/** toggle(options): one of a fixed list. Action `set {value}`; gesture `next` (Python's relative `toggle` op). */
export function toggle(options) {
  if (!Array.isArray(options) || !options.length || !options.every(isStr) || new Set(options).size !== options.length) throw new Error('toggle: options must be distinct strings, at least one');
  const opts = [...options];
  return component({
    kind: 'toggle', args: [opts], conflict: 'lww',
    initial: { value: opts[0], index: 0 },
    actions: {
      set: (s, { value } = {}) => (opts.includes(value) ? keep(s, { value, index: opts.indexOf(value) }) : s),
    },
    gestures: {
      next: (s) => ['set', { value: opts[(opts.indexOf(s.value) + 1) % opts.length] }],
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
/** modes(names, {transitions?, initial?}): editor modes (normal / insert / visual ...), a lifecycle on `mode`.
 *  Action `set {mode}`. Without transitions every mode may follow every other. */
export function modes(names, { transitions, initial } = {}) {
  if (!Array.isArray(names) || !names.length || !names.every(isStr)) throw new Error('modes: names must be strings, at least one');
  const T = transitions || Object.fromEntries(names.map((n) => [n, names.filter((m) => m !== n)]));
  return component({
    kind: 'modes', args: [names, { transitions: T, initial }], conflict: 'lww',
    initial: { mode: initial ?? names[0] },
    states: [...names], transitions: T, terminal: [], stateField: 'mode',
    actions: { set: (s, { mode } = {}) => (names.includes(mode) ? keep(s, { mode }) : s) },
    gestures: {},
  });
}

// ---------------------------------------------------------------------------------------------------------------------
/** listSelect(): a cursor over a list that remembers where it was when deselected.
 *  state { cursor: int|null, anchor: int, suspended: bool }
 *  actions select {index, row_count?} (clamped when row_count is given), deselect {}, restore {row_count}
 *  gesture move {delta, row_count}: from a cursor, select the clamped neighbour; with no cursor, restore. */
export function listSelect() {
  const restore = (s, { row_count } = {}) => {
    if (!isNat(row_count)) return s;
    if (row_count === 0) return keep(s, { cursor: null, anchor: 0, suspended: false });
    const r = clamp(s.anchor, 0, row_count - 1);
    return keep(s, { cursor: r, anchor: r, suspended: false });
  };
  return component({
    kind: 'listSelect', args: [], conflict: 'lww',
    initial: { cursor: null, anchor: 0, suspended: false },
    actions: {
      select: (s, { index, row_count } = {}) => {
        if (!isNat(index)) return s;
        if (row_count !== undefined) { if (!isNat(row_count)) return s; if (row_count === 0) return restore(s, { row_count }); index = Math.min(index, row_count - 1); }
        return keep(s, { cursor: index, anchor: index, suspended: false });
      },
      deselect: (s) => keep(s, { cursor: null, anchor: s.cursor ?? s.anchor, suspended: true }),
      restore,
    },
    gestures: {
      move: (s, { delta, row_count } = {}) => {
        if (!isInt(delta) || !isNat(row_count)) return null;
        if (row_count === 0 || s.cursor === null) return ['restore', { row_count }];
        return ['select', { index: clamp(s.cursor + delta, 0, row_count - 1) }];
      },
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Python str.strip() whitespace (exactly the code points where str.isspace() is true), so a committed query is the same
// string on every implementation.
const WS = '[\\t\\n\\v\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const TRIM = new RegExp(`^${WS}+|${WS}+$`, 'gu');
export const pyStrip = (t) => t.replace(TRIM, '');

/** search(): a query being edited and the committed query rows are filtered by.
 *  state { active, value, committed }; actions start, update {value}, commit, cancel, clear (all idempotent). */
export function search() {
  return component({
    kind: 'search', args: [], conflict: 'lww',
    initial: { active: false, value: '', committed: '' },
    actions: {
      start: (s) => keep(s, { active: true, value: s.committed, committed: s.committed }),
      update: (s, { value } = {}) => (isStr(value) ? keep(s, { active: true, value, committed: s.committed }) : s),
      commit: (s) => keep(s, { active: false, value: s.value, committed: pyStrip(s.value) }),
      cancel: (s) => keep(s, { active: false, value: '', committed: '' }),
      clear: (s) => keep(s, { active: false, value: '', committed: '' }),
    },
    gestures: {},
  });
}
/** The rows a committed query keeps: case-insensitive substring over a row's string and number values. */
export function searchRows(rows, state) {
  const q = state.committed.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => Object.values(r).filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v).toLowerCase()).join(' ').includes(q));
}

// ---------------------------------------------------------------------------------------------------------------------
/** connection(): a socket's lifecycle. reconnect_at is whatever clock the caller uses (seconds or ms), opaque here.
 *  actions connect {url, attempt} (attempt is absolute: the count after this attempt), opened, errored {msg, reconnect_at?},
 *  closed {reconnect_at?}; gesture connect {url} -> attempt = attempt_count + 1. */
export function connection() {
  const at = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return component({
    kind: 'connection', args: [], conflict: 'lww',
    initial: { state: 'disconnected', url: '', error_msg: null, reconnect_at: null, attempt_count: 0 },
    states: ['disconnected', 'connecting', 'connected', 'error'],
    transitions: { disconnected: ['connecting'], connecting: ['connected', 'error', 'disconnected'], connected: ['error', 'disconnected'], error: ['connecting', 'disconnected'] },
    terminal: [], stateField: 'state',
    actions: {
      connect: (s, { url, attempt } = {}) => (isStr(url) && isNat(attempt) ? keep(s, { state: 'connecting', url, error_msg: null, reconnect_at: null, attempt_count: attempt }) : s),
      opened: (s) => keep(s, { ...s, state: 'connected', error_msg: null, reconnect_at: null }),
      errored: (s, { msg, reconnect_at } = {}) => (isStr(msg) ? keep(s, { ...s, state: 'error', error_msg: msg, reconnect_at: at(reconnect_at) }) : s),
      closed: (s, { reconnect_at } = {}) => keep(s, { ...s, state: 'disconnected', error_msg: null, reconnect_at: at(reconnect_at) }),
    },
    gestures: {
      connect: (s, { url } = {}) => (isStr(url) ? ['connect', { url, attempt: s.attempt_count + 1 }] : null),
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
/** scrollAnchor(): follow the live end, or hold a block at an offset.
 *  state { mode: 'auto'|'manual', anchor_id, offset_px }; actions user_scrolled {top_block_id, offset}, snap_to_live, snap_to_block {block_id}. */
export function scrollAnchor() {
  return component({
    kind: 'scrollAnchor', args: [], conflict: 'lww',
    initial: { mode: 'auto', anchor_id: null, offset_px: 0 },
    actions: {
      user_scrolled: (s, { top_block_id, offset } = {}) => (isStr(top_block_id) && isInt(offset) ? keep(s, { mode: 'manual', anchor_id: top_block_id, offset_px: offset }) : s),
      snap_to_live: (s) => keep(s, { mode: 'auto', anchor_id: null, offset_px: 0 }),
      snap_to_block: (s, { block_id } = {}) => (isStr(block_id) ? keep(s, { mode: 'manual', anchor_id: block_id, offset_px: 0 }) : s),
    },
    gestures: {},
  });
}

// ---------------------------------------------------------------------------------------------------------------------
/** documentCursor(): a caret in a block document (paragraph id + offset) with an optional selection anchor.
 *  actions set {para_id, offset}, set_with_selection {para_id, offset, sel_anchor_para, sel_anchor_offset},
 *  collapse_selection, select_all {first_para_id, last_para_id, last_para_length}. */
export function documentCursor() {
  return component({
    kind: 'documentCursor', args: [], conflict: 'lww',
    initial: { para_id: null, offset: 0, sel_anchor_para: null, sel_anchor_offset: null },
    actions: {
      set: (s, { para_id, offset } = {}) => (isStr(para_id) && isNat(offset) ? keep(s, { para_id, offset, sel_anchor_para: null, sel_anchor_offset: null }) : s),
      set_with_selection: (s, { para_id, offset, sel_anchor_para, sel_anchor_offset } = {}) =>
        (isStr(para_id) && isNat(offset) && isStr(sel_anchor_para) && isNat(sel_anchor_offset) ? keep(s, { para_id, offset, sel_anchor_para, sel_anchor_offset }) : s),
      collapse_selection: (s) => keep(s, { ...s, sel_anchor_para: null, sel_anchor_offset: null }),
      select_all: (s, { first_para_id, last_para_id, last_para_length } = {}) =>
        (isStr(first_para_id) && isStr(last_para_id) && isNat(last_para_length) ? keep(s, { para_id: last_para_id, offset: last_para_length, sel_anchor_para: first_para_id, sel_anchor_offset: 0 }) : s),
    },
    gestures: {},
  });
}

// ---------------------------------------------------------------------------------------------------------------------
/** undoHistory(): undo/redo with batching, for any editor (text, track, density map, flow field).
 *  state { entries: [{ ids, actions, cursor_before, cursor_after }], position, batch: entry-in-progress | null }
 *    entries[0..position) are done (undoable), entries[position..) are undone (redoable).
 *  actions
 *    record {id, actions, cursor_before, cursor_after}: one edit. A seen id is a no-op (duplicate delivery). Drops the
 *      redoable entries. Inside an open batch it joins the batch: the batch keeps the FIRST cursor_before and the last
 *      cursor_after, and its actions are the flat concatenation.
 *    batch {open}: open=true starts a batch (already open: no-op, nothing is dropped); open=false commits it as one entry.
 *    seek {position}: commits an open batch first, then moves to the clamped position. Absolute, so two devices that
 *      both "undo once" from the same position land on the same position, not two steps back.
 *  gestures undo, redo -> seek. What to apply or revert is the caller's job: entries[position-1].actions after an undo. */
export function undoHistory() {
  const commit = (s) => (s.batch && s.batch.ids.length ? { entries: [...s.entries, s.batch], position: s.entries.length + 1, batch: null } : { entries: s.entries, position: s.position, batch: null });
  const seen = (s, id) => s.entries.some((e) => e.ids.includes(id)) || Boolean(s.batch?.ids.includes(id));
  return component({
    kind: 'undoHistory', args: [], conflict: 'log',
    initial: { entries: [], position: 0, batch: null },
    actions: {
      record: (s, { id, actions, cursor_before = null, cursor_after = null } = {}) => {
        if (!isStr(id) || !Array.isArray(actions) || seen(s, id)) return s;
        const entries = s.entries.slice(0, s.position);
        if (s.batch) {
          const b = s.batch, first = b.ids.length === 0;
          return { entries, position: s.position, batch: { ids: [...b.ids, id], actions: [...b.actions, ...actions], cursor_before: first ? cursor_before : b.cursor_before, cursor_after } };
        }
        return { entries: [...entries, { ids: [id], actions: [...actions], cursor_before, cursor_after }], position: entries.length + 1, batch: null };
      },
      batch: (s, { open } = {}) => {
        if (typeof open !== 'boolean') return s;
        if (open) return s.batch ? s : { ...s, batch: { ids: [], actions: [], cursor_before: null, cursor_after: null } };
        return s.batch ? commit(s) : s;
      },
      seek: (s, { position } = {}) => {
        if (!isInt(position)) return s;
        const c = commit(s);
        return keep(s, { ...c, position: clamp(position, 0, c.entries.length) });
      },
    },
    gestures: {
      undo: (s) => (effective(s) > 0 ? ['seek', { position: effective(s) - 1 }] : null),
      redo: (s) => (!s.batch?.ids.length && s.position < s.entries.length ? ['seek', { position: s.position + 1 }] : null),
    },
  });
}
/** The entry an undo just reverted / a redo just re-applied, given the states before and after the seek. */
const effective = (s) => s.position + (s.batch?.ids.length ? 1 : 0); // an open batch counts as done: a seek commits it
export const undone = (before, after) => after.entries.slice(after.position, Math.max(after.position, effective(before))).reverse();
export const redone = (before, after) => after.entries.slice(effective(before), Math.max(effective(before), after.position));

// ---------------------------------------------------------------------------------------------------------------------
// The four below were designed from webchat's real overlays, panes, orderings and long lists (GUIDE.md 3c, with file:line
// evidence); the Python reference (ModalComponent, SplitPaneComponent, SortComponent, PaginationComponent) is a projection
// of each, compared in conformance/diff-python.mjs.
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** A plain JSON value (what a payload may carry and still replay byte for byte on every replica). An undefined member is
 *  allowed because the log's JSON form drops it (in an array it becomes null), so the raw and the logged payload agree. */
export function isJson(v, depth = 0) {
  if (depth > 32) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => x === undefined || isJson(x, depth + 1));
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.values(v).every((x) => x === undefined || isJson(x, depth + 1));
  return false;
}
const jsonCopy = (v) => JSON.parse(JSON.stringify(v));
const obj = (p) => (p && typeof p === 'object' && !Array.isArray(p) ? p : {});

// ---------------------------------------------------------------------------------------------------------------------
/** modal(): the overlay stack (dialogs, sheets, the palette, menus, the lightbox), independent of any DOM.
 *  state { stack: [{ id, kind, payload, capture, esc, backdrop, return_to }] }, bottom first; the last entry is on top.
 *    capture    while it is on top, keys belong to it (modalLayer below is the keymap layer that enforces it)
 *    esc        'close' | 'ignore'   what Escape does when it is on top (a required prompt ignores it)
 *    backdrop   'close' | 'ignore'   what a pointer outside it does (a menu's outside click, a sheet's scrim)
 *    return_to  an app-chosen string naming where focus goes back when it closes (the app maps it to an element)
 *  actions open {id, kind?, payload?, capture?, esc?, backdrop?, return_to?}: id is open, on top, with these fields (an
 *            already-open id moves to the top); close {id}: id and everything opened over it are gone; close_all {}.
 *  gestures escape {}: closes the top if its esc is 'close'; backdrop {id}: closes id if id is the top the user saw and
 *            its backdrop is 'close'. Both resolve to an absolute close {id}, so a doubled Escape closes one layer. */
export function modal() {
  const POLICY = ['close', 'ignore'];
  const entryOf = (p) => {
    const { id, kind = null, payload = null, capture = true, esc = 'close', backdrop = 'close', return_to = null } = obj(p);
    if (!isStr(id) || !id || (kind !== null && !isStr(kind)) || !isJson(payload)) return null;
    if (typeof capture !== 'boolean' || !POLICY.includes(esc) || !POLICY.includes(backdrop)) return null;
    if (return_to !== null && !isStr(return_to)) return null;
    return { id, kind, payload: jsonCopy(payload), capture, esc, backdrop, return_to };
  };
  return component({
    kind: 'modal', args: [], conflict: 'lww',
    initial: { stack: [] },
    actions: {
      open: (s, p) => { const e = entryOf(p); return e ? keep(s, { stack: [...s.stack.filter((x) => x.id !== e.id), e] }) : s; },
      close: (s, { id } = {}) => { if (!isStr(id)) return s; const at = s.stack.findIndex((x) => x.id === id); return at === -1 ? s : { stack: s.stack.slice(0, at) }; },
      close_all: (s) => (s.stack.length ? { stack: [] } : s),
    },
    gestures: {
      escape: (s) => { const t = modalTop(s); return t && t.esc === 'close' ? ['close', { id: t.id }] : null; },
      backdrop: (s, { id } = {}) => { const t = modalTop(s); return t && t.id === id && t.backdrop === 'close' ? ['close', { id }] : null; },
    },
  });
}
/** The entry on top, or null. */
export const modalTop = (s) => s.stack[s.stack.length - 1] || null;
/** Whether keys belong to the overlay stack now (the top entry captures). */
export const modalCaptures = (s) => Boolean(modalTop(s)?.capture);
/** Where focus goes after a transition: the return_to of the lowest entry it closed (the one opened from the page or
 *  from the layer that is now on top), or null when nothing closed. */
export function focusReturn(before, after) {
  const gone = before.stack.find((e) => !after.stack.some((a) => a.id === e.id));
  return gone ? gone.return_to : null;
}
/** The keymap layer for an overlay stack held under `target`: active while the top captures, swallows every unbound
 *  key, Escape resolves to the absolute close. `keys` adds the top layer's own bindings (arrows in a palette). */
export function modalLayer(target = 'modal', keys = {}) {
  return { when: (ctx) => modalCaptures(ctx.get(target)), capture: true, keys: { Escape: [target, 'escape'], ...keys } };
}

// ---------------------------------------------------------------------------------------------------------------------
/** splitPane(options): panes side by side with sizes, rails, focus and constraints; per-device when declared 'local'.
 *  options (JSON, so they travel in vectors) {
 *    panes: [ids]           initial panes, in order
 *    unit: 'fraction'|'px'  fraction: open panes share 1 (webchat's chat panes); px: each pane but `fluid` has a pixel
 *                           size and `fluid` takes the rest (webchat's chat list beside the stage)
 *    fluid: id|null         px only: the pane that takes the remaining space; it never collapses
 *    min, max, collapse_below, collapsible, snap: [sizes], snap_within, default   per-pane constraints in `unit`, with
 *                           per: { id: {...} } overriding them for one pane. A drag that leaves a pane below
 *                           collapse_below collapses it to a rail; between collapse_below and min it clamps at min.
 *    rail_px                the width a collapsed pane keeps (34 for webchat panes, 0 for the hidden chat list)
 *    max_panes, direction ('horizontal'|'vertical', layout metadata) }
 *  state { order: [ids], sizes: {id: n|null}, collapsed: [ids, sorted], focused: id|null }
 *  actions (absolute) size {pane, size, against?}: fraction moves width between pane and `against`, conserving their sum;
 *    px sets the pane's pixels. collapse {pane}, expand {pane, size?} (focuses it), focus {pane} (expands a rail),
 *    add {pane, after}, remove {pane}, move {pane, to}, reset {pane?}.
 *  gestures resize {divider, delta_px, container_px}: the WHOLE drag, resolved against the layout at drag start; render
 *    the drag with preview(...) and dispatch this once on release. toggle {pane}, focus_neighbour {delta}, shift {pane, delta}. */
export function splitPane(options = {}) {
  const o = { panes: ['main'], unit: 'fraction', fluid: null, rail_px: 0, max_panes: null, direction: 'horizontal', per: {}, ...options };
  const frac = o.unit === 'fraction';
  if (!['fraction', 'px'].includes(o.unit)) throw new Error('splitPane: unit must be fraction or px');
  if (!['horizontal', 'vertical'].includes(o.direction)) throw new Error('splitPane: direction must be horizontal or vertical');
  if (!Array.isArray(o.panes) || !o.panes.every((p) => isStr(p) && p) || new Set(o.panes).size !== o.panes.length) throw new Error('splitPane: panes must be distinct non-empty strings');
  if (o.fluid !== null && (frac || !o.panes.includes(o.fluid))) throw new Error('splitPane: fluid is a px-mode pane that is in panes');
  const base = { min: frac ? 0.06 : 0, max: null, collapse_below: null, collapsible: true, snap: [], snap_within: 0, default: null };
  const con = (id) => ({ ...base, ...pick(o), ...(o.per?.[id] || {}) });
  for (const id of [...o.panes, ...Object.keys(o.per || {})]) {
    const c = con(id);
    if (!isNum(c.min) || c.min < 0 || (frac && c.min >= 1)) throw new Error(`splitPane: ${id} min out of range`);
    if (c.max !== null && (!isNum(c.max) || c.max < c.min)) throw new Error(`splitPane: ${id} max below min`);
    if (c.collapse_below !== null && (!isNum(c.collapse_below) || c.collapse_below > c.min)) throw new Error(`splitPane: ${id} collapse_below must be at most min`);
  }
  const lim = (id, v) => { const c = con(id); return Math.min(Math.max(v, c.min), c.max ?? Infinity); };
  const snapTo = (id, v) => { const c = con(id); for (const p of c.snap) if (Math.abs(v - p) <= c.snap_within) return p; return v; };
  const isC = (s, id) => s.collapsed.includes(id);
  const openN = (s) => s.order.filter((id) => !isC(s, id)).length;
  const can = (id) => con(id).collapsible && id !== o.fluid;
  // Fraction widths over open panes, renormalised to sum to 1 exactly as webchat's panels.js normalised() does.
  const normalised = (s, sizes, collapsed) => {
    const W = s.order.map((id) => (collapsed.includes(id) ? 0 : sizes[id]));
    const total = W.reduce((a, w) => a + w, 0), open = s.order.filter((id) => !collapsed.includes(id)).length;
    return Object.fromEntries(s.order.map((id, i) => [id, collapsed.includes(id) ? 0 : total > 0 ? W[i] / total : 1 / Math.max(open, 1)]));
  };
  const even = (s, collapsed) => { const open = s.order.filter((id) => !collapsed.includes(id)).length; return Object.fromEntries(s.order.map((id) => [id, collapsed.includes(id) ? 0 : 1 / open])); };
  const pxDefault = (id) => (id === o.fluid ? null : lim(id, con(id).default ?? con(id).min));
  const sorted = (xs) => [...xs].sort();
  const initial = { order: [...o.panes], sizes: frac ? (o.panes.length ? Object.fromEntries(o.panes.map((id) => [id, 1 / o.panes.length])) : {}) : Object.fromEntries(o.panes.map((id) => [id, pxDefault(id)])), collapsed: [], focused: o.panes[0] ?? null };

  const expand = (s, id, size) => {
    if (!s.order.includes(id)) return s;
    if (!isC(s, id)) return keep(s, { ...s, focused: id });
    const collapsed = s.collapsed.filter((x) => x !== id);
    if (!frac) return keep(s, { ...s, collapsed, focused: id, sizes: isNum(size) ? { ...s.sizes, [id]: lim(id, size) } : s.sizes });
    const open = s.order.filter((x) => !collapsed.includes(x)).length;
    const share = isNum(size) ? lim(id, size) : 1 / open;
    if (share >= 1) return keep(s, { ...s, collapsed, focused: id, sizes: even(s, collapsed) });
    let sizes = Object.fromEntries(s.order.map((x) => [x, collapsed.includes(x) ? 0 : x === id ? share : s.sizes[x] * (1 - share)]));
    if (s.order.some((x) => !collapsed.includes(x) && sizes[x] < con(x).min)) sizes = even(s, collapsed);
    return keep(s, { ...s, collapsed, focused: id, sizes: normalised(s, sizes, collapsed) });
  };
  const collapse = (s, id) => {
    if (!s.order.includes(id) || isC(s, id) || !can(id)) return s;
    if (frac && openN(s) <= 1) return s;
    const collapsed = sorted([...s.collapsed, id]);
    if (!frac) return { ...s, collapsed };
    return { ...s, collapsed, sizes: normalised(s, { ...s.sizes, [id]: 0 }, collapsed) };
  };

  return component({
    kind: 'splitPane', args: [options], opts: o, conflict: 'lww', initial,
    actions: {
      size: (s, { pane, size, against } = {}) => {
        if (!isStr(pane) || !s.order.includes(pane) || !isNum(size)) return s;
        if (!frac) { if (pane === o.fluid) return s; const next = lim(pane, size); return next === s.sizes[pane] ? s : { ...s, sizes: { ...s.sizes, [pane]: next } }; }
        if (!isStr(against) || against === pane || !s.order.includes(against) || isC(s, pane) || isC(s, against)) return s;
        const a = con(pane), b = con(against), pair = s.sizes[pane] + s.sizes[against];
        const lo = Math.max(a.min, pair - (b.max ?? Infinity)), hi = Math.min(a.max ?? Infinity, pair - b.min);
        if (!(lo <= hi)) return s;
        const next = Math.min(Math.max(size, lo), hi);
        // a move under 1e-12 of the container is no move: the pair's float sum can drift by an ulp, and a redelivered size
        // must land on the same reference
        return Math.abs(next - s.sizes[pane]) <= 1e-12 ? s : { ...s, sizes: { ...s.sizes, [pane]: next, [against]: pair - next } };
      },
      collapse: (s, { pane } = {}) => collapse(s, pane),
      expand: (s, { pane, size } = {}) => (isStr(pane) && (size === undefined || isNum(size)) ? expand(s, pane, size) : s),
      focus: (s, { pane } = {}) => (isStr(pane) && s.order.includes(pane) ? expand(s, pane) : s),
      add: (s, { pane, after = null } = {}) => {
        if (!isStr(pane) || !pane || s.order.includes(pane) || (after !== null && !s.order.includes(after))) return s;
        if (o.max_panes !== null && s.order.length >= o.max_panes) return s;
        if (!s.order.length) return { order: [pane], sizes: { [pane]: frac ? 1 : pxDefault(pane) }, collapsed: [], focused: pane };
        const from = after !== null && isC(s, after) ? expand(s, after) : s;
        const at = after === null ? -1 : from.order.indexOf(after);
        const order = [...from.order]; order.splice(at + 1, 0, pane);
        const t = { ...from, order };
        if (!frac) return { ...t, sizes: { ...from.sizes, [pane]: pxDefault(pane) }, focused: pane };
        const donor = at === -1 ? null : from.sizes[after];
        if (donor === null || donor / 2 < Math.max(con(after).min, con(pane).min)) return { ...t, sizes: normalised(t, Object.fromEntries(order.map((x) => [x, from.collapsed.includes(x) ? 0 : 1])), from.collapsed), focused: pane };
        return { ...t, sizes: normalised(t, { ...from.sizes, [after]: donor / 2, [pane]: donor / 2 }, from.collapsed), focused: pane };
      },
      remove: (s, { pane } = {}) => {
        if (!isStr(pane) || !s.order.includes(pane) || s.order.length <= 1 || pane === o.fluid) return s;
        const at = s.order.indexOf(pane), order = s.order.filter((x) => x !== pane), collapsed = s.collapsed.filter((x) => x !== pane);
        const { [pane]: _gone, ...rest } = s.sizes;
        const focused = s.focused === pane ? order[clamp(at - 1, 0, order.length - 1)] : s.focused;
        const t = { order, collapsed, focused, sizes: frac ? normalised({ order }, rest, collapsed) : rest };
        return order.every((x) => collapsed.includes(x)) ? expand(t, focused) : t;
      },
      move: (s, { pane, to } = {}) => {
        if (!isStr(pane) || !s.order.includes(pane) || !isNat(to) || to >= s.order.length || s.order.indexOf(pane) === to) return s;
        const order = s.order.filter((x) => x !== pane); order.splice(to, 0, pane);
        return { ...s, order };
      },
      reset: (s, { pane } = {}) => {
        if (pane !== undefined) { if (frac || !isStr(pane) || !s.order.includes(pane) || pane === o.fluid) return s; return keep(s, { ...s, sizes: { ...s.sizes, [pane]: pxDefault(pane) } }); }
        return keep(s, { ...s, sizes: frac ? even(s, s.collapsed) : Object.fromEntries(s.order.map((x) => [x, pxDefault(x)])) });
      },
    },
    gestures: {
      // The whole drag against the layout he grabbed: delta_px is the pointer's displacement since pointerdown.
      resize: (s, { divider, delta_px, container_px } = {}) => {
        if (!isNat(divider) || !isNum(delta_px) || !isNum(container_px) || container_px <= 0) return null;
        const a = s.order[divider], b = s.order[divider + 1];
        if (b === undefined) return null;
        if (frac) {
          if (isC(s, a) || isC(s, b)) return null; // no divider beside a rail; a rail opens by click (expand)
          const space = container_px - s.collapsed.length * o.rail_px;
          if (space <= 0) return null;
          const pair = s.sizes[a] + s.sizes[b], wanted = s.sizes[a] + delta_px / space, ca = con(a), cb = con(b);
          if (ca.collapse_below !== null && can(a) && wanted < ca.collapse_below) return ['collapse', { pane: a }];
          if (cb.collapse_below !== null && can(b) && pair - wanted < cb.collapse_below) return ['collapse', { pane: b }];
          const lo = Math.max(ca.min, pair - (cb.max ?? Infinity)), hi = Math.min(ca.max ?? Infinity, pair - cb.min);
          if (!(lo <= hi)) return null;
          const next = Math.min(Math.max(snapTo(a, wanted), lo), hi);
          return Math.abs(next - s.sizes[a]) <= 1e-12 ? null : ['size', { pane: a, size: next, against: b }];
        }
        const [t, sign] = a !== o.fluid ? [a, 1] : b !== o.fluid ? [b, -1] : [null, 0];
        if (t === null) return null;
        const c = con(t), shut = isC(s, t), wanted = (shut ? o.rail_px : s.sizes[t]) + sign * delta_px;
        if (c.collapse_below !== null && can(t) && wanted < c.collapse_below) return shut ? null : ['collapse', { pane: t }];
        const next = lim(t, snapTo(t, wanted));
        if (shut) return ['expand', { pane: t, size: next }];
        return next === s.sizes[t] ? null : ['size', { pane: t, size: next }];
      },
      toggle: (s, { pane } = {}) => (isStr(pane) && s.order.includes(pane) ? [isC(s, pane) ? 'expand' : 'collapse', { pane }] : null),
      focus_neighbour: (s, { delta } = {}) => {
        if (!isInt(delta) || delta === 0 || s.focused === null) return null;
        const step1 = Math.sign(delta);
        let at = s.order.indexOf(s.focused), left = Math.abs(delta);
        while (left > 0) { at += step1; if (at < 0 || at >= s.order.length) return null; if (!isC(s, s.order[at])) left -= 1; }
        return ['focus', { pane: s.order[at] }];
      },
      shift: (s, { pane, delta } = {}) => {
        if (!isStr(pane) || !isInt(delta) || !s.order.includes(pane)) return null;
        const to = s.order.indexOf(pane) + delta;
        return to < 0 || to >= s.order.length || delta === 0 ? null : ['move', { pane, to }];
      },
    },
  });
}
const CON_KEYS = ['min', 'max', 'collapse_below', 'collapsible', 'snap', 'snap_within', 'default'];
const pick = (o) => Object.fromEntries(CON_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
/** Each pane's on-screen pixels for a container (webchat panels.js panelPx): a rail keeps rail_px, fraction panes share
 *  what the rails leave, px panes keep their size and the fluid pane takes the rest. */
export function splitLayout(comp, s, container_px) {
  const o = comp.opts, rails = s.collapsed.length * o.rail_px;
  if (o.unit === 'fraction') return Object.fromEntries(s.order.map((id) => [id, s.collapsed.includes(id) ? o.rail_px : Math.max(0, container_px - rails) * s.sizes[id]]));
  const fixed = s.order.reduce((a, id) => a + (id === o.fluid ? 0 : s.collapsed.includes(id) ? o.rail_px : s.sizes[id]), 0);
  return Object.fromEntries(s.order.map((id) => [id, id === o.fluid ? Math.max(0, container_px - fixed) : s.collapsed.includes(id) ? o.rail_px : s.sizes[id]]));
}

// ---------------------------------------------------------------------------------------------------------------------
/** sort(options): the user's ordering choice as state, plus a total-order comparator and an incrementally maintained
 *  sorted view (sortedView) so one changed row costs a binary search, not a re-sort of the list.
 *  options (JSON) {
 *    keys: { name: { type: 'string'|'number'|'time'|'bool', from: field | [fields] (first present wins), dir? } }
 *    by: [[key, 'asc'|'desc'], ...]   the initial (and reset) ordering
 *    lead: [[key, dir], ...]          always applied first, not his to change (webchat: pinned chats on top)
 *    id: 'id'                         the field that breaks every tie, ascending, so the order is total }
 *  state { by: [[key, dir], ...] }. actions set {by}, reset {}. gesture column {key}: a click on a column header makes it
 *  the ordering; clicking the current one flips its direction (Python SortComponent's set, resolved to an absolute set).
 *  Missing values (null, unparseable time) sort after present ones in either direction; strings compare by UTF-16 code
 *  unit (the order lib/canonical.js uses; localeCompare differs between machines). */
export function sort(options = {}) {
  const o = { keys: {}, by: null, lead: [], id: 'id', ...options };
  const names = Object.keys(o.keys);
  if (!names.length) throw new Error('sort: at least one key');
  for (const [k, spec] of Object.entries(o.keys)) if (!['string', 'number', 'time', 'bool'].includes(spec?.type)) throw new Error(`sort: key ${k} needs a type`);
  const validBy = (by) => Array.isArray(by) && by.length > 0 && by.every((t) => Array.isArray(t) && t.length === 2 && names.includes(t[0]) && ['asc', 'desc'].includes(t[1])) && new Set(by.map((t) => t[0])).size === by.length;
  const by0 = o.by ?? [[names[0], o.keys[names[0]].dir || 'asc']];
  if (!validBy(by0)) throw new Error('sort: by must be distinct [declared key, asc|desc] pairs');
  if (o.lead.length && !validBy(o.lead)) throw new Error('sort: lead must be distinct [declared key, asc|desc] pairs');
  const initial = { by: by0.map((t) => [...t]) };
  return component({
    kind: 'sort', args: [options], opts: o, conflict: 'lww', initial,
    actions: {
      set: (s, { by } = {}) => (validBy(by) ? keep(s, { by: by.map((t) => [t[0], t[1]]) }) : s),
      reset: (s) => keep(s, initial),
    },
    gestures: {
      column: (s, { key } = {}) => {
        if (!names.includes(key)) return null;
        const [k, d] = s.by[0];
        return ['set', { by: [[key, k === key ? (d === 'asc' ? 'desc' : 'asc') : (o.keys[key].dir || 'asc')]] }];
      },
    },
  });
}
const read = (row, from) => { for (const f of Array.isArray(from) ? from : [from]) { const v = row?.[f]; if (v !== undefined && v !== null && v !== '') return v; } return null; };
const norm = (type, v) => {
  if (type === 'bool') return v ? 1 : 0; // a missing flag is false (an unpinned chat has no pinned field)
  if (v === null) return null;
  if (type === 'time') { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; }
  if (type === 'number') return isNum(v) ? v : null;
  return typeof v === 'string' ? v : String(v);
};
/** { keyOf(row) -> key array, compare(ka, kb) } for a sort component in a state: keys are extracted ONCE per row (the */
export function sorter(comp, s) {
  const o = comp.opts, spec = [...o.lead, ...s.by.filter(([k]) => !o.lead.some(([l]) => l === k))];
  const cols = spec.map(([k, d]) => ({ type: o.keys[k].type, from: o.keys[k].from ?? k, sign: d === 'desc' ? -1 : 1 }));
  const keyOf = (row) => [...cols.map((c) => norm(c.type, read(row, c.from))), String(row?.[o.id] ?? '')];
  const compare = (x, y) => {
    for (let i = 0; i < cols.length; i++) {
      const a = x[i], b = y[i];
      if (a === b) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a < b ? -1 : 1) * cols[i].sign;
    }
    const a = x[cols.length], b = y[cols.length];
    return a < b ? -1 : a > b ? 1 : 0;
  };
  return { keyOf, compare };
}
/** A sorted view kept in order incrementally: upsert(row) and remove(id) cost a binary search (O(log n) comparisons) and
 *  one array splice; slice(start, end) is O(window). Build it again only when the sort state itself changes.
 *  `comparisons` counts comparator calls (tests and perf probes read it). */
export function sortedView(comp, s, rows = []) {
  const { keyOf, compare } = sorter(comp, s), idf = comp.opts.id;
  const byId = new Map();
  for (const row of rows) byId.set(String(row?.[idf] ?? ''), { row, k: keyOf(row) });
  const view = { comparisons: 0, get size() { return list.length; } };
  let list = [...byId.values()];
  list.sort((a, b) => { view.comparisons++; return compare(a.k, b.k); });
  const lower = (k) => { let lo = 0, hi = list.length; while (lo < hi) { const mid = (lo + hi) >> 1; view.comparisons++; if (compare(list[mid].k, k) < 0) lo = mid + 1; else hi = mid; } return lo; };
  return Object.assign(view, {
    at: (i) => list[i]?.row,
    slice: (start = 0, end = list.length) => list.slice(start, end).map((e) => e.row),
    rows: () => list.map((e) => e.row),
    indexOf: (id) => { const e = byId.get(id); if (!e) return -1; const i = lower(e.k); return list[i] === e ? i : -1; },
    /** Insert or move one row; returns its new index. */
    upsert(row) {
      const id = String(row?.[idf] ?? ''), k = keyOf(row), old = byId.get(id);
      if (old) {
        const i = lower(old.k);
        if (compare(old.k, k) === 0) { const e = { row, k }; byId.set(id, e); list[i] = e; return i; }
        list.splice(i, 1);
      }
      const e = { row, k }; byId.set(id, e);
      const at = lower(k); list.splice(at, 0, e);
      return at;
    },
    remove(id) { const e = byId.get(id); if (!e) return false; list.splice(lower(e.k), 1); byId.delete(id); return true; },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
/**  state { page (1-based), page_size, total: int|null (null while the end is unknown) }.
 *  actions goto {page} (clamped to the last page once total is known), set_total {total}, set_page_size {page_size} (the
 *  first row on screen stays on screen). gestures next, prev -> goto. pageRange gives the rows to render.
 */
export function pagination({ page_size = 20 } = {}) {
  if (!Number.isInteger(page_size) || page_size <= 0) throw new Error('pagination: page_size must be a positive integer');
  const last = (total, size) => Math.max(1, Math.ceil(total / size));
  const fit = (page, total, size) => (total === null ? page : Math.min(page, last(total, size)));
  return component({
    kind: 'pagination', args: [{ page_size }], conflict: 'lww',
    initial: { page: 1, page_size, total: null },
    actions: {
      goto: (s, { page } = {}) => (isInt(page) && page >= 1 ? keep(s, { ...s, page: fit(page, s.total, s.page_size) }) : s),
      set_total: (s, { total } = {}) => (total === null || isNat(total) ? keep(s, { ...s, total, page: fit(s.page, total, s.page_size) }) : s),
      set_page_size: (s, { page_size: size } = {}) => {
        if (!Number.isInteger(size) || size <= 0) return s;
        const page = Math.floor(((s.page - 1) * s.page_size) / size) + 1;
        return keep(s, { page: fit(page, s.total, size), page_size: size, total: s.total });
      },
    },
    gestures: {
      next: (s) => (s.total !== null && s.page >= last(s.total, s.page_size) ? null : ['goto', { page: s.page + 1 }]),
      prev: (s) => (s.page <= 1 ? null : ['goto', { page: s.page - 1 }]),
    },
  });
}
/** Rows [start, end) to render: one page, or with extent every page up to this one (a "show more" list). */
export function pageRange(s, { extent = false } = {}) {
  const start = extent ? 0 : (s.page - 1) * s.page_size;
  const end = s.page * s.page_size;
  return { start, end: s.total === null ? end : Math.min(end, s.total) };
}

// ---------------------------------------------------------------------------------------------------------------------
/** heightIndex({ estimate, bucket }): row heights for a virtual window. Unmeasured rows stand in at estimate(row) (or the
 *  learned mean of their bucket(row), as webchat's Transcript.svelte learns per type and length), measured rows at their
 *  measurement. A Fenwick tree makes offsetOf(index) and indexAt(px) O(log n) and a measurement O(log n); sync(rows) is
 *  O(n) and only runs when the row list changes. Heights are device measurements, never logged: what is logged is the
 *  scrollAnchor (top row id + offset), dispatched when a scroll settles. */
export function heightIndex({ estimate = () => 40, bucket = null } = {}) {
  let ids = [], rows = [], h = new Float64Array(0), tree = new Float64Array(1), at = new Map(), source = null;
  const measured = new Map(), learned = new Map();
  const ix = { estimates: 0, get count() { return h.length; } };
  const guess = (row) => { ix.estimates++; const b = bucket ? learned.get(bucket(row)) : null; return b ? b.sum / b.count : estimate(row); };
  // 1-indexed Fenwick tree: tree[i] holds the heights of rows (i - lowbit(i), i]
  const build = () => { const n = h.length; tree = new Float64Array(n + 1); for (let i = 1; i <= n; i++) { tree[i] += h[i - 1]; const j = i + (i & -i); if (j <= n) tree[j] += tree[i]; } };
  const add = (i0, d) => { for (let i = i0 + 1; i < tree.length; i += i & -i) tree[i] += d; };
  return Object.assign(ix, {
    /** Point the index at a row list (same array again: nothing to do). Measurements survive by id. */
    sync(next, idOf = (r) => r.id) {
      if (next === source) return false;
      source = next; rows = next; ids = next.map(idOf); at = new Map(ids.map((id, i) => [id, i]));
      h = Float64Array.from(rows, (r, i) => (measured.has(ids[i]) ? measured.get(ids[i]) : guess(r)));
      build();
      return true;
    },
    /** Record a row's rendered height; returns whether anything moved. */
    measure(id, px) {
      if (!isNum(px) || px < 0) return false;
      const first = !measured.has(id);
      measured.set(id, px);
      const i = at.get(id);
      if (i === undefined) return false;
      if (first && bucket) { const k = bucket(rows[i]); const b = learned.get(k) || { sum: 0, count: 0 }; b.sum += px; b.count += 1; learned.set(k, b); }
      if (h[i] === px) return false;
      add(i, px - h[i]); h[i] = px;
      return true;
    },
    heightOf: (i) => h[i],
    indexOfId: (id) => at.get(id) ?? -1,
    /** Pixels above row i (offsetOf(count) is the total height). */
    offsetOf(k) { let s = 0; for (let i = Math.max(0, Math.min(k, h.length)); i > 0; i -= i & -i) s += tree[i]; return s; },
    /** The row containing pixel px (clamped to the list). */
    indexAt(px) {
      const n = h.length;
      if (!n) return 0;
      let pos = 0, rest = px;
      for (let step = 1 << Math.floor(Math.log2(n)); step; step >>= 1) {
        if (pos + step <= n && tree[pos + step] <= rest) { pos += step; rest -= tree[pos]; }
      }
      return Math.min(pos, n - 1);
    },
  });
}
/** The rows to render for a scroll position: [start, end) plus the spacer heights above and below, O(log n). */
export function windowFor(index, { scroll_top, viewport_px, overscan_px = 600 }) {
  if (!index.count) return { start: 0, end: 0, before_px: 0, after_px: 0 };
  const start = index.indexAt(Math.max(0, scroll_top - overscan_px));
  const end = Math.min(index.count, index.indexAt(scroll_top + viewport_px + overscan_px) + 1);
  const total = index.offsetOf(index.count);
  return { start, end, before_px: index.offsetOf(start), after_px: total - index.offsetOf(end) };
}
/** The anchor to log for a scroll position: the first row whose bottom is below scroll_top, and how far its top sits from
 *  the viewport top (negative when it is partly scrolled past), as scrollAnchor's user_scrolled {top_block_id, offset}. */
// `skip(i)`: rows that must never be the anchor because they do not move with the content when rows are prepended above
// them: a "loading older" sentinel at index 0, a sticky head. Anchoring on one holds the page at the top while a whole
// page arrives under it. The first row at or after the scroll position that is not skipped is used.
export function anchorAt(index, scroll_top, idAt, { skip = null } = {}) {
  if (!index.count) return null;
  let i = index.indexAt(scroll_top);
  if (skip) while (i < index.count - 1 && skip(i)) i += 1;
  return { top_block_id: idAt(i), offset: Math.round(index.offsetOf(i) - scroll_top) };
}
/** The scroll_top that puts an anchored row back where it was, after rows above it arrived, left or changed height. */
export function scrollTopFor(index, anchor) {
  const i = anchor ? index.indexOfId(anchor.anchor_id ?? anchor.top_block_id) : -1;
  if (i === -1) return null;
  return Math.max(0, index.offsetOf(i) - (anchor.offset_px ?? anchor.offset ?? 0));
}

/** A gesture's outcome WITHOUT dispatching it: what a drag renders under the pointer before he lets go. */
export function preview(comp, s, name, payload = {}) {
  const r = resolve(comp, s, name, payload);
  return r ? comp.actions[r[0]](s, r[1]) : s;
}

// ---------------------------------------------------------------------------------------------------------------------
/** Every state component, by kind, for vectors and generic tests: the seven ported first, modes, and the four designed
 *  from webchat's overlays, panes, orderings and long lists. */
export const registry = { toggle, modes, listSelect, search, connection, scrollAnchor, documentCursor, undoHistory, modal, splitPane, sort, pagination };

/** Resolve a gesture against a state: [op, payload] or null (nothing to do). An action name is its own gesture. */
export function resolve(comp, state, name, payload = {}) {
  if (comp.gestures?.[name]) return comp.gestures[name](state, payload);
  if (comp.actions[name]) return [name, payload];
  throw new Error(`${comp.kind}: unknown gesture "${name}"`);
}
/** Resolve a gesture against what the replica shows now and dispatch the absolute action. Returns the entry or null. */
export function gesture(replica, comp, name, payload = {}) {
  const r = resolve(comp, replica.get(), name, payload);
  return r ? replica.dispatch(r[0], r[1]) : null;
}

/** A pure component on a quicklook store path (store.component mutates in place): the new slice replaces the old. */
export function inPlace(comp) {
  return {
    initial: comp.initial,
    actions: Object.fromEntries(Object.entries(comp.actions).map(([op, fn]) => [op, (slice, payload) => {
      const next = fn(JSON.parse(JSON.stringify(slice)), payload);
      if (same(next, slice)) return;
      for (const k of Object.keys(slice)) delete slice[k];
      Object.assign(slice, JSON.parse(JSON.stringify(next)));
    }])),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
/** keymap(layers): keys -> gestures, editor-grade. A layer is { when?(ctx) -> bool, keys: { key: binding } } where a
 *  binding is [target, gesture, payload?] or (ctx) => [target, gesture, payload] | null. Layers are tried in order; the
 *  first layer that is active AND binds the key wins (a modal or an insert mode captures by being first with when()).
 *  A layer may set `capture: true`: when active it swallows unbound keys too (text entry).
 *  ctx is whatever the app passes: usually { get(target) -> state, mode }. Returns { target, op, payload } | null | 'captured'. */
export function keymap(layers) {
  for (const l of layers) if (!l || typeof l.keys !== 'object') throw new Error('keymap: each layer needs keys');
  return {
    layers,
    route(key, ctx, comps) {
      for (const l of layers) {
        if (l.when && !l.when(ctx)) continue;
        const b = l.keys[key];
        if (b) {
          const [target, name, payload = {}] = typeof b === 'function' ? (b(ctx) || []) : b;
          if (!target) return null;
          const r = resolve(comps[target], ctx.get(target), name, payload);
          // a bound key that resolves to nothing inside a capturing layer is still that layer's (Escape on a prompt that
          // ignores Escape must not fall through to the page and close the sidebar)
          return r ? { target, op: r[0], payload: r[1] } : l.capture ? 'captured' : null;
        }
        if (l.capture) return 'captured';
      }
      return null;
    },
    /** The same routing from a DOM KeyboardEvent; binding keys are lib/keys.js specs ('mod+z', 'shift+g', 'Escape'). */
    routeEvent(e, ctx, comps, mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '')) {
      for (const l of layers) {
        if (l.when && !l.when(ctx)) continue;
        const spec = Object.keys(l.keys).find((k) => matches(e, parseSpec(k, mac)));
        if (spec) return this.route(spec, ctx, comps);
        if (l.capture) return 'captured';
      }
      return null;
    },
  };
}

/** The declaration for a component (model.js declare): `app.use(declareComponent('conn', connection(), { scope: 'ephemeral' }))`. */
export function declareComponent(name, comp, opts = {}) {
  const life = comp.states ? { states: comp.states, transitions: comp.transitions, terminal: comp.terminal, stateField: comp.stateField } : {};
  return { name, initial: comp.initial, actions: comp.actions, conflict: comp.conflict, ...life, ...opts };
}
