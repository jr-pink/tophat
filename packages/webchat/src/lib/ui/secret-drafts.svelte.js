// The /secrets forms' drafts for Svelte: the kit's `secretDrafts` family (core/secret-draft-state.js) read as reactive state.
// A component never keeps what he typed; it reads `draft(key).data` and writes `draft(key).patch(...)`. Created lazily, once per
// key per page, and never unsubscribed while the page lives, so closing a form or navigating inside the page keeps the record.
import { uiApp } from '$lib/client/ui-app.js';
import { secretDrafts } from '$lib/core/secret-draft-state.js';
import { draftIsDirty } from '$lib/core/secret-form.js';

let snaps = $state({});          // key -> { data, base }, mirrors each replica
const handles = new Map();

function open(key) {
  let handle = handles.get(key);
  if (handle) return handle;
  const replica = secretDrafts.use(uiApp(), key);
  replica.subscribe((state) => { snaps[key] = { data: state.data, base: state.base }; });
  handle = {
    key,
    get data() { return snaps[key]?.data || {}; },
    get base() { return snaps[key]?.base || {}; },
    get dirty() { return draftIsDirty(snaps[key]?.data, snaps[key]?.base); },
    /** Replace the form (opening it). */
    set(data, base) { replica.dispatch('draft.set', { data, base }); },
    /** One or more fields, as typed. */
    patch(fields) { replica.dispatch('draft.patch', fields); },
    /** Saved or discarded on purpose: the record is removed. */
    clear() { replica.dispatch('draft.clear', {}); },
    /** Write now (before a reload or a close), not on the next tick. */
    flush() { replica.flush(); }
  };
  handles.set(key, handle);
  return handle;
}

export const draft = open;

const inert = { key: null, data: {}, base: {}, dirty: false, set() {}, patch() {}, clear() {}, flush() {} };
/** The handle for `key` if it has been opened, else an inert empty one. Reading never creates state, so it is safe in a $derived
 *  or a template (Svelte forbids writing state there); `draft(key)` is what opens a form, from an event or onMount. */
export const peek = (key) => handles.get(key) || inert;

/** Forms this tab holds a record for, found in its sessionStorage, opened so they are reactive. Call once at mount. */
export function restoreDrafts() {
  let keys = [];
  try { keys = secretDrafts.keys(globalThis.sessionStorage); } catch { keys = []; }
  for (const key of keys) open(key);
  return keys;
}

/** Keys of the forms with unsaved changes right now. */
export function dirtyKeys() {
  return Object.keys(snaps).filter((key) => draftIsDirty(snaps[key]?.data, snaps[key]?.base));
}

/** Test seam: forget every handle (a new page load). */
export function resetDrafts() { handles.clear(); snaps = {}; }
