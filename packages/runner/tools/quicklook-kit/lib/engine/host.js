// One state engine per browser, tabs as views (Docstore3 section 8, perf doctrine rule 12).
//
// Engine side: `serveEngine({ methods, view, status, subscribe })` accepts MessagePorts. A port that says hello
// gets a snapshot; every change after it is one patch (patch.js), coalesced to at most one per task, broadcast to
// every port. A call is `{t:'call', id, m, a}` and gets `{t:'ret', id, ok, v | e}`.
// `workerMain(makeServer)` is the worker entry: SharedWorker `connect` ports, or a dedicated Worker handed ports.
//
// Tab side: `connectEngine({ name, shared, dedicated, local })` picks the transport in this order and says which in
// `client.kind`:
//   'shared'   a SharedWorker (desktop browsers, Safari 16+);
//   'leader'   Web Locks leader election where SharedWorker is missing (Chrome on Android): the tab holding the
//              lock runs the engine in a dedicated Worker and relays other tabs over a BroadcastChannel; when it
//              closes, the next tab in the lock queue takes over and every tab re-joins and gets a fresh snapshot;
//   'worker'   a dedicated Worker per tab (no Web Locks);
//   'local'    the engine on this thread (no Worker at all; tests).
// Calls not answered when the transport changes are re-sent, so engine methods must be idempotent by an id the tab
// minted (a ULID per intent: the outbox dedupes on it).
//
//   const client = connectEngine({ name: 'notes', shared: () => new SharedWorker(url, { type: 'module', name: 'notes' }),
//     dedicated: () => new Worker(url, { type: 'module' }), local: () => makeServer() })
//   client.subscribe((state, status) => render(state)); await client.call('add', { id: ulid(), text })

import { apply, diff } from './patch.js';
import { ulid } from './ulid.js';

const randomId = () => { try { const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); } catch { return Math.random().toString(16).slice(2); } };
const errorOf = (cause) => ({ name: cause?.name || 'Error', message: String(cause?.message || cause), code: cause?.code ?? null });
const onMessage = (port, fn) => { if (port.addEventListener) { port.addEventListener('message', fn); port.start?.(); } else port.onmessage = fn; };

export function serveEngine({ methods, view, status = () => null, subscribe, diffOptions = {}, schedule = (f) => setTimeout(f, 0) }) {
  const ports = new Set();
  let last = view();
  let lastStatus = status();
  let rev = 0;
  // a snapshot and every patch carry (epoch, rev): rev counts within one engine incarnation, the epoch names the
  // incarnation, so a tab never applies a patch derived from another engine's state (a leader change restarts rev at 0)
  const epoch = ulid();
  let queued = false;
  const counts = { patches: 0, snapshots: 0, calls: 0, ports: 0 };

  function flush() {
    queued = false;
    const next = view();
    const nextStatus = status();
    const p = diff(last, next, diffOptions);
    const statusChanged = nextStatus !== lastStatus;
    if (!p && !statusChanged) return;
    const from = rev;
    rev += 1;
    last = next;
    lastStatus = nextStatus;
    counts.patches += 1;
    for (const port of ports) { try { port.postMessage({ t: 'patch', epoch, from, to: rev, p, status: statusChanged ? nextStatus : undefined }); } catch { ports.delete(port); } }
  }
  const dirty = () => { if (!queued) { queued = true; schedule(flush); } };
  subscribe?.(dirty);

  function connect(port) {
    counts.ports += 1;
    onMessage(port, async (event) => {
      const msg = event.data || {};
      if (msg.t === 'hello') {
        if (queued) flush();
        ports.add(port);
        counts.snapshots += 1;
        port.postMessage({ t: 'snap', epoch, rev, state: last, status: lastStatus });
        return;
      }
      if (msg.t === 'bye') { ports.delete(port); return; }
      if (msg.t !== 'call') return;
      counts.calls += 1;
      const fn = methods[msg.m];
      try {
        if (typeof fn !== 'function') throw Object.assign(new Error(`no method ${msg.m}`), { name: 'NoMethod' });
        const v = await fn(...(msg.a || []), { tab: msg.tab ?? null });
        if (queued) flush(); // the caller sees its own effect before its promise resolves
        port.postMessage({ t: 'ret', id: msg.id, ok: true, v });
      } catch (cause) { port.postMessage({ t: 'ret', id: msg.id, ok: false, e: errorOf(cause) }); }
    });
  }
  return { connect, flush, epoch, stats: () => ({ ...counts, epoch, rev, ports: ports.size }) };
}

