// A multiplayer room's client: the app's own session (client/session.js), pointed at one room.
//
// The room tab runs exactly the machinery his chats run: the replica in IndexedDB that paints the
// transcript before the network answers, the chunked fold through core/reducer.js, the cursor and
// the `after` paging, the outbox that keeps a message through a dropped connection, the watchdog
// and the heal ladder. Three things are swapped, the way the incognito session swaps them:
//
//   1. Endpoints. Every request the session makes is rewritten onto the room's own routes under
//      /api/mp/<token>/ (or /api/mp/ for the legacy room), which serve the gated projection of the
//      room conversation in the shapes the app's endpoints use. A request for anything else, an
//      owner-only path, is refused here without touching the network, so no code path in the
//      session can reach his other chats from a room tab.
//   2. Storage. The replica is a database of its own, its outbox and device id are keys of their
//      own, all named by the room token, so a room tab on his own browser neither reads his chats
//      nor replays his queued sends into the room, and two rooms never share a byte.
//   3. Identity. A room tab joins (POST /join) and carries the clientId it is handed on every
//      request; a server that restarted and forgot it is answered by joining again.

import { createSession } from './session.js';
import { createReplica } from '../../../../runner/tools/quicklook-kit/lib/model.js';
import { field, set } from '../../../../runner/tools/quicklook-kit/lib/schema.js';
import { keyed } from '../../../../runner/tools/quicklook-kit/lib/recipes.js';

// The label this tab joins a room under ('owner' or 'anon'), per room, in the tab's storage: the kit's keyed `mp-as`
// family, `durable` (read from and written to the storage on every use, as the old getItem/setItem were). The old
// `tophat-mp-as-<ns>` key is imported once, then archived.
const identities = keyed('mp-as', {
  durable: true,
  fields: { as: field('owner', (v) => (typeof v === 'string' && v ? v : 'owner')) },
  legacy: (ns) => [{ key: `tophat-mp-as-${ns}`, into: 'as', archive: true }],
  actions: { 'as.set': set('as', 'as') }
});
const identityOf = (ns, storage) => createReplica(identities.decl(ns), { storage, device: 'mp' });

/** The room's endpoint prefix: /api/mp/<token>, or /api/mp for the legacy room. */
export const roomApi = (token) => (token ? `/api/mp/${encodeURIComponent(token)}` : '/api/mp');

/** The namespace every stored key of this room lives under. */
export const roomNamespace = (token) => (token ? `t-${token}` : 'legacy');

/** Every storage name a room uses, all derived from its token. */
export function roomStorage(token) {
  const ns = roomNamespace(token);
  return {
    database: `tophat-mp-${ns}`,
    outboxKey: `tophat-mp-outbox-${ns}`,
    deviceKey: `tophat-mp-device-${ns}`,
    identityKey: `tophat-mp-as-${ns}`,
    draftKey: `mp:${ns}`
  };
}

// The app endpoints the session calls, and the room route each becomes. `/api/conversation/<id>`
// keeps the id so the room route can refuse any conversation but its own.
const ROUTES = [
  ['/api/bootstrap', 'bootstrap'],
  ['/api/sync', 'sync'],
  ['/api/events', 'events'],
  ['/api/actions', 'actions']
];

/**
 * `url` as a room session must ask it, or null when the session asked for something a room does
 * not serve (search, files, the week sync, anything of his): the caller refuses those locally.
 */
export function roomUrl(url, { token = null, clientId = null, identity = null } = {}) {
  const text = String(url);
  const api = roomApi(token);
  const [path, query = ''] = text.split('?');
  const params = new URLSearchParams(query);
  if (clientId) params.set('client', clientId);
  // The label this tab joined under, so a server that restarted can take the tab back in as the
  // same participant instead of answering 401 (mp.js adopt).
  if (identity) params.set('as', identity);
  const tail = () => { const q = params.toString(); return q ? `?${q}` : ''; };
  for (const [prefix, route] of ROUTES) {
    if (path === prefix) {
      if (route === 'events') params.set('v', '2');
      return `${api}/${route}${tail()}`;
    }
  }
  const conversation = /^\/api\/conversation\/([^/?]+)$/u.exec(path);
  if (conversation) return `${api}/conversation/${conversation[1]}${tail()}`;
  return null;
}

