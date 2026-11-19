// The app-level INTENT record: where the user's attention is (which pane, which element inside it, the caret or selection in that element)
// and whether the screen has been brought to show it yet.
//
// This is the editor's rule (editor.js: every gesture is one absolute action through the reducer, caret and selection are kit
// state, never the DOM) taken one level up, from "the caret inside one document" to "the focus across the whole app".
//
//   state = { pane, at, caret, pending, seq }
//     pane     the ONE focused pane (a key the app gives it: a chat group, a document), null when focus is outside every pane
//     at       the ONE element inside that pane: { kind, id } (kind 'composer' | 'thread' | 'note' | 'field' are boxes that hold a
//              caret; anything else, 'transcript', 'chrome', is a place that does not), null exactly when pane is null
//     caret    { start, end } inside `at` when it is a box and the browser has said so, else null
//     pending  true while the screen has not been brought to show (pane, at): a transition asked for focus to MOVE (a pane
//              opened, a thread opened, a click on a box's body, typing with nothing focused). `at` is the owner at rest AND
//              the target while pending: there is never a second record naming a different place, so no two writers.
//     seq      counts the transitions that set `pending`, so the one apply effect (intent-dom.js) re-runs for each
//
// Named transitions (each an absolute, pure, total action; a no-op returns the same state object):
//   press {pane, at, inside}          a pointer press. Lands where it landed (pane and element change together). `inside`: on the
//                                     text field itself, which the browser focuses; else a press on a box's body (click-into-box)
//                                     asks for focus to move into the box.
//   focusin {pane, at, caret}         the DOM reports focus landed (a Tab, a programmatic focus, the apply effect's own echo).
//                                     While a transition is pending, an echo from anywhere but its target is ignored: the
//                                     intent stands and the effect makes the screen agree (the old Shift-Enter bug: the old
//                                     box kept DOM focus and the next keystroke went there).
//   caret {pane, at, start, end}      the caret or selection moved inside the owner (ignored for any other element)
//   focus {pane, at}                  code asks for the caret in a box (default the pane's composer)
//   openPane {pane, at}               a pane opened (Shift-Enter, a new chat, a split): focus is carried INTO it, its composer by default
//   closePane {pane, next}            a pane closed: when it held focus, focus moves to `next` (its composer), else out
//   openThread {pane, id}             a side thread opened: its box takes the caret
//   blurThread {pane, id, to}         a side thread was put away: focus goes to `to` (default the pane's composer)
//   typeToFocus {printable, editable} a printable key with nothing editable focused: the owner box takes the keystroke (a pane
//                                     with no box focused offers its composer), so typing is never lost
//   leave {}                          a press outside every pane: no pane is focused
//   applied {seq}                     the screen shows (pane, at): pending ends
//
// Laws (tests/intent.test.js): at rest exactly one owner (`violations` is empty over every reachable state); every transition is
// total and the same reference on a no-op; a pane-open transition carries focus into the new pane and survives a stale echo from
// the old element; the highlight of a thread and the caret are both read from this one record (`threadFocus`, `isOwner`).

export const BOX_KINDS = Object.freeze(['composer', 'thread', 'note', 'field']);
export const isBox = (kind) => BOX_KINDS.includes(kind);

const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const cleanAt = (at) => {
  if (!at || typeof at !== 'object' || Array.isArray(at) || !text(at.kind)) return null;
  const id = text(at.id) ? at.id : null;
  return { kind: at.kind, id };
};
const cleanCaret = (start, end) => {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) return null;
  return start <= end ? { start, end } : { start: end, end: start };
};
const sameAt = (a, b) => (a === null && b === null) || Boolean(a && b && a.kind === b.kind && (a.id ?? null) === (b.id ?? null));
const sameCaret = (a, b) => (a === null && b === null) || Boolean(a && b && a.start === b.start && a.end === b.end);
const composerOf = () => ({ kind: 'composer', id: null });
/** Whether the target `at` names the owner. A composer of no particular chat (id null) names any composer of the pane. */
const names = (target, owner) => sameAt(target, owner) || (target.kind === owner.kind && (target.id === null || owner.id === null) && target.kind === 'composer');

export const INITIAL = Object.freeze({ pane: null, at: null, caret: null, pending: false, seq: 0 });

/** The state `next` over `s`, or `s` itself when nothing differs (the no-op contract). */
function put(s, next) {
  const n = { ...s, ...next };
  return n.pane === s.pane && sameAt(n.at, s.at) && sameCaret(n.caret, s.caret) && n.pending === s.pending && n.seq === s.seq ? s : n;
}
/** Move the owner to (pane, at); a different element starts without a caret. */
function moveTo(s, pane, at, { pending }) {
  const same = s.pane === pane && sameAt(s.at, at);
  const asks = pending && !(same && s.pending); // a repeat of a move already pending is the same move (idempotent)
  return put(s, { pane, at, caret: same ? s.caret : null, pending: pending || (same ? s.pending : false), seq: asks ? s.seq + 1 : s.seq });
}

