// Peer hosting: a chat lives on one host, the peer whose runner answers it (hosts.js lists the peers, the conversation's
// `host` names one, null is this machine). This server stays the front end for every chat; for a chat hosted on a peer it
// attaches to that peer's live event stream and writes what arrives into its own log, so the local UI streams tokens, thinking,
// tool input and run state exactly as for a local run, the transcript reads offline, and a restart resumes from the stored cursor.
//
// How a turn runs. wrap(runner) returns the runner with send/interrupt/isBusy/phase/warm decided per conversation. A send to a
// chat whose host is a peer writes the owner's message into the local log, then forwards it over the peer's machine surface
// (/api/agent: spawn for the first message, send after), seeded with the transcript the peer has not seen. The chat's events
// then arrive on one held-open stream per chat (/api/agent op events, conversation-stream.js: the frames /api/events carries,
// narrowed to the chat, resumable by cursor) and are appended locally as they come.
//
// Rules the module holds: only a chat whose host is a peer goes remote (never by content: choosing a host is the user's, or the
// router's with confirmation); a chat mid-run is not moved mid-turn; an unreachable peer is a visible "offline" state with the
// message kept and re-sent, never a hang and never a silent local run; every routing decision is logged (remote-routing.jsonl).

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { webchatStorePath } from './paths.js';
import { loadRuntimes } from './hosts.js';

const TWINS = () => webchatStorePath('remote-twins.json');
const DECISIONS = () => webchatStorePath('remote-routing.jsonl');

export const TICK_MS = 5_000;
export const CALL_TIMEOUT_MS = 8_000;
export const STREAM_IDLE_MS = 60_000; // the host pings every 20 s (sse.js): silence this long is a dead connection
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;
export const CONFIG_TTL_MS = 10_000;
export const SEED_CHARS = 24_000;

// What a run writes that a viewer renders. Conversation bookkeeping (created, renamed, workspace, host) and the host's own
// background-agent events stay on the host.
const MIRRORED = new Set(['assistant.delta', 'assistant.message', 'thinking.delta', 'tool.started', 'tool.input_delta', 'tool.completed',
  'context.compacted', 'run.status']);
const TERMINAL = new Set(['run.completed', 'run.error', 'run.cancelled']);

/** One line in the routing log (the same file the bridge writes), for decisions made outside it (the host router). */
export function logDecision(entry, path = DECISIONS()) {
  try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch { /* the console line stands */ }
}

/** The earlier conversation as plain text, from events after `after`, never the message being sent. Tail-capped. */
export function seedTranscript(events, { after = 0, exclude = null, cap = SEED_CHARS } = {}) {
  const lines = [];
  for (const e of events) {
    if (e.cursor <= after) continue;
    const c = e.content || {};
    if (exclude && c.itemId === exclude) continue;
    if (e.kind === 'message.user' && c.text) lines.push(`Owner: ${String(c.text).trim()}`);
    else if (e.kind === 'assistant.message' && c.text && !c.agentId) lines.push(`Assistant: ${String(c.text).trim()}`);
  }
  let text = lines.join('\n\n');
  if (text.length > cap) text = `[earlier part cut]\n${text.slice(text.length - cap)}`;
  return text;
}

/** The message as sent to the runtime that has not seen part of the chat: the missed transcript first, then the message. */
export function withSeed(seed, wire, where) {
  if (!seed) return wire;
  return `[Earlier in this chat, which ran ${where}. Background only; the owner's new message follows the marker.]\n${seed}\n[End of earlier transcript.]\n\n${wire}`;
}

/** Splits a server-sent stream into its JSON frames: feed(text) returns the frames completed so far, keeping any partial one. */
export function frameParser() {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    const frames = [];
    for (;;) {
      const end = buffer.search(/\r?\n\r?\n/u);
      if (end < 0) break;
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/u, '');
      const data = raw.split(/\r?\n/u).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /u, '')).join('\n');
      if (!data) continue;
      try { frames.push(JSON.parse(data)); } catch { /* a malformed frame is skipped, the cursor resumes after it */ }
    }
    return frames;
  };
}

