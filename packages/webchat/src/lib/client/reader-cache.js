// What the reader has already fetched, kept on the client.
//
// Opening something is a paint, not a round trip, whenever we can help it. Three rules hold that
// up: a hit comes back synchronously so the caller can render in the same frame; a second request
// for something already in flight joins the first rather than starting another; and an entry that
// has gone stale is served anyway and refreshed behind the screen.
//
// A hover, a pasted link that has not been submitted yet, and the chapter after this one are all
// requests we can pay for before the click, which is why prefetch and load share one map.

const DEFAULT_MAX = 24;
const DEFAULT_FRESH_MS = 45_000;

export function createCache({ max = DEFAULT_MAX, freshMs = DEFAULT_FRESH_MS, now = () => Date.now() } = {}) {
  const entries = new Map();    // key -> { at, value }
  const inflight = new Map();   // key -> promise

  const trim = () => { while (entries.size > max) entries.delete(entries.keys().next().value); };

  /** A hit, with whether it is still fresh; null when there is nothing. Never async. */
  function peek(key) {
    const hit = entries.get(key);
    if (!hit) return null;
    return { value: hit.value, fresh: now() - hit.at <= freshMs, at: hit.at };
  }

  function put(key, value) {
    entries.delete(key);
    entries.set(key, { at: now(), value });
    trim();
    return value;
  }

  /** Run the request unless the same key is already running; the result lands in the cache. */
  function load(key, request) {
    const running = inflight.get(key);
    if (running) return running;
    let promise;
    try {
      promise = Promise.resolve(request());
    } catch (cause) {
      return Promise.reject(cause);
    }
    const tracked = promise.then(
      (value) => { inflight.delete(key); return put(key, value); },
      (cause) => { inflight.delete(key); throw cause; }
    );
    inflight.set(key, tracked);
    return tracked;
  }

  /** Pay for something before it is asked for. Failures here are not the owner's problem. */
  function prefetch(key, request) {
    if (entries.has(key) || inflight.has(key)) return;
    load(key, request).catch(() => {});
  }

  return {
    peek,
    put,
    load,
    prefetch,
    has: (key) => entries.has(key),
    pending: (key) => inflight.has(key),
    drop: (key) => { entries.delete(key); },
    clear: () => { entries.clear(); inflight.clear(); },
    get size() { return entries.size; }
  };
}