export const actions = {
  press(s, p) {
    const pane = text(p?.pane) ? p.pane : null, at = cleanAt(p?.at);
    if (!pane || !at) return s;
    const wants = isBox(at.kind) && p.inside !== true;
    return moveTo(s, pane, at, { pending: wants });
  },
  focusin(s, p) {
    const pane = text(p?.pane) ? p.pane : null, at = cleanAt(p?.at);
    if (!pane || !at) return s;
    if (s.pending && !(s.pane === pane && names(s.at, at))) return s; // the intent stands; the apply effect will make the screen agree
    // the echo names the element concretely (a composer of no particular chat becomes this chat's), so it is what is kept
    const caret = cleanCaret(p.caret?.start, p.caret?.end);
    const same = s.pane === pane && sameAt(s.at, at);
    return put(s, { pane, at, caret: isBox(at.kind) ? (caret ?? (same ? s.caret : null)) : null, pending: false });
  },
  caret(s, p) {
    const pane = text(p?.pane) ? p.pane : null, at = cleanAt(p?.at);
    if (!pane || !at || s.pane !== pane || !s.at || !isBox(s.at.kind) || !names(at, s.at)) return s;
    return put(s, { caret: cleanCaret(p.start, p.end) });
  },
  // Programmatic focus: put the caret in (pane, at) (a rejected message back into the composer, a closed lightbox returning focus,
  // Ctrl-H / Ctrl-L stepping a pane). The same move `press` on a box body makes, asked by code instead of a pointer.
  focus(s, p) {
    const pane = text(p?.pane) ? p.pane : null, at = cleanAt(p?.at) || composerOf();
    if (!pane) return s;
    return moveTo(s, pane, at, { pending: isBox(at.kind) });
  },
  openPane(s, p) {
    const pane = text(p?.pane) ? p.pane : null;
    if (!pane) return s;
    return moveTo(s, pane, cleanAt(p.at) || composerOf(), { pending: true });
  },
  closePane(s, p) {
    const pane = text(p?.pane) ? p.pane : null;
    if (!pane || s.pane !== pane) return s;
    const next = text(p.next) && p.next !== pane ? p.next : null;
    if (!next) return put(s, { pane: null, at: null, caret: null, pending: false });
    return moveTo({ ...s, pane: null, at: null, caret: null }, next, composerOf(), { pending: true });
  },
  openThread(s, p) {
    const pane = text(p?.pane) ? p.pane : null;
    if (!pane || !text(p.id)) return s;
    return moveTo(s, pane, { kind: 'thread', id: p.id }, { pending: true });
  },
  blurThread(s, p) {
    const pane = text(p?.pane) ? p.pane : null;
    if (!pane || s.pane !== pane || s.at?.kind !== 'thread' || (text(p.id) && s.at.id !== p.id)) return s;
    const to = cleanAt(p.to) || composerOf();
    return moveTo(s, pane, to, { pending: isBox(to.kind) });
  },
  typeToFocus(s, p) {
    if (p?.printable !== true || p.editable === true || !s.pane) return s;
    if (s.at && isBox(s.at.kind)) return s.pending ? s : moveTo(s, s.pane, s.at, { pending: true });
    return moveTo(s, s.pane, composerOf(), { pending: true });
  },
  leave(s) {
    return put(s, { pane: null, at: null, caret: null, pending: false });
  },
  applied(s, p) {
    return s.pending && Number.isInteger(p?.seq) && p.seq === s.seq ? put(s, { pending: false }) : s;
  }
};

/** The component for the kit's declare path: `declare(declareComponent('intent', intent(), { scope: 'ephemeral' }))`. */
export function intent() {
  return { kind: 'intent', initial: INITIAL, actions, conflict: 'lww' };
}

// ---- reading it: every projection of focus (highlight, caret, ring) is one of these

/** The id of the thread that holds focus in `pane`, else null: the strong passage highlight and the open card read this. */
export const threadFocus = (state, pane) => (state.pane === pane && state.at?.kind === 'thread' ? state.at.id : null);
/** Whether (pane, at) is the owner now. */
export const isOwner = (state, pane, at) => state.pane === pane && Boolean(state.at) && names(cleanAt(at) || { kind: '', id: null }, state.at);
/** Whether `pane` is the focused pane; `fallback` is what a pane says while nothing has been focused yet (the layout's own focused one). */
export const paneActive = (state, pane, fallback = false) => (state.pane === null && state.at === null && state.seq === 0 ? fallback : state.pane === pane);

/** What a pane paints over the passages its threads annotate: every thread faintly (a collapsed one too: its mark opens it), the
 *  focused one strongly, nothing while the pane is not the focused one. */
export function highlightsFor(state, pane, threadIds, { fallback = false } = {}) {
  if (!paneActive(state, pane, fallback)) return { faint: [], strong: [] };
  const id = threadFocus(state, pane);
  const strong = id && threadIds.includes(id) ? [id] : [];
  return { faint: threadIds.filter((t) => !strong.includes(t)), strong };
}

/** Broken invariants of one state (empty at every reachable state). */
export function violations(s) {
  const bad = [];
  if (!s || typeof s !== 'object') return ['not a record'];
  if (s.pane === null && (s.at !== null || s.caret !== null || s.pending)) bad.push('no pane is focused but an element, caret or pending move remains');
  if (s.pane !== null && !text(s.pane)) bad.push('pane is not a key');
  if (s.at !== null && s.pane === null) bad.push('an element without a pane');
  if (s.at !== null && !cleanAt(s.at)) bad.push('element is malformed');
  if (s.caret !== null && !(s.at && isBox(s.at.kind))) bad.push('a caret outside a box');
  if (s.pending && !(s.at && isBox(s.at.kind))) bad.push('a pending move to a place that holds no caret');
  if (!Number.isInteger(s.seq) || s.seq < 0) bad.push('seq is not a count');
  return bad;
}
