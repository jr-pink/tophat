// The tab's freeze watchdog: the browser half of the server's lag guard (src/lib/server/lag-guard.js).
//
// This module makes the next one name itself, in client-lag.jsonl beside lag.jsonl:
//   * `longtask`: a task (or Long Animation Frame, with per-script attribution: source URL, function,
//     invoker, forced layout time) over LONG_TASK_MS;
//   * `gap`: the tab was visible yet a 1 s timer fired more than GAP_MS late (the thread was held, by
//     anything, whether or not the browser classed it as one long task);
//   * `unreachable`: requests to this server failed or hung for more than GAP_MS (the case on 11-08:
//     the server Mac's Wi-Fi uplink was down, the tab itself was fine);
//   * `capture_slow`: one interaction-capture handler blew its time budget (interaction.js).
// Each record carries the recent call sites noted with noteCall() (capture handlers, flushes) so a
// freeze comes with what ran just before it. Records queue in localStorage, so a reload after a freeze
// still delivers them, and are posted to /api/client-lag.

export const LONG_TASK_MS = 1000;
export const GAP_MS = 5000;
const TICK_MS = 1000;
const RECENT = 40;
const QUEUE_KEY = 'tophat-client-lag-queue';
const QUEUE_MAX = 100;

const recent = [];
let watcher = null;

/** Remember that `label` just ran for `ms` (cheap; a ring of the last 40). */
export function noteCall(label, ms = 0, detail = undefined) {
  recent.push({ at: Date.now(), label, ms: Math.round(ms * 10) / 10, ...(detail ? { detail } : {}) });
  if (recent.length > RECENT) recent.shift();
}
export const recentCalls = () => recent.slice();

/** Report a request to this server: ok or not, how long it took. Feeds the `unreachable` detector. */
export function noteServer(ok, ms, detail = undefined) { watcher?.server(ok, ms, detail); }
/** Queue an arbitrary record (kind must be one the server accepts). */
export function reportClientLag(record) { watcher?.push(record); }

function readQueue(storage) { try { const v = JSON.parse(storage?.getItem(QUEUE_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function writeQueue(storage, queue) { try { if (queue.length) storage?.setItem(QUEUE_KEY, JSON.stringify(queue)); else storage?.removeItem(QUEUE_KEY); } catch { /* full or blocked */ } }

const scriptOf = (s) => ({ invoker: s.invoker, invokerType: s.invokerType, sourceURL: s.sourceURL, sourceFunctionName: s.sourceFunctionName, sourceCharPosition: s.sourceCharPosition, durationMs: Math.round(s.duration), forcedStyleAndLayoutMs: Math.round(s.forcedStyleAndLayoutDuration || 0), pauseMs: Math.round(s.pauseDuration || 0) });

/**
 * Start the watchdog once per tab. Everything the browser provides is injectable for tests.
 * Returns { stop, flush, server, push, tick } (tick and server are exposed for tests).
 */
export function installFreezeWatch({ win = globalThis.window, fetchImpl = (...a) => globalThis.fetch(...a), storage = globalThis.localStorage, now = () => Date.now(), mono = () => win.performance.now(), longTaskMs = LONG_TASK_MS, gapMs = GAP_MS, tickMs = TICK_MS, autoTimers = true } = {}) {
  if (watcher) return watcher;
  const doc = win.document;
  let queue = readQueue(storage);
  let sending = false;
  const base = () => ({ at: new Date(now()).toISOString(), path: win.location?.pathname || null, visible: !doc?.hidden, online: win.navigator?.onLine ?? null, recent: recentCalls() });
  function push(record) {
    queue.push({ ...base(), ...record });
    if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX);
    writeQueue(storage, queue);
    flush();
  }
  async function flush() {
    if (sending || !queue.length) return;
    sending = true;
    const batch = queue.slice(0, 50);
    const started = mono();
    try {
      const response = await fetchImpl('/api/client-lag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records: batch }), keepalive: true });
      if (response.ok) { queue = queue.slice(batch.length); writeQueue(storage, queue); }
      server(response.ok || response.status < 500, mono() - started, { route: 'client-lag', status: response.status });
    } catch (error) {
      server(false, mono() - started, { route: 'client-lag', error: String(error?.message || error).slice(0, 120) });
    } finally { sending = false; }
  }

  // Unreachable: from the first failed/slow request to the next good one.
  let down = null;
  function server(ok, ms, detail) {
    const slow = ms > gapMs;
    if (!ok || slow) {
      if (!down) down = { since: now() - ms, monoSince: mono() - ms, failures: 0, last: null };
      down.failures++; down.last = detail || null;
      if (!ok) return;
    }
    if (down) {
      const durationMs = mono() - down.monoSince;
      const record = { kind: 'unreachable', durationMs: Math.round(durationMs), from: new Date(down.since).toISOString(), failures: down.failures, lastFailure: down.last, recoveredBy: detail || null };
      down = null;
      if (durationMs > gapMs) push(record);
    }
  }

  // Long tasks. Long Animation Frames carry script attribution, so they are preferred where supported.
  const observers = [];
  const supported = win.PerformanceObserver?.supportedEntryTypes || [];
  const loaf = supported.includes('long-animation-frame');
  if (loaf) {
    const po = new win.PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration > longTaskMs) push({ kind: 'longtask', source: 'long-animation-frame', durationMs: Math.round(e.duration), blockingMs: Math.round(e.blockingDuration || 0), startMono: Math.round(e.startTime), renderStartMono: Math.round(e.renderStart || 0), styleAndLayoutStartMono: Math.round(e.styleAndLayoutStart || 0), scripts: (e.scripts || []).slice(0, 20).map(scriptOf) });
    });
    po.observe({ type: 'long-animation-frame', buffered: true }); observers.push(po);
  } else if (supported.includes('longtask')) {
    const po = new win.PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration > longTaskMs) push({ kind: 'longtask', source: 'longtask', durationMs: Math.round(e.duration), startMono: Math.round(e.startTime), attribution: (e.attribution || []).map((a) => ({ name: a.name, containerType: a.containerType, containerName: a.containerName, containerSrc: a.containerSrc, containerId: a.containerId })) });
    });
    po.observe({ type: 'longtask', buffered: true }); observers.push(po);
  }

  // Gap: a 1 s timer that fires late while the tab is visible (hidden tabs are throttled by design).
  let lastMono = mono(), lastWall = now(), wasVisible = !doc?.hidden;
  function tick() {
    const m = mono(), w = now(), visible = !doc?.hidden;
    const late = m - lastMono;
    if (wasVisible && visible && late > gapMs) push({ kind: 'gap', durationMs: Math.round(late), wallMs: w - lastWall, startMono: Math.round(lastMono), detector: 'interval' });
    lastMono = m; lastWall = w; wasVisible = visible;
    if (queue.length) flush();
  }
  const onVisibility = () => { lastMono = mono(); lastWall = now(); wasVisible = !doc.hidden; };
  doc?.addEventListener?.('visibilitychange', onVisibility);
  const timer = autoTimers ? win.setInterval(tick, tickMs) : null;
  if (autoTimers && queue.length) win.setTimeout(flush, 0);

  watcher = {
    loaf, flush, server, push, tick, queue: () => queue.slice(),
    stop() { if (timer) win.clearInterval(timer); observers.forEach((o) => o.disconnect()); doc?.removeEventListener?.('visibilitychange', onVisibility); watcher = null; }
  };
  return watcher;
}
