// The browser end of the focus record: the one store, and the one DOM-apply effect installed over it (kit lib/intent-dom.js).
// Idempotent: any surface (chat page, public document) asks for it and gets the same store with the owner installed once.
import { installIntent } from '../../../../runner/tools/docstore-kit/lib/intent-dom.js';
import { intentDecl } from '$lib/core/intent-state.js';
import { uiApp } from './ui-app.js';

let owner = null;
export function intentStore() {
  const store = uiApp().use(intentDecl);
  if (!owner && typeof document !== 'undefined') owner = installIntent({ store, root: document });
  return store;
}
/** Test seam: drop the installed owner (its listeners) with the app. */
export function resetIntent() { owner?.stop(); owner = null; }
