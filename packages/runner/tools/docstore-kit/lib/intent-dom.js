// The DOM end of the intent record (lib/intent.js): the ONE module that moves DOM focus, and the one set of delegated listeners that turn what the
// browser did into intent transitions. Nothing else in an app calls.focus() or.blur() or keeps a "focused" flag (lint `focus-outside-intent`,
// lib/laws, GUIDE). "a ui needs to track intent in some centralzed way".
//
//   installIntent({ store, root })   store = the app's `use(declare(declareComponent('intent', intent(), ...)))`
//
// The view is a projection with an address (editor law 2): a pane's root carries data-focus-pane="<pane key>", an element
// that can own focus carries data-focus-at="<kind>" or "<kind>:<id>", and the text field inside it (or the element itself, when
// it is an input or textarea) carries data-focus-field. This module reads those, never a component's own refs.
//
//   DOM -> state: pointerdown (press), click on a box's body (click-into-box: focus moves to its field), focusin (an echo),
//                 keydown of a printable key with nothing editable focused (type-to-focus), input / focusout / keyup / pointerup / select (caret).
//   state -> DOM: whenever `pending`, find the address and focus its field, restore the caret, then `applied`. A target that has
//                 not mounted yet (a pane that has just opened) is retried each frame until it exists or the intent changes.
const BOX = 'textarea, input, select, [contenteditable=""], [contenteditable="true"]';
const INTERACTIVE = 'button, a[href], summary, input, textarea, select, label, [role="button"], [role="menuitem"]';
const parseAt = (v) => { const i = String(v).indexOf(':'); return i < 0 ? { kind: String(v), id: null } : { kind: v.slice(0, i), id: v.slice(i + 1) || null }; };
const esc = (v) => (globalThis.CSS?.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));

export const isEditable = (el) => Boolean(el && el.nodeType === 1 && el.matches?.(BOX));
/** The element a key or focus event really came from: a shadow root (an extension's overlay) retargets e.target to its host, which hides the input. */
export const deepTarget = (e) => {
  const inner = e?.composedPath?.()[0];
  return inner && inner.nodeType === 1 ? inner : e?.target;
};
const fieldOf = (el) => (el.matches?.(BOX) ? el : el.querySelector?.('[data-focus-field]') || (el.matches?.('[data-focus-field]') ? el : null));

/** The address a DOM node sits at: { pane, at, inside } or null when it is outside every pane. */
export function addressOf(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  const paneEl = el?.closest?.('[data-focus-pane]');
  if (!paneEl) return null;
  const atEl = el.closest('[data-focus-at]');
  const inPane = atEl && paneEl.contains(atEl);
  return {
    pane: paneEl.dataset.focusPane,
    at: inPane ? parseAt(atEl.dataset.focusAt) : { kind: 'chrome', id: null },
    inside: Boolean(isEditable(el) || el.closest?.(BOX)),
    atEl: inPane ? atEl : null
  };
}

/** The element an address names, inside the pane's root. A composer of no particular chat is the pane's first composer. */
export function findTarget(root, pane, at) {
  const paneEl = root.querySelector(`[data-focus-pane="${esc(pane)}"]`);
  if (!paneEl || !at) return null;
  if (at.id) return paneEl.querySelector(`[data-focus-at="${esc(`${at.kind}:${at.id}`)}"]`) || (at.kind === 'composer' ? paneEl.querySelector('[data-focus-at^="composer"]') : null);
  return paneEl.querySelector(`[data-focus-at="${esc(at.kind)}"], [data-focus-at^="${esc(at.kind)}:"]`);
}

