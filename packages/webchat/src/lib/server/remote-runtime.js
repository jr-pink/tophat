// Peer hosting: a chat lives on one host, the peer whose runner answers it (hosts.js lists the peers, the conversation's
// `host` names one, null is this host). This server stays the front end for every chat; for a chat hosted on a peer it
// attaches to that peer's live event feed and writes what arrives into its own log, so the local UI streams tokens, thinking,
// tool input and run state exactly as for a local run, the transcript reads offline, and a restart resumes from the stored cursor.
//
// The link is the host's own actions (the Docstore A1 corollary (native actions, never a private protocol), docs/HOST-DESIGN.md section 6. His message is ONE intent with ONE id
// minted at home (A7): it is posted to the host's /api/actions as the same message.send (or conversation.fork for a side thread) a browser would post, action id = the home item id,
// so a retry is a no-op there (the host answers `replayed`). The chat has the same id on both sides, so a send to an unknown conversation creates it, as in a browser. What the host
// writes comes back on its own feed (/api/events?conversation=, resumable by cursor; /api/sync for a catch-up) and is stored here keyed by the host's event id (`hostEvent`), a row
// whose id is already stored being a no-op. His own message comes back under his own item id and is therefore already here; one typed on the host by another member has its own id
// and is added. Nothing matches on text, nothing is re-emitted under an invented id, and the only cursor kept is the feed's resume point.
//
// How a turn runs. wrap(runner) returns the runner with send/interrupt/isBusy/phase/warm decided per conversation. A send to a
// chat whose host is a peer writes the owner's message into the local log, then posts it, seeded with the transcript the peer has
// not seen. The chat's events then arrive on one held-open feed per chat and are appended locally as they come.
//
// A host that predates the actions build (its /api/health lacks `peer.actions`) is served by remote-runtime-legacy.js, chosen by
// that capability handshake and never by guessing.
//
// Rules the module holds: only a chat whose host is a peer goes remote (never by content: choosing a host is the user's, or the
// router's with confirmation); a chat mid-run is not moved mid-turn; an unreachable peer is a visible "offline" state with the
// message kept and re-sent, never a hang and never a silent local run; every routing decision is logged (remote-routing.jsonl).
//
// The first message of a new chat waits for the host decision (the host gate). The router's pick used to land about 1.5 s after
// message 1, when this host's run of it had already started, so a team-level first message ran here and only the second one went to
// the team host. A send flagged `hostGate` to a chat with no host and no message yet is held here until decideHost answers (bounded by
// HOST_GATE_MS; a decision that does not come in time is logged and the message runs here, and a late pick is dropped), and then goes
// out the normal way: to the chosen host as the original message, or to this host. Docs: docs/HOST-DESIGN.md.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { webchatStorePath } from './paths.js';
import { loadRuntimes, selfDevice } from './hosts.js';
import { createHostedMemory } from './hosted-memory.js';
import { SEED_CLOSE, seedMarker, unseeded } from '../core/automated-event.js';
import { UPLOAD_ROOT } from './uploads.js';
import { findUploadPaths, pushFile, replacePaths } from './peer-upload.js';
import { ACTIONS, makeAction, newId } from '../core/contract.js';
import * as legacy from './remote-runtime-legacy.js';

const TWINS = () => webchatStorePath('remote-twins.json');
const DECISIONS = () => webchatStorePath('remote-routing.jsonl');

export const TICK_MS = 5_000;
export const CALL_TIMEOUT_MS = 8_000;
export const STREAM_IDLE_MS = 60_000; // the host pings every 20 s (sse.js): silence this long is a dead connection
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;
export const CONFIG_TTL_MS = 10_000;
export const CAPABILITY_TTL_MS = 30_000; // how long a host's answer about which protocol it speaks is trusted (a host updated in place is noticed within this)
export const SEED_CHARS = 24_000;
// How long a new chat's first message waits for the router's host decision before it runs on this host.
export const HOST_GATE_MS = 3_000;
// A file his message names that is still arriving here (the composer sends the message while a big upload finishes) holds the
// forward this long; after it the path is replaced by a plain note that the file never arrived, never left as a dead path.
export const UPLOAD_WAIT_MS = 30 * 60_000;
// An older message in the seed names files too: they go along when small, so the host can reread them; a big one stays a local path.
// A named path with no file and no partial yet (a reservation the client has not started, or an old upload since deleted) waits a short while.
export const ABSENT_WAIT_MS = 2 * 60_000;
export const STAGE_RETRY_MS = 15_000; // between tries while the host is unreachable or cannot take uploads (each try hashes the file)
export const SEED_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

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
  let lastOwner = null, spoke = false;
  for (const e of events) {
    if (e.cursor <= after) continue;
    const c = e.content || {};
    if (exclude && (Array.isArray(exclude) ? exclude.includes(c.itemId) : c.itemId === exclude)) continue;
    if (e.kind === 'message.user' && c.text) {
      const own = unseeded(c.text);
      if (own && !(lastOwner === own && !spoke && String(c.itemId || '').startsWith('rt:'))) { lines.push(`Owner: ${own}`); lastOwner = own; spoke = false; }
    } else if (e.kind === 'assistant.message' && c.text && !c.agentId) { lines.push(`Assistant: ${String(c.text).trim()}`); spoke = true; }
  }
  let text = lines.join('\n\n');
  if (text.length > cap) text = `[earlier part cut]\n${text.slice(text.length - cap)}`;
  return text;
}