function refused(url) {
  // A JSON 404 is "the app answered no", which the session treats as a verdict on the request,
  // never as the server being unreachable.
  return new Response(JSON.stringify({ error: `not served in a room: ${String(url).split('?')[0]}` }), {
    status: 404, headers: { 'content-type': 'application/json', 'x-mp-refused': '1' }
  });
}

export function createRoomSession({
  token = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  EventSourceImpl = globalThis.EventSource,
  sessionImpl = createSession,
  storage = () => globalThis.sessionStorage,
  replicaImpl = undefined
} = {}) {
  const api = roomApi(token);
  const names = roomStorage(token);
  const listeners = new Set();
  let info = { conversationId: null, clientId: null, identity: null, participantId: null, authenticated: false, here: [], title: null };
  let joining = null;
  let refusals = 0;

  const publish = () => { for (const listener of listeners) listener(info); };
  const update = (patch) => { info = { ...info, ...patch }; publish(); };

  function wanted() {
    try { return identityOf(roomNamespace(token), storage()).get().as; } catch { return 'owner'; }
  }

  /** Join (or join again): the room hands back this tab's clientId, its label and the conversation. */
  function join(as = wanted()) {
    joining = (async () => {
      const response = await fetchImpl(`${api}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ as })
      });
      if (!response.ok) throw new Error(`join ${response.status}`);
      const body = await response.json();
      try { identityOf(roomNamespace(token), storage()).dispatch('as.set', { as }); } catch { /* a private window */ }
      update({
        conversationId: body.conversationId,
        clientId: body.clientId,
        identity: body.identity,
        participantId: body.participantId ?? null,
        authenticated: Boolean(body.authenticated),
        here: body.here || [],
        title: body.title || null
      });
      return body;
    })();
    joining.catch(() => { joining = null; });
    return joining;
  }

  async function clientId() {
    if (info.clientId) return info.clientId;
    try { await (joining || join()); } catch { /* offline: the request goes out without one */ }
    return info.clientId;
  }

  async function roomFetch(url, init) {
    if (!roomUrl(url)) { refusals += 1; return refused(url); }
    const first = roomUrl(url, { token, clientId: await clientId(), identity: info.identity });
    const response = await fetchImpl(first, init);
    // 401 from the room means it no longer knows this tab (the server restarted): join again
    // and send the same request once more, rather than leave the outbox retrying for ever.
    if (response.status === 401 && String(url).startsWith('/api/actions')) {
      try { await join(); } catch { return response; }
      return fetchImpl(roomUrl(url, { token, clientId: info.clientId, identity: info.identity }), init);
    }
    return response;
  }

  const Source = EventSourceImpl
    ? class RoomEventSource extends EventSourceImpl {
      constructor(url, options) {
        super(roomUrl(url, { token, clientId: info.clientId }) || `${api}/events?v=2`, options);
        // Presence rides the same stream as a named event, so the session's own onmessage never
        // sees it.
        this.addEventListener('here', (message) => {
          try { update({ here: JSON.parse(message.data).here || [] }); } catch { /* malformed */ }
        });
      }
    }
    : null;

  const session = sessionImpl({
    fetchImpl: roomFetch,
    eventSourceImpl: Source,
    replicaImpl,
    replicaOptions: { name: names.database, outboxKey: names.outboxKey },
    deviceKey: names.deviceKey,
    weekSync: false,
    // One conversation lives here; until the room says which, whatever the replica held is it.
    accepts: (id) => !info.conversationId || id === info.conversationId
  });

  let started = null;
  /**
   * Paint from the replica first, then join and catch up. The session reads its last-opened
   * conversation from the room's own database, so a reload shows the transcript before any
   * request has been answered.
   */
  function start() {
    started ??= (async () => {
      const joined = join().catch(() => null);
      await session.start({ hydrate: 0 });
      const body = await joined;
      const id = body?.conversationId || info.conversationId;
      if (id) await session.hydrate(id);
      return id;
    })();
    return started;
  }

  return {
    session,
    start,
    join,
    names,
    api,
    get info() { return info; },
    get refusals() { return refusals; },
    /** Leave and come back under the other label (owner tabs only; the server decides). */
    rejoinAs(as) { try { identityOf(roomNamespace(token), storage()).dispatch('as.set', { as }); } catch { /* ignore */ } },
    subscribe(listener) { listeners.add(listener); listener(info); return () => listeners.delete(listener); }
  };
}
