// The chosen microphone, one setting for the whole app rather than one per
// composer. Every chat pane mounts its own DictationMic, and each used to read
// localStorage once at mount and keep its own copy: picking a microphone in one
// chat left every other pane recording on the old one until a reload.
//
// So the choice lives here, with everyone who cares subscribed to it, and the
// browser's own `storage` event carries it between tabs and windows.

import { DEVICE_KEY } from '../core/audio-devices.js';

const LABEL_KEY = 'tophat.dictation.input.label';

const listeners = new Set();
let current;
let listening = false;

function fromStorage() {
  try { return globalThis.localStorage?.getItem(DEVICE_KEY) || null; } catch { return null; }
}

function announce(next) {
  for (const listener of [...listeners]) {
    try { listener(next); } catch {  }
  }
}

function onStorage(event) {
  // A null key is the whole store being cleared, which counts as a change.
  if (event && event.key !== null && event.key !== DEVICE_KEY) return;
  const next = fromStorage();
  if (next === current) return;
  current = next;
  announce(next);
}

/** The microphone he picked, or null for the system default. */
export function preferredMic() {
  if (current === undefined) current = fromStorage();
  return current;
}

/** The name of that microphone, kept because a browser hands out a new
 *  deviceId for the same hardware after a restart. */
export function preferredMicLabel() {
  try { return globalThis.localStorage?.getItem(LABEL_KEY) || ''; } catch { return ''; }
}

/** Pick one, everywhere at once. Returns what was stored. */
export function setPreferredMic(id, label = null) {
  const next = id || null;
  current = next;
  try {
    if (next) globalThis.localStorage?.setItem(DEVICE_KEY, next);
    else globalThis.localStorage?.removeItem(DEVICE_KEY);
    if (!next) globalThis.localStorage?.removeItem(LABEL_KEY);
    else if (label) globalThis.localStorage?.setItem(LABEL_KEY, String(label));
  } catch {  }
  announce(next);
  return next;
}

/** Hear about it when the choice changes anywhere. Returns the unsubscribe. */
export function watchPreferredMic(listener) {
  if (typeof listener !== 'function') return () => {};
  if (current === undefined) current = fromStorage();
  listeners.add(listener);
  if (!listening) {
    listening = true;
    globalThis.addEventListener?.('storage', onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size || !listening) return;
    listening = false;
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

/** Tests only: forget what this module has cached. */
export function resetPreferredMic() {
  current = undefined;
  listeners.clear();
  if (listening) globalThis.removeEventListener?.('storage', onStorage);
  listening = false;
}