export class RemoteError extends Error {
  constructor(message, { offline = false, status = null } = {}) { super(message); this.offline = offline; this.status = status; }
}

/**
 * The bridge. `store` is the local event store; `runtimes()` gives the reachable peers ({ id: { id, label, url, tokenFile } }, default
 * hosts.js); the chat's host is `store.conversation(id).host`. Everything that touches the network or the clock is injectable for tests.
 */
export function createRemoteRuntimes({
  store, runtimes = loadRuntimes, twinsPath = TWINS(), decisionsPath = DECISIONS(), fetchImpl = fetch, now = () => Date.now(),
  onUserMessage = null, onTurnEnd = null, log = (line) => console.log(line), sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); })
} = {}) {
  let twins = {};
  try { twins = JSON.parse(readFileSync(twinsPath, 'utf8')) || {}; } catch { twins = {}; }
  const health = new Map(); // peer id -> { online, at, error }
  const flushing = new Map();
  const streams = new Map(); // chat id -> { stop, ctl, twin }
  let timer = null;

  let cached = null, cachedAt = 0;
  const config = () => {
    if (typeof runtimes !== 'function') return runtimes || {};
    if (!cached || now() - cachedAt > CONFIG_TTL_MS) { cached = runtimes() || {}; cachedAt = now(); }
    return cached;
  };
  const labelOf = (id) => config()[id]?.label || id;

  function save() {
    try {
      mkdirSync(dirname(twinsPath), { recursive: true });
      const tmp = `${twinsPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(twins, null, 1));
      renameSync(tmp, twinsPath);
    } catch (cause) { log(`[remote-runtime] could not persist twins: ${cause?.message || cause}`); }
  }
  function decide(entry) {
    const line = { at: new Date(now()).toISOString(), ...entry };
    log(`[remote-runtime] ${JSON.stringify(line)}`);
    try { mkdirSync(dirname(decisionsPath), { recursive: true }); appendFileSync(decisionsPath, `${JSON.stringify(line)}\n`); } catch { /* the console line stands */ }
  }
  const emit = (id, kind, content, at = null) => store.append(id, kind, content, { runId: null, at: at || new Date(now()).toISOString() });

  function mark(runtimeId, ok, error = null) {
    const before = health.get(runtimeId);
    health.set(runtimeId, { online: ok, at: now(), error: ok ? null : String(error || 'unreachable') });
    if (before?.online !== ok) decide({ event: ok ? 'online' : 'offline', runtime: runtimeId, error: ok ? undefined : String(error || '') });
  }

  async function tokenOf(rt) {
    try { return (await readFile(rt.tokenFile, 'utf8')).trim(); } catch { throw new RemoteError(`no service token for ${rt.label} (${rt.tokenFile})`, { offline: false }); }
  }

  /** The peer's machine surface: one authenticated request. Network failures and 5xx are `offline`; a refusal is not. */
  async function request(runtimeId, body, { timeoutMs = CALL_TIMEOUT_MS, signal = null } = {}) {
    const rt = config()[runtimeId];
    if (!rt) throw new RemoteError(`host "${runtimeId}" is not configured on this server`, { offline: false });
    const token = await tokenOf(rt);
    let response;
    try {
      response = await fetchImpl(`${rt.url}/api/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(timeoutMs)
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      mark(runtimeId, false, cause?.cause?.code || cause?.name || cause?.message);
      throw new RemoteError(`${rt.label} is offline (${cause?.cause?.code || cause?.name || cause?.message})`, { offline: true });
    }
    if (response.status >= 500) {
      mark(runtimeId, false, `HTTP ${response.status}`);
      throw new RemoteError(`${rt.label} is offline (HTTP ${response.status})`, { offline: true, status: response.status });
    }
    return { response, rt };
  }

  /** One /api/agent call answered with JSON. */
  async function call(runtimeId, body, options) {
    const { response, rt } = await request(runtimeId, body, options);
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    // The machine surface answers 404 "not found" to a wrong token or a non-loopback peer, and 404 "no conversation" to a good one.
    const refused = response.status === 404 && /^not found$/iu.test(String(data?.error || ''));
    mark(runtimeId, !refused, refused ? 'refused: wrong service token, or the forward is not loopback' : null);
    if (!response.ok) throw new RemoteError(refused ? `${rt.label} refused the service token` : (data?.error || `${rt.label} refused the request (HTTP ${response.status})`), { status: response.status });
    return data;
  }

  /** Reachability for the host menu: a cheap authenticated call, at most once per `maxAgeMs`. */
  async function probe(runtimeId, { maxAgeMs = 10_000 } = {}) {
    const known = health.get(runtimeId);
    if (known && now() - known.at < maxAgeMs) return known;
    try { await call(runtimeId, { op: 'read', conversationId: 'probe-none' }, { timeoutMs: 4000 }); } catch { /* call() recorded the outcome */ }
    return health.get(runtimeId) || { online: null, at: 0, error: null };
  }

  async function status({ probeNow = true } = {}) {
    const out = {};
    for (const [id, rt] of Object.entries(config())) {
      const h = probeNow ? await probe(id) : (health.get(id) || { online: null, at: 0, error: null });
      out[id] = { id, label: rt.label, online: h.online, checkedAt: h.at ? new Date(h.at).toISOString() : null, error: h.error || null,
        chats: Object.values(twins).filter((t) => t.runtime === id).length };
    }
    return out;
  }

  // ---- which host answers a send ------------------------------------------------------------------------------------

  const twinOf = (id) => twins[id] || null;
  const isRemoteBusy = (id) => Boolean(twins[id]?.busy || twins[id]?.pending?.length);

  /** { runtime, reason } for a send now: null runtime = this machine. Never by content: only the chat's host, or a twin mid-run. */
  function route(id, { localBusy = false } = {}) {
    const conversation = store.conversation(id);
    if (!conversation) return { runtime: null, reason: 'unknown conversation' };
    const twin = twinOf(id);
    if (twin && isRemoteBusy(id)) return { runtime: twin.runtime, reason: 'a remote turn is in progress; it is not moved mid-turn' };
    if (localBusy) return { runtime: null, reason: 'a local turn is in progress; it is not moved mid-turn' };
    const host = conversation.host || null;
    return host ? { runtime: host, reason: `the chat's host is ${host}` } : { runtime: null, reason: 'the chat runs here' };
  }

  // ---- sending ---------------------------------------------------------------------------------------------------------

  function newTwin(runtime, conversationId) {
    return { runtime, remoteId: null, cursor: 0, pending: [], echo: [], sentIds: [], busy: false, running: false, remoteSeen: 0, localSeen: null,
      sentAt: 0, offlineNoted: false, conversationId };
  }

  function sendRemote(id, wire, { itemId, display = wire, runtimeId, reason }) {
    let twin = twins[id];
    if (twin && twin.runtime !== runtimeId) { detach(id); twin = null; } // the chat moved to another host: a new twin there, the old chat stays where it is
    if (!twin) twin = twins[id] = newTwin(runtimeId, id);
    if (twin.sentIds.includes(itemId) || twin.pending.some((p) => p.itemId === itemId)) return { queued: false, injected: false, duplicate: true };
    if (twin.localSeen == null) twin.localSeen = store.cursor();
    // What the host has not seen: everything after the last turn it ran (the whole chat on the first send).
    const seed = seedTranscript(store.allConversationEvents(id), { after: twin.remoteSeen, exclude: itemId });
    const text = withSeed(seed, wire, twin.remoteId ? 'elsewhere' : 'on another machine');
    const wasBusy = twin.busy;
    twin.pending.push({ itemId, text, display });
    twin.busy = true;
    twin.sentAt = now();
    twin.offlineNoted = false;
    save();
    decide({ event: 'route', chat: id, runtime: runtimeId, label: labelOf(runtimeId), reason, seededChars: seed.length, first: !twin.remoteId });
    emit(id, 'message.user', { itemId, text: display });
    if (onUserMessage) { try { onUserMessage(id); } catch { /* a hook never blocks a send */ } }
    if (!twin.running) { twin.running = true; emit(id, 'run.status', { state: 'starting', note: `Running on ${labelOf(runtimeId)}` }); save(); }
    flush(id).catch(() => {});
    return { queued: false, injected: wasBusy };
  }

  /** Forward every pending message, in order. An unreachable host keeps them and says so once. */
  function flush(id) {
    if (flushing.has(id)) return flushing.get(id);
    const done = doFlush(id).finally(() => flushing.delete(id));
    flushing.set(id, done);
    return done;
  }
  async function doFlush(id) {
    const twin = twins[id];
    if (!twin) return;
    while (twin.pending.length) {
      const item = twin.pending[0];
      try {
        if (!twin.remoteId) {
          const out = await call(twin.runtime, { op: 'spawn', prompt: item.text, title: String(store.conversation(id)?.title || item.display).slice(0, 72) });
          twin.remoteId = out.id;
          twin.cursor = Number(out.cursor) || 0; // the host's cursor before it ran the prompt: the stream starts there
        } else {
          await call(twin.runtime, { op: 'send', conversationId: twin.remoteId, text: item.text });
        }
      } catch (cause) {
        if (cause.offline) { noteOffline(id, twin, cause); return; }
        twin.pending.shift();
        twin.busy = false; twin.running = false;
        save();
        emit(id, 'run.error', { message: `${labelOf(twin.runtime)} would not take the message: ${cause.message}` });
        return;
      }
      twin.pending.shift();
      twin.echo.push(item.text.trim());
      twin.sentIds.push(item.itemId);
      if (twin.sentIds.length > 200) twin.sentIds.splice(0, twin.sentIds.length - 200);
      twin.offlineNoted = false;
      save();
      attach(id);
    }
  }

  function noteOffline(id, twin, cause) {
    if (twin.offlineNoted) return;
    twin.offlineNoted = true;
    save();
    const label = labelOf(twin.runtime);
    if (twin.pending.length) {
      emit(id, 'run.error', { message: `${cause.message}. Your message is saved here and is sent to ${label} when it is back.` });
      // The turn is not running anywhere: the row says it waits, instead of the "running on" note the send wrote.
      emit(id, 'run.status', { state: 'queued', note: `Waiting for ${label}: offline` });
    } else if (twin.busy) emit(id, 'run.status', { state: 'running', note: `${label} is offline; waiting for it` });
  }

  // ---- the live attach -------------------------------------------------------------------------------------------------

  function endTurn(id, twin) {
    if (twin.pending.length) return; // a message still waiting to be forwarded keeps the chat busy
    twin.busy = false; twin.running = false;
    twin.remoteSeen = store.cursor();
    if (onTurnEnd) { try { onTurnEnd(id); } catch { /* a hook never blocks */ } }
  }

  /** One host event into the local log, as the same event a local run writes. */
  function apply(id, twin, e) {
    const c = e.content || {};
    if (typeof e.cursor === 'number') twin.cursor = Math.max(twin.cursor, e.cursor);
    if (e.kind === 'message.user') {
      const at = twin.echo.indexOf(String(c.text || '').trim());
      if (at >= 0) twin.echo.splice(at, 1);
      else if (c.text) emit(id, 'message.user', { itemId: `rt:${e.cursor}`, text: c.text }, e.at);
      return;
    }
    if (MIRRORED.has(e.kind)) {
      if (!twin.busy) { twin.busy = true; twin.running = true; }
      emit(id, e.kind, c, e.at);
    } else if (TERMINAL.has(e.kind)) {
      emit(id, e.kind, e.kind === 'run.completed' ? { ...c, remote: true } : c, e.at);
      endTurn(id, twin);
    }
  }

  /** The turn may have ended while the stream was down and left no event this side saw (the host restarted mid-run): ask once per connection. */
  async function reconcile(id, twin) {
    if (!twin.busy || twin.pending.length || now() - twin.sentAt < 6000) return;
    let data;
    try { data = await call(twin.runtime, { op: 'read', conversationId: twin.remoteId, after: twin.cursor }); } catch { return; }
    if (!twin.busy || data.busy || (data.rows || []).length) return;
    emit(id, 'run.completed', { remote: true, synthesized: true });
    endTurn(id, twin);
    save();
  }

  async function consume(id, twin, s) {
    const { response, rt } = await request(twin.runtime, { op: 'events', conversationId: twin.remoteId, after: twin.cursor }, { signal: s.ctl.signal });
    if (!response.ok || !response.body) {
      const refused = response.status === 404;
      mark(twin.runtime, !refused, refused ? 'refused or no such chat on the host' : `HTTP ${response.status}`);
      throw new RemoteError(`${rt.label} refused the stream (HTTP ${response.status})`, { status: response.status });
    }
    const parse = frameParser();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let idle = null;
    const watch = () => { clearTimeout(idle); idle = setTimeout(() => s.ctl.abort(), STREAM_IDLE_MS); idle.unref?.(); };
    watch();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        watch();
        let changed = false;
        for (const frame of parse(decoder.decode(value, { stream: true }))) {
          if (frame.events) { for (const e of frame.events) apply(id, twin, e); changed = true; }
          else if (frame.hello) {
            mark(twin.runtime, true);
            twin.offlineNoted = false;
            reconcile(id, twin).catch(() => {});
          } else if (frame.resync) { s.resync = true; s.ctl.abort(); changed = true; } // too far behind for the held events: reconnect from the stored cursor, which replays them from the host's log
        }
        if (changed) save();
      }
    } finally { clearTimeout(idle); try { reader.releaseLock(); } catch { /* already released */ } }
  }

  /** Keeps one stream per chat that has a chat on a host; reconnects with backoff, resuming from the stored cursor. Idempotent. */
  function attach(id) {
    const twin = twins[id];
    if (!twin?.remoteId || streams.has(id)) return;
    const s = { stop: false, ctl: null, twin };
    streams.set(id, s);
    (async () => {
      let delay = RECONNECT_MIN_MS;
      while (!s.stop && twins[id] === twin) {
        s.ctl = new AbortController();
        try { await consume(id, twin, s); delay = RECONNECT_MIN_MS; }
        catch (cause) {
          if (s.stop) break;
          if (s.resync) { s.resync = false; delay = RECONNECT_MIN_MS; continue; } // our own abort: reconnect at once from the stored cursor
          const err = cause instanceof RemoteError ? cause : new RemoteError(`${labelOf(twin.runtime)} is offline (${cause?.cause?.code || cause?.name || cause?.message})`, { offline: true });
          if (err.offline) mark(twin.runtime, false, err.message);
          noteOffline(id, twin, err);
        }
        if (s.stop) break;
        await sleep(delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
      if (streams.get(id) === s) streams.delete(id);
    })();
  }

  function detach(id) {
    const s = streams.get(id);
    if (s) { s.stop = true; try { s.ctl?.abort(); } catch { /* closed */ } streams.delete(id); }
  }

  async function tick() {
    for (const [id, twin] of Object.entries(twins)) {
      if (!twin.busy && !twin.pending.length && store.conversation(id)?.archived) {
        // An archived chat that has gone quiet releases its twin and its stream; unarchiving and sending starts a new twin seeded with the transcript.
        detach(id); delete twins[id]; save(); decide({ event: 'twin-released', chat: id, runtime: twin.runtime }); continue;
      }
      if (twin.pending.length) await flush(id).catch(() => {});
      attach(id);
    }
  }

  function interrupt(id) {
    const twin = twins[id];
    if (!twin || !(twin.busy || twin.pending.length)) return false;
    const label = labelOf(twin.runtime);
    const dropped = twin.pending.length;
    twin.pending = [];
    decide({ event: 'interrupt', chat: id, runtime: twin.runtime, droppedUnsent: dropped });
    if (!twin.remoteId) {
      twin.busy = false; twin.running = false; save();
      emit(id, 'run.cancelled', { reason: 'Stopped before it was sent.' });
      return true;
    }
    // The host answers with its own run.cancelled on the stream.
    call(twin.runtime, { op: 'interrupt', conversationId: twin.remoteId }).catch((cause) => {
      twin.busy = false; twin.running = false; save();
      emit(id, 'run.error', { message: `Stop could not reach ${label}: ${cause.message}` });
    });
    return true;
  }

  // ---- the runner ------------------------------------------------------------------------------------------------------

  /** The same runner with send/interrupt/isBusy/phase/warm decided per conversation; every other member passes through. */
  function wrap(runner) {
    const local = runner;
    const patched = {
      send(id, text, options = {}) {
        const { runtime, reason } = route(id, { localBusy: Boolean(local.isBusy?.(id)) });
        const twin = twinOf(id);
        if (options.recovery) {
          // A message the boot found unanswered: the twin already holds it (forwarded or waiting), else it was a local turn.
          if (twin && (twin.sentIds.includes(options.itemId) || twin.pending.some((p) => p.itemId === options.itemId))) return { queued: false, injected: false, duplicate: true, remote: true };
          return local.send(id, text, options);
        }
        if (runtime && config()[runtime]) return sendRemote(id, text, { itemId: options.itemId || `rt-${now()}`, display: options.display ?? text, runtimeId: runtime, reason });
        if (runtime) {
          // The chat's host is not reachable from this server (no address or token): fail loudly, never fall back to a run on this machine.
          decide({ event: 'refused', chat: id, runtime, reason: 'host not configured' });
          emit(id, 'message.user', { itemId: options.itemId || `rt-${now()}`, text: options.display ?? text });
          emit(id, 'run.error', { message: `This chat's host is "${runtime}", which this server has no address for (hosts.json). Nothing was run.` });
          return { queued: false, injected: false };
        }
        // Back on this machine after remote turns: the local run has not seen them, so the missed transcript goes first.
        if (twin && twin.localSeen != null) {
          const seed = seedTranscript(store.allConversationEvents(id), { after: twin.localSeen, exclude: options.itemId });
          if (seed) { text = withSeed(seed, text, `on ${labelOf(twin.runtime)}`); decide({ event: 'return-local', chat: id, runtime: twin.runtime, seededChars: seed.length }); }
          twin.localSeen = null; save();
        }
        return local.send(id, text, options);
      },
      interrupt(id, options) {
        const remote = interrupt(id);
        const mine = local.interrupt(id, options);
        return remote || mine;
      },
      isBusy: (id) => isRemoteBusy(id) || local.isBusy(id),
      phase: (id) => (isRemoteBusy(id) ? 'running' : local.phase(id)),
      warm(id) {
        if (route(id).runtime) return false;
        return local.warm?.(id);
      },
      // A run a restart cut off on a host is picked up by the stream, never by a local child.
      revive(id, options) {
        if (isRemoteBusy(id)) return { ok: true, conversationId: id, revived: false, carriedOn: false, note: 'runs on a host; the stream resumes it' };
        return local.revive(id, options);
      }
    };
    return new Proxy(local, { get: (target, prop) => (prop in patched ? patched[prop] : target[prop]) });
  }

  // One loop, one tick at a time: the next tick is scheduled when the last one has finished.
  let running = false;
  function start({ every = TICK_MS } = {}) {
    if (running) return;
    running = true;
    const loop = async () => {
      try { await tick(); } catch (cause) { log(`[remote-runtime] tick failed: ${cause?.message || cause}`); }
      if (running) { timer = setTimeout(loop, every); timer.unref?.(); }
    };
    timer = setTimeout(loop, 0);
    timer.unref?.();
  }
  function stop() { running = false; if (timer) clearTimeout(timer); timer = null; for (const id of [...streams.keys()]) detach(id); }

  return { wrap, route, tick, flush, start, stop, status, probe, call, attach, detach, twins: () => twins, twin: twinOf, isRemoteBusy, runtimes: config, decide };
}
