

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { createPaceClock } from './pace.js';
import { adoptRelay } from './relay-child.js';
import { SIGNALS } from './translate.js';
import { adapterFor, availableProviders, orphanMarkers } from './providers/contract.js';
import { UPLOAD_ROOT } from './uploads.js';
import { carriedTranscript } from './handoff.js';
import { takeEcho } from './echo-match.js';
import { effectiveFastMode, newId } from '../core/contract.js';
import {
  DEADLINES, DEFAULT_TIMING, EFFECTS, PHASES, initialState, step as machineStep,
} from './session-machine.js';

const CONTEXT_WINDOW = Math.max(100_000, Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) || 800_000);

const IDLE_SHUTDOWN_MS = 30 * 60 * 1000;

const INTERRUPT_GRACE_MS = Number(process.env.WEBCHAT_INTERRUPT_GRACE_MS || 8000);


const KILL_ESCALATION_MS = Number(process.env.WEBCHAT_KILL_ESCALATION_MS || 2000);

// How long an asked-for restart lets the child reach its next boundary before it forces it out.
// The child's own boundary grace has to fit inside this one: rev5/pull.mjs writes the partial of
// the model call in flight, drains its queued pushes and exits, bounded by
// TOPHAT_RUNNER_RESTART_GRACE_MS (default 2000ms), so 5s leaves room for a slow ledger write.
const RESTART_GRACE_MS = Number(process.env.WEBCHAT_RESTART_GRACE_MS || 5000);

// After the SIGKILL, how long the restart still waits for the exit before it refuses to start a
// replacement: two processes resuming one ledger session both claim that row, which is worse than
// a conversation whose child arrives with the next message.
const RESTART_KILL_WAIT_MS = Number(process.env.WEBCHAT_RESTART_KILL_WAIT_MS || 1000);

// The restart owns its own grace window, so the escalation the session machine (or stop()) would
// do anyway is armed just behind it: a backstop for the case where this promise is dropped, never
// the thing that decides. Without the gap the two fire in the same millisecond and neither the
// caller nor a test can say which of them forced the child.
const RESTART_BACKSTOP_MS = 250;

// Providers whose child understands the `restart` control request, which aborts the turn at the
// next boundary without killing the process (rev5/pull.mjs, control(): it sets state.restarting,
// aborts the model call in flight and writes what had streamed as the restart boundary). Anything
// else is asked with SIGTERM alone.
const BOUNDARY_RESTART_PROVIDERS = new Set(
  String(process.env.WEBCHAT_BOUNDARY_RESTART_PROVIDERS || 'direct')
    .split(',').map((name) => name.trim()).filter(Boolean),
);

const FIRST_OUTPUT_MS = Number(
  process.env.WEBCHAT_FIRST_OUTPUT_MS || DEFAULT_TIMING[DEADLINES.FIRST_OUTPUT],
);

const SILENCE_MS = Number(process.env.WEBCHAT_SILENCE_MS || 600_000);

const TOOL_CEILING_MS = Number(process.env.WEBCHAT_TOOL_CEILING_MS || 660_000);

const COMPACTION_MS = Number(process.env.WEBCHAT_COMPACTION_MS || 1_800_000);

const SPAWN_MS = Number(process.env.WEBCHAT_SPAWN_MS || DEFAULT_TIMING[DEADLINES.SPAWN]);


const SPAWN_RETRY_MS = Number(process.env.WEBCHAT_SPAWN_RETRY_MS || DEFAULT_TIMING[DEADLINES.SPAWN_RETRY]);

export { controlRequestsFor } from './providers/claude.js';

/** What a revived child is told, once, when the run the restart killed had work in it. It is delivered as a
 * recovery message, so it never becomes a message.user and the owner never sees a sentence he did not write.
 */
export const CARRY_ON_TEXT = 'The server restarted and cut your last run off mid-thought. Nothing new has been asked of you:'
  + ' pick the work up from where it stopped, check what was already done before redoing it, and carry on.';

export function orphanPids(listing, uploadRoot, markers = orphanMarkers()) {
  const out = [];
  for (const line of String(listing || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    if (ppid !== '1') continue;
    // A relay (scripts/relay.mjs) carries its child's whole command line after `--`, markers and upload root
    // included, and is re-parented to launchd once the server that spawned it is gone, which is every relay a
    // boot adopts. It is not an orphan: adoption takes it back, and app.js adoptRelays ends the ones nobody
    // named. Its child, if the relay itself has died, is re-parented in turn and is swept as before.
    if (/\/scripts\/relay\.mjs\s/u.test(command)) continue;
    if (!markers.some((marker) => command.includes(marker))) continue;
    if (!uploadRoot || !command.includes(uploadRoot)) continue;
    out.push(Number(pid));
  }
  return out;
}

/**
 * The one word for "this run ended because the process was signalled for a restart". It is not a new word: it is
 * what reconcile.js already writes on the run.error it leaves for a run the last process abandoned
 * (CUT_OFF_MESSAGE, reason 'server-restart'), and what rev5/pull.mjs now puts on the result of a turn its
 * SIGTERM handler cut short. Everything that has to tell a restart kill from the owner pressing stop reads this
 * one word, so there are two cases in the store and not three.
 */
export const RESTART_KILL_REASON = 'server-restart';

/** Whether the child's own result says the turn ended because this process asked it to leave for a restart.
 * rev5/pull.mjs keeps terminal_reason 'interrupted' (that is what translate.js reads to close the run) and puts
 * the cause beside it.
 */
/**
 * The row a child's own death leaves behind. Exported because the walks drive it rather than
 * copying it (answering.model.test.js, endtoend.model.test.js): the note the owner reads after a
 * crash is part of the answering machine, and a test with its own copy of it proves nothing.
 */
export function deathStatus({ how, oom = false, waiting = 0, tail = null, code = null, signal = null }) {
  return {
    state: waiting ? 'running' : 'idle',
    note: `The assistant process stopped on its own with ${how}`
      + `${oom ? ', having run out of memory' : ''}.`
      + (waiting ? ' Picking the message up again.' : ' Nothing was waiting, so nothing was picked up.'),
    detail: tail || null,
    code: code ?? null,
    signal: signal ?? null,
    oom,
  };
}

export function restartKilledResult(message) {
  return message?.type === 'result' && message.terminal_cause === RESTART_KILL_REASON;
}

/** The record of which conversations have a child right now, kept in a small file beside the event
 * store so it outlives this process. A child is written when it spawns and dropped when its
 * session ends on purpose, so whatever is left in the file after a kickstart, a crash or a
 * `launchctl kickstart -k` is exactly the set of conversations that were working when the server
 * went away. Boot reads it and brings them back (app.js), which the unfinished-run resume alone
 * cannot do: a conversation whose last run had already discharged has nothing unfinished, and
 * before this it simply stayed dead.
 */
export function openLiveChildren(path) {
  if (!path) return null;
  let children = {};
  const load = () => {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      children = raw && typeof raw.children === 'object' && raw.children ? raw.children : {};
    } catch { children = {}; }
  };
  load();
  const flush = () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      // Written whole and renamed into place: a half-written record read at boot would either
      // revive nothing or throw, and this file is the only thing that knows what was running.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, at: new Date().toISOString(), children }, null, 1)}\n`);
      renameSync(tmp, path);
    } catch (error) {
      console.error(`[webchat] could not write the live-child record ${path}: ${error.message}`);
    }
  };
  return {
    path,
    ids() { return Object.keys(children); },
    list() { return Object.entries(children).map(([conversationId, info]) => ({ conversationId, ...info })); },
    record(conversationId, info = {}) {
      // The revival count outlives the child it counts. A boot spawns the replacement and the spawn writes this
      // record again, so if the count lived only in the entry the spawn replaces, a server that dies again a
      // second later would start the count from zero and the cap below would never bite.
      const before = children[conversationId];
      const revivals = Number(before?.revivals || 0);
      children[conversationId] = { at: new Date().toISOString(), ...(revivals ? { revivals } : {}), ...info };
      flush();
    },
    // How many times a boot has already brought this conversation back on its own, with nothing to show for it.
    revivals(conversationId) { return Number(children[conversationId]?.revivals || 0); },
    countRevival(conversationId) {
      const entry = children[conversationId];
      if (!entry) return 0;
      entry.revivals = Number(entry.revivals || 0) + 1;
      flush();
      return entry.revivals;
    },
    // A child that reached the end of a turn is working, not looping, so the count of unproductive automatic
    // revivals goes back to zero and the next restart may bring this conversation back again.
    clearRevivals(conversationId) {
      const entry = children[conversationId];
      if (!entry || !entry.revivals) return false;
      delete entry.revivals;
      flush();
      return true;
    },
    forget(conversationId) {
      if (!(conversationId in children)) return false;
      delete children[conversationId];
      flush();
      return true;
    },
    reload: load,
  };
}

/** Where the rev 5 runner keeps its ledger; the same rule as rev5/pull.mjs ledgerPath(). */
export function runnerLedgerPath(env = process.env) {
  return env.TOPHAT_RUNNER_RUNNER_DB
    || join(env.TOPHAT_STATE_DIR || join(homedir(), '.local', 'state', 'tophat'), 'rev5', 'runner.sqlite');
}

/**
 * How many subagents of this session the ledger still calls running. A subagent of the rev 5
 * runner is an async task inside the child process, not a process of its own, so a restart does
 * end it: the next start marks it `uncertain` and keeps its ledger session (rev5/agents.mjs). The
 * count is read here only so a restart can say what it is about to cost. Read-only and best
 * effort: a missing file, an old schema or a locked database all count as none.
 */
