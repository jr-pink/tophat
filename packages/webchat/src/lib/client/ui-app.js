// The webchat's one docstore-ui-kit app: one device id, the device's localStorage (and, for a state declared
// `storage: 'tab'`, this window's sessionStorage), one save-on-the-way-out hook. Every piece of UI state that must
// survive a reload is `uiApp().use(declaration)`; components never touch storage. Created lazily on first use (never at
// import) so a test can give it a storage first and `resetUiApp()` after.
import { createApp } from '../../../../runner/tools/docstore-kit/lib/model.js';

let app = null, detach = () => {};

// The kit's engine (`createApp({ engine: 'auto' })`, GUIDE 4f) would turn every `scope: 'cloud'` state here, today the
// docs comments (core/docs-state.js), into automatic sync with an IndexedDB copy, for everyone, unverified in the docs
// UI. Off until the cutover: the comments keep the path they have always had (sync when the page asks). A browser opts
// in by hand with localStorage `tophat.ui-engine` = `auto` (read once, when the app is created); pinned by ui-app.test.js.
export const UI_ENGINE_KEY = 'tophat.ui-engine';
export function uiEngineChoice(storage) {
  try { return storage?.getItem(UI_ENGINE_KEY) === 'auto' ? 'auto' : false; } catch { return false; }
}

export function uiApp() {
  if (!app) {
    let storage; try { storage = globalThis.localStorage; } catch { storage = undefined; }
    app = createApp({ storage: storage ?? null, engine: uiEngineChoice(storage) });
    detach = app.attachLifecycle(globalThis);
  }
  return app;
}

export function resetUiApp() { detach(); app = null; detach = () => {}; }