/** A MessageChannel-shaped pair that delivers in microtasks (structured clone kept): deterministic under fake timers. */
export function microtaskChannel() {
  const make = () => ({ listeners: new Set(), onmessage: null, other: null,
    postMessage(data) { const to = this.other; const copy = structuredClone(data); queueMicrotask(() => { to.onmessage?.({ data: copy }); for (const l of to.listeners) l({ data: copy }); }); },
    addEventListener(type, fn) { if (type === 'message') this.listeners.add(fn); }, start() {}, close() { this.listeners.clear(); this.onmessage = null; } });
  const port1 = make(), port2 = make();
  port1.other = port2; port2.other = port1;
  return { port1, port2 };
}

/** Worker entry. `makeServer()` is called once, on the first port. */
export function workerMain(makeServer, scope = globalThis) {
  let server = null;
  const get = () => (server ||= makeServer());
  if ('onconnect' in scope) scope.onconnect = (e) => { for (const p of e.ports) get().connect(p); };
  scope.addEventListener?.('message', (e) => { if (e.data?.t === 'port') for (const p of e.ports || []) get().connect(p); });
}

/** A port pair onto an in-thread server (the 'local' transport, and what the leader tab uses for itself). */
function localPort(server, channel = () => new MessageChannel()) {
  const ch = channel();
  server.connect(ch.port1);
  return ch.port2;
}
function workerPort(worker, channel = () => new MessageChannel()) {
  const ch = channel();
  worker.postMessage({ t: 'port' }, [ch.port1]);
  return ch.port2;
}

