// Incognito chats, the tab's half (see core/incognito.js for the whole design).
//
// An incognito chat lives in a second client session that is the same code as the app's (client/session.js) with
// three things swapped: its replica is in memory (client/replica.js memoryReplica), never IndexedDB, so nothing of it
// is on the device after the tab goes; its requests go to /api/incognito/* (the server's in-memory store and
// runner) carrying this tab's key; and it accepts only incognito ids, while the app's session accepts everything
// else. The sidebar, cross-chat search, the week sync of the app's replica and share links all read the app's
// session, so an incognito chat is in none of them.
import { createSession } from './session.js';
import { memoryReplica } from './replica.js';
import { normalizeSettings } from '../core/contract.js';
import { incognitoId, isIncognito, newIncognitoTab } from '../core/incognito.js';
import { conversationItems } from '../core/reducer.js';

/** The app endpoints an incognito session talks to, and where each goes instead. */
const ROUTED = ['/api/bootstrap', '/api/sync', '/api/events', '/api/actions', '/api/search', '/api/conversation/'];

/** `url` as the incognito session must ask it: the incognito route, with the tab key. Anything else unchanged. */
export function incognitoUrl(url, tab) {
  const text = String(url);
  const hit = ROUTED.find((prefix) => text.startsWith(prefix)
    && (prefix.endsWith('/') || text.length === prefix.length || text[prefix.length] === '?'));
  if (!hit) return text;
  const routed = `/api/incognito/${text.slice('/api/'.length)}`;
  return `${routed}${routed.includes('?') ? '&' : '?'}tab=${encodeURIComponent(tab)}`;
}

/** Settings for a new incognito chat: the agent he would get anyway, on the direct provider. */
export function incognitoSettings(settings = {}) {
  return normalizeSettings({ ...(settings || {}), provider: 'direct' });
}

export function createIncognitoSession({
  fetchImpl = (...args) => globalThis.fetch(...args),
  EventSourceImpl = globalThis.EventSource,
  tab = newIncognitoTab(),
  sessionImpl = createSession,
  beacon = (url, body) => globalThis.navigator?.sendBeacon?.(url, new Blob([body], { type: 'application/json' })),
} = {}) {
  const Source = EventSourceImpl
    ? class IncognitoEventSource extends EventSourceImpl {
      constructor(url, options) { super(incognitoUrl(url, tab), options); }
    }
    : null;
  const session = sessionImpl({
    replicaImpl: memoryReplica(),
    fetchImpl: (url, init) => fetchImpl(incognitoUrl(url, tab), init),
    eventSourceImpl: Source,
    accepts: isIncognito,
    newIdImpl: () => incognitoId(tab),
  });

  let started = null;
  /** Started on the first incognito chat, so a tab that never opens one holds no stream for it. */
  function start() {
    started ??= session.start({ fullLog: false, hydrate: 0 });
    return started;
  }

  /** Opens `id` (from session.newConversationId) as a new incognito chat, held in this tab until it is used. */
  function open(id, payload = {}) {
    if (!isIncognito(id)) return false;
    return session.createProvisional(id, { ...payload, title: 'Incognito chat', settings: incognitoSettings(payload.settings) });
  }

  /** A new incognito chat: started, opened, and its id returned. */
  async function newChat(payload = {}) {
    await start();
    const id = session.newConversationId();
    open(id, payload);
    return id;
  }

  /** Whether a chat has anything in it a person would miss. */
  function hasContent(id) {
    if (!isIncognito(id) || session.isProvisional(id)) return false;
    return conversationItems(session.state, id).length > 0;
  }

  /** Ends a chat: the server forgets it now (the archive action is a discard there); this tab drops it. */
  function discard(id) {
    if (!isIncognito(id)) return false;
    if (session.isProvisional(id)) return session.discardProvisional(id);
    if (!session.state.conversations[id]) return false;
    session.archive(id, true);
    return true;
  }

  /** Every chat this tab holds that the server knows about. */
  function chats() {
    return Object.keys(session.state.conversations || {}).filter((id) => isIncognito(id) && !session.isProvisional(id)
      && !session.state.conversations[id]?.archived);
  }

  // Leaving the page ends them: a reload or a closed tab must not leave a chat running on the server for the idle
  // sweep to find. A page kept in the back-forward cache is not leaving, so it is not told (event.persisted).
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', (event) => {
      if (event.persisted || !started || !chats().length) return;
      try { beacon('/api/incognito/discard', JSON.stringify({ tab })); } catch { /* best effort; the idle sweep is the backstop */ }
    });
    window.addEventListener('beforeunload', (event) => {
      if (!chats().some(hasContent)) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  return { session, tab, start, open, newChat, discard, hasContent, chats, isIncognito };
}