export function installIntent({ store, root = globalThis.document, frame = (fn) => globalThis.requestAnimationFrame(fn), maxFrames = 180 }) {
  const win = root.defaultView || globalThis;
  let applying = 0;

  // ---- state -> DOM: the one place anything is focused
  function apply() {
    const s = store.get();
    if (!s.pending || !s.pane || !s.at) return true;
    const el = findTarget(root, s.pane, s.at);
    const field = el && fieldOf(el);
    if (!field) return false;
    const was = s.seq;
    field.focus({ preventScroll: true });
    if (s.caret && typeof field.setSelectionRange === 'function') { try { field.setSelectionRange(s.caret.start, s.caret.end); } catch { /* a field type with no selection */ } }
    store.dispatch('applied', { seq: was });
    return true;
  }
  function settle() {
    const token = ++applying;
    let left = maxFrames;
    const again = () => {
      if (token !== applying) return;
      if (apply()) return;
      if (--left > 0) frame(again);
    };
    again();
  }
  let lastSeq = -1;
  const unsubscribe = store.subscribe((s) => { if (s.pending && s.seq !== lastSeq) { lastSeq = s.seq; settle(); } });

  // ---- DOM -> state
  const on = (type, fn, opts = true) => { root.addEventListener(type, fn, opts); return () => root.removeEventListener(type, fn, opts); };
  const caretOf = (el) => (el && typeof el.selectionStart === 'number' ? { start: el.selectionStart, end: el.selectionEnd } : undefined);
  const offs = [
    on('pointerdown', (e) => {
      const a = addressOf(e.target);
      if (!a) store.dispatch('leave', {});
      else store.dispatch('press', { pane: a.pane, at: a.at, inside: true }); // the browser focuses a field itself; a box body waits for the click
    }),
    on('click', (e) => {
      const a = addressOf(e.target);
      if (!a || !a.atEl || a.inside || e.target.closest?.(INTERACTIVE)) return;
      const sel = win.getSelection?.();
      if (sel && !sel.isCollapsed) return; // he is selecting words in the box; leave them selected
      if (!fieldOf(a.atEl)) return;
      store.dispatch('press', { pane: a.pane, at: a.at, inside: false });
    }),
    on('focusin', (e) => {
      const a = addressOf(e.target);
      if (!a || !isEditable(e.target)) return;
      store.dispatch('focusin', { pane: a.pane, at: a.at, caret: caretOf(e.target) });
    }),
    on('keydown', (e) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.key?.length !== 1) return;
      const t = deepTarget(e);
      // a key pressed on a button, link or inside a menu or dialog is that control's (Space presses a button), never typing
      if (t?.closest?.(`${INTERACTIVE}, [role="menu"], [role="dialog"], [role="listbox"], [role="combobox"]`) && !isEditable(t)) return;
      const editable = isEditable(t) || t?.isContentEditable === true || t?.closest?.(BOX) != null;
      const before = root.activeElement;
      store.dispatch('typeToFocus', { printable: true, editable });
      // The move happens inside this keydown. Where a browser has already chosen the key's target, the character would be lost
      // with it; the field the record just focused takes it here instead, the same character at its caret.
      const now = root.activeElement;
      if (now !== before && now !== t && (now?.tagName === 'TEXTAREA' || now?.tagName === 'INPUT') && !now.readOnly && !now.disabled) {
        e.preventDefault();
        const a = now.selectionStart ?? now.value.length, b = now.selectionEnd ?? a;
        now.setRangeText(e.key, a, b, 'end');
        now.dispatchEvent(new (win.InputEvent || win.Event)('input', { bubbles: true, data: e.key, inputType: 'insertText' }));
      }
    }),
    // The caret moves with the text too (a fill, a paste, a programmatic insert fire `input`, not keyup) and is read once more as the
    // field gives up focus, so the record never restores a caret from before the words he had typed.
    on('input', (e) => caret(e.target), true),
    on('focusout', (e) => caret(e.target), true),
    on('keyup', (e) => caret(e.target), true),
    on('pointerup', (e) => caret(e.target), true),
    on('select', (e) => caret(e.target), true)
  ];
  function caret(target) {
    const a = addressOf(target);
    if (!a || !isEditable(target)) return;
    const c = caretOf(target);
    if (c) store.dispatch('caret', { pane: a.pane, at: a.at, start: c.start, end: c.end });
  }
  return { settle, stop() { applying = Infinity; unsubscribe?.(); for (const off of offs) off(); } };
}