export function connectEngine({ name, shared = null, dedicated = null, local = null, prefer = null, nav = globalThis.navigator,
  Broadcast = globalThis.BroadcastChannel, hasShared = typeof globalThis.SharedWorker === 'function', hasWorker = typeof globalThis.Worker === 'function',
  channel = () => new MessageChannel() }) {
  const tab = randomId();
  const subs = new Set();
  const pending = new Map(); // id -> { m, a, resolve, reject }
  let state = null, status = null, rev = -1, epoch = null, kind = null, send = null;
  let readyResolve; const ready = new Promise((r) => { readyResolve = r; });
  const counts = { snaps: 0, patches: 0, resyncs: 0, applyMs: 0, worstApplyMs: 0, rejoins: 0 };
  const clock = () => (globalThis.performance?.now?.() ?? Date.now());
  let closeLeader = () => {};

  function receive(msg) {
    if (msg.t === 'snap') {
      state = msg.state; status = msg.status; rev = msg.rev; epoch = msg.epoch ?? null; counts.snaps += 1;
      notify(); readyResolve(); return;
    }
    if (msg.t === 'patch') {
      // a patch applies only to the snapshot it was derived from: same engine epoch, from === our rev; anything else
      // is a stale projection, and the tab asks for a fresh snapshot instead of patching the wrong state
      if ((msg.epoch ?? null) !== epoch) { counts.resyncs += 1; send({ t: 'hello', tab }); return; }
      if (msg.from !== rev) { if (msg.to > rev) { counts.resyncs += 1; send({ t: 'hello', tab }); } return; }
      const t0 = clock();
      state = apply(state, msg.p);
      if (msg.status !== undefined) status = msg.status;
      rev = msg.to;
      const ms = clock() - t0;
      counts.patches += 1; counts.applyMs += ms; counts.worstApplyMs = Math.max(counts.worstApplyMs, ms);
      notify(); return;
    }
    if (msg.t === 'ret') {
      const call = pending.get(msg.id);
      if (!call) return;
      pending.delete(msg.id);
      if (msg.ok) call.resolve(msg.v); else call.reject(Object.assign(new Error(msg.e?.message), msg.e || {}));
    }
  }
  function notify() { for (const fn of subs) { try { fn(state, status); } catch { /* one view */ } } }

  function attach(post, k) {
    kind = k;
    send = post;
    send({ t: 'hello', tab });
    for (const [id, call] of pending) send({ t: 'call', id, m: call.m, a: call.a, tab });
  }
  const portSender = (port) => { onMessage(port, (e) => receive(e.data || {})); return (msg) => port.postMessage(msg); };

  const order = prefer ? [prefer] : ['shared', 'leader', 'worker', 'local'];
  for (const k of order) {
    try {
      if (k === 'shared' && hasShared && shared) { const sw = shared(); attach(portSender(sw.port), 'shared'); break; }
      if (k === 'leader' && nav?.locks?.request && Broadcast && (dedicated || local)) { leader(); break; }
      if (k === 'worker' && hasWorker && dedicated) { attach(portSender(workerPort(dedicated(), channel)), 'worker'); break; }
      if (k === 'local' && local) { attach(portSender(localPort(local(), channel)), 'local'); break; }
    } catch { /* next transport */ }
  }
  if (!send) throw new Error('connectEngine: no transport available');

  function leader() {
    const bc = new Broadcast(`qk-engine:${name}`);
    let release = () => {};
    closeLeader = () => { try { bc.close(); } catch { /* gone */ } release(); };
    let leading = false;
    const relays = new Map(); // follower tab -> port onto the engine
    let makePort = null;
    bc.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'leader' && !leading) { counts.rejoins += 1; bc.postMessage({ t: 'join', tab }); attach((msg) => bc.postMessage({ t: 'up', from: tab, msg }), 'leader'); return; }
      if (m.t === 'down' && m.to === tab && !leading) { receive(m.msg); return; }
      if (!leading) return;
      if (m.t === 'join' && m.tab !== tab) {
        relays.get(m.tab)?.close?.();
        const port = makePort();
        onMessage(port, (ev) => bc.postMessage({ t: 'down', to: m.tab, msg: ev.data }));
        relays.set(m.tab, port);
        return;
      }
      if (m.t === 'up' && relays.has(m.from)) relays.get(m.from).postMessage(m.msg);
    };
    // A follower until the lock is ours: relay through whoever leads.
    // join first: the leader opens this tab's relay before the hello that rides it (one sender's messages stay in order)
    bc.postMessage({ t: 'join', tab });
    attach((msg) => bc.postMessage({ t: 'up', from: tab, msg }), 'leader');
    nav.locks.request(`qk-engine:${name}`, () => new Promise((resolve) => {
      release = resolve; // the lock is held until this tab closes (or close() is called)
      leading = true;
      let server = null;
      makePort = dedicated && hasWorker ? (() => { const w = dedicated(); return () => workerPort(w, channel); })() : () => localPort(server ||= local(), channel);
      attach(portSender(makePort()), 'leader');
      bc.postMessage({ t: 'leader', tab });
    }));
  }

  return {
    tab,
    get kind() { return kind; },
    ready,
    state: () => state,
    status: () => status,
    subscribe(fn) { subs.add(fn); if (state) fn(state, status); return () => subs.delete(fn); },
    call(m, ...a) {
      const id = ulid(); // one intent id per call, minted once; a call re-sent after a transport change keeps it
      return new Promise((resolve, reject) => { pending.set(id, { m, a, resolve, reject }); send({ t: 'call', id, m, a, tab }); });
    },
    stats: () => ({ ...counts, pending: pending.size, rev, kind }),
    /** Leave: say bye to the engine, and as a leader give the lock to the next tab. */
    close() { try { send?.({ t: 'bye', tab }); } catch { /* gone */ } closeLeader(); subs.clear(); }
  };
}
