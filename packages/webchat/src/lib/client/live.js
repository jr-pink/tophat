// The tab's end of the live feed (src/lib/server/live-feed.js, /api/live): one EventSource per tab,
// shared by every page that wants to hear that a store changed, and the tab's own id, which its
// writes carry in `x-tophat-client` so it can skip its own echoes.
//
// Losing the stream costs nothing but freshness: the page keeps working from its local copy. The
// browser reconnects by itself after a network drop (sending Last-Event-ID); a stream the server
// refused or answered with an error page is closed for good by the browser, so this reopens it with
// backoff, at once on `online`, and on the tab coming back, which is also when a phone's stream is
// most likely to be silently dead. The server then replays what was missed or sends `resync`.

const backoff = [1000, 2000, 5000, 10_000, 30_000];
const STALE_AFTER_HIDDEN_MS = 10_000;

function randomId() {
  try {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    return `tab_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch { return `tab_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`; }
}

let tabId = null;
/** This tab's id; every write it makes names it. */
export function liveClientId() {
  if (!tabId) tabId = randomId();
  return tabId;
}
/** Headers that attribute a write to this tab. */
export const liveHeaders = (headers = {}) => ({ ...headers, 'x-tophat-client': liveClientId() });

/**
 * A connection with topic listeners. `listener(event)` gets `{topic, cursor, origin}` for another
 * tab's (or the server's) change and `{topic, resync: true}` when the gap could not be replayed.
 * Exported as a factory for the tests; pages use `liveSubscribe`.
 */
export function createLiveConnection({
  url = '/api/live',
  EventSourceImpl = globalThis.EventSource,
  win = globalThis.window,
  doc = globalThis.document,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
  now = () => Date.now(),
  self = liveClientId
} = {}) {
  const listeners = new Map();
  let source = null;
  let cursor = null;
  let retryTimer = null;
  let attempt = 0;
  let hiddenAt = 0;
  const status = { connected: false, events: 0, resyncs: 0, opens: 0 };

  const dispatch = (topic, event) => {
    for (const fn of listeners.get(topic) || []) { try { fn(event); } catch { /* one page's bug */ } }
  };

  function onMessage(message) {
    let payload;
    try { payload = JSON.parse(message.data); } catch { return; }
    if (payload.cursor) cursor = payload.cursor;
    if (payload.hello) { status.connected = true; attempt = 0; return; }
    if (payload.resync) {
      status.resyncs += 1;
      for (const topic of listeners.keys()) dispatch(topic, { topic, resync: true, cursor: payload.cursor });
      return;
    }
    if (!payload.topic) return;
    if (payload.origin && payload.origin === self()) return;
    status.events += 1;
    dispatch(payload.topic, payload);
  }

  function close() {
    if (source) { try { source.close(); } catch { /* gone */ } }
    source = null;
    status.connected = false;
  }

  function open() {
    clearTimer?.(retryTimer);
    retryTimer = null;
    if (!EventSourceImpl || !listeners.size) return;
    close();
    const topics = [...listeners.keys()].join(',');
    const query = new URLSearchParams({ topics });
    if (cursor) query.set('after', cursor);
    let es;
    // A url may carry its own query (a document's stream names the tab and its author there).
    try { es = new EventSourceImpl(`${url}${url.includes('?') ? '&' : '?'}${query}`); } catch { schedule(); return; }
    source = es;
    status.opens += 1;
    es.onmessage = onMessage;
    es.onerror = () => {
      if (source !== es) return;
      status.connected = false;
      // CONNECTING means the browser is retrying by itself; CLOSED means it gave up.
      if (es.readyState === 2) { source = null; schedule(); }
    };
  }

  function schedule() {
    if (retryTimer !== null || !listeners.size) return;
    const wait = backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    retryTimer = setTimer?.(() => { retryTimer = null; open(); }, wait) ?? null;
  }

  const onOnline = () => { attempt = 0; open(); };
  const onVisibility = () => {
    if (doc?.visibilityState === 'hidden') { hiddenAt = now(); return; }
    const away = hiddenAt ? now() - hiddenAt : 0;
    hiddenAt = 0;
    if (!source || away >= STALE_AFTER_HIDDEN_MS) { attempt = 0; open(); }
  };

  function start() {
    win?.addEventListener?.('online', onOnline);
    doc?.addEventListener?.('visibilitychange', onVisibility);
    open();
  }
  function stop() {
    clearTimer?.(retryTimer);
    retryTimer = null;
    win?.removeEventListener?.('online', onOnline);
    doc?.removeEventListener?.('visibilitychange', onVisibility);
    close();
  }

  function subscribe(topic, fn) {
    const first = listeners.size === 0;
    const known = listeners.has(topic);
    if (!known) listeners.set(topic, new Set());
    listeners.get(topic).add(fn);
    if (first) start();
    else if (!known) open();   // a new topic needs a stream that asks for it
    return () => {
      const set = listeners.get(topic);
      set?.delete(fn);
      if (set && !set.size) listeners.delete(topic);
      if (!listeners.size) stop();
    };
  }

  return { subscribe, status: () => ({ ...status, cursor, open: Boolean(source) }), _message: onMessage, _reopen: open };
}

let shared = null;
/** Listen for changes to `topic` from other tabs and devices; returns the unsubscribe. */
export function liveSubscribe(topic, fn) {
  if (typeof globalThis.EventSource === 'undefined') return () => {};
  if (!shared) shared = createLiveConnection();
  return shared.subscribe(topic, fn);
}
/** For the harness and the checks: what the shared connection has seen. */
export const liveStatus = () => shared?.status() ?? null;
