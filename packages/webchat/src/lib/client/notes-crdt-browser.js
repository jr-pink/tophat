// Loads Automerge (slim build) with its WebAssembly as a hashed build asset, so the service worker
// precaches it with the rest of the shell and the notes app still opens with the server down.
// `notes-crdt.js` stays pure; this is the one place the browser's module is handed to it.
import * as Automerge from '@automerge/automerge/slim';
import wasmUrl from '@automerge/automerge/automerge.wasm?url';
import { automergeReady, useAutomerge } from '$lib/core/notes-crdt.js';

let loading = null;

/** Resolves true when documents can be made and merged, false when the WebAssembly would not load. */
export function loadCrdt() {
  if (automergeReady()) return Promise.resolve(true);
  loading ||= Automerge.initializeWasm(wasmUrl).then(() => { useAutomerge(Automerge); return true; }).catch(() => { loading = null; return false; });
  return loading;
}
