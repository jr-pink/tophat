/** Undo for the things he does to a row: Done (archive), set aside, defer, star/pin, mark unread.
 *
 * Before this the reader had one slot that held the last archive for nine seconds and nothing
 * else, and the chat list had no undo at all, so a Done pressed on the wrong row had to be
 * repaired by hand from the archived tray.
 *
 * Three small pieces, all plain JavaScript so they can be unit tested without a browser:
 *
 *   createUndoStack  a last-in-first-out stack of undoable actions. The newest one is also the
 *                    one the bar names, and the bar times out while the stack does not: the
 *                    button is for the gesture he just made, Cmd-Z is for the last few.
 *   isUndoShortcut   Cmd-Z / Ctrl-Z, but never while a text editor holds its own undo history.
 *   createSerialQueue  per-key ordering for optimistic writes, so an undo's write cannot overtake
 *                    the write it is undoing.
 *
 * An entry's `undo` restores only the fields its own action changed. That is what makes the
 * stack compose: starring and then archiving the same row and undoing twice gives back the
 * starred, unarchived row, rather than replaying a whole stale snapshot over it.
 */

// How long the bar names the last action. The stack outlives it; this is only the visible offer.
export const UNDO_TOAST_MS = 9000;
// How many actions Cmd-Z can walk back. Deep enough for a run of Dones, shallow enough that
// nothing from an hour ago is sitting under his fingers.
export const UNDO_DEPTH = 20;

