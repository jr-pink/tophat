// Deadline classes with latest-wins supersede (Docstore3 A9, perf doctrine rule 8). Every network call an engine makes
// carries the deadline of its class, and a newer request with the same key aborts a stalled older one, so a dead request can
// never sit in front of the live ones. the owner's rule exempts model calls (no wall-clock bound on a still-streaming
// model); do not route them here.
//
//   const net = createDeadlineFetch(fetch)                        // or { deadlines: { ...DEADLINE_MS, mine: 5000 } }
//   const r = await net.fetchWithin('send', '/api/x', { method: 'POST', body }, { key: `send:${id}` })
//   const page = await net.within('pull', (signal) => transport.pull(stream, cursor, { signal }), { key: `pull:${stream}` })
//
// A deadline abort surfaces as a rejected promise whose error has `name === 'DeadlineError'` (or 'SupersededError'),
// so the caller treats it exactly like a transport failure: a durable outbox keeps the action and retries it under
// the same id.

export const DEADLINE_MS = Object.freeze({
  send: 15_000,      // an outbox flush (one action or one batch)
  push: 15_000,      // Stream push
  pull: 20_000,      // Stream pull / a delta
  read: 20_000,      // reading one object or page
  bulk: 30_000,      // a snapshot or a background fill page
  search: 8_000,     // server search (an offline index answers past it)
  file: 15_000,      // a file or blob
  telemetry: 10_000  // the telemetry lane's flush (its own lane, never the outbox's)
});

export class DeadlineError extends Error {
  constructor(klass, ms) { super(`${klass} deadline ${ms} ms`); this.name = 'DeadlineError'; this.klass = klass; }
}
export class SupersededError extends Error {
  constructor(key) { super(`superseded: ${key}`); this.name = 'SupersededError'; this.key = key; }
}

export function createDeadlineFetch(fetchImpl = (url, init) => globalThis.fetch(url, { ...init, signal: init?.signal }), { deadlines = DEADLINE_MS, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() } = {}) {
  const latest = new Map(); // key -> AbortController of the current holder
  const stats = {};
  const statFor = (klass) => (stats[klass] ||= { started: 0, ok: 0, deadline: 0, superseded: 0, failed: 0, slowestMs: 0 });

  /** Run `fn(signal)` under the class deadline; `key` makes it latest-wins. */
  async function within(klass, fn, { key = null } = {}) {
    const ms = deadlines[klass];
    if (!Number.isFinite(ms)) throw new TypeError(`no deadline class ${klass}`);
    const stat = statFor(klass);
    stat.started += 1;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (key) {
      const prior = latest.get(key);
      if (prior) { prior.reason = 'superseded'; try { prior.abort(); } catch { /* gone */ } }
      if (controller) latest.set(key, controller);
    }
    let timedOut = false;
    const started = now();
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimer(() => {
        timedOut = true;
        try { controller?.abort(); } catch { /* gone */ }
        reject(new DeadlineError(klass, ms));
      }, ms);
      timer?.unref?.();
    });
    deadline.catch(() => {});
    const superseded = new Promise((_, reject) => { controller?.signal?.addEventListener?.('abort', () => { if (controller.reason === 'superseded') reject(new SupersededError(key)); }); });
    superseded.catch(() => {});
    try {
      const result = await Promise.race([fn(controller?.signal), deadline, superseded]);
      stat.ok += 1;
      stat.slowestMs = Math.max(stat.slowestMs, now() - started);
      return result;
    } catch (cause) {
      if (timedOut) { stat.deadline += 1; throw cause instanceof DeadlineError ? cause : new DeadlineError(klass, ms); }
      if (controller?.reason === 'superseded') { stat.superseded += 1; throw new SupersededError(key); }
      stat.failed += 1;
      throw cause;
    } finally {
      clearTimer(timer);
      if (key && latest.get(key) === controller) latest.delete(key);
    }
  }

  const fetchWithin = (klass, url, init = {}, options = {}) => within(klass, (signal) => fetchImpl(url, { ...init, ...(signal ? { signal } : {}) }), options);
  return { within, fetchWithin, stats: () => JSON.parse(JSON.stringify(stats)) };
}
