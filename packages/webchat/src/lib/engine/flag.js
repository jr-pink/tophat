// Which chat core a tab runs. this module only reads it, and it holds across tabs and reloads). Only the app's own session is ever
// switched: an incognito session, a multiplayer room and a test that injects its own replica, fetch or EventSource always get the
// legacy session.
import { declare } from '../../../../runner/tools/quicklook-kit/lib/model.js';
import { uiApp } from '../client/ui-app.js';

export const ENGINE_FLAG_KEY = 'tophat:engine';

// A `?engine=` choice holds for the rest of the tab (full page loads included: /reader and back keeps the engine), as a
// kit state in this tab's sessionStorage; a new tab starts from the localStorage key again.
const choiceDecl = declare({ name: 'engine-choice', scope: 'local', storage: 'tab', initial: { core: null },
  actions: { 'core.set': (s, { core }) => (s.core === core || !['docstore', 'legacy', null].includes(core) ? s : { core }) } });

export function engineSelected({ win = globalThis.window, storage = globalThis.localStorage, app = null } = {}) {
  if (!win) return false;
  try {
    const choice = (app || uiApp()).use(choiceDecl);
    const asked = new URLSearchParams(win.location?.search || '').get('engine');
    if (asked === 'docstore' || asked === 'legacy') { choice.dispatch('core.set', { core: asked }); choice.flush?.(); return asked === 'docstore'; }
    if (choice.get().core) return choice.get().core === 'docstore';
    const saved = storage?.getItem(ENGINE_FLAG_KEY);
    if (saved === 'legacy') return false;
    if (saved === 'docstore') return true;
    return Boolean(win.indexedDB);   // the engine keeps its store in IndexedDB; without it the old session is the only one that can run
  } catch { return false; }
}

/** True for the app's own session only (no injected seams, no other replica, the default accepts). */
export function isAppSession(options = {}) {
  const { fetchImpl, replicaImpl, eventSourceImpl, replicaOptions, accepts, deviceKey } = options;
  return !fetchImpl && !replicaImpl && eventSourceImpl === undefined && !replicaOptions && !accepts && (deviceKey === undefined || deviceKey === 'tophat-webchat-device');
}