let counter = 0;
const nextId = () => `u${(counter += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * @param {object} [options]
 * @param {number} [options.depth]     how many entries to keep
 * @param {number} [options.toastMs]   how long the bar names the newest one
 * @param {(view: {toast: {id: string, label: string}|null, size: number}) => void} [options.onchange]
 * @param {(fn: () => void, ms: number) => any} [options.schedule]
 * @param {(handle: any) => void} [options.cancel]
 */
export function createUndoStack({
  depth = UNDO_DEPTH,
  toastMs = UNDO_TOAST_MS,
  onchange = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle)
} = {}) {
  /** @type {{id: string, label: string, undo: () => any}[]} */
  const entries = [];
  let toast = null;
  let timer = null;
  // Every undo runs through one chain, so two fast Cmd-Z presses apply newest first and never
  // interleave their awaits.
  let chain = Promise.resolve();

  const view = () => ({ toast: toast ? { id: toast.id, label: toast.label } : null, size: entries.length });
  const emit = () => onchange(view());

  function hideToast() {
    if (timer !== null) cancel(timer);
    timer = null;
    toast = null;
  }

  function show(entry) {
    hideToast();
    toast = entry;
    if (toastMs > 0) {
      timer = schedule(() => {
        timer = null;
        if (toast === entry) { toast = null; emit(); }
      }, toastMs);
    }
  }

  return {
    /** Record something he just did. `label` is what the bar says ("Set aside: The Energies of
     * Men"), `undo` puts it back and may be async.
     *
     * `silent` records the action without saying anything: the entry is on the stack and Cmd-Z
     * reaches it, but no bar appears. Done is pushed this way. A silent action also clears
     * whatever offer was standing, because that offer named an older gesture and pressing Undo on
     * it after a Done would take back the wrong thing.
     */
    push({ label = '', undo, silent = false }) {
      if (typeof undo !== 'function') throw new TypeError('an undo entry needs an undo function');
      const entry = { id: nextId(), label: String(label), undo };
      entries.push(entry);
      while (entries.length > depth) entries.shift();
      if (silent) hideToast();
      else show(entry);
      emit();
      return entry.id;
    },

    /**
     * Undo the newest entry, or the named one (the bar names the entry it is offering, so the
     * button cannot act on something else that landed in between). The entry goes back on the
     * stack if its own write fails, so a blip leaves the offer standing rather than eating it.
     */
    undo(id = null) {
      const at = id ? entries.findIndex((entry) => entry.id === id) : entries.length - 1;
      if (at < 0) return Promise.resolve(null);
      const [entry] = entries.splice(at, 1);
      if (toast === entry) hideToast();
      emit();
      const run = chain.then(() => entry.undo()).then(
        (value) => { emit(); return value; },
        (cause) => { entries.splice(at, 0, entry); emit(); throw cause; }
      );
      chain = run.then(() => {}, () => {});
      return run;
    },

    /**
     * Forget an action without running its undo. The caller pushes the entry the moment the
     * gesture happens, so Cmd-Z works while the write is still in the air; if that write then
     * fails and the row is put back by the failure path, the offer has to go with it.
     */
    remove(id) {
      const at = entries.findIndex((entry) => entry.id === id);
      if (at < 0) return false;
      const [entry] = entries.splice(at, 1);
      if (toast === entry) hideToast();
      emit();
      return true;
    },

    /** Drop the offer without undoing anything; the stack keeps the entry for Cmd-Z. */
    dismiss() {
      if (!toast) return;
      hideToast();
      emit();
    },

    clear() {
      entries.length = 0;
      hideToast();
      emit();
    },

    get toast() { return view().toast; },
    get size() { return entries.length; },
    /** The ids on the stack, oldest first. Tests read this; the UI does not. */
    get ids() { return entries.map((entry) => entry.id); }
  };
}

// Fields he has actually typed in. Emptiness is not enough to decide: a box he filled and then
// cleared still has a typing history, and Cmd-Z there means "give me my sentence back", not
// "unarchive something". Membership is per element and dies with it.
const edited = new WeakSet();

/** Remember that this field has a typing history of its own. */
export function markEdited(node) {
  if (node && typeof node === 'object') edited.add(node);
}

/**
 * Watch one document for typing. Every input event marks its field, so from the first keystroke
 * that field keeps Cmd-Z whatever its value becomes. Capture phase, because a component may
 * stop the event on its way up. Returns the function that stops watching.
 */
export function watchEditedFields(root = (typeof document === 'undefined' ? null : document)) {
  if (!root?.addEventListener) return () => {};
  const onInput = (event) => markEdited(event.target);
  root.addEventListener('beforeinput', onInput, true);
  root.addEventListener('input', onInput, true);
  return () => {
    root.removeEventListener('beforeinput', onInput, true);
    root.removeEventListener('input', onInput, true);
  };
}

/**
 * Does the focused element own Cmd-Z? Any rich editor does, and so does any field he has typed
 * into, whether or not there is still text in it. A field that merely took the caret by itself
 * does not: the reader's add-a-link box and the chat composer both autofocus, and an undo that
 * only worked after clicking elsewhere would not be an undo. Same reading as Cmd-E, which
 * already acts on the hovered row while that field is untouched.
 */
export function editorHoldsUndo(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return edited.has(target) || String(target.value ?? '').length > 0;
  return false;
}

/** Cmd-Z on a Mac, Ctrl-Z elsewhere; Shift-Cmd-Z is redo and is left alone. */
export function isUndoShortcut(event) {
  if (!event || event.isComposing || event.repeat) return false;
  if (String(event.key || '').toLowerCase() !== 'z') return false;
  if (event.shiftKey || event.altKey) return false;
  if (event.metaKey === event.ctrlKey) return false;   // neither, or the two together
  return !editorHoldsUndo(event.target);
}

/**
 * Writes that must not overtake each other. Keyed by the thing being written to, usually a row
 * id: an optimistic PATCH and the PATCH that undoes it are two round trips to the same row, and
 * sent at once the server can apply them in either order. A task runs after everything already
 * queued for its key has settled, failed or not.
 */
export function createSerialQueue() {
  const tails = new Map();
  return function serial(key, task) {
    const prior = tails.get(key) || Promise.resolve();
    const run = prior.then(() => task(), () => task());
    const settled = run.then(() => {}, () => {});
    tails.set(key, settled);
    settled.then(() => { if (tails.get(key) === settled) tails.delete(key); });
    return run;
  };
}