/** The message as sent to the runtime that has not seen part of the chat: the missed transcript first, then the message. */
export function withSeed(seed, wire, where) {
  if (!seed) return wire;
  return `${seedMarker(where)}\n${seed}\n${SEED_CLOSE}\n\n${wire}`;
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
  uploadRoot = UPLOAD_ROOT, pushImpl = pushFile, onUserMessage = null, onTurnEnd = null, decideHost = null, hostGateMs = HOST_GATE_MS, selfHost = selfDevice(),
  hostedMemory = createHostedMemory({ store, outboxPath: join(dirname(twinsPath), 'hosted-memory-outbox.jsonl'), log: (line) => console.log(line) }), hostGateWanted = () => true, door = null, log = (line) => console.log(line), sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); })
} = {}) {
  let twins = {};
  try { twins = JSON.parse(readFileSync(twinsPath, 'utf8')) || {}; } catch { twins = {}; }
  const health = new Map(); // peer id -> { online, at, error }
  const flushing = new Map();
  const streams = new Map(); // chat id -> { stop, ctl, twin }
  const gates = new Map(); // chat id -> { held: [{ text, options }], controller } while the first message waits for the host decision
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
  const writerOf = () => ({ scope: 'member', ...(selfHost ? { host: selfHost } : {}) });
  const emit = (id, kind, content, at = null) => store.append(id, kind, content, { runId: null, at: at || new Date(now()).toISOString() });

  function mark(runtimeId, ok, error = null) {
    const before = health.get(runtimeId);
    health.set(runtimeId, { online: ok, at: now(), error: ok ? null : String(error || 'unreachable') });
    if (before?.online !== ok) decide({ event: ok ? 'online' : 'offline', runtime: runtimeId, error: ok ? undefined : String(error || '') });
  }

  async function tokenOf(rt) {
    try { return (await readFile(rt.tokenFile, 'utf8')).trim(); } catch { throw new RemoteError(`no service token for ${rt.label} (${rt.tokenFile})`, { offline: false }); }
  }

  /** One authenticated request to a peer. Network failures and 5xx are `offline`; a refusal is not. */
  async function fetchPeer(runtimeId, path, { method = 'POST', body = undefined, timeoutMs = CALL_TIMEOUT_MS, signal = null } = {}) {
    const rt = config()[runtimeId];
    if (!rt) throw new RemoteError(`host "${runtimeId}" is not configured on this server`, { offline: false });
    const token = await tokenOf(rt);
    let response;
    try {
      response = await fetchImpl(`${rt.url}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  /** The peer's machine surface (/api/agent): what is not a chat action (uploads, inject, grants) and the legacy host branch. */
  const request = (runtimeId, body, options) => fetchPeer(runtimeId, '/api/agent', { ...options, body });

  /** One answer read as JSON; a 404 "not found" is a wrong token or a non-loopback peer, a 404 with another error is a good caller. */
  async function readJson(runtimeId, { response, rt }) {
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    const refused = response.status === 404 && /^not found$/iu.test(String(data?.error || ''));
    mark(runtimeId, !refused, refused ? 'refused: wrong service token, or the forward is not loopback' : null);
    if (!response.ok) throw new RemoteError(refused ? `${rt.label} refused the service token` : (data?.error || `${rt.label} refused the request (HTTP ${response.status})`), { status: response.status });
    return data;
  }

  /** One /api/agent call answered with JSON. */
  async function call(runtimeId, body, options) {
    return readJson(runtimeId, await request(runtimeId, body, options));
  }

  // ---- the host's own actions ------------------------------------------------------------------------------------------------

  const deviceId = () => selfHost || 'home-server';
  let lastSeq = 0;
  /** Monotone per process and across restarts (wall clock floors it); /api/actions dedupes on the action id, so the seq only has to be valid. */
  const nextSeq = () => { lastSeq = Math.max(lastSeq + 1, now()); return lastSeq; };

  /** Post one action to a host's /api/actions, as a browser would. `actionId` is the intent's id: a retry of the same id changes nothing there. */
  async function postAction(runtimeId, { op, conversationId, payload, actionId }) {
    const action = makeAction({ op, conversationId, payload, deviceId: deviceId(), deviceSeq: nextSeq(), actionId, at: new Date(now()).toISOString() });
    return readJson(runtimeId, await fetchPeer(runtimeId, '/api/actions', { body: action }));
  }

  const capabilities = new Map(); // peer id -> { actions: boolean, at }

  /**
   * Whether this host speaks the actions protocol, asked of the host itself (/api/health `peer.actions`). A host that answers without it
   * is a legacy host (remote-runtime-legacy.js). An unreachable host throws `offline`; the answer is never assumed.
   */
  async function speaksActions(runtimeId) {
    const known = capabilities.get(runtimeId);
    if (known && now() - known.at < CAPABILITY_TTL_MS) return known.actions;
    const got = await fetchPeer(runtimeId, '/api/health', { method: 'GET', timeoutMs: 4000 });
    let data = {};
    try { data = await got.response.json(); } catch { data = {}; }
    if (!got.response.ok) throw new RemoteError(`${got.rt.label} would not say what it speaks (HTTP ${got.response.status})`, { status: got.response.status });
    mark(runtimeId, true);
    const actions = Number(data?.peer?.actions) >= 1;
    if (known && known.actions !== actions) decide({ event: 'capability-changed', runtime: runtimeId, actions });
    else if (!known) decide({ event: 'capability', runtime: runtimeId, actions });
    capabilities.set(runtimeId, { actions, at: now() });
    return actions;
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
  /** A twin whose chat moved to another host while its turn ran: kept under this key until that turn ends. */
  const retiredKey = (id, twin) => `${id}@${twin.runtime}`;
  const retiredOf = (id) => Object.keys(twins).filter((k) => k.startsWith(`${id}@`));
  const isRemoteBusy = (id) => Boolean(twins[id]?.busy || twins[id]?.pending?.length);

  /**
   * { runtime, reason } for a send now: null runtime = this host. Never by content: the chat's host decides, also mid-turn. A send after he
   * switched host goes to the new host; the turn already running on the old one runs on in the background and its output still lands here
   * (a remote twin keeps its stream; a local run keeps writing). The one exception: a chat has one remote twin, so while a turn runs on one
   * peer a send for a different peer stays with the running one (its stream would otherwise be cut and its output lost).
   */
  function route(id, { localBusy = false } = {}) {
    const conversation = store.conversation(id);
    if (!conversation) return { runtime: null, reason: 'unknown conversation' };
    const twin = twinOf(id);
    const chosen = chosenRoute(id, conversation, twin);
    if (twin && isRemoteBusy(id)) {
      if (chosen.runtime === twin.runtime) return { runtime: twin.runtime, reason: 'a turn is in progress on the chat\'s host; the message joins it' };
      if (chosen.runtime) return { runtime: chosen.runtime, reason: `switched to ${labelOf(chosen.runtime)} mid-turn; the turn on ${labelOf(twin.runtime)} runs on in the background` };
      return { runtime: null, reason: `switched to this host mid-turn; the turn on ${labelOf(twin.runtime)} runs on in the background` };
    }
    if (localBusy) {
      if (!chosen.runtime) return { runtime: null, reason: 'a local turn is in progress; the message joins it' };
      return { ...chosen, reason: `switched to ${labelOf(chosen.runtime)} mid-turn; the local turn runs on in the background` };
    }
    return chosen;
  }

  /** Where the chat runs when nothing is in flight: its host, a side thread's parent host, or here. */
  function chosenRoute(id, conversation, twin) {
    const host = conversation.host || null;
    // A side thread runs where its parent runs: the parent's session (the transcript the model saw and the prompt cache over it)
    // lives in that host's ledger, so a fork anywhere else starts with an empty context.
    const home = sideParentTwin(conversation);
    if (home && !host && !twin) return { runtime: home.runtime, reason: `a side thread runs where its parent chat runs (${home.runtime})` };
    if (host && !twin && autoHostSkipped(id)) return { runtime: null, reason: `the router's pick (${host}) is not used: the chat already worked on files on this host` };
    return host ? { runtime: host, reason: `the chat's host is ${host}` } : { runtime: null, reason: 'the chat runs here' };
  }

  /** The twin of a side thread's parent chat when the parent runs on a host (its remote chat has a session to fork), else null. */
  function sideParentTwin(conversation) {
    if (!conversation?.sidechat || !conversation.parentId) return null;
    const parent = twinOf(conversation.parentId);
    return parent?.remoteId ? parent : null;
  }

  // The router picks a host on a chat's first message, while this host's run of it has already started. If that run went on to
  // use tools (read files, ran commands) the work lives on this host's disk, and a host without those files can only answer
  // "that isn't here". A host he chose himself is always honored; the router's pick yields once local work exists and the chat
  // has never run on the host.
  function autoHostSkipped(id) {
    let auto = false, worked = false;
    for (const e of store.allConversationEvents(id)) {
      if (e.kind === 'conversation.host') auto = e.content?.auto === true;
      else if (e.kind === 'tool.started' && e.run_id) worked = true; // a mirrored host run is stored with no run id
    }
    return auto && worked;
  }

  // ---- the host gate: the first message of a new chat waits for the router --------------------------------------------------

  let sendThrough = null; // wrap()'s patched send, set there: a held message goes out the normal way once the decision is in

  const gateApplies = (id) => {
    if (!decideHost) return false;
    const c = store.conversation(id);
    // A host he chose by hand is honored as it stands, a chat that already has a message or a twin is never re-decided, and with no
    // peer to choose the send is not delayed at all.
    if (!c || c.host || c.sidechat || (c.turns || 0) > 0 || twinOf(id) || !Object.keys(config()).length) return false;
    return hostGateWanted(id) !== false;
  };

  /** Holds the first message, asks decideHost (bounded), then sends everything held through wrap().send in arrival order. */
  function holdForHost(id, text, options) {
    const gate = { held: [{ text, options }], controller: new AbortController(), at: now() };
    gates.set(id, gate);
    (async () => {
      let outcome = 'decided', timer = null;
      try {
        const asked = Promise.resolve(decideHost(id, { text: options.display ?? text, signal: gate.controller.signal })).then(() => 'decided');
        const late = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), hostGateMs); timer.unref?.(); });
        outcome = await Promise.race([asked, late]);
      } catch (cause) { outcome = `error: ${cause?.message || cause}`; }
      clearTimeout(timer);
      if (outcome !== 'decided') gate.controller.abort(); // a pick that arrives after this is dropped (autoroute.js): the chat runs here from now on
      decide({ event: 'host-gate', chat: id, outcome, ms: now() - gate.at, host: store.conversation(id)?.host || null, held: gate.held.length });
      if (gate.cancelled) return; // he stopped it while it waited (cancelGate): nothing is sent
      gates.delete(id);
      for (const h of gate.held) {
        try { sendThrough(id, h.text, { ...h.options, hostGate: false }); }
        catch (cause) { emit(id, 'run.error', { message: `The message could not be sent: ${cause?.message || cause}` }); }
      }
    })();
    return { queued: false, injected: false, held: true };
  }

  /** Stop while the first message is still waiting for its host: nothing was sent anywhere; the words stay in the chat and the turn is cancelled. */
  function cancelGate(id) {
    const gate = gates.get(id);
    if (!gate) return false;
    gates.delete(id);
    gate.cancelled = true;
    gate.controller.abort();
    for (const h of gate.held) emit(id, 'message.user', { itemId: h.options.itemId || `rt-${now()}`, text: h.options.display ?? h.text });
    emit(id, 'run.cancelled', { reason: 'Stopped before it was sent.' });
    decide({ event: 'host-gate', chat: id, outcome: 'interrupted', ms: now() - gate.at });
    return true;
  }

  /** Only a turn that is running there takes it. */
  async function inject(id, text, { note = '' } = {}) {
    const twin = twins[id];
    const said = String(text || '').trim();
    if (!said) throw Object.assign(new RemoteError('Nothing to inject', { status: 400 }), { status: 400 });
    if (!twin?.remoteId) throw Object.assign(new RemoteError('this chat does not run on another host', { status: 409 }), { status: 409 });
    if (!twin.busy) return { ok: false, injected: false, reason: 'no turn is running on the host' };
    try {
      const out = await call(twin.runtime, { op: 'inject', conversationId: twin.remoteId, text: said, note, writer: writerOf() });
      decide({ event: 'inject', chat: id, runtime: twin.runtime, chars: said.length, ok: out?.ok !== false });
      return out;
    } catch (cause) {
      if (cause.status === 409) return { ok: false, injected: false, reason: 'no turn is running on the host' };
      throw cause;
    }
  }

  // ---- sending ---------------------------------------------------------------------------------------------------------

  function newTwin(runtime, conversationId) {
    return { runtime, remoteId: null, cursor: 0, pending: [], echo: [], sentIds: [], busy: false, running: false, remoteSeen: 0, localSeen: null,
      sentAt: 0, offlineNoted: false, conversationId, uploads: {} };
  }

  const sideSettings = (conversation) => {
    const settings = conversation?.settings || {};
    return {
      ...(settings.provider ? { provider: settings.provider } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {})
    };
  };

  function sendRemote(id, wire, { itemId, display = wire, runtimeId, reason }) {
    let twin = twins[id];
    let carried = [];
    if (twin && twin.runtime !== runtimeId) {
      // The chat moved to another host: a new twin there. A turn still running on the old host runs on in the background: its twin is kept
      // under its own key with its own stream, so its output keeps landing here (the same as a local turn left running).
      detach(id);
      // Messages of his the old host has not been given yet follow him to the new one, in order and before this one (a twin is flushed
      // under the chat's id only, so they cannot be left behind on a retired twin, and dropping them lost them silently).
      carried = twin.pending.splice(0).map((p) => ({ ...p, text: unseeded(p.text) }));
      if (twin.busy && twin.remoteId) { twin.pending = []; twins[retiredKey(id, twin)] = twin; delete twins[id]; attach(retiredKey(id, twin)); }
      twin = null;
    }
    if (!twin) twin = twins[id] = newTwin(runtimeId, id);
    if (twin.sentIds.includes(itemId) || twin.pending.some((p) => p.itemId === itemId)) return { queued: false, injected: false, duplicate: true };
    if (twin.localSeen == null) twin.localSeen = store.cursor();
    // What the host has not seen: everything after the last turn it ran (the whole chat on the first send).
    const seed = seedTranscript(store.allConversationEvents(id), { after: twin.remoteSeen, exclude: [itemId, ...carried.map((p) => p.itemId)] });
    // The seed rides on the first message the host will read; carried messages (already unseeded) go first.
    const text = carried.length ? wire : withSeed(seed, wire, twin.remoteId ? 'elsewhere' : 'on another host');
    const wasBusy = twin.busy;
    carried.forEach((p, i) => twin.pending.push({ ...p, text: i === 0 ? withSeed(seed, p.text, 'on another host') : p.text }));
    twin.pending.push({ itemId, text, display, at: now() });
    twin.busy = true;
    twin.sentAt = now();
    twin.offlineNoted = false;
    save();
    decide({ event: 'route', chat: id, runtime: runtimeId, label: labelOf(runtimeId), reason, seededChars: seed.length, first: !twin.remoteId });
    // He writes here as a member of the host's group: the tag keeps these words his (hosted-memory.js) and out of the host's memory.
    emit(id, 'message.user', { itemId, text: display, writer: writerOf() });
    seenOf(id).add(`item:${itemId}`); // the host's row for this message comes back under this id and is already here
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
      // His files go to the host first; the host sees its own paths (his message here keeps the local ones).
      let wire, withdraw = () => {};
      if (item.notBefore && now() < item.notBefore) return;
      try { wire = await stage(id, twin, item); item.notBefore = 0; }
      catch (cause) {
        if (cause.offline || cause.hold) { item.notBefore = now() + (cause.waiting ? 0 : STAGE_RETRY_MS); noteHold(id, twin, cause); return; }
        twin.pending.shift();
        twin.busy = false; twin.running = false;
        save();
        emit(id, 'run.error', { message: `${labelOf(twin.runtime)} would not take the message: ${cause.message}` });
        return;
      }
      try {
        const conversation = store.conversation(id);
        // A side thread opens as a child of its parent's chat on the host: the host's runner then resumes a fork of the parent's session
        // (the same transcript and the same cached prompt prefix), with the model and effort the side thread was given.
        const parentTwin = !twin.remoteId ? sideParentTwin(conversation) : null;
        const forkOf = parentTwin && parentTwin.runtime === twin.runtime ? { parentId: parentTwin.remoteId, ...sideSettings(conversation) } : null;
        const title = String(conversation?.title || item.display).slice(0, 72);
        if (await speaksActions(twin.runtime)) {
          // His message is one action with one id, posted to the host's own reducer; the chat has this id there too, so the host's
          // log, its feed and this log name it the same. A known id is a no-op on the host, so a retry after a lost reply is safe.
          const hostChat = twin.remoteId || id;
          // The door back into this host's folder for the turn (host-door.js): its address rides in what the host's model reads.
          let doorText = '';
          if (door) { try { doorText = await door.open(id, twin.runtime, config()[twin.runtime], doorHooks(id)); } catch (cause) { log(`[remote-runtime] door for ${id}: ${cause?.message || cause}`); } }
          const payload = { text: wire.display, wire: doorText ? `${wire.text}\n\n${doorText}` : wire.text, writer: writerOf(), title };
          if (forkOf) await postAction(twin.runtime, { op: ACTIONS.FORK, conversationId: hostChat, actionId: item.itemId, payload: { ...payload, parentId: forkOf.parentId, settings: sideSettings(conversation), sidechat: conversation.sidechat || {} } });
          else await postAction(twin.runtime, { op: ACTIONS.SEND, conversationId: hostChat, actionId: item.itemId, payload });
          if (!twin.remoteId) { twin.remoteId = hostChat; twin.cursor = 0; } // the feed starts at the beginning of a chat this host has just been given
          if (!twin.sentIds.includes(item.itemId)) twin.sentIds.push(item.itemId);
        } else {
          // LEGACY HOST: no id-keyed action to post; the host's echo of this message is recognised by its words (remote-runtime-legacy.js).
          withdraw = legacy.registerEcho(twin, wire, item);
          await legacy.forward({ call, twin, item, wire, writer: writerOf(), title, forkOf: forkOf || {} });
        }
      } catch (cause) {
        withdraw();
        if (cause.offline) { noteOffline(id, twin, cause); return; }
        twin.pending.shift();
        twin.busy = false; twin.running = false;
        save();
        emit(id, 'run.error', { message: `${labelOf(twin.runtime)} would not take the message: ${cause.message}` });
        return;
      }
      twin.pending.shift();
      if (twin.sentIds.length > 200) twin.sentIds.splice(0, twin.sentIds.length - 200);
      twin.offlineNoted = false;
      save();
      attach(id);
    }
  }

  /**
   * The message as the host should read it: every upload it names is on the host (size and sha256 checked) and the text carries the
   * host's path for it. Waits (hold) while a named file is still arriving here; an unreachable host or one that cannot take
   * uploads holds too, so the message stays queued and visible, and is never sent with a path the host cannot read.
   */
  async function stage(id, twin, item) {
    const found = findUploadPaths(item.text, uploadRoot);
    if (!found.length) return { text: item.text, display: item.display };
    twin.uploads = twin.uploads || {};
    const required = new Set(findUploadPaths(unseeded(item.text), uploadRoot).map((f) => f.path));
    const pairs = {}; // local path -> what the host sees
    const waiting = [];
    for (const f of found) {
      if (pairs[f.path] !== undefined) continue;
      const must = required.has(f.path);
      if (f.state === 'failed') continue; // the client said it never uploaded: the text already says so, and there is nothing to send
      if (f.state !== 'ready') {
        if (!must) continue;
        if (now() - (item.at || now()) < (f.state === 'partial' ? UPLOAD_WAIT_MS : ABSENT_WAIT_MS)) { waiting.push(f.path); continue; }
        pairs[f.path] = `[this file never finished uploading: ${f.path.split('/').pop()}]`;
        decide({ event: 'upload-never-arrived', chat: id, runtime: twin.runtime, file: f.path });
        continue;
      }
      if (!must && !(twin.uploads[f.path]) && (await sizeOf(f.path)) > SEED_UPLOAD_MAX_BYTES) continue;
      try {
        pairs[f.path] = await pushImpl({ call: (body, options) => call(twin.runtime, body, options), local: f.path, cache: twin.uploads, persist: save });
        decide({ event: 'upload', chat: id, runtime: twin.runtime, file: f.path, remote: pairs[f.path] });
      } catch (cause) {
        if (!must && !cause.offline) continue; // an older message's file is best effort
        if (cause.offline) throw cause;
        // A host on an older build answers 'unknown op': the message waits for it to be updated. Any other refusal (too large, a
        // checksum that did not match) is said once and the message is not retried in a loop.
        if (cause.status === 400 && /unknown op/iu.test(cause.message)) throw Object.assign(new RemoteError(`${labelOf(twin.runtime)} runs a build that cannot take uploads yet`, { status: 400 }), { hold: true });
        throw cause;
      }
    }
    if (waiting.length) throw Object.assign(new RemoteError(`waiting for ${waiting.map((p) => p.split('/').pop()).join(', ')} to finish uploading`, {}), { hold: true, waiting: true });
    return { text: replacePaths(item.text, pairs), display: replacePaths(item.display, pairs) };
  }
  const sizeOf = async (p) => { try { return (await stat(p)).size; } catch { return 0; } };

  function noteHold(id, twin, cause) {
    if (cause.offline) { noteOffline(id, twin, cause); return; }
    if (twin.offlineNoted) return;
    twin.offlineNoted = true;
    save();
    const label = labelOf(twin.runtime);
    if (!cause.waiting) emit(id, 'run.error', { message: `${cause.message}. Your message is saved here and is sent to ${label} when its files can go with it.` });
    emit(id, 'run.status', { state: 'queued', note: cause.waiting ? `Waiting for the upload to finish, then sending to ${label}` : `Waiting for ${label}: ${cause.message}` });
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
    if (twins[id] !== twin) { // a turn that ran on in the background after the chat moved host: its stream and twin are done
      const key = retiredKey(id, twin);
      if (twins[key] === twin) { detach(key); delete twins[key]; save(); decide({ event: 'twin-released', chat: id, runtime: twin.runtime, background: true }); }
      return;
    }
    // The door back into this host stays open while this turn's work runs on the host (subagents, background turns, jobs it started)
    // and closes after a grace once none is left (host-door.js): the host is asked per grant, not about the chat as a whole.
    door?.turnEnded?.(id, { probe: (grant, opts) => doorProbe(twin, grant, opts) });
    hostedMemory?.flush(id, twin, { hostLabel: labelOf(twin.runtime), group: config()[twin.runtime]?.group || null }).then(save).catch(() => {});
    if (onTurnEnd) { try { onTurnEnd(id); } catch { /* a hook never blocks */ } }
  }

  /**
   * What of one door grant still runs on the host ({ live, why }; the host's /api/door, door-work.js). A host on a build without that route
   * answers by the chat's busy flag (/api/sync). Throws when the host is unreachable (the door then stays: host-door.js).
   */
  /**
   * Who a door caller is, asked of the host's ledger (the same /api/door route, `agent`): { known, live, grant } for a subagent id of this chat. The
   * door (host-door.js) decides on it; an unreachable host throws, which the door answers "retry", never "allowed".
   */
  async function doorAgent(twin, agent) {
    if (!twin) throw new RemoteError('this chat is not attached to a team host yet', { offline: true });
    const chat = encodeURIComponent(twin.remoteId || '');
    return readJson(twin.runtime, await fetchPeer(twin.runtime, `/api/door?conversation=${chat}&agent=${encodeURIComponent(agent)}`, { method: 'GET' }));
  }

  /** The two questions the home host's door asks of a chat's team host, resolved at call time (a restored door asks before the chat is attached: the probe then counts as live). */
  const doorHooks = (id) => ({
    probe: (grant, opts) => { const twin = twinOf(id); if (!twin) throw new RemoteError('this chat is not attached to a team host yet', { offline: true }); return doorProbe(twin, grant, opts); },
    agent: (agent) => doorAgent(twinOf(id), agent)
  });

  async function doorProbe(twin, grant, { open = null, holder = false } = {}) {
    const chat = encodeURIComponent(twin.remoteId || '');
    const extra = open ? `&open=${encodeURIComponent(open.join(','))}${holder ? '&holder=1' : ''}` : '';
    const asked = await fetchPeer(twin.runtime, `/api/door?conversation=${chat}&grant=${encodeURIComponent(grant)}${extra}`, { method: 'GET' });
    if (asked.response.ok) return readJson(twin.runtime, asked);
    if (asked.response.status !== 401 && asked.response.status !== 404) return readJson(twin.runtime, asked);
    const sync = await readJson(twin.runtime, await fetchPeer(twin.runtime, `/api/sync?conversation=${chat}&after=${Number.MAX_SAFE_INTEGER}`, { method: 'GET' }));
    return { live: Boolean(sync.busy), why: sync.busy ? 'chat busy (older host)' : '' };
  }

  // A settled assistant.message names `firstCursor`, the cursor its block began at, and the reducer places the row there. The
  // host wrote that number in ITS cursor space (a few thousand), which is below every cursor of this log: the row moved to the
  // top of the chat above the whole conversation. Here the block start is the local cursor its first delta was stored under
  // (what runner.js does for a local run); a block whose first delta this server never saw (a resync after a restart) drops
  // the field and sits at its own cursor.
  const blockKey = (c) => `${c.agentId || ''}\u0000${c.itemId || ''}`;
  const blockStarts = new WeakMap();
  const startsOf = (twin) => { let m = blockStarts.get(twin); if (!m) { m = new Map(); blockStarts.set(twin, m); } return m; };
  function forgetBlockStarts(twin) { blockStarts.delete(twin); }

  // The ids of the host events and of his messages this log already holds, per chat, built from the log itself on first use (so a restart
  // knows what the last life stored) and kept current as rows are written. This is the whole of the dedupe: an id seen is a no-op.
  const seenIds = new Map();
  function seenOf(id) {
    let seen = seenIds.get(id);
    if (!seen) {
      seen = new Set();
      for (const e of store.allConversationEvents(id)) {
        const c = e.content || {};
        if (c.hostEvent) seen.add(c.hostEvent);
        if (e.kind === 'message.user' && c.itemId) seen.add(`item:${c.itemId}`);
      }
      seenIds.set(id, seen);
    }
    return seen;
  }
  const hostEventId = (twin, e) => e.event_id || `${twin.remoteId}:${e.cursor}`;

  /** One host event into the local log, as the same event a local run writes. `actions` is the protocol the feed was opened under. */
  function apply(id, twin, e, actions = true) {
    const c = e.content || {};
    if (!actions) return applyLegacy(id, twin, e);
    // The feed resumes after the stored cursor, so an event at or below it was already taken; the id check below is what makes a
    // replay (a resync, a restart between the append and the save of the cursor) harmless.
    // (A token fragment is not stored on the host's log and has no committed id, so the cursor is its only guard.)
    const fragment = e.kind === 'assistant.delta' || e.kind === 'thinking.delta' || e.kind === 'tool.input_delta';
    if (typeof e.cursor === 'number') { if (fragment && e.cursor <= twin.cursor) return; twin.cursor = Math.max(twin.cursor, e.cursor); }
    const seen = seenOf(id);
    const hostEvent = hostEventId(twin, e);
    if (e.kind === 'message.user') {
      if (seen.has(hostEvent)) return;
      seen.add(hostEvent);
      // Under his own item id: the row he sent from here, stored already.
      if (c.itemId && seen.has(`item:${c.itemId}`)) return;
      // Typed on the host by someone else: it keeps its own item id and is written here as theirs.
      if (c.text) { seen.add(`item:${c.itemId}`); emit(id, 'message.user', { itemId: c.itemId || `host:${hostEvent}`, text: c.text, writer: { scope: 'peer', host: twin.runtime }, hostEvent }, e.at); }
      return;
    }
    if (MIRRORED.has(e.kind) || TERMINAL.has(e.kind)) {
      if (!fragment) { if (seen.has(hostEvent)) return; seen.add(hostEvent); }
      mirror(id, twin, e, fragment ? c : { ...c, hostEvent });
    }
  }

  /** The legacy host's rows: his echo recognised by its words, a row typed on the host given an `rt:` id (remote-runtime-legacy.js). */
  function applyLegacy(id, twin, e) {
    const c = e.content || {};
    if (typeof e.cursor === 'number') twin.cursor = Math.max(twin.cursor, e.cursor);
    if (e.kind === 'message.user') {
      if (!legacy.consumeEcho(twin, c) && c.text) emit(id, 'message.user', { itemId: `rt:${e.cursor}`, text: c.text }, e.at);
      return;
    }
    if (MIRRORED.has(e.kind) || TERMINAL.has(e.kind)) mirror(id, twin, e, c);
  }

  /** A run's own events (deltas, tools, run state) written here as a local run writes them; the settled block is placed at its first delta's row here. */
  function mirror(id, twin, e, c) {
    if (MIRRORED.has(e.kind)) {
      if (!twin.busy) { twin.busy = true; twin.running = true; }
      let content = c;
      if (e.kind === 'assistant.message') {
        const { firstCursor: _hostCursor, ...rest } = c;
        const began = startsOf(twin).get(blockKey(c));
        content = { ...(Number.isSafeInteger(began) ? { ...rest, firstCursor: began } : rest), writer: { scope: 'group', host: twin.runtime } }; // the host's own work: the group's
      }
      const written = emit(id, e.kind, content, e.at);
      if (e.kind === 'assistant.delta') {
        const key = blockKey(c);
        const starts = startsOf(twin);
        if (!starts.has(key) && Number.isSafeInteger(written?.cursor)) starts.set(key, written.cursor);
      }
    } else if (TERMINAL.has(e.kind)) {
      forgetBlockStarts(twin);
      emit(id, e.kind, e.kind === 'run.completed' ? { ...c, remote: true } : c, e.at);
      endTurn(id, twin);
    }
  }

  /** The turn may have ended while the stream was down and left no event this side saw (the host restarted mid-run): ask once per connection. */
  async function reconcile(id, twin, actions) {
    if (!twin.busy || twin.pending.length || now() - twin.sentAt < 6000) return;
    let data;
    try {
      if (actions) data = await readJson(twin.runtime, await fetchPeer(twin.runtime, `/api/sync?conversation=${encodeURIComponent(twin.remoteId)}&after=${twin.cursor}`, { method: 'GET' }));
      else data = await call(twin.runtime, { op: 'read', conversationId: twin.remoteId, after: twin.cursor });
    } catch { return; }
    if (!twin.busy || data.busy || (data.rows || data.events || []).length) return;
    emit(id, 'run.completed', { remote: true, synthesized: true });
    endTurn(id, twin);
    save();
  }

  /** The chat's events after the stored cursor, read by cursor in pages and applied by id; ends when the host has nothing more. */
  async function catchUp(id, twin) {
    for (let page = 0; page < 500; page += 1) {
      const data = await readJson(twin.runtime, await fetchPeer(twin.runtime, `/api/sync?conversation=${encodeURIComponent(twin.remoteId)}&after=${twin.cursor}`, { method: 'GET' }));
      const events = data.events || [];
      for (const e of events) apply(id, twin, e, true);
      if (events.length) save();
      if (!data.truncated || !events.length) return;
    }
  }

  async function consume(id, twin, s) {
    // The protocol is asked of the host before the feed opens, and holds for this connection (an offline host throws here and is retried).
    const actions = await speaksActions(twin.runtime);
    s.actions = actions;
    const { response, rt } = actions
      ? await fetchPeer(twin.runtime, `/api/events?conversation=${encodeURIComponent(twin.remoteId)}&after=${twin.cursor}`, { method: 'GET', signal: s.ctl.signal })
      : await request(twin.runtime, { op: 'events', conversationId: twin.remoteId, after: twin.cursor }, { signal: s.ctl.signal });
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
          if (frame.events) { for (const e of frame.events) apply(id, twin, e, actions); changed = true; }
          else if (frame.hello) {
            mark(twin.runtime, true);
            twin.offlineNoted = false;
            reconcile(id, twin, actions).catch(() => {});
          } else if (frame.resync) { s.resync = true; s.ctl.abort(); changed = true; } // too far behind for the held events: reconnect from the stored cursor, which replays them from the host's log
        }
        if (changed) save();
      }
    } finally { clearTimeout(idle); try { reader.releaseLock(); } catch { /* already released */ } }
  }

  /** Keeps one stream per chat that has a chat on a host; reconnects with backoff, resuming from the stored cursor. Idempotent. */
  function attach(key) {
    const twin = twins[key];
    if (!twin?.remoteId || streams.has(key)) return;
    const id = key.includes('@') && twin.conversationId ? twin.conversationId : key; // a retired twin is keyed chat@host
    const s = { stop: false, ctl: null, twin };
    streams.set(key, s);
    (async () => {
      let delay = RECONNECT_MIN_MS;
      while (!s.stop && twins[key] === twin) {
        s.ctl = new AbortController();
        try { await consume(id, twin, s); delay = RECONNECT_MIN_MS; }
        catch (cause) {
          if (s.stop) break;
          if (s.resync) {
            // The host said this feed is too far behind its log head to replay (sse.js). Its backlog was skipped, so reconnecting from the same
            // cursor would be told the same thing again, forever, and lose what the run wrote meanwhile: read the chat by cursor
            // (/api/sync, the same events, paged) and reconnect from where that reached.
            s.resync = false; delay = RECONNECT_MIN_MS;
            if (s.actions) await catchUp(id, twin).catch(() => {});
            else continue; // a legacy host replays from the stored cursor
            continue;
          }
          const err = cause instanceof RemoteError ? cause : new RemoteError(`${labelOf(twin.runtime)} is offline (${cause?.cause?.code || cause?.name || cause?.message})`, { offline: true });
          if (err.offline) mark(twin.runtime, false, err.message);
          noteOffline(id, twin, err);
        }
        if (s.stop) break;
        await sleep(delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
      if (streams.get(key) === s) streams.delete(key);
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
        detach(id); delete twins[id]; seenIds.delete(id); save(); decide({ event: 'twin-released', chat: id, runtime: twin.runtime }); continue;
      }
      if (twin.pending.length) await flush(id).catch(() => {});
      attach(id);
    }
  }

  /** Stop is total: the chat's own twin and any turn left running in the background on another host. */
  function interrupt(id) {
    let any = false;
    for (const key of [id, ...retiredOf(id)]) { if (interruptTwin(id, twins[key])) any = true; }
    return any;
  }
  function interruptTwin(id, twin) {
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
    // The host answers with its own run.cancelled on the feed. Stop is the host's own run.interrupt action.
    const failed = (cause) => {
      twin.busy = false; twin.running = false; save();
      emit(id, 'run.error', { message: `Stop could not reach ${label}: ${cause.message}` });
    };
    speaksActions(twin.runtime)
      .then((actions) => (actions
        ? postAction(twin.runtime, { op: ACTIONS.INTERRUPT, conversationId: twin.remoteId, actionId: newId(), payload: { cancelQueued: false } })
        : call(twin.runtime, { op: 'interrupt', conversationId: twin.remoteId })))
      .catch(failed);
    return true;
  }

  // ---- the runner ------------------------------------------------------------------------------------------------------

  /** The same runner with send/interrupt/isBusy/phase/warm decided per conversation; every other member passes through. */
  function wrap(runner) {
    const local = runner;
    const patched = {
      send(id, text, options = {}) {
        if (!options.recovery) {
          // The first message of a new chat waits for the router's host decision; anything sent while it waits queues behind it.
          const waiting = gates.get(id);
          if (waiting) { waiting.held.push({ text, options }); return { queued: false, injected: false, held: true }; }
          if (options.hostGate === true && gateApplies(id)) return holdForHost(id, text, options);
        }
        const { runtime, reason } = route(id, { localBusy: Boolean(local.isBusy?.(id)) });
        const twin = twinOf(id);
        if (options.recovery) {
          // A message the boot found unanswered: the twin already holds it (forwarded or waiting), else it was a local turn.
          if (twin && (twin.sentIds.includes(options.itemId) || twin.pending.some((p) => p.itemId === options.itemId))) return { queued: false, injected: false, duplicate: true, remote: true };
          return local.send(id, text, options);
        }
        if (reason.startsWith("the router's pick")) {
          // Written down once: the header and the next sends say it runs here, as a host-switched row (an auto host event).
          decide({ event: 'auto-host-skipped', chat: id, host: store.conversation(id)?.host, reason });
          emit(id, 'conversation.host', { host: null, auto: true });
        }
        if (runtime && config()[runtime]) return sendRemote(id, text, { itemId: options.itemId || `rt-${now()}`, display: options.display ?? text, runtimeId: runtime, reason });
        if (runtime) {
          // The chat's host is not reachable from this server (no address or token): fail loudly, never fall back to a run on this host.
          decide({ event: 'refused', chat: id, runtime, reason: 'host not configured' });
          emit(id, 'message.user', { itemId: options.itemId || `rt-${now()}`, text: options.display ?? text });
          emit(id, 'run.error', { message: `This chat's host is "${runtime}", which this server has no address for (hosts.json). Nothing was run.` });
          return { queued: false, injected: false };
        }
        // Back on this host after remote turns: the local run has not seen them, so the missed transcript goes first. The
        // runner sees the seeded text.
        options = { ...options, display: options.display ?? text };
        if (twin && twin.localSeen != null) {
          const seed = seedTranscript(store.allConversationEvents(id), { after: twin.localSeen, exclude: options.itemId });
          if (seed) { text = withSeed(seed, text, `on ${labelOf(twin.runtime)}`); decide({ event: 'return-local', chat: id, runtime: twin.runtime, seededChars: seed.length }); }
          twin.localSeen = null; save();
        }
        return local.send(id, text, options);
      },
      interrupt(id, options) {
        if (cancelGate(id)) return true;
        const remote = interrupt(id);
        const mine = local.interrupt(id, options);
        return remote || mine;
      },
      isBusy: (id) => gates.has(id) || isRemoteBusy(id) || local.isBusy(id),
      phase: (id) => (gates.has(id) || isRemoteBusy(id) ? 'running' : local.phase(id)),
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
    sendThrough = (id, text, options) => patched.send(id, text, options);
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

  return { wrap, route, tick, flush, start, stop, status, probe, call, inject, attach, detach, doorHooks, twins: () => twins, twin: twinOf, isRemoteBusy, runtimes: config, decide };
}