export function runningSubagents(sessionId, { path = runnerLedgerPath() } = {}) {
  if (!sessionId || !path || !existsSync(path)) return 0;
  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE parent_session = ? AND status = 'running'").get(sessionId);
    return Number(row?.n || 0);
  } catch { return 0; } finally {
    try { db?.close(); } catch {  }
  }
}

/**
 * Whether what a child said means it could not authenticate. rev5/model.mjs readKey() throws
 * ModelError('auth', 'TOPHAT_RUNNER_API_KEY_FILE is not set') when its process has no credential
 * named, and pull.mjs writes that out as the turn's result error, so the sentence that reaches
 * the runner is "The model request failed (auth: TOPHAT_RUNNER_API_KEY_FILE is not set)." A child
 * that says this before it has produced anything was born without a credential; it cannot be
 * this conversation's runner, however it came to be started.
 */
export function isAuthFailure(message) {
  return /\(auth:/u.test(String(message ?? ''));
}

/** What a child has to have said before it counts as one that is really working. */
const PRODUCED = new Set([
  'assistant.delta', 'assistant.message', 'thinking.delta', 'tool.started', 'tool.completed',
  'agent.started', 'context.compacted', 'run.completed',
]);

export function createRunner({
  store, defaultCwd, spawnImpl = spawn, now = () => new Date().toISOString(), onTurnEnd = () => {},
  
  
  
  
  
  timing = {}, beforeDispatch = null, onUserMessage = null, paceIntervalMs = 600000, paceNow = Date.now,
  // The one environment of this runner: the object a child is asked about and the object a child
  // is given. Both questions are put to the same `env` so no path can fork with variables the
  // readiness check never saw. It stays `process.env` itself by default, because serve.mjs edits
  // process.env in place on a SIGHUP reload (TOPHAT_RUNNER_RUNTIME_DIR names the new build) and the
  // next spawn has to see that.
  env = process.env,
  
  
  
  liveChildren = null,
  // Where this runner hands its children to the next server process and reads them back from:
  // { path, shape } (app.js). Without it a server restart ends every child, as it always did.
  handover = null,
  adoptImpl = adoptRelay,
  // The spawn for providers that can be handed over (adapter.handover): a relay (relay-child.js
  // relaySpawner). Every other provider keeps spawnImpl and dies with the server as it always has.
  relaySpawnImpl = null,
} = {}) {
  const live = new Map();
  const accepting = new Map();
  // Evaluation captures still running beside their messages' dispatch; serialised per conversation, never gating dispatch.
  const capturing = new Map();
  const captureGeneration = new Map();
  // The restart in flight for a conversation, so a second ask joins the first instead of racing
  // it; cleared when it answers.
  const restarts = new Map();

  
  
  
  // Whether a child started here could authenticate at all, asked once, of the one environment
  // this runner spawns with.
  function providerReadiness(adapter, model = null) {
    try { return adapter?.ready ? adapter.ready(env, model) : { ok: true, missing: null, reason: '' }; }
    catch (cause) { return { ok: false, missing: 'provider', reason: cause?.message || String(cause) }; }
  }

  // The hard gate. A process that cannot authenticate must never be written down as a
  // conversation's live runner: this record is what a boot revives from and what a later process
  // reads as "that conversation already has a child", so a keyless process that recorded itself
  // would both hide and displace the child that is really working. The check sits at the one
  // place the record is written, so no spawn path added later can get round it.
  const recordLive = (conversationId, info, adapter = null) => {
    const readiness = providerReadiness(adapter);
    if (!readiness.ok) {
      console.error(`[webchat] not recording a live child for ${conversationId}: ${readiness.reason}.`
        + ' A process without a credential is never this conversation\'s runner.');
      return false;
    }
    try { liveChildren?.record(conversationId, info); return true; } catch { return false; }
  };
  const forgetLive = (conversationId) => { try { liveChildren?.forget(conversationId); } catch {  } };

  // The directory a conversation's child runs in. A stored cwd that is no longer a directory this process can
  // see would fail the spawn of the relay with ENOENT, and the chat with it. The default is what every new
  // conversation gets, so an old one whose directory is gone gets the same, said once.
  const unusableCwd = new Set();
  const cwdFor = (conversation) => {
    const stored = conversation?.cwd || null;
    if (!stored) return defaultCwd;
    let usable = false;
    try { usable = statSync(stored).isDirectory(); } catch { usable = false; }
    if (usable) return stored;
    if (!unusableCwd.has(stored)) {
      unusableCwd.add(stored);
      console.error(`[webchat] cwd ${stored} is not a directory here; conversations stored with it run in ${defaultCwd}`);
    }
    return defaultCwd;
  };

  const TIMING = {
    [DEADLINES.FIRST_OUTPUT]: FIRST_OUTPUT_MS,
    [DEADLINES.SILENCE]: SILENCE_MS,
    [DEADLINES.INTERRUPT_GRACE]: INTERRUPT_GRACE_MS,
    [DEADLINES.KILL_ESCALATION]: KILL_ESCALATION_MS,
    [DEADLINES.IDLE_SHUTDOWN]: IDLE_SHUTDOWN_MS,
    [DEADLINES.TOOL_CEILING]: TOOL_CEILING_MS,
    [DEADLINES.COMPACTION]: COMPACTION_MS,
    [DEADLINES.SPAWN]: SPAWN_MS,
    [DEADLINES.SPAWN_RETRY]: SPAWN_RETRY_MS,
    ...timing,
  };

  
  
  
  
  
  
  
  for (const name of Object.values(DEADLINES)) {
    if (!(TIMING[name] > 0)) throw new Error(`runner has no duration for deadline ${name}`);
  }

  // from the outside that is a chat stuck on "reconnecting" with a pile of unsent messages.
  //
  // The deltas are held here for a beat and appended as one event instead. The reducer concatenates
  // `partial` (core/reducer.js) and work-service.js accumulates it the same way, so joining the
  // fragments before the append renders byte-for-byte what the fragments rendered. Ordering is kept
  // by flushing whatever is held before any other event of that conversation is written, and before
  // a delta belonging to a different tool call. The first fragment's timestamp is the batch's.
  const DELTA_COALESCE_MS = 100;
  const DELTA_COALESCE_BYTES = 8192;
  const heldDeltas = new Map();

  function flushDeltas(conversationId) {
    const held = heldDeltas.get(conversationId);
    if (!held) return;
    heldDeltas.delete(conversationId);
    if (held.timer) clearTimeout(held.timer);
    store.append(conversationId, 'tool.input_delta', {
      itemId: held.itemId, tool: held.tool, partial: held.partial, agentId: held.agentId
    }, { runId: held.runId, at: held.at });
  }

  function flushAllDeltas() {
    for (const conversationId of [...heldDeltas.keys()]) flushDeltas(conversationId);
  }

  // Where a text block STARTED, carried on the event that settles it.
  //
  // A row is placed at the earliest cursor it has been seen under, which is right live, where the
  // first `assistant.delta` creates it. A cold open does not always get the deltas: a hydrate or
  // load-earlier window can begin after them and still contain the `assistant.message`, which the
  // model finishes after that step's `tool.started` events and which therefore carries a later
  // cursor than the tool cards it was written above. The block then sorted below its own tool
  // calls. The settling event says where the block began, so the one window is enough to place it.
  // the reducer falls back to the event's own cursor, which is what it used before, so nothing
  // needs backfilling.
  const blockStart = new Map();
  const blockKey = (conversationId, content) => `${conversationId}\u0000${content?.agentId || ''}\u0000${content?.itemId || ''}`;

  function forgetBlockStarts(conversationId) {
    const prefix = `${conversationId}\u0000`;
    for (const key of blockStart.keys()) if (key.startsWith(prefix)) blockStart.delete(key);
  }

  function emit(conversationId, runId, kind, content) {
    if (kind === 'tool.input_delta') {
      const held = heldDeltas.get(conversationId);
      // A different tool call, or a different run, is a different stream of fragments.
      if (held && (held.itemId !== content?.itemId || held.runId !== runId)) flushDeltas(conversationId);
      const open = heldDeltas.get(conversationId);
      if (open) {
        open.partial += content?.partial || '';
        if (open.partial.length >= DELTA_COALESCE_BYTES) flushDeltas(conversationId);
        return;
      }
      const batch = {
        runId, itemId: content?.itemId, tool: content?.tool, agentId: content?.agentId,
        partial: content?.partial || '', at: now(), timer: null
      };
      heldDeltas.set(conversationId, batch);
      if (batch.partial.length >= DELTA_COALESCE_BYTES) { flushDeltas(conversationId); return; }
      batch.timer = setTimeout(() => flushDeltas(conversationId), DELTA_COALESCE_MS);
      batch.timer?.unref?.();
      return;
    }
    flushDeltas(conversationId);
    if (kind === 'assistant.message') {
      const started = blockStart.get(blockKey(conversationId, content));
      if (Number.isSafeInteger(started)) content = { ...content, firstCursor: started };
    }
    const event = store.append(conversationId, kind, content, { runId, at: now() });
    if (kind === 'assistant.delta') {
      const key = blockKey(conversationId, content);
      if (!blockStart.has(key) && Number.isSafeInteger(event?.cursor)) blockStart.set(key, event.cursor);
    } else if (kind === 'run.completed' || kind === 'run.error' || kind === 'run.cancelled') {
      forgetBlockStarts(conversationId);
    }
    return event;
  }

  

  function signalSession(session, sig) {
    
    
    if (!session.child) return;
    if (sig === 'interrupt') {
      session.provider.interrupt(session.link);
      return;
    }
    // A restart is asked at a boundary because the work either side of it is worth keeping, and
    // the child's own tool processes and background jobs live in its process group: a group
    // SIGTERM would take them with it. While a restart is being asked for, the polite signal goes
    // to the child alone; the SIGKILL that follows still takes the group, because a child that
    // ignored its boundary leaves nothing worth keeping behind it.
    const gentle = Boolean(session.gentleSignal) && sig === 'SIGTERM';
    // Only a real fork owns a process group, and only a real process has a pid to signal; a
    // handle that never became one still gets kill() so a test's fake child hears the signal.
    if (session.groupOwner && session.child.pid > 0 && !gentle) {
      try { process.kill(-session.child.pid, sig); return; } catch {  }
    }
    try { session.child.kill(sig); } catch {  }
  }

  

  function guardStream(stream, label, onError) {
    if (typeof stream?.on !== 'function') return false;
    stream.on('error', (error) => onError(error, label));
    return true;
  }

  function clearDeadline(session, name) {
    if (name === 'all') {
      for (const timer of session.timers.values()) clearTimeout(timer);
      session.timers.clear();
      return;
    }
    const timer = session.timers.get(name);
    if (timer) { clearTimeout(timer); session.timers.delete(name); }
  }

  function setDeadline(session, name, ms) {
    
    
    if (!(ms > 0)) throw new Error(`refusing to arm ${name} with a duration of ${ms}`);
    clearDeadline(session, name);
    const timer = setTimeout(() => {
      session.timers.delete(name);
      dispatch(session.conversationId, { type: 'deadline_fired', name });
    }, ms);
    timer.unref?.();
    session.timers.set(name, timer);
  }

  

  function dispatch(conversationId, event) {
    const session = live.get(conversationId);
    if (!session) return null;
    
    
    
    
    
    
    
    
    
    
    
    
    session.inbox.push(event);
    if (session.draining) return session.machine;
    session.draining = true;
    try {
      while (session.inbox.length) {
        const queued = session.inbox.shift();
        const [next, effects] = machineStep(session.machine, queued, { timing: TIMING });
        session.machine = next;
        if (next.phase !== PHASES.RUNNING || next.maintenance) session.pace?.stop();
        perform(conversationId, session, effects);
      }
    } finally {
      session.draining = false;
      
      
      session.inbox.length = 0;
    }
    // Nothing owns a process and nothing is owed, so the session is over rather than waiting. A child
    // that already exited counts as no process: its exit handler may have queued child_exited while
    // this loop was draining (a kill that returns synchronously), in which case the handler saw the
    // old phase and left the cleanup to us; child_exited cleared every deadline, so nothing else would.
    if ((!session.child || session.childExited) && session.machine.phase === PHASES.IDLE && !session.machine.owed.length) {
      stop(conversationId);
    }
    return session.machine;
  }

  
  function perform(conversationId, session, effects) {
    for (const e of effects) {
      switch (e.type) {
        case EFFECTS.EMIT:
          
          
          
          
          
          
          
          
          
          
          
          try {
            emit(conversationId, session.runId, e.kind, e.content);
          } catch (error) {
            session.emitFailures = (session.emitFailures || 0) + 1;
            console.error(`[webchat] could not write ${e.kind} for ${conversationId}`
              + ` (${session.emitFailures} lost): ${error.message}`);
          }
          break;
        case EFFECTS.DELIVER:
        case EFFECTS.INJECT:
          session.runId = e.type === EFFECTS.DELIVER ? newId() : session.runId;
          
          
          
          
          
          
          
          
          
          
          
          try {
            
            
            
            
            
            
            
            
            ensurePace(conversationId, session);
            if (!session.machine.maintenance) session.pace.start();
            // The transcript a provider change left behind rides in front of the first message
            // this child is given, and only that one: everything after it is in its own session.
            const outgoing = session.carry ? `${session.carry}\n${e.text}` : e.text;
            session.carry = null;
            session.provider.deliver(session.link, outgoing, { injected: e.type === EFFECTS.INJECT, clockContext: session.provider.id === 'codex' ? session.pace.context : session.pace.context() });
            
            
            
            
            session.awaitingHandoff.push({ at: Date.now(), injected: e.type === EFFECTS.INJECT, text: e.text });
            
            
            
            if (session.awaitingHandoff.length > 64) session.awaitingHandoff.shift();
          } catch (error) {
            console.error(`[webchat] could not hand ${conversationId} its message: ${error.message}`);
            dispatch(conversationId, { type: 'child_aborted', reason: `delivery failed: ${error.message}` });
          }
          break;
        case EFFECTS.SIGNAL:
          signalSession(session, e.signal);
          break;
        case EFFECTS.SET_DEADLINE:
          setDeadline(session, e.name, e.ms);
          break;
        case EFFECTS.CLEAR_DEADLINE:
          clearDeadline(session, e.name);
          break;
        case EFFECTS.ABANDON_CHILD:
          abandonChild(session);
          break;
        case EFFECTS.SPAWN:
          
          
          
          
          
          
          
          
          
          
          
          
          
          
          if (session.child && !session.childExited) {
            dispatch(conversationId, { type: 'child_spawned' });
            
            
            
            dispatch(conversationId, { type: 'context_observed', window: CONTEXT_WINDOW });
          
          
          } else respawn(session);
          break;
        default:
          break;
      }
    }
  }

  

  function ensurePace(conversationId, session) {
    session.pace ??= createPaceClock({ now: paceNow, intervalMs: paceIntervalMs,
      active: () => live.get(conversationId) === session && session.machine.phase === PHASES.RUNNING && !session.machine.maintenance,
      remind: (text, meta = {}) => {
        try {
          // Only a checkpoint the provider actually took gets a card: a reminder the adapter
          // refused never reached the model, so showing it would be a lie about the transcript.
          if (session.provider.pace?.(session.link, text) === false) return;
          emit(conversationId, session.runId, 'pace.check', { itemId: newId(), text, elapsedMs: meta.elapsedMs ?? null });
        } catch (error) { console.error(`[webchat] pace delivery failed: ${error.message}`); }
      },
    });
    return session.pace;
  }

  function reportDeath(session, { code, signal, asked }) {
    const tail = session.stderr.trim().split('\n').slice(-8).join('\n');
    // A relay gone from under the child (relay-child.js: the connection dropped, or the relay never came up)
    // is reported as SIGKILL on the wire; name it for what it is rather than a signal nobody sent.
    const lostRelay = Boolean(session.child?.exitInfo?.lostRelay);
    const how = lostRelay ? 'its relay gone' : signal ? `signal ${signal}` : `exit code ${code}`;
    const oom = /JavaScript heap out of memory|FATAL ERROR: .*Allocation failed/i.test(session.stderr);
    const line = `[webchat] claude child for ${session.conversationId} died: ${how}`
      + `${asked ? ' (we asked it to)' : ''}${oom ? ' (V8 heap exhaustion)' : ''}`
      + `${tail ? `\n${tail}` : ''}`;
    
    
    console.error(line);
    if (asked) return;
    
    
    if (!signal && (code === 0 || code === null || code === undefined)) return;
    
    
    
    
    
    
    const signature = `${how}|${oom}`;
    if (session.lastDeath === signature) return;
    session.lastDeath = signature;
    
    
    
    
    
    
    
    
    
    
    
    // What the row says next depends on whether anything is waiting. A child that dies with an
    // owed message is picked up: the machine respawns on child_exited and the row keeps working. A
    // child that dies with nothing owed is not picked up by anyone -- child_exited with an empty
    // `owed` goes idle and emits nothing unless the machine itself ordered the kill -- so claiming
    // 'running' here left the conversation reading "working, picking the message up again" for
    // ever, with no child and nothing to pick up. Found by the composed walk
    // (endtoend.model.test.js) on owner_message -> turn_completed -> child_exit.
    const waiting = session.machine?.owed?.length || 0;
    emit(session.conversationId, session.runId, 'run.status', deathStatus({ how, oom, waiting, tail, code, signal }));
  }

  

  function abandonChild(session) {
    const child = session.child;
    if (!child) return;
    const groupOwner = session.groupOwner;
    session.child = null;
    
    
    
    
    
    try { session.provider?.dispose?.(session.link); } catch {  }
    session.link = null;
    
    
    session.childExited = true;
    // A pidless handle from a real fork never became a process, so name that instead of a mount.
    if (groupOwner && !(child.pid > 0)) {
      console.error(`[webchat] dropping a handle for ${session.conversationId} that never became a process;`
        + ' the fork failed, so there is nothing to kill');
      child.unref?.();
      return;
    }
    console.error(`[webchat] abandoning an unkillable child for ${session.conversationId}`
      + ` (pid ${child.pid}); it is probably blocked on a disk or a network mount`);
    try {
      if (session.groupOwner) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {  }
    child.unref?.();
  }

  

  function respawn(session) {
    const conversationId = session.conversationId;
    const conversation = store.conversation(conversationId);
    
    
    if (!conversation) {
      dispatch(conversationId, { type: 'spawn_failed', reason: 'the conversation is gone' });
      return;
    }
    const adapter = adapterFor(conversation.settings);
    // Asked before anything is killed, replaced or forked, because a provider that cannot work in
    // this process must cost nothing: a child started without the rev 5 key file reaches the
    // Messages API, fails auth, writes a run.error into the conversation, and claims the ledger row
    // of the child that is really working. So: say so once, let the machine settle, touch nothing.
    // The model matters: the direct provider holds one key file per model family, so a chat on
    // gpt-6-astra is unrunnable in a process that has only the Anthropic key even though the
    // provider as a whole looks ready. Ask about the model this conversation actually carries.
    const readiness = providerReadiness(adapter, conversation.settings?.model || null);
    if (!readiness.ok) {
      const alive = Boolean(session.child) && !session.childExited;
      console.error(`[webchat] not starting a ${adapter.id} child for ${conversationId}: ${readiness.reason}`
        + `${alive ? '; the live child of this conversation is untouched' : ''}`);
      // A conversation whose child is alive hears nothing at all: its transcript belongs to the
      // turn in flight, and a failed attempt beside it is a log line, not an error in the chat.
      // Otherwise the session machine says it, once, in the same run.error that names the message
      // it could not deliver (one refusal used to show two errors). A missing credential is not
      // load: retrying it four more times only delays a message that was never going to be
      // delivered, and ends in "send it again once this host is less loaded", which is false.
      // Fail it once, with the reason.
      // Every message it could not deliver carries the reason (retry-wakes.js reads notReady to
      // know a wake was refused); the runner's own line, for a machine that is not starting and so
      // will not speak, is said once per reason.
      const refusal = alive ? {} : { notReady: readiness.missing || 'provider', provider: adapter.id };
      const tell = !alive && session.notReadyReason !== readiness.reason;
      if (tell) session.notReadyReason = readiness.reason;
      if (tell && session.machine.phase !== PHASES.STARTING) {
        try {
          emit(conversationId, session.runId, 'run.error', {
            provider: adapter.id,
            notReady: refusal.notReady,
            message: `This chat's assistant process is not configured in this server process (${readiness.reason}),`
              + ' so nothing was started. Anything already running was left alone.',
          });
        } catch {  }
      }
      dispatch(conversationId, { type: 'spawn_failed', reason: `${adapter.id} is not ready: ${readiness.reason}`, fatal: true, ...refusal });
      return;
    }
    session.notReadyReason = null;
    
    
    
    
    
    
    if (session.child && !session.childExited) {
      console.error(`[webchat] replacing a live child for ${conversationId}; something spawned twice`);
      try { session.child.kill('SIGTERM'); } catch {  }
    }
    const cwd = cwdFor(conversation);
    
    
    
    
    
    // A session id belongs to the provider that minted it. Resuming one with a different
    // provider resumes nothing: codex refuses an id it never wrote, and rev 5 opens an empty
    // session under it and answers the next message as if the chat had just begun. So a
    // switch starts a new session and carries the transcript out of the webchat's own store
    // into the first message instead.
    const sessionOwner = conversation.sessionId
      ? (conversation.sessionProvider || null)
      : (session.resumeFrom ? session.resumeProvider || null : null);
    const foreignSession = Boolean((conversation.sessionId || session.resumeFrom)
      && sessionOwner && sessionOwner !== adapter.id);
    const ownSession = foreignSession ? null : conversation.sessionId;
    const resumeFrom = ownSession || (foreignSession ? null : session.resumeFrom) || null;
    const sessionId = ownSession || newId();
    if (foreignSession) {
      const carried = carriedTranscript(store, conversationId, { from: sessionOwner, to: adapter.id });
      if (carried) {
        session.carry = carried;
        console.error(`[webchat] ${conversationId} moved from ${sessionOwner} to ${adapter.id};`
          + ` carrying ${carried.length} characters of transcript into the next message`);
      }
    }
    
    
    
    
    
    
    session.provider = adapter;
    
    
    
    
    let child;
    let link;
    session.spawnSettings = { ...conversation.settings };
    const impl = adapter.handover === true && relaySpawnImpl ? relaySpawnImpl : spawnImpl;
    try {
      
      
      
      
      
      ({ child, link } = adapter.spawn({
        conversationId,
        sessionId: ownSession ? null : sessionId,
        resumeFrom,
        fork: Boolean(session.fork && !ownSession),
        settings: conversation.settings,
        cwd,
        contextWindow: CONTEXT_WINDOW,
        spawnImpl: impl,
        uploadRoot: UPLOAD_ROOT,
        // The same object adapter.ready(env) just answered about.
        env,
        push: (message) => {
          if (session.child !== child) return;
          handle(session, message);
        }
      }));
    } catch (cause) {
      console.error(`[webchat] could not spawn a ${adapter.id} child for ${conversationId}:`, cause);
      dispatch(conversationId, { type: 'spawn_failed', reason: String(cause?.code || cause?.message || cause),
        fatal: cause?.code === 'provider-not-ready' });
      return;
    }
    if (!child) {
      dispatch(conversationId, { type: 'spawn_failed', reason: `${adapter.id} produced no child` });
      return;
    }
    // The real spawn sets pid synchronously on success, so no pid means the fork itself failed:
    // a failed spawn rather than a child waiting for its message. A test's fake spawnImpl sets
    // no pid and is not judged by this rule.
    // A relay child learns its pid from the relay a moment later; a relay that never comes up reports
    // itself through 'error', which wire() turns into a failed start.
    if (impl === spawn && !(child.pid > 0)) {
      child.on('error', (error) => {
        console.error(`[webchat] the fork for ${conversationId} failed: ${error?.code || error?.message || error};`
          + ' no process was started, so there is nothing to kill');
      });
      child.unref?.();
      dispatch(conversationId, { type: 'spawn_failed', reason: 'the fork produced no process' });
      return;
    }
    wire(session, child, link, adapter, { sessionId: ownSession || sessionId, cwd });

    
    dispatch(conversationId, { type: 'child_spawned' });
    
    
    
    
    dispatch(conversationId, { type: 'context_observed', window: CONTEXT_WINDOW });
  }

  

  // Everything a child needs to be part of a session: its streams read, its exit heard, its record
  // written. Shared by a fresh spawn and by a child adopted from the last server process.
  function wire(session, child, link, adapter, record) {
    const conversationId = session.conversationId;
    session.link = link || { child };
    session.child = child;
    session.childExited = false;
    
    
    
    session.awaitingHandoff = [];
    session.groupOwner = spawnImpl === spawn && !child.relay;
    session.ctx = adapter.emptyContext();
    session.stderr = '';
    
    
    
    recordLive(conversationId, { sessionId: record.sessionId, provider: adapter.id, pid: child.pid ?? null, cwd: record.cwd }, adapter);

    const onLine = (line) => {
      
      
      
      if (session.child !== child) return;
      if (!line.trim()) return;
      const message = adapter.parse(line);
      
      
      
      if (message === null || message === undefined) return;
      handle(session, message);
    };
    // A child under a relay (relay-child.js) hands over numbered lines and counts one as processed only
    // once this returns; that count is what a handover records. Anything else is read the old way.
    let lines = null;
    if (typeof child.onLine === 'function') child.onLine(onLine);
    else {
      lines = createInterface({ input: child.stdout });
      lines.on('line', onLine);
    }
    child.stderr.on('data', (chunk) => {
      if (session.child !== child) return;
      session.stderr = `${session.stderr}${chunk}`.slice(-4000);
    });

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    const streamFailure = (label, error, consequence) => {
      const code = error?.code || error?.errno || error?.name || 'error';
      console.error(`[webchat] claude child ${label} for ${conversationId} failed: `
        + `${code}${error?.syscall ? ` on ${error.syscall}` : ''}: ${error?.message || error} `
        + `-- ${consequence}`);
    };

    
    
    
    
    
    
    
    
    guardStream(child.stdin, 'stdin', (error) => {
      const mine = session.child === child;
      const owed = mine ? session.machine.owed.length : 0;
      streamFailure('stdin', error, owed
        ? `${owed} message(s) still owed and NOT delivered; restarting the child rather than waiting for its silence bar`
        : 'nothing was owed');
      
      
      
      
      if (mine && owed) dispatch(session.conversationId, { type: 'child_aborted', reason: `stdin failed: ${error?.message || error}` });
    });

    
    
    
    
    
    
    
    
    
    
    
    
    let wireLost = false;
    const loseWire = (label) => (error) => {
      if (wireLost) return;
      wireLost = true;
      streamFailure(label, error, 'the wire to the child is gone; treating the child as dead');
      if (live.get(conversationId) !== session || session.child !== child) return;
      if (session.childExited) return;
      try { child.kill('SIGTERM'); } catch {  }
    };
    guardStream(child.stdout, 'stdout', loseWire('stdout'));
    if (lines) guardStream(lines, 'stdout reader', loseWire('stdout reader'));

    
    
    guardStream(child.stderr, 'stderr', (error) => {
      streamFailure('stderr', error, 'diagnostics only; the run continues');
    });
    child.on('exit', (code, signal) => {
      if (session.child === child) session.childExited = true;
      if (live.get(conversationId) !== session) return;
      
      
      
      if (session.child !== child) return;
      
      const asked = session.machine.terminating;
      reportDeath(session, { code, signal, asked });
      dispatch(conversationId, { type: 'child_exited' });
      if (session.machine.phase === PHASES.IDLE && session.machine.owed.length === 0) live.delete(conversationId);
      // The live-child record is what a boot revives from, so it outlives an exit nobody here
      // asked for (a crash, a kickstart, the SIGTERM of a service restart) and goes only when the
      // runner itself put the child down and left nothing in its place: the 30-minute idle
      // shutdown above all, whose conversation was asleep rather than working when the process
      // went away. A respawn writes the record again, so an exit the machine answers with a new
      // child (an owed message, a restart) keeps it.
      if (asked && !live.has(conversationId) && !accepting.has(conversationId)) forgetLive(conversationId);
    });
    child.on('error', (error) => {
      if (live.get(conversationId) !== session || session.child !== child) return;
      // An 'error' is a child that is not there (a fork that failed, a relay that cannot be reached). Without
      // marking it, the respawn that child_exited asks for found this dead handle "alive" and reused it.
      session.childExited = true;
      emit(conversationId, session.runId, 'run.error', { message: error.message });
      dispatch(conversationId, { type: 'child_exited' });
    });
  }

  function resumptionFor(conversation) {
    if (conversation.sessionId) {
      return { resumeFrom: conversation.sessionId, fork: false, resumeProvider: conversation.sessionProvider || null };
    }
    const parent = conversation.parentId ? store.conversation(conversation.parentId) : null;
    // A fork inherits the parent's session, so it inherits the question of who minted it too.
    if (parent?.sessionId) {
      return { resumeFrom: parent.sessionId, fork: true, resumeProvider: parent.sessionProvider || null };
    }
    return { resumeFrom: null, fork: false, resumeProvider: null };
  }

  function start(conversationId, { resumeFrom = null, fork = false, resumeProvider = null } = {}) {
    const conversation = store.conversation(conversationId);
    if (!conversation) throw new Error(`Unknown conversation ${conversationId}`);
    const existing = live.get(conversationId);
    if (existing) return existing;
    const adapter = adapterFor(conversation.settings);
    const session = {
      conversationId,
      child: null,
      
      childExited: true,
      groupOwner: false,
      
      
      
      
      provider: adapter,
      link: null,
      ctx: adapter.emptyContext(),
      runId: newId(),
      machine: initialState(),
      
      
      
      inbox: [],
      draining: false,
      timers: new Map(),
      resumeFrom,
      resumeProvider,
      fork,
      stderr: '',
      lastDeath: null,
      
      
      unknownShapes: new Set(),
      
      
      
      
      awaitingHandoff: [],
    };
    live.set(conversationId, session);
    return session;
  }

  

  function handle(session, message) {
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    const { ctx, emit: transcript, inputs, signal, shape } =
      session.provider.ingest(session.link, session.ctx, message);
    session.ctx = ctx;
    if (signal === SIGNALS.UNKNOWN) reportUnknownShape(session, shape);
    if (signal === SIGNALS.USER_REPLAY) reportHandoff(session, message);
    for (const event of transcript) {
      let content = event.content;
      // The id in an init event is the live child's, so the provider that owns it is this
      // session's adapter. Stored beside it, a later switch can tell a resumable id from one
      // another provider minted.
      if (event.kind === 'conversation.meta' && content.sessionId && !content.sessionProvider) {
        content = { ...content, sessionProvider: session.provider.id };
      }
      if (event.kind === 'conversation.meta' && content.sessionId && content.settings) {
        // Init describes the settings at spawn, not changes sent while startup
        // was in flight. A late init must not undo a newer user choice and make
        // the next live-settings diff compare against an obsolete model.
        const current = store.conversation(session.conversationId)?.settings || {};
        const settings = Object.fromEntries(Object.entries(content.settings)
          .filter(([key]) => current[key] === session.spawnSettings?.[key]));
        content = { ...content, settings };
      }
      if (event.kind === 'run.error' && !session.produced && isAuthFailure(content?.message)) {
        disownKeyless(session, content?.message);
        return;
      }
      // translate.js turns any aborted result into run.cancelled and copies terminal_reason into the reason, so
      // both a restart kill and the owner's stop arrive here saying 'interrupted'. The child said which it was;
      // this is where that survives into the event the webchat writes, and it is the whole difference between a
      // conversation a boot must bring back and one it must leave alone.
      if (event.kind === 'run.cancelled' && restartKilledResult(message)) {
        content = { ...content, reason: RESTART_KILL_REASON };
      }
      if (PRODUCED.has(event.kind)) session.produced = true;
      emit(session.conversationId, session.runId, event.kind, content);
      // The main lane said something to him (a subagent's report is not an answer).
      if (event.kind === 'assistant.message' && !content?.agentId && String(content?.text || '').trim()) dispatch(session.conversationId, { type: 'child_answered' });
    }
    for (const input of inputs) dispatch(session.conversationId, input);
    if (signal === SIGNALS.TURN_ENDED) {
      
      
      session.lastDeath = null;
      // A turn that reached its end is proof this conversation is not in a restart loop, so the count of
      // automatic revivals it has spent goes back to zero. Without this, three legitimate deploys in a day would
      // use up the cap and the fourth restart would leave real work dead.
      try { liveChildren?.clearRevivals?.(session.conversationId); } catch {  }
      onTurnEnd(session.conversationId);
      retireIfIdle(session);
    }
  }

  

  /**
   * A child that failed its first model call on authentication: it has no credential, so it can
   * never answer, and every moment it stays the session's child is a moment it holds the ledger
   * row of whatever child is really working. It is stopped with its own handle -- stop() signals
   * session.child and nothing else, so no healthy child of any conversation is ever touched --
   * dropped from this runner's live map, and its live-child record is removed, because a record
   * naming a child that cannot work must not stand in for one that can. The chat is told once, in
   * a sentence that says what happened and that nothing else was disturbed.
   */
  function disownKeyless(session, message) {
    const conversationId = session.conversationId;
    if (session.disowned) return;
    session.disowned = true;
    console.error(`[webchat] a child of ${conversationId} could not authenticate (${message});`
      + ' it is stopped and is not this conversation\'s runner. No other child was signalled.');
    try {
      emit(conversationId, session.runId, 'run.error', {
        provider: session.provider?.id || null,
        notReady: 'credential',
        message: `This chat's assistant process could not authenticate (${message}), so it was stopped`
          + ' before it could answer and is not this conversation\'s runner.'
          + ' Anything already running was left alone.',
      });
    } catch {  }
    stop(conversationId, { forget: true });
  }

  function reportHandoff(session, message) {
    const pending = takeEcho(session.awaitingHandoff, message);
    if (!pending || !pending.injected) return;
    const waited = Date.now() - pending.at;
    emit(session.conversationId, session.runId, 'run.status', {
      state: 'running',
      handoffMs: waited,
      note: `your message reached the model after ${(waited / 1000).toFixed(1)}s`,
    });
  }

  

  function reportUnknownShape(session, shape) {
    if (session.unknownShapes.has(shape)) return;
    session.unknownShapes.add(shape);
    console.error(`[webchat] unrecognised claude stream shape ${shape} for ${session.conversationId};`
      + ' treated as control traffic, so it moves no deadline. Add it to classify() in translate.js.');
  }

  

  function retireIfIdle(session) {
    if (!session.retireWhenIdle) return;
    if (session.machine.phase !== PHASES.IDLE) return;
    session.retireWhenIdle = false;
    stop(session.conversationId);
  }

  function retireSession(conversationId) {
    const session = live.get(conversationId);
    if (!session) return 'absent';
    if (session.machine.phase === PHASES.IDLE) {
      stop(conversationId);
      return 'retired';
    }
    session.retireWhenIdle = true;
    return 'deferred';
  }

  

  function askChild(session, request, done) {
    session.provider.control(session.link, request, done);
  }

  
  
  
  
  
  
  
  
  
  
  function stop(conversationId, { forget = true, ask = true, escalateMs = KILL_ESCALATION_MS } = {}) {
    captureGeneration.set(conversationId, (captureGeneration.get(conversationId) || 0) + 1);
    if (forget) forgetLive(conversationId);
    const session = live.get(conversationId);
    if (!session) return;
    clearDeadline(session, 'all');
    session.pace?.stop();
    live.delete(conversationId);
    
    
    
    try { session.provider?.dispose?.(session.link); } catch {  }
    // A relay holding this child is told no server will adopt it, so it goes when the child does.
    try { session.child?.release?.(); } catch {  }
    if (!session.child || session.childExited) return;
    if (ask) signalSession(session, 'SIGTERM');
    const escalate = setTimeout(() => {
      
      
      session.gentleSignal = false;
      signalSession(session, 'SIGKILL');
    }, Math.max(1, escalateMs));
    escalate.unref?.();
  }

  // Starting a child with nothing to say to it, so the next message meets a process that is
  // already up. The session id comes from the store, so the child resumes the same ledger row.
  function warmSession(conversationId) {
    const conversation = store.conversation(conversationId);
    if (!conversation) return false;
    if (live.has(conversationId)) return false;
    start(conversationId, resumptionFor(conversation));
    dispatch(conversationId, { type: 'warm_requested' });
    return true;
  }

  // Waiting for something that may already have happened, with a bound on the waiting. Resolves
  // true if the promise settled inside the window, false if the window ran out first.
  //
  // This timer is deliberately not unref'd, unlike the deadlines elsewhere in here. Those are a
  // server's idle clocks and must never be the reason a process stays up; this one is the few
  // bounded seconds of a restart somebody asked for, and unref'ing it means that in a process
  // with nothing else on the loop (a script calling restart(), not the service with its listening
  // socket) the promise never settles and the caller is told nothing at all.
  function within(promise, ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish(false), Math.max(1, ms));
      promise.then(() => finish(true), () => finish(true));
    });
  }

  // Whatever the store still owes this one conversation an answer for. The boot resume asks the
  // same question of every conversation at once; a restart asks it of one.
  function unansweredIn(conversationId) {
    try { return (store.unfinished?.({ includeIds: true }) || []).filter((row) => row.id === conversationId); }
    catch (error) {
      console.error(`[webchat] could not read the unanswered messages of ${conversationId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Replacing one conversation's child at the next boundary the child reaches, touching no other
   * conversation. Nothing of the conversation lives in the child: the history is the runner
   * ledger and start() only claims the session row, so a restart costs one spawn (0.20s measured
   * cold for `node rev5/pull.mjs`) and loses only the model call in flight, which the child
   * writes out as a marked partial before it goes.
   *
   * The ask is the `restart` control request where the child understands it (rev5/pull.mjs
   * control(): abort the turn at the boundary, write the partial) followed by one SIGTERM, which
   * is that child's own graceful exit path. Both are sent because the control request alone does
   * not end the process; a provider that does not know the request is asked with the SIGTERM
   * alone. If the child has not gone by `graceMs` it is SIGKILLed, and only then is its process
   * group taken with it.
   *
   * Answers rather than throws: the caller is a person asking for a restart, not a run that went
   * wrong. The answer is
   *   { ok, conversationId, action, restarted, asked, boundaryAck, escalated, exited, respawned,
   *     owed, subagents, graceMs, ms, note }
   * where action is one of restarted | started | noop | racing | skipped | busy | stuck.
   */
  async function restartSession(conversationId, options = {}) {
    const {
      reason = null,
      graceMs = RESTART_GRACE_MS,
      killWaitMs = RESTART_KILL_WAIT_MS,
      
      
      control = null,
    } = options;
    const startedAt = Date.now();
    const why = reason ? `: ${reason}` : '';
    const shape = {
      ok: true, conversationId, action: 'noop', restarted: false, asked: 'none', boundaryAck: null,
      escalated: false, exited: false, respawned: false, owed: 0, subagents: 0, graceMs, ms: 0, note: '',
    };
    const done = (patch) => ({ ...shape, ...patch, ms: Date.now() - startedAt });

    const session = live.get(conversationId);

    
    
    if (session && (!session.child || session.childExited)) {
      return done({ action: 'racing', note: 'a child is already being started for this conversation, so a restart would race it' });
    }
    
    
    if (accepting.has(conversationId)) {
      return done({ ok: false, action: 'busy', note: 'a message is still being accepted here; restart once it has reached the child' });
    }
    
    
    
    if (!session) {
      const unanswered = unansweredIn(conversationId);
      if (!unanswered.length) {
        return done({ note: `${conversationId} has no live child and nothing unanswered, so there is nothing to restart; the next message starts one` });
      }
      for (const { text, itemId } of unanswered) {
        try { api.send(conversationId, text, { itemId, recovery: true }); }
        catch (error) { return done({ ok: false, action: 'failed', note: `could not ask the unanswered message again: ${error.message}` }); }
      }
      return done({
        action: 'started', respawned: true, owed: unanswered.length,
        note: `no child was live; started one and asked its ${unanswered.length} unanswered message(s) again${why}`,
      });
    }

    const phase = session.machine.phase;
    if (phase !== PHASES.RUNNING && phase !== PHASES.IDLE) {
      
      
      return done({ action: 'skipped', note: `the child is already ${phase}, so it is on its way out without a restart` });
    }

    const child = session.child;
    const owedBefore = [...session.machine.owed];
    const sessionId = store.conversation(conversationId)?.sessionId || null;
    // From this runner's own environment, like everything else it opens: a process whose env
    // names no ledger (a test, a build) must not reach the owner's real one.
    const subagents = runningSubagents(sessionId, { path: runnerLedgerPath(env) });
    if (subagents) {
      
      
      
      console.error(`[webchat] restarting ${conversationId} with ${subagents} subagent(s) still running;`
        + ' they are tasks inside the child, so the next start marks them uncertain and keeps their ledger sessions');
    }

    
    
    const exited = new Promise((resolve) => {
      if (session.childExited) { resolve(true); return; }
      if (typeof child.once === 'function') child.once('exit', () => resolve(true));
    });

    
    let asked = 'sigterm';
    let boundaryAck = null;
    const useControl = control ?? (
      BOUNDARY_RESTART_PROVIDERS.has(session.provider?.id)
      && typeof session.provider?.control === 'function'
      && Boolean(child.stdin) && !child.stdin.destroyed
    );
    if (useControl) {
      asked = 'control';
      try { askChild(session, { subtype: 'restart' }, (response) => { boundaryAck = response?.subtype === 'success'; }); }
      catch (error) {
        asked = 'sigterm';
        boundaryAck = false;
        console.error(`[webchat] ${conversationId} would not take the restart request (${error.message}); asking with SIGTERM alone`);
      }
    }

    
    session.gentleSignal = true;
    if (phase === PHASES.RUNNING) {
      
      
      
      
      dispatch(conversationId, { type: 'child_aborted', reason: `restart requested${why}` });
      
      
      
      
      if (live.get(conversationId) === session && !session.childExited) {
        setDeadline(session, DEADLINES.KILL_ESCALATION, graceMs + RESTART_BACKSTOP_MS);
      }
    } else {
      
      
      
      signalSession(session, 'SIGTERM');
      stop(conversationId, { ask: false, escalateMs: graceMs + RESTART_BACKSTOP_MS, forget: false });
    }

    
    let gone = await within(exited, graceMs);
    let escalated = false;
    if (!gone && !session.childExited) {
      
      
      escalated = true;
      session.gentleSignal = false;
      signalSession(session, 'SIGKILL');
      gone = await within(exited, killWaitMs);
    }
    if (!gone && !session.childExited) {
      return done({
        ok: false, action: 'stuck', asked, boundaryAck, escalated: true, owed: owedBefore.length, subagents,
        note: `the child ignored the boundary request for ${graceMs}ms and then survived SIGKILL;`
          + ` no replacement was started, because two children resuming session ${sessionId} would both claim its ledger row`,
      });
    }

    
    
    session.gentleSignal = false;
    
    
    
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    if (phase === PHASES.IDLE && !live.has(conversationId)) warmSession(conversationId);
    const after = live.get(conversationId);
    const respawned = Boolean(after && (!after.childExited || after.machine.phase === PHASES.STARTING));

    return done({
      action: 'restarted', restarted: true, asked, boundaryAck, escalated, exited: true, respawned,
      owed: owedBefore.length, subagents,
      note: `restarted at the boundary${why}`
        + `; asked with ${asked === 'control' ? 'the restart control request and SIGTERM' : 'SIGTERM'}`
        + `${escalated ? `, forced with SIGKILL after ${graceMs}ms` : ''}`
        + `${owedBefore.length ? `; ${owedBefore.length} owed message(s) are asked again on the new child` : '; nothing was owed, so the new child waits idle'}`
        + `${subagents ? `; ${subagents} running subagent(s) end with the old child and are marked uncertain` : ''}`,
    });
  }

  /** Bringing a conversation's child back after the server itself went away.
   *
   * Two shapes, because there are two things that can be true of a conversation whose child is gone. Warm is the
   * old one: the start the next message would have paid for, done up front, asking the child nothing, for a
   * conversation that owes no answer. That nudge goes in as a recovery message (runner.send with recovery:
   * true), which is exactly how the boot resume re-asks an unanswered message: the text reaches the child, no
   * message.user is written, and the owner sees no words he did not type.
   */
  function reviveSession(conversationId, { reason = 'the server restarted', carryOn = false, text = CARRY_ON_TEXT } = {}) {
    if (live.has(conversationId)) {
      return { ok: true, conversationId, revived: false, note: 'a child is already live for this conversation' };
    }
    if (!store.conversation(conversationId)) {
      forgetLive(conversationId);
      return { ok: false, conversationId, revived: false, note: 'no such conversation any more; its record is dropped' };
    }
    let started = false;
    let carried = false;
    if (carryOn) {
      try {
        api.send(conversationId, text, { recovery: true });
        started = live.has(conversationId) || accepting.has(conversationId);
        carried = started;
      } catch (error) {
        console.error(`[webchat] could not tell ${conversationId} to carry on after the restart: ${error.message};`
          + ' starting it warm instead so the next message meets a process that is up');
      }
    }
    if (!started) started = warmSession(conversationId);
    
    
    
    // Counted here rather than at the call site so every way back in is counted, and counted after the spawn,
    // which writes the record again (openLiveChildren.record keeps the count across that).
    const revivals = started ? (liveChildren?.countRevival?.(conversationId) ?? 0) : 0;
    return {
      ok: started, conversationId, revived: started, carriedOn: carried, revivals,
      note: started
        ? `${carried ? 'child started again and told to carry on where it stopped' : 'warm child started again'} (${reason})`
        : 'no child could be started for this conversation',
    };
  }

  // ---- Handing children to the next server process, and taking them back ------------------------
  //
  // A restart used to end every conversation's child: this process SIGTERMed them on the way out and the
  // next boot revived them with a "carry on" nudge, a new process and a lost model call. A child under a
  // relay (scripts/relay.mjs) outlives this process, so on the way out each one is paused at a line
  // boundary and written down with everything this process knew about it that the store does not: the
  // session machine, the translator context, the run id, where its text blocks began, and the number of
  // the last output line processed. The next server reads that record, attaches to the same relays, and
  // reads on from the next line, so not one event is written twice or lost (the store cannot tell).
  //
  // What is not handed over is ended as before and revived as before: a child not under a relay, a
  // provider whose link holds state this process cannot write down (codex), a conversation caught between
  // phases (starting, interrupting, being killed, being restarted, a message half accepted). And a record
  // written by different session-machine or translator code is refused whole: `shape` fingerprints them.
  const HANDOVER_VERSION = 1;
  const HANDOVER_PHASES = new Set([PHASES.IDLE, PHASES.RUNNING]);
  const HANDOVER_MAX_AGE_MS = 10 * 60_000;

  function handoverRefusal(conversationId, session) {
    if (!session.child?.relay) return 'not under a relay';
    if (session.childExited || session.child.exited) return 'its child already exited';
    if (session.provider?.handover !== true) return `the ${session.provider?.id} provider cannot be handed over`;
    if (accepting.has(conversationId)) return 'a message is half accepted';
    if (restarts.has(conversationId)) return 'it is being restarted';
    if (!HANDOVER_PHASES.has(session.machine.phase)) return `it is ${session.machine.phase}`;
    if (session.machine.terminating) return 'its child is being put down';
    if (session.draining || session.inbox.length) return 'it is mid-dispatch';
    if (typeof session.provider.handoverState === 'function') {
      const state = session.provider.handoverState(session.link);
      if (state?.refuse) return state.refuse;
    }
    return null;
  }

  function handoffAll({ path: file = handover?.path, shape = handover?.shape ?? null } = {}) {
    if (!file) return { handed: [], kept: [] };
    flushAllDeltas();
    const sessions = [];
    const kept = [];
    for (const [conversationId, session] of live) {
      const refusal = handoverRefusal(conversationId, session);
      if (refusal) { kept.push({ conversationId, why: refusal }); continue; }
      const linkState = typeof session.provider.handoverState === 'function' ? session.provider.handoverState(session.link) : null;
      const processedSeq = session.child.pause();
      const prefix = `${conversationId}\u0000`;
      sessions.push({
        conversationId,
        relayDir: session.child.dir,
        relayId: session.child.relayId,
        childPid: session.child.pid ?? null,
        processedSeq,
        provider: session.provider.id,
        linkState,
        runId: session.runId,
        machine: session.machine,
        ctx: session.ctx,
        awaitingHandoff: session.awaitingHandoff,
        spawnSettings: session.spawnSettings || null,
        resumeFrom: session.resumeFrom || null,
        resumeProvider: session.resumeProvider || null,
        fork: Boolean(session.fork),
        stderr: session.stderr || '',
        lastDeath: session.lastDeath || null,
        produced: Boolean(session.produced),
        retireWhenIdle: Boolean(session.retireWhenIdle),
        blockStarts: [...blockStart].filter(([key]) => key.startsWith(prefix)).map(([key, cursor]) => [key.slice(prefix.length), cursor]),
      });
    }
    const record = { v: HANDOVER_VERSION, shape, at: new Date().toISOString(), pid: process.pid, sessions };
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      // No record means no adoption: resume reading, and let the ordinary shutdown end them.
      console.error(`[webchat] could not write the handover record (${error.message}); ending children as before`);
      for (const { conversationId } of sessions) live.get(conversationId)?.child?.resume?.();
      return { handed: [], kept: [...kept, ...sessions.map(({ conversationId }) => ({ conversationId, why: 'no record' }))] };
    }
    for (const { conversationId } of sessions) {
      const session = live.get(conversationId);
      clearDeadline(session, 'all');
      session.pace?.stop();
      live.delete(conversationId);
      session.child.detach();
    }
    if (sessions.length || kept.length) {
      console.error(`[webchat] handed ${sessions.length} running child(ren) to the next server`
        + `${kept.length ? `; ending ${kept.length} as before (${kept.map(({ conversationId, why }) => `${conversationId}: ${why}`).join('; ')})` : ''}`);
    }
    return { handed: sessions.map(({ conversationId }) => conversationId), kept };
  }

  // Read once: the record is renamed aside before anything is adopted, so a boot that dies half way
  // cannot adopt the same relays twice. Returns what was adopted and what was refused; the caller ends
  // the relays of the refused (relay-child.js endRelay) and the ordinary revive picks them up.
  function adoptHandoff({ path: file = handover?.path, shape = handover?.shape ?? null, accepts = handover?.accepts ?? [] } = {}) {
    const result = { adopted: [], refused: [] };
    if (!file || !existsSync(file)) return result;
    let record;
    try {
      const consumed = `${file}.consumed`;
      renameSync(file, consumed);
      record = JSON.parse(readFileSync(consumed, 'utf8'));
    } catch (error) {
      console.error(`[webchat] could not read the handover record: ${error.message}`);
      return result;
    }
    const refuse = (entry, why) => { result.refused.push({ conversationId: entry?.conversationId, relayDir: entry?.relayDir, relayId: entry?.relayId, why }); };
    const entries = Array.isArray(record?.sessions) ? record.sessions : [];
    const report = () => {
      if (result.adopted.length || result.refused.length) {
        console.error(`[webchat] adopted ${result.adopted.length} running child(ren) from the last server`
          + `${result.refused.length ? `; refused ${result.refused.length} (${result.refused.map(({ conversationId, why }) => `${conversationId}: ${why}`).join('; ')})` : ''}`);
      }
      return result;
    };
    if (record?.v !== HANDOVER_VERSION) { entries.forEach((entry) => refuse(entry, `record version ${record?.v}`)); return report(); }
    // A record is for the boot right after the process that wrote it, not one from long ago (relays
    // switched off for a while, say): its relays have ended their children on their own by now.
    const age = Date.now() - Date.parse(record.at || 0);
    if (!(age >= 0 && age < HANDOVER_MAX_AGE_MS)) { entries.forEach((entry) => refuse(entry, `the record is ${Math.round(age / 1000)}s old`)); return report(); }
    if (record.shape !== shape && !accepts.includes(record.shape)) {
      entries.forEach((entry) => refuse(entry, `written by different session code (${record.shape} vs ${shape})`));
      return report();
    }
    for (const entry of entries) {
      const conversationId = entry?.conversationId;
      const conversation = conversationId ? store.conversation(conversationId) : null;
      if (!conversation) { refuse(entry, 'no such conversation'); continue; }
      if (live.has(conversationId)) { refuse(entry, 'already live'); continue; }
      const adapter = adapterFor(conversation.settings);
      if (adapter.id !== entry.provider || adapter.handover !== true || typeof adapter.adoptLink !== 'function') {
        refuse(entry, `provider ${entry.provider} cannot be adopted as ${adapter.id}`);
        continue;
      }
      if (!entry.machine || !HANDOVER_PHASES.has(entry.machine.phase)) { refuse(entry, 'no usable session machine'); continue; }
      let child;
      try { child = adoptImpl({ dir: entry.relayDir, id: entry.relayId, from: Number(entry.processedSeq) + 1 }); }
      catch (error) { refuse(entry, `could not attach: ${error.message}`); continue; }
      const session = {
        conversationId,
        child: null,
        childExited: true,
        groupOwner: false,
        provider: adapter,
        link: null,
        ctx: adapter.emptyContext(),
        runId: entry.runId || newId(),
        // Fields added since the record's server (code-shape.js ADDITIVE_MACHINE_FIELDS) take their initial values.
        machine: { ...initialState(), ...entry.machine },
        inbox: [],
        draining: false,
        timers: new Map(),
        resumeFrom: entry.resumeFrom,
        resumeProvider: entry.resumeProvider,
        fork: entry.fork,
        stderr: '',
        lastDeath: entry.lastDeath,
        unknownShapes: new Set(),
        awaitingHandoff: [],
        spawnSettings: entry.spawnSettings || { ...conversation.settings },
        produced: entry.produced,
        retireWhenIdle: entry.retireWhenIdle,
        adopted: true,
      };
      live.set(conversationId, session);
      const link = adapter.adoptLink(child, {
        conversationId,
        state: entry.linkState || null,
        push: (message) => { if (session.child === child) handle(session, message); },
      });
      wire(session, child, link, adapter, { sessionId: conversation.sessionId, cwd: cwdFor(conversation) });
      session.ctx = entry.ctx || adapter.emptyContext();
      session.awaitingHandoff = Array.isArray(entry.awaitingHandoff) ? entry.awaitingHandoff : [];
      session.stderr = entry.stderr || '';
      for (const [key, cursor] of entry.blockStarts || []) blockStart.set(`${conversationId}\u0000${key}`, cursor);
      // The clocks start again rather than from where they were; each deadline is a bar, not a schedule.
      for (const name of session.machine.pending || []) {
        if (TIMING[name] > 0) setDeadline(session, name, TIMING[name]);
      }
      if (session.machine.phase === PHASES.RUNNING && !session.machine.maintenance) ensurePace(conversationId, session).start();
      result.adopted.push(conversationId);
    }
    return report();
  }

  const api = {
    live,

    handoffAll,
    adoptHandoff,

    

    providers: Object.freeze(availableProviders()),

    

    reapOrphans() {
      let listing = '';
      try { listing = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8' }); }
      catch { return 0; }
      let reaped = 0;
      for (const pid of orphanPids(listing, UPLOAD_ROOT)) {
        try {
          
          
          
          process.kill(-pid, 'SIGKILL');
          reaped += 1;
        } catch {  }
      }
      if (reaped) console.warn(`[webchat] reaped ${reaped} orphaned claude child${reaped === 1 ? '' : 'ren'} from a previous run`);
      return reaped;
    },

    isLive(conversationId) { return live.has(conversationId); },

    
    
    isBusy(conversationId) { return live.get(conversationId)?.machine.phase === PHASES.RUNNING; },

    

    retire(conversationId) { return retireSession(conversationId); },

    // Restarting one child is cheap (the spawn is a fifth of a second and replays no context), so
    // it is an ordinary operation: at a tool or model call boundary, or instead of draining the
    // whole server. Async, because the answer is worth waiting for: it says whether the child
    // went at its boundary or had to be forced.

    restart(conversationId, options = {}) {
      // Two people (or a person and a deploy) asking for the same conversation at once get one
      // restart and the same answer: a second pass would signal a child the first one is already
      // waiting on, and could SIGKILL the replacement the first one had just started.
      const inFlight = restarts.get(conversationId);
      if (inFlight) return inFlight;
      const attempt = restartSession(conversationId, options)
        .finally(() => { if (restarts.get(conversationId) === attempt) restarts.delete(conversationId); });
      restarts.set(conversationId, attempt);
      return attempt;
    },

    // Starting a child for a conversation that had one before this process existed. Boot calls it
    // for every conversation in the live-child record that the unfinished-run resume did not
    // already cover.

    revive(conversationId, options = {}) { return reviveSession(conversationId, options); },

    // The conversations that had a child when the last process went away, newest record first.

    recordedLive() { return (liveChildren?.list() || []).sort((a, b) => String(b.at).localeCompare(String(a.at))); },

    // Dropping a record by hand, for a conversation that must not come back.

    forgetLive(conversationId) { return Boolean(liveChildren?.forget(conversationId)); },

    

    applySettings(conversationId, before = {}, after = {}) {
      const session = live.get(conversationId);
      if (!session) return 'absent';
      if ((before.cwd || null) !== (after.cwd || null)) return retireSession(conversationId);
      
      
      
      
      
      
      
      if ((before.provider || 'claude') !== (after.provider || 'claude')) return retireSession(conversationId);
      const requests = session.provider.controlRequests(before, after, session.link);
      
      
      
      
      if (!requests.length) {
        if (!session.provider.settingsAreLive) return 'unchanged';
        const changed = ['model', 'permissionMode', 'reasoningEffort', 'fastMode']
          .some((key) => before[key] !== after[key]);
        return changed ? 'applied' : 'unchanged';
      }
      if (!session.child?.stdin || session.child.stdin.destroyed) return retireSession(conversationId);
      for (const request of requests) {
        askChild(session, request, (response) => {
          if (response?.subtype === 'success') return;
          
          
          
          console.error(`[webchat] ${conversationId}: ${request.subtype} refused`
            + ` (${JSON.stringify(response).slice(0, 200)}); retiring the child instead`);
          emit(conversationId, session.runId, 'run.status', {
            state: session.machine.phase === PHASES.RUNNING ? 'running' : 'idle',
            note: 'That setting needs a fresh chat process, so this one starts over after the current answer.'
          });
          retireSession(conversationId);
        });
      }
      return 'applied';
    },

    
    owed(conversationId) { return [...(live.get(conversationId)?.machine.owed || [])]; },

    phase(conversationId) { return live.get(conversationId)?.machine.phase || PHASES.IDLE; },

    // Could a turn start for this conversation in this process? The same question respawn() asks before it forks,
    // asked before anything is appended, so an automated sender (goal retry wakes) can refuse instead of posting a
    // message that only earns a run.error.
    readiness(conversationId) {
      const conversation = store.conversation(conversationId);
      if (!conversation) return { ok: false, missing: 'conversation', reason: 'the conversation is gone' };
      return providerReadiness(adapterFor(conversation.settings), conversation.settings?.model || null);
    },

    
    
    
    
    
    
    
    
    
    
    
    
    send(conversationId, text, { itemId = newId(), display = text, attribution = null,
      userTimestamp = null, lineage = null, participantId = null, recovery = false, writer = null } = {}) {
      const conversation = store.conversation(conversationId);
      if (!conversation) throw new Error(`Unknown conversation ${conversationId}`);
      const acceptedAt = now();
      const duplicate = beforeDispatch && !recovery && store.acceptedMessage?.(conversationId, itemId);
      if (duplicate) return { queued: false, injected: false, duplicate: true };
      let prior = [], contextAvailable = true, alreadyCaptured = false;
      try {
        if (beforeDispatch) prior = store.conversationEvents?.(conversationId, { newest: true, limit: 160 }) || [];
        alreadyCaptured = recovery && store.evaluationStatus?.(conversationId, itemId)?.content?.state === 'captured';
      } catch { contextAvailable = false; }
      const generation = captureGeneration.get(conversationId) || 0;
      const priorProviderActivity = live.has(conversationId);
      const wasRunning = live.get(conversationId)?.machine.phase === PHASES.RUNNING;
      if (!recovery) emit(conversationId, null, 'message.user', { itemId, text: display,
        ...(participantId ? { participantId } : {}),
        ...(writer ? { writer } : {}), // who wrote it: a member of the group on a hosted chat (core of rev6/base/writer-scope.mjs)
        ...(beforeDispatch ? { attribution, userTimestamp, lineage, evaluationCapture: 'pending' } : {}) });
      if (!recovery && onUserMessage) { try { onUserMessage(conversationId); } catch { /* a hook never blocks a send */ } }
      const deliver = () => {
        const current = store.conversation(conversationId);
        if (!current) return;
        const session = live.get(conversationId) || start(conversationId, resumptionFor(current));
        dispatch(conversationId, { type: 'user_message', text });
      };
      if (!beforeDispatch) { deliver(); return { queued: false, injected: wasRunning }; }
      const precedingContext = prior.filter(e => ['message.user', 'assistant.message'].includes(e.kind)).slice(-40)
        .map(e => ({ role: e.kind === 'message.user' ? 'user' : 'assistant', itemId: e.content?.itemId || null,
          text: String(e.content?.text || '').slice(0, 2000), at: e.at }));
      const envelope = { messageId: itemId, conversationId, text: display, acceptedAt, userTimestamp,
        attribution, lineage, precedingContext, delivery: wasRunning ? 'steering' : 'initial',
        priorProviderActivity, recovery, contextAvailable };
      // Dispatch never waits on the capture. The capture still begins at acceptance, in acceptance order per conversation,
      // and still reports pending -> its snapshot status; it just runs beside the provider instead of in front of it.
      // Whether a provider was already live is read here, before deliver() starts one.
      envelope.providerActiveAtCapture = live.has(conversationId);
      envelope.priorProviderActivity ||= envelope.providerActiveAtCapture;
      const capture = (capturing.get(conversationId) || Promise.resolve()).catch(() => {}).then(async () => {
        if (generation !== (captureGeneration.get(conversationId) || 0)) return;
        try { if (!alreadyCaptured) await beforeDispatch(envelope); }
        catch {
          try { emit(conversationId, null, 'evaluation.snapshot', { messageId: itemId, state: 'missing', reason: 'bridge-failed' }); } catch {}
        }
      });
      capturing.set(conversationId, capture);
      capture.finally(() => { if (capturing.get(conversationId) === capture) capturing.delete(conversationId); });
      // Dispatch failure remains recoverable from the accepted message. Never dispatch twice.
      try { deliver(); } catch {
        try { emit(conversationId, null, 'run.status', { state: 'queued', note: 'Accepted message awaits provider recovery.' }); } catch {}
      }
      return { queued: false, injected: wasRunning };
    },


    /**
     * Context for the turn that is running, from a member's home host (/api/agent op inject): delivered to the live turn as the model's
     * input and written nowhere else. No message.user (it is not his message and never shows as one), no router or titler hook, no
     * evaluation capture; its text carries the automated-event label that the host's memory intake keeps out of the store
     * (rev6/base/writer-scope.mjs). Only a turn that is running takes it: an idle chat is not woken by context.
     */
    inject(conversationId, text) {
      if (!store.conversation(conversationId)) return { ok: false, injected: false, reason: 'no such conversation' };
      const held = live.get(conversationId);
      if (!held || held.machine.phase !== PHASES.RUNNING) return { ok: false, injected: false, reason: 'no turn is running' };
      dispatch(conversationId, { type: 'user_message', text });
      return { ok: true, injected: true };
    },

    warm(conversationId) {
      if (beforeDispatch) return false; // Evaluation mode starts the provider at the first message, beside its capture.
      return warmSession(conversationId);
    },

    interrupt(conversationId) {
      // Stop fully stops: the runner's interrupt aborts the live turn, kills its calls and cancels every background turn
      // and subagent. With no turn running the machine has nothing to interrupt, but a background turn may still be going,
      // so the signal goes straight to an idle child.
      const held = live.get(conversationId);
      if (held?.child && ![PHASES.RUNNING, PHASES.STARTING].includes(held.machine?.phase)) {
        try { held.provider.interrupt(held.link); } catch {  }
      }
      if (accepting.has(conversationId)) {
        captureGeneration.set(conversationId, (captureGeneration.get(conversationId) || 0) + 1);
        emit(conversationId, null, 'run.cancelled', { reason: 'Cancelled pending evaluation capture and dispatch.' });
      }
      if (!live.has(conversationId)) return accepting.has(conversationId);
      dispatch(conversationId, { type: 'interrupt_requested' });
      return true;
    },

    fork(conversationId, newConversationId) {
      const parent = store.conversation(conversationId);
      if (!parent) throw new Error(`Unknown conversation ${conversationId}`);
      return { resumeFrom: parent.sessionId, parentId: conversationId };
    },

    stop,

    
    
    
    stopAll() { flushAllDeltas(); for (const id of new Set([...live.keys(), ...accepting.keys()])) stop(id, { forget: false }); }
  };

  return api;
}
