import { createEvaluationCapture } from './evaluation-capture.js';


import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { openStore } from './store.js';
import { createRunner, openLiveChildren, RESTART_KILL_REASON } from './runner.js';
import { createTitler } from './autotitle.js';
import { createRouter } from './autoroute.js';
import { startDaily as startFolderDescriptions } from './folder-descriptions.js';
import { createAuth, readSecret } from './auth.js';
import { ACTIONS, newId, normalizeSettings } from '../core/contract.js';
import { canonicalWorkspace, normalizeWorkspace } from '../core/workspaces.js';
import { routePatch } from '../core/model-route.js';
import { RUNNING_STATES, readMark } from '../core/rowstate.js';
import { requestRefresh } from './brief.js';
import { createSpliceLedger, prepareSend } from './sidechat.js';
import { CUT_OFF_MESSAGE, reconcileStuckRuns } from './reconcile.js';
import { acceptedHandoverShapes, builtShape, builtShapeDetail, handoverShape } from './code-shape.js';
import { endRelay, listRelays, relaySpawner } from './relay-child.js';
import { scopeHooks, scopeServiceFor } from './scopes.js';
import { conversationThreads, createRemoveDerivedMemory } from './scope-memory.js';
import { routeFirstMessage } from './scope-router.js';
import { warm as warmWhisper } from '../services/voice/server/whisper-service.js';
import { webchatStorePath } from './paths.js';
import { adapterFor } from './providers/contract.js';
import { BEAT_MS, startLiveness } from './liveness.js';
import { drainObservations, RETENTION_DAYS } from './interaction.js';
import { agentsOwed } from './owed-work.js';
import { runnerLedgerPath } from './translate.js';
import { RETRY_SWEEP_MS, startRetryWakes, storeDeliver, storeProbe } from './retry-wakes.js';
import { cdpEndpoint, closeConversationTabs, dueForSweep, openTabRegistry, openTabsDb, SWEEP_HOUR, sweepTabs, tabsDbPath }
  from '../../../../runner/rev5/cua-tabs.mjs';

const DB_PATH = process.env.WEBCHAT_DB || webchatStorePath('events.sqlite');
export const DEFAULT_CWD = process.env.WEBCHAT_CWD || join(homedir(), '.local', 'share', 'tophat', 'workspace');

// Restarting one conversation's child rides the interrupt action rather than an op of its own:
// validateAction() (src/lib/core/contract.js) refuses any op that is not in the ACTIONS enum, and
// that file is not ours to change here, so a new op would be rejected at the route before it ever
// reached applyAction. `run.interrupt` with { restart: true } in the payload is the same action,
// the same auth, the same idempotency record and the same one conversation.
export const RESTART_FLAG = 'restart';
// Still accepted when something in this process builds an action itself (applyAction, not the
// route): the day the contract lists the op, the client can send it unchanged.
export const RESTART_OP = 'run.restart';

// Where the record of which conversations have a child lives. Beside the event store, so a second
// store (a dev server, a test) keeps its own.
export const LIVE_CHILDREN_PATH = process.env.WEBCHAT_LIVE_CHILDREN || webchatStorePath('live-children.json');

// A revival at boot is for work that was alive, not for an archive sweep: anything whose
// conversation has not been touched inside this window is dropped from the record instead.
const REVIVE_WITHIN_MS = Number(process.env.WEBCHAT_REVIVE_WITHIN_MS || 24 * 3_600_000);
// And a boot does not fork sixty children at once, however long the record is.
const REVIVE_MAX = Number(process.env.WEBCHAT_REVIVE_MAX || 12);
// How many times in a row a boot may bring one conversation back on its own with nothing to show for it. A child
// that reaches the end of a turn clears its count (runner.js, the TURN_ENDED branch of handle), so this only ever
// counts revivals that led nowhere: a child that dies on its first breath, taking the server with it, would
// otherwise be revived by every boot for ever. Small on purpose, and in the style of TOPHAT_RUNNER_AGENT_RESUME_CAP
// in rev5/agents.mjs, which caps subagent relaunches the same way and for the same reason.
/**
 * What a revived child is told when its last run had finished but subagents running in its runner were cut off with
 * it (owed-work.js): the runner relaunches them from their own ledgers when it starts, so the chat's job is to say
 * so, not to redo anything.
 */
export function owedAgentsText(owed) {
  return `The server restarted while ${owed.length} subagent(s) were working for you (${owed.map((a) => a.id).join(', ')}).`
    + ' Your runner relaunches them from where they stopped, and their reports reach you as they finish. Nothing new has been asked of you:'
    + ' check agent_list, tell the owner in one line that the restart interrupted them and what state they are in, and carry on.';
}

export const REVIVE_CAP = Number(process.env.WEBCHAT_REVIVE_CAP) || 3;

/** Why a conversation's last run ended, read from the tail of its own transcript, oldest event first. The answer is
 * one of:
 *   'server-restart' -- the process was signalled for a restart and the run went with it. Either the child said so
 *       (rev5/pull.mjs puts terminal_cause 'server-restart' on the result, runner.js copies it onto run.cancelled)
 *       or the next boot said so for it, because the run was still open when the process vanished (reconcile.js
 *       writes run.error with reason 'server-restart' and CUT_OFF_MESSAGE).
 *   'interrupted'    -- the owner pressed stop. run.cancelled with any other reason counts here: whatever cancelled
 *       it, nobody asked the server to bring it back.
 *   'error', 'completed', 'none' -- the run failed on its own, finished, or the conversation has no run in it.
 *
 * This is the whole classification the boot revival turns on.
 */
export function lastRunEnding(events = []) {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const { kind, content } = events[at] || {};
    const reason = content?.reason || null;
    if (kind === 'run.cancelled') return reason === RESTART_KILL_REASON ? RESTART_KILL_REASON : 'interrupted';
    if (kind === 'run.error') {
      // The message is read as well as the reason because reconcile.js has written this row since before it
      // carried a reason at all, and an old row in the owner's store must still read as a restart kill.
      if (reason === RESTART_KILL_REASON || content?.message === CUT_OFF_MESSAGE) return RESTART_KILL_REASON;
      return 'error';
    }
    if (kind === 'run.completed') return 'completed';
  }
  return 'none';
}

/** How each conversation last ended, asked of a store. The marker, not a tail of the last N events: a
 * conversation of the owner's that has been working for an hour has thousands of tool events since its last run
 * ended, so any window small enough to read at every boot would answer "no ending here" for exactly the busy
 * conversations this is for. runMarkers() is one query for the whole store and gives the cursor of each
 * conversation's last run ending, which is the one row that has to be read. An unreadable conversation is left
 * alone rather than guessed at.
 */
export function endingReader(store, markers = store.runMarkers()) {
  return (id) => {
    try {
      const ended = markers.get(id)?.ended || 0;
      if (!ended) return 'none';
      return lastRunEnding(store.conversationEvents(id, { after: ended - 1, limit: 1 }));
    } catch (cause) {
      console.error(`[app] could not read how ${id} last ended (${cause.message}); leaving it alone`);
      return 'none';
    }
  };
}

/** What a boot should do with the two records it has: the conversations the store still owes an
 * answer (they are sent their message again) and the conversations that had a child when the last
 * process went away (of those, the ones a restart killed are brought back and asked to carry on).
 * Pure, so it can be tested without a boot: build() below only carries it out.
 *
 * A recorded conversation is revived only when its last run ended in a restart kill. Every other ending (the run
 * completed, the run failed on its own) is held too, with the reason said out loud, because "it had a child once"
 * is not a reason to make a model talk.
 */
export function bootPlan({ resuming = [], recorded = [], conversationAt = () => null,
  endingFor = () => 'none', owedFor = () => [], now = Date.now(), within = REVIVE_WITHIN_MS, max = REVIVE_MAX,
  cap = REVIVE_CAP } = {}) {
  const resumingIds = new Set(resuming.map(({ id }) => id));
  const revive = [];
  const drop = [];
  const held = [];
  const owedBy = new Map();
  for (const entry of recorded) {
    const id = entry?.conversationId;
    if (!id || resumingIds.has(id)) continue;
    const at = conversationAt(id);
    // No conversation behind the record, or one nobody has touched in a day: the record is stale
    // and would otherwise fork a child at every boot for ever.
    if (!at) { drop.push(id); continue; }
    const age = now - Date.parse(at);
    if (!(age >= 0) || age > within) { drop.push(id); continue; }
    const ending = endingFor(id);
    // A run that ended on its own is still owed work when subagents were running in its runner or their reports
    // were not yet delivered (owed-work.js): the restart took those, and nothing else will ever reopen the chat.
    // An owner stop stays a stop whatever is owed.
    const owed = ending !== RESTART_KILL_REASON && ending !== 'interrupted' ? owedFor(id) : [];
    if (ending !== RESTART_KILL_REASON && !owed.length) {
      held.push({ id, ending, why: ending === 'interrupted'
        ? 'the owner stopped this run, so a restart is not a reason to start it again'
        : `its last run ended ${ending}, which no restart cut off` });
      continue;
    }
    const revivals = Number(entry.revivals || 0);
    if (revivals >= cap) {
      held.push({ id, ending, why: `it has already been revived ${revivals} time(s) automatically without finishing a turn` });
      continue;
    }
    revive.push(id);
    if (owed.length) owedBy.set(id, owed);
  }
  return { resume: resuming, revive: revive.slice(0, max), deferred: revive.slice(max), drop, held, owedBy };
}

/**
 * Everything a boot reads and writes before it starts anything, in one place: the messages the
 * store still owes an answer, the runs the last process left open (closed here with reason
 * 'server-restart', before the plan is made, so a restart kill can be told from a run that ended on
 * its own), the one announcement per conversation the owner sees while his message is picked up
 * again, and the plan for the conversations that had a child. The sends and the revivals stay with
 * the caller, which owns the runner; this half of a boot touches only the store, so it can be
 * walked (answering.model.test.js) without forking anything.
 */
export function bootResume({ store, live = [], startable = () => true, recorded = [],
  owedLedgerPath = null, now = () => new Date().toISOString() } = {}) {
  // A conversation whose child this boot adopted from the last server (runner.adoptHandoff) is live:
  // its child has every message it was given, so asking again would deliver it twice.
  const liveIds = new Set(live);
  const resuming = store.unfinished({ includeIds: true }).filter(({ id }) => startable(id) && !liveIds.has(id));
  let closed = [];
  try {
    closed = reconcileStuckRuns({ store, live, skip: resuming.map(({ id }) => id) });
    if (closed.length) console.error(`[app] closed ${closed.length} run(s) the last process left open`);
  } catch (cause) {
    console.error(`[app] could not close the runs the last process left open: ${cause.message}`);
  }
  // One per conversation, however many messages it owes: the announcement says the conversation is
  // being picked up, not how much of it.
  const announced = new Set();
  for (const { id } of resuming) {
    if (announced.has(id)) continue;
    announced.add(id);
    store.append(id, 'run.status', { state: 'starting', note: 'Picking this up again; the last attempt was cut off.' },
      { at: now() });
  }
  // A revived child is asked nothing (runner.revive), so a conversation that owes no answer comes back idle
  // and ready rather than inventing a turn. Read after reconcileStuckRuns above, on purpose: a run that was
  // still open when the last process vanished has just been closed with reason 'server-restart', so by the
  // time this asks, every restart kill in the store says so, whether the dying child managed to say it or the
  // reconcile said it for it.
  const plan = bootPlan({
    resuming,
    recorded: recorded.filter((entry) => !liveIds.has(entry?.conversationId)),
    conversationAt: (id) => store.conversation(id)?.updatedAt || null,
    endingFor: endingReader(store, store.runMarkers()),
    owedFor: (id) => {
      const sessionId = store.conversation(id)?.sessionId;
      return sessionId ? agentsOwed({ ledgerPath: owedLedgerPath, sessionId }) : [];
    },
  });
  for (const [id, owed] of plan.owedBy) console.error(`[app] reviving ${id}: it is owed ${owed.length} subagent(s) (${owed.map((a) => `${a.id} ${a.status}`).join(', ')}) that the restart cut off`);
  for (const { id, why } of plan.held) console.error(`[app] not reviving ${id}: ${why}`);
  if (plan.deferred.length) {
    console.error(`[app] ${plan.deferred.length} conversation(s) had a child but wait for their next message:`
      + ` this boot revives at most ${REVIVE_MAX}`);
  }
  return { resuming, closed, announced: [...announced], plan };
}

const BUILD_ENTRY = /^(?:vite|rollup|esbuild|svelte-kit|vitest)(?:\.(?:c|m)?js)?$/u;

/**
 * The one positive sign that a process exists to serve: serve.mjs writes its own pid here before
 * it loads a build's handler.js. The pid is what makes it honest -- every child of the server
 * inherits the variable, so an inherited mark names someone else's pid and a build asked for from
 * inside a tool the server started cannot pass itself off as the server.
 */
export const SERVER_MARK = 'WEBCHAT_SERVER_BOOT';

/** Whether this process is a build rather than a server. Importing this module boots a whole app (the
 * singleton at the bottom of the file), and `vite build` imports every server module to render the
 * routes, so a build inherits whatever environment the shell that asked for it had.
 *
 * The entry test alone did not catch it. SvelteKit 2.70 runs the last two steps of a build,
 * analyse and prerender, in a worker thread of the build process
 * (node_modules/@sveltejs/kit/src/utils/fork.js: `new Worker(fileURLToPath(module), { env: {
 * ...process.env, SVELTEKIT_FORK: 'true' } })`), and analyse.js does `await route.endpoint()` for
 * every route, which imports every +server.js -- and every one of ours imports this module. In
 * that worker `process.argv[1]` is the worker's own file
 * (.../@sveltejs/kit/src/core/postbuild/analyse.js), not `vite`, so the entry test said "server".
 *
 * So: a worker thread is never a server, SVELTEKIT_FORK is never a server, and a build reaps
 * nothing, resumes nothing and revives nothing.
 */
export function relayConfig({ building = bootIsBuild(), env = process.env } = {}) {
  if (env.VITEST || building || env.WEBCHAT_RELAYS === '0') return null;
  const script = env.WEBCHAT_RELAY_SCRIPT;
  if (!script || !existsSync(script)) return null;
  return { script, dir: env.WEBCHAT_RELAY_DIR || webchatStorePath('relays'), handover: env.WEBCHAT_HANDOVER_PATH || webchatStorePath('handover.json') };
}

// Take back what the last server handed over, then end every relay nobody adopted: after a crash there is
// no record, and those children are revived the old way (the live-children record) rather than left running
// unseen beside the revived ones.
export function adoptRelays(runner, relays) {
  let adopted = [];
  try { ({ adopted } = runner.adoptHandoff()); }
  catch (cause) { console.error(`[app] could not adopt the last server's children: ${cause?.message || cause}`); }
  const kept = new Set([...runner.live.values()].map((session) => session.child?.relayId).filter(Boolean));
  for (const relay of listRelays(relays.dir)) {
    if (!relay.alive || kept.has(relay.id)) continue;
    endRelay(relays.dir, relay.id).then((reached) => console.error(`[app] ended relay ${relay.id} of ${relay.conversationId || 'an unknown conversation'}`
      + ` (child ${relay.childPid}), which no handover named${reached ? '' : '; it could not be reached'}`));
  }
  return adopted;
}

export function bootIsBuild({ argv = process.argv, env = process.env, mainThread = isMainThread, pid = process.pid } = {}) {
  if (env.VITEST) return true;
  // serve.mjs, in this very process: whatever the entry is called, it is the server.
  if (env[SERVER_MARK] && env[SERVER_MARK] === String(pid)) return false;
  // No server does its work in a worker thread, and nothing but SvelteKit's own build sets
  // SVELTEKIT_FORK.
  if (!mainThread || env.SVELTEKIT_FORK) return true;
  const entry = String(argv[1] || '').split('/').pop();
  if (!BUILD_ENTRY.test(entry)) return false;
  // `vite dev` and `vite preview` are servers and keep their boot; `vite build` is the one that
  // renders the app once in a process that is thrown away.
  return entry !== 'vite' || argv.slice(2).includes('build');
}

/**
 * Whether a conversation's provider could actually run in this process, asked before the boot
 * starts anything for it. A child that cannot authenticate does not merely fail: it resumes the
 * conversation's ledger session and claims the row from the child that is really working, so the
 * honest answer to "I cannot run this" is to start nothing and say why.
 */
export function bootReadiness(settings, { adapter = adapterFor } = {}) {
  try {
    const provider = adapter(settings || {});
    const readiness = typeof provider.ready === 'function' ? provider.ready() : { ok: true, reason: '' };
    return { id: provider.id, ok: Boolean(readiness.ok), reason: readiness.reason || '' };
  } catch (cause) {
    return { id: 'unknown', ok: false, reason: cause.message };
  }
}

const DEFAULT_MODEL_OVERRIDE = process.env.WEBCHAT_DEFAULT_MODEL || null;
const DEFAULT_PROVIDER_OVERRIDE = process.env.WEBCHAT_DEFAULT_PROVIDER || null;

/**
 * A default this process cannot start is not a default. The direct provider keeps one key file per
 * model family, so on a machine with the Anthropic key and no OpenAI key every new chat pinned to
 * `direct`/`gpt-6-astra` opened on a model that could not fork: five refused spawns and a message
 * that was never delivered. The pin stands as written the moment the key file is there; until then
 * the chat opens on a model of the same provider that can actually answer.
 */
export function runnableDefault(provider, model, { adapter = adapterFor } = {}) {
  if (!model) return model;
  try {
    const target = adapter({ provider: provider || undefined, model });
    const readiness = typeof target.ready === 'function' ? target.ready(process.env, model) : { ok: true };
    if (readiness.ok) return model;
    for (const candidate of FALLBACK_MODELS) {
      if (candidate === model) continue;
      const alternative = adapter({ provider: provider || undefined, model: candidate });
      const ok = typeof alternative.ready === 'function' ? alternative.ready(process.env, candidate) : { ok: true };
      if (ok.ok) {
        console.error(`[webchat] the pinned default ${provider || ''}/${model} cannot start here (${readiness.reason});`
          + ` new chats open on ${candidate} until it can`);
        return candidate;
      }
    }
  } catch {  }
  return model;
}

const FALLBACK_MODELS = Object.freeze(['claude-opus-5']);

export const pinnedDefaults = (settings) =>
  DEFAULT_MODEL_OVERRIDE ? { model: runnableDefault(DEFAULT_PROVIDER_OVERRIDE, DEFAULT_MODEL_OVERRIDE),
    ...(DEFAULT_PROVIDER_OVERRIDE ? { provider: DEFAULT_PROVIDER_OVERRIDE } : {}), ...settings } : settings;

// A build (vite's analyse step imports this module) must not create or open the real chat store: on a fresh machine
// it would write events.sqlite under HOME, and on a live one it would open the live store from a build process.
// The build gets a throwaway store in a temp dir; VITEST keeps its own WEBCHAT_DB.
function bootStorePath() {
  if (process.env.WEBCHAT_DB || process.env.VITEST || !bootIsBuild()) return DB_PATH;
  return join(mkdtempSync(join(tmpdir(), 'webchat-build-store-')), 'events.sqlite');
}

function build() {
  const store = openStore(bootStorePath());
  
  
  const titler = createTitler({
    store,
    rename: (id, title) => store.append(id, 'conversation.renamed', { title, auto: true }, { at: new Date().toISOString() })
  });
  // Files an unfiled chat into one of his existing folders, or leaves it in Inbox (autoroute.js).
  if (!process.env.VITEST && !bootIsBuild()) startFolderDescriptions(() => store.conversations());
  const folderRouter = createRouter({
    store,
    file: (id, workspace) => store.append(id, 'conversation.workspace', { workspace, auto: true }, { at: new Date().toISOString() })
  });
  // Safety net under the per-message and per-turn routes (autoroute.js): a restart or a failed call
  // must not leave a routable chat unfiled for good.
  if (!process.env.VITEST && !bootIsBuild()) folderRouter.startSweeping();
  
  
  
  // A build opens no record of live children either: the file is the service's, and a process
  // that must start nothing has no business holding the list of what is running.
  const building = bootIsBuild();
  const liveChildren = (process.env.VITEST || building) ? null : openLiveChildren(LIVE_CHILDREN_PATH);
  // Direct-runner children live under relays (scripts/relay.mjs) so a server restart hands them to the
  // next server instead of ending them (runner.handoffAll / adoptHandoff). Only a real server does this,
  // and only with the relay script serve.mjs names; WEBCHAT_RELAYS=0 turns it off.
  const relays = relayConfig({ building });
  const runner = createRunner({ store, defaultCwd: DEFAULT_CWD, liveChildren, beforeDispatch: createEvaluationCapture({ store }), onUserMessage: (id) => { if (!process.env.VITEST) folderRouter.schedule(id, 0); }, onTurnEnd: (id) => { titler.schedule(id); if (!process.env.VITEST) folderRouter.schedule(id); },
    ...(relays ? { relaySpawnImpl: relaySpawner({ script: relays.script, dir: relays.dir }), handover: { path: relays.handover, shape: handoverShape(), accepts: acceptedHandoverShapes() } } : {}) });
  
  
  
  warmWhisper();
  const auth = createAuth({
    db: store.db,
    rpId: process.env.WEBCHAT_RP_ID || 'localhost',
    origin: process.env.WEBCHAT_ORIGIN || 'http://localhost:5173',
    bootstrapToken: readSecret('webchat-bootstrap-token', 'WEBCHAT_BOOTSTRAP_TOKEN'),
    secret: readSecret('webchat-session-secret', 'WEBCHAT_SESSION_SECRET') || randomBytes(32).toString('hex'),
    disabled: process.env.WEBCHAT_AUTH_DISABLED === '1'
  });
  
  
  
  
  
  
  
  
  
  
  
  
  if (building && !process.env.VITEST) {
    console.error(`[app] this process is a build, not a server (${process.argv.slice(1, 3).join(' ')}):`
      + ` it reaps nothing, resumes nothing and revives nothing in ${DB_PATH}.`);
  }
  if (!process.env.VITEST) {
    if (!building) runner.reapOrphans();
    if (relays) adoptRelays(runner, relays);
    
    
    
    
    
    
    
    for (const signal of ['SIGTERM', 'SIGINT']) {
      
      
      process.once(signal, () => {
        // Children that can be handed over go to the next server untouched; stopAll ends the rest.
        try { runner.handoffAll(); } catch (cause) { console.error(`[app] handover failed: ${cause?.message || cause}`); }
        try { runner.stopAll(); } catch {  }
        // The log-first store holds a few events in memory until its writer thread has made them durable (and
        // open thinking blocks until they are committed): hand them over before the process can exit.
        try { Promise.resolve(store.drain?.()).catch((cause) => console.error(`[app] store drain failed: ${cause?.message || cause}`)); } catch {  }
      });
    }
    // serve.mjs emits this once the listener has closed; whatever the last requests appended goes out too.
    process.once('sveltekit:shutdown', () => { try { Promise.resolve(store.drain?.()).catch(() => {}); } catch {  } });
  }
  process.on('exit', () => runner.stopAll());

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  if (process.env.WEBCHAT_NO_RESUME !== '1' && !process.env.VITEST && !building) {
    // Only what this process could actually run. The answer is cached per conversation so one
    // unusable provider is reported once rather than once per owed message.
    const readiness = new Map();
    const startable = (id) => {
      if (!readiness.has(id)) {
        const answer = bootReadiness(store.conversation(id)?.settings);
        readiness.set(id, answer);
        if (!answer.ok) {
          console.error(`[app] not starting ${id} at boot: the ${answer.id} provider is not usable in this process`
            + ` (${answer.reason}). A child started here would fail its first model call and would claim the ledger`
            + ' session of whatever child is really running, so nothing is started and nothing is written.');
        }
      }
      return readiness.get(id).ok;
    };
    const { resuming, plan } = bootResume({
      store,
      live: [...runner.live.keys()],
      startable,
      recorded: runner.recordedLive?.() || [],
      owedLedgerPath: runnerLedgerPath(),
    });
    for (const id of plan.drop) runner.forgetLive?.(id);

    // The two second timer that used to stand here is gone: the store has been read and the
    // resume is announced, so nothing below waits on a clock, and the dead air was two seconds in
    // which a conversation the owner was watching had no child. What is left is one turn of the
    // event loop, and it is there for one reason: build() has not returned yet, so the app
    // singleton the module below publishes does not exist, and a child's first event would reach
    // store subscribers through a half-built app. The orphan reap needs no waiting of its own:
    // reapOrphans() sends its SIGKILLs synchronously above, and a ledger row still held by a
    // process on its way out is waited for by the child itself (rev5/pull.mjs sets
    // `PRAGMA busy_timeout = 5000` on the runner ledger), not by this boot.
    setImmediate(() => {
      for (const { id, text, itemId } of resuming) {
        try { runner.send(id, text, { itemId, recovery: true }); } catch {  }
      }
      // After the owed messages, so a conversation that is owed one gets its child from the send
      // and is never spawned twice.
      let revived = 0;
      for (const id of plan.revive) {
        if (!startable(id)) continue;
        // carryOn, because these are runs a restart cut off mid-thought and nobody cancelled: the child comes
        // back and is told to pick the work up, in a recovery message that writes no message.user.
        const owed = plan.owedBy.get(id);
        const options = owed?.length ? { carryOn: true, text: owedAgentsText(owed) } : { carryOn: true };
        try { if (runner.revive(id, options).revived) revived += 1; } catch (cause) {
          console.error(`[app] could not bring ${id} back: ${cause.message}`);
        }
      }
      if (resuming.length || revived) {
        console.error(`[app] boot resumed ${resuming.length} unanswered message(s) and revived ${revived} restart-killed run(s)`);
      }
    }).unref?.();
  }

  
  
  
  
  
  store.subscribe((event) => {
    if (!String(event.conversation_id || '').startsWith('brief-')) return;
    if (!['run.completed', 'run.error', 'run.cancelled'].includes(event.kind)) return;
    requestRefresh();
  });

  
  
  
  
  const splices = createSpliceLedger(store);
  store.subscribe((event) => {
    if (event.kind === 'run.completed') splices.commit(event.conversation_id);
    else if (event.kind === 'run.error' || event.kind === 'run.cancelled') splices.drop(event.conversation_id);
  });

  
  
  
  
  
  const built = builtShapeDetail();
  return { store, runner, auth, titler, folderRouter, splices, code: built.hash, codeFiles: built.files };
}

const key = Symbol.for('tophat.webchat.app');

export function storeShape(store = app.store) {
  return Object.keys(store || {}).filter((name) => typeof store[name] === 'function').sort().join(',');
}

/**
 * What the chat store says about itself (log-store.js health(): a real append, read and stream round
 * trip on a timer, the writer's queue and age, index lag). Memory only: /api/health calls it on every
 * poll and must never touch a disk. The legacy store has nothing to say beyond "open".
 */
export function storeHealth() {
  const store = app?.store;
  if (typeof store?.health === 'function') {
    try { return store.health(); } catch (cause) { return { mode: store.mode || 'unknown', ok: false, error: String(cause?.message || cause) }; }
  }
  return { mode: 'legacy', ok: true };
}

export function runnerShape(runner = app.runner) {
  return Object.keys(runner || {}).filter((name) => typeof runner[name] === 'function').sort().join(',');
}

export function bootCodeShape() {
  return app?.code || 'unknown';
}

function reportStaleAdoption(adopted) {
  let fresh;
  try {
    fresh = openStore(':memory:');
  } catch {
    return; 
  }
  try {
    const freshRunner = createRunner({ store: fresh, defaultCwd: DEFAULT_CWD });
    const staleRunner = Object.keys(freshRunner)
      .filter((name) => typeof adopted.runner?.[name] !== typeof freshRunner[name]);
    if (staleRunner.length) {
      console.error(
        `[app] the running runner predates this build and is missing ${staleRunner.join(', ')}; ` +
        'a hot reload cannot swap it. Run scripts/deploy.sh --restart.'
      );
    }
    
    
    
    if (adopted.code && adopted.code !== builtShape()) {
      const now = new Map(builtShapeDetail().files.map((entry) => {
        const at = entry.lastIndexOf(':');
        return [entry.slice(0, at), entry.slice(at + 1)];
      }));
      const boot = new Map((adopted.codeFiles || []).map((entry) => {
        const at = entry.lastIndexOf(':');
        return [entry.slice(0, at), entry.slice(at + 1)];
      }));
      const changed = boot.size
        ? [...now.keys()].filter((name) => boot.get(name) !== now.get(name))
        : [];
      console.error(
        `[app] the running singletons were built from different source than this build (${adopted.code} vs ${builtShape()})`
        + `${changed.length ? `; changed: ${changed.join(', ')}` : ''}`
        + '; a hot reload cannot swap them. Run scripts/deploy.sh --restart.'
      );
    }
    const missing = Object.keys(fresh).filter((name) => typeof adopted.store?.[name] !== typeof fresh[name]);
    if (missing.length) {
      console.error(
        `[app] the running store predates this build and is missing ${missing.join(', ')}; ` +
        'a hot reload cannot swap it. Run scripts/deploy.sh --restart.'
      );
    }
  } finally {
    try { fresh.close(); } catch {  }
  }
}

/** How often the sweep asks whether it is the 02:00 hour yet. The sweep itself runs once a day. */
export const TAB_SWEEP_CHECK_MS = Number(process.env.WEBCHAT_TAB_SWEEP_CHECK_MS || 10 * 60_000);

const adopted = globalThis[key];
if (adopted) reportStaleAdoption(adopted);
export const app = adopted || (globalThis[key] = build());


export function liveConversations() {
  return [...app.runner.live.keys()];
}

export function sidebarSnapshot({ since = null } = {}) {
  const rows = app.store.conversations(since ? { since } : {}).map((conversation) => {
    if (!RUNNING_STATES.has(conversation.runState)) return conversation;
    if (app.runner.isBusy(conversation.id)) return conversation;
    return { ...conversation, runState: 'idle', awaitingFirstToken: false, note: null, noteAt: null, maintenance: false };
  });
  return { cursor: app.store.cursor(), rows };
}

export function busyConversations() {
  return [...app.runner.live.keys()].filter((id) => app.runner.isBusy(id));
}

// COMPUTER-USE TABS.
//
// rev5/cua-tabs.mjs keeps the register of which chat opened which tab, written by the runner
// children; this is the side that acts on it.


/** One short-lived handle on the runner ledger, where the register lives, and never in a test. */
async function withTabRegistry(work) {
  if (process.env.VITEST) return null;
  const endpoint = cdpEndpoint();
  if (!endpoint) return null;
  const db = openTabsDb(tabsDbPath());
  try { return await work({ db, endpoint }); } finally { try { db.close(); } catch {  } }
}

/** The tabs of one archived chat. */
export function closeTabsOf(conversationId) {
  return withTabRegistry(async ({ db, endpoint }) => {
    const { closed, gone, failed, error } = await closeConversationTabs({ db, endpoint, conversationId });
    if (error) console.error(`[app] could not close the computer-use tabs of ${conversationId}: ${error}`);
    else if (closed.length || gone.length || failed.length) {
      console.log(`[app] archived ${conversationId}: closed ${closed.length} computer-use tab(s)`
        + `${gone.length ? `, ${gone.length} already gone` : ''}`
        // Still claimed, so the 02:00 sweep comes back for it.
        + `${failed.length ? `, ${failed.length} would not close` : ''}`);
    }
    return { closed, gone, failed };
  }).catch((cause) => {
    console.error(`[app] could not close the computer-use tabs of ${conversationId}: ${cause.message}`);
    return null;
  });
}

/** The nightly pass, if this is the night's 02:00 hour and it has not run yet today. */
export function sweepTabsIfDue({ now = new Date().toISOString(), active = busyConversations } = {}) {
  return withTabRegistry(async ({ db, endpoint }) => {
    if (!dueForSweep(now, openTabRegistry(db).lastSweepAt())) return null;
    const running = active();
    const { closed, kept, failed, error } = await sweepTabs({ db, endpoint, active: running, now: () => now });
    if (error) console.error(`[app] ${SWEEP_HOUR}:00 tab sweep could not read the browser: ${error}`);
    else {
      console.log(`[app] ${SWEEP_HOUR}:00 tab sweep: closed ${closed.length}, kept ${kept.length}`
        + `${failed?.length ? `, ${failed.length} refused to close` : ''}`
        + `${running.length ? ` (running: ${running.join(', ')})` : ''}`);
    }
    return { closed, kept, failed };
  }).catch((cause) => {
    console.error(`[app] the ${SWEEP_HOUR}:00 tab sweep failed: ${cause.message}`);
    return null;
  });
}

// Interaction observations are telemetry and they expire. This is on a slow timer and never on a
// request: at a tab heartbeat each, the table reached 1.77 million rows and 2.2 GB in nine days, and a
// delete that size has no business sitting in front of a chat. Each run drains in small passes with a
// yield between them and a time budget (interaction.js drainObservations). Now the first run is a
// minute after boot, the interval is 30 minutes, and a run that ran out of budget with rows still
// waiting comes back a minute later until it has caught up.
export const PRUNE_EVERY_MS = Number(process.env.WEBCHAT_PRUNE_EVERY_MS || 30 * 60 * 1000);
export const PRUNE_FIRST_MS = Number(process.env.WEBCHAT_PRUNE_FIRST_MS || 60 * 1000);
export const PRUNE_BUDGET_MS = 20_000;

export function startObservationPrune({ interval = PRUNE_EVERY_MS, first = PRUNE_FIRST_MS, again = PRUNE_FIRST_MS,
  budgetMs = PRUNE_BUDGET_MS, drain = drainObservations, log = console } = {}) {
  const key = Symbol.for('tophat.webchat.observationprune');
  // A hot swap adopts the running process: whatever the last version left is stopped so exactly
  // one schedule survives.
  const previous = globalThis[key];
  try { if (previous && typeof previous === 'object' && 'stop' in previous) previous.stop(); else clearInterval(previous); } catch {  }
  let running = null;
  let followUp = null;
  const run = () => {
    if (running) return running;
    running = (async () => {
      try {
        const { removed, more } = await drain({ budgetMs });
        if (removed) log.log(`[app] pruned ${removed} interaction observation(s) past ${RETENTION_DAYS} days${more ? ', more waiting' : ''}`);
        if (more && !followUp) {
          followUp = setTimeout(() => { followUp = null; run(); }, again);
          followUp.unref?.();
        }
        return { removed, more };
      } catch (cause) {
        log.error(`[app] interaction prune failed: ${cause.message}`);
        return null;
      } finally { running = null; }
    })();
    return running;
  };
  const kick = setTimeout(run, first);
  kick.unref?.();
  const timer = setInterval(run, interval);
  timer.unref?.();
  const handle = { timer, kick, run, stop() { clearTimeout(kick); clearInterval(timer); if (followUp) clearTimeout(followUp); followUp = null; } };
  globalThis[key] = handle;
  return handle;
}

/** The timer behind it. Replaces its own, so a hot swap that adopts this app leaves one. */
export function startTabSweep({ interval = TAB_SWEEP_CHECK_MS } = {}) {
  const key = Symbol.for('tophat.webchat.tabsweep');
  try { clearInterval(globalThis[key]); } catch {  }
  const timer = setInterval(() => { sweepTabsIfDue(); }, interval);
  timer.unref?.();
  globalThis[key] = timer;
  return timer;
}

// Conversation reply lines follow the Beeper monitor's latest assessment (replies.js). The timer is
// what keeps the Notes page truthful when nothing else asks; the badge job's call to
// /api/replies/projection runs the same idempotent pass. The monitor files are only parsed when one
// of them changed, so a quiet minute costs two stat calls.
export const REPLY_SYNC_MS = Number(process.env.WEBCHAT_REPLY_SYNC_MS || 60 * 1000);

export function startReplySync({ interval = REPLY_SYNC_MS } = {}) {
  const key = Symbol.for('tophat.webchat.replysync');
  try { clearInterval(globalThis[key]); } catch {  }
  const run = async () => {
    try {
      const [{ notesStore }, { syncReplyProjection }] = await Promise.all([import('./notes-store.js'), import('./replies.js')]);
      const answer = await syncReplyProjection(notesStore());
      const changed = answer.report && (answer.report.created.length || answer.report.renewed.length || answer.report.closed.length);
      if (changed) console.log(`[app] reply lines: ${answer.report.created.length} created, ${answer.report.renewed.length} renewed, ${answer.report.closed.length} closed`);
    } catch (cause) { console.error(`[app] reply sync failed: ${cause.message}`); }
  };
  const timer = setInterval(run, interval);
  timer.unref?.();
  globalThis[key] = timer;
  return timer;
}

// The shaped answer the runner gives is the point of a restart, so it is returned (a promise of
// it) rather than the cursor applyAction hands back: a caller wants to hear whether the child
// went at its boundary or had to be forced. This is the in-process way in; the way in from a
// client is the interrupt action with { restart: true }.
export function restartConversation(conversationId, { reason = 'asked for', ...options } = {}) {
  return app.runner.restart(conversationId, { reason, ...options });
}

// Bringing one conversation's child back without a message, the way boot does.
export function reviveConversation(conversationId, options = {}) {
  return app.runner.revive(conversationId, options);
}

export const CAPABILITIES = Object.freeze({
  actions: Object.values(ACTIONS),
  streaming: true,
  fastMode: true,
  defaultCwd: DEFAULT_CWD,
  
  
  
  
  
  providers: Object.freeze([...(app?.runner?.providers || ['claude'])])
});

// The seam the client-session walk needs (src/lib/client/session.model.test.js): which store,
// runner and splice ledger this action lands in. Every one defaults to the app singleton, so the
// route, the boot and every existing caller are untouched; a walk hands in its own sqlite file and
// a runner that records instead of forking a child, and gets the real action round-trip.
export function applyAction(action, {
  attribution = null, lineage = null, participantId = null, identity = null,
  store = app.store, runner = app.runner, splices = app.splices
} = {}) {
  // Scopes (server/scopes.js): off, this is a disabled service and every line using it is inert.
  const scopes = scopeServiceFor(store, { runner });
  const at = new Date().toISOString();
  const id = action.conversation_id;
  const payload = action.payload || {};
  const evaluation = { attribution, userTimestamp: action.at || null, lineage, participantId };

  switch (action.op) {
    case ACTIONS.CREATE: {
      if (store.conversation(id)) break;
      const settings = normalizeSettings(pinnedDefaults(payload.settings || {}));
      // A chat is created in the scope the owner has selected, when his account may open it; else in his personal scope.
      const scope = scopes.scopeForNewChat(identity, payload.scope || null);
      store.ensureConversation(id, { at, cwd: payload.cwd || DEFAULT_CWD, settings, title: payload.title || 'New chat', scope });
      store.append(id, 'conversation.created', { title: payload.title || 'New chat', settings, cwd: payload.cwd || DEFAULT_CWD, ...(scope ? { scope, ...(payload.scopeChosen ? { scopeChosen: true } : {}) } : {}), ...(canonicalWorkspace(payload.workspace) ? { workspace: canonicalWorkspace(payload.workspace), ...(payload.workspaceDefault ? { workspaceDefault: true } : {}) } : {}) }, { at });
      if (payload.text) {
        routeAfterFirst(scopes, { identity, id, text: payload.text, store });
        // A new chat can be created with a file still uploading, so it needs the same
        // pending-upload note SEND and FORK get; without it the model is never told.
        const { wire, display } = prepareSend(store, id, payload.text, { pendingUploads: payload.pending_uploads });
        runner.send(id, wire, { itemId: action.action_id, display, ...evaluation });
      } else runner.warm?.(id);
      break;
    }
    case ACTIONS.FORK: {
      const parent = store.conversation(payload.parentId);
      if (!parent) throw new Error('Cannot fork an unknown conversation');
      const settings = normalizeSettings(payload.settings || parent.settings);
      // A fork lives in its parent's scope: copying a history into a different scope is a move, and has its own gate.
      const forkScope = scopes.enabled ? scopes.scopeOf(parent) : null;
      store.ensureConversation(id, {
        at, cwd: parent.cwd, settings, parentId: parent.id, scope: forkScope,
        forkedFrom: payload.forkedFromCursor ?? null,
        title: payload.title || `${parent.title} ↳`,
        sidechat: payload.sidechat || null
      });
      store.append(id, 'conversation.created', {
        title: payload.title || `${parent.title} ↳`,
        settings, cwd: parent.cwd, parentId: parent.id,
        forkedFromCursor: payload.forkedFromCursor ?? null,
        sidechat: payload.sidechat || null,
        ...(forkScope ? { scope: forkScope } : {}),
        // A fork stays in its parent's workspace unless the page named another.
        ...((canonicalWorkspace(payload.workspace) || canonicalWorkspace(parent.workspace)) ? { workspace: canonicalWorkspace(payload.workspace) || canonicalWorkspace(parent.workspace) } : {})
      }, { at });
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      const ENDS_SWEEP = new Set(['message.user', 'run.error', 'run.cancelled']);
      const FOLDED = new Set([
        'assistant.delta', 'assistant.message', 'thinking.delta',
        'tool.started', 'tool.input_delta', 'tool.completed',
        'agent.started', 'agent.completed'
      ]);
      if (!payload.sidechat) {
        let sweeping = false;
        for (const event of store.allConversationEvents(parent.id)) {
          if (payload.forkedFromCursor && event.cursor > payload.forkedFromCursor) break;
          if (event.kind.startsWith('conversation.')) continue;
          if (event.kind === 'hook.fired') { sweeping = true; continue; }
          if (sweeping && ENDS_SWEEP.has(event.kind)) sweeping = false;
          else if (sweeping && FOLDED.has(event.kind)) continue;
          const copied = event.kind === 'message.user' || event.kind === 'evaluation.snapshot';
          const content = copied ? { ...event.content, lineage: {
            ...event.content.lineage,
            originalMessageId: event.content.lineage?.originalMessageId || event.content.itemId || event.content.messageId || null,
            originalConversationId: event.content.lineage?.originalConversationId || parent.id,
            copied: true, copySourceConversationId: parent.id, copySourceCursor: event.cursor
          } } : event.content;
          store.append(id, event.kind, content, { at: event.at });
        }
      }
      
      
      
      
      
      if (payload.text) {
        const first = prepareSend(store, id, payload.text, { staged: splices.pending(id), pendingUploads: payload.pending_uploads });
        runner.send(id, first.wire, { itemId: action.action_id, display: first.display, ...evaluation });
        splices.stage(id, first.marks);
      }
      break;
    }
    case ACTIONS.SEND: {
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      let conversation = store.conversation(id);
      if (!conversation) {
        const settings = normalizeSettings(pinnedDefaults(payload.settings || {}));
        const scope = scopes.scopeForNewChat(identity, payload.scope || null);
        store.ensureConversation(id, { at, cwd: payload.cwd || DEFAULT_CWD, settings, title: 'New chat', scope });
        store.append(id, 'conversation.created', { title: 'New chat', settings, cwd: payload.cwd || DEFAULT_CWD, ...(scope ? { scope } : {}) }, { at });
        conversation = store.conversation(id);
      }
      
      
      
      
      // Opus for a request to do something, Sonnet for an ask (core/model-route.js); a model he picked by hand turns it off.
      const routed = routePatch(conversation.settings, payload.text, { idleMs: Date.now() - Date.parse(conversation.updatedAt || 0), turns: conversation.turns });
      if (routed) {
        const before = conversation.settings || {};
        const merged = store.setSettings(id, routed);
        store.append(id, 'conversation.meta', { settings: merged }, { at });
        if (typeof runner.applySettings === 'function') runner.applySettings(id, before, merged);
      }
      const { wire, display, marks } = prepareSend(store, id, payload.text, { staged: splices.pending(id), pendingUploads: payload.pending_uploads });
      if (!conversation.turns) routeAfterFirst(scopes, { identity, id, text: payload.text, store });
      runner.send(id, wire, { itemId: action.action_id, display, ...evaluation });
      
      splices.stage(id, marks);
      break;
    }
    case ACTIONS.INTERRUPT:
    case RESTART_OP: {
      // One action, two things to ask of one conversation's child: stop this turn, or go and come
      // back. Restart is the flagged form because the ACTIONS enum is not ours to extend here.
      const restarting = action.op === RESTART_OP || Boolean(payload[RESTART_FLAG]);
      if (!restarting) {
        runner.interrupt(id, { cancelQueued: payload.cancelQueued !== false });
        break;
      }
      // Nothing waits on the restart: the action answers with the cursor like every other action,
      // and what the restart did reaches the page as the run.status events the runner writes.
      runner.restart(id, { reason: payload.reason || 'asked for' })
        .then((result) => console.error(`[app] restart ${id}: ${JSON.stringify(result)}`))
        .catch((cause) => console.error(`[app] restart ${id} failed: ${cause.message}`));
      break;
    }
    case ACTIONS.RENAME:
      store.append(id, 'conversation.renamed', { title: payload.title }, { at });
      break;
    case ACTIONS.PIN:
      store.append(id, 'conversation.pinned', { pinned: Boolean(payload.pinned) }, { at });
      break;
    case ACTIONS.ARCHIVE:
      store.append(id, 'conversation.archived', { archived: Boolean(payload.archived) }, { at });
      // Putting a chat away puts its browser state away with it: the computer-use tabs that chat
      // opened are closed, here rather than in the runner, because an archived conversation's
      // child is usually long gone by the time he archives it.
      if (payload.archived) closeTabsOf(id);
      break;
    case ACTIONS.ASIDE:
      store.append(id, 'conversation.aside', { aside: Boolean(payload.aside) }, { at });
      break;
    case ACTIONS.WORKSPACE:
      // The catch-all's name (Inbox) files nothing: it is the unfiled set.
      store.append(id, 'conversation.workspace', { workspace: canonicalWorkspace(payload.workspace) }, { at });
      break;
    case ACTIONS.DEFER:
      store.append(id, 'conversation.deferred', {
        until: payload.until || null,
        condition: payload.condition || null
      }, { at });
      break;
    
    
    
    
    case ACTIONS.READ: {
      if (payload.read === false) { store.append(id, 'conversation.meta', { read: false }, { at }); break; }
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      const busy = typeof runner.isBusy === 'function' && runner.isBusy(id);
      const content = readMark({ seenCursor: payload.seenCursor, head: store.cursor(), mute: payload.mute, busy });
      store.append(id, 'conversation.meta', content, { at });
      break;
    }
    case ACTIONS.TOUCH:
      store.append(id, 'conversation.opened', {}, { at });
      break;
    case ACTIONS.SETTINGS: {
      const before = store.conversation(id)?.settings || {};
      const merged = store.setSettings(id, payload.settings || {});
      store.append(id, 'conversation.meta', { settings: merged }, { at });
      
      
      
      
      
      
      
      
      
      const disposition = typeof runner.applySettings === 'function'
        ? runner.applySettings(id, before, merged)
        : typeof runner.retire === 'function'
          ? runner.retire(id)
          : (runner.isBusy(id) ? 'deferred' : (runner.stop(id), 'retired'));
      if (disposition === 'deferred') {
        store.append(id, 'run.status', {
          state: 'running',
          note: 'Settings saved. They apply to the next message, so the answer in flight is not interrupted.'
        }, { at });
      }
      break;
    }
    default:
      throw new Error(`Unsupported action ${action.op}`);
  }
  return { cursor: store.cursor() };
}

// A chat moved to a less open scope loses its public share links (src/lib/server/shares.js). Loaded
// on first use: the share store opens its own database.
scopeHooks.revokeShares = async ({ conversationId }) => {
  const { shareStore } = await import('./shares.js');
  const store = shareStore();
  const revoked = store.revoke('chat', conversationId);
  const askRevoked = store.revokeAsk(conversationId);
  return { revoked, askRevoked };
};

// A chat moved to a more private scope has the memory derived from it hidden in the groups it left (server/scope-memory.js,
// rev6/push/scope-retract.mjs). Active only while the memory cloud is in primary mode; otherwise it answers `skipped`.
scopeHooks.removeDerivedMemory = createRemoveDerivedMemory({ threadsFor: (id) => conversationThreads(app.store, id) });

// After a chat's first message the scope router (server/scope-router.js) may file it elsewhere. It
// runs beside the send and never blocks it; with the router flag off it returns at once.
function routeAfterFirst(scopes, { identity, id, text, store }) {
  if (!scopes.enabled || !scopes.config.router?.enabled) return;
  routeFirstMessage({ service: scopes, identity, conversationId: id, text, store }).catch(() => {});
}

export function newConversationId() { return newId(); }

// Start background work only after all module constants have initialized. Proof of life for
// the fleet monitor../liveness.js stamps a `<log>.heartbeat` beside this process's own stdout,
// and only when this server's own /api/health answers. It stands out here rather than inside
// build() because a hot swap ADOPTS the running app and never calls build(), which is how the
// first version of this shipped and beat nothing; startLiveness replaces its own timer, so
// adopting twice leaves one.
if (!process.env.VITEST && !bootIsBuild()) {
  const { path: beatFile } = startLiveness({});
  if (beatFile) console.log(`[app] heartbeat every ${BEAT_MS / 1000}s in ${beatFile}, while /api/health answers`);
  else console.log('[app] no heartbeat: stdout is not one of the tophat log files');
  startTabSweep();
  console.log(`[app] computer-use tabs are swept in the ${SWEEP_HOUR}:00 hour, keeping the tabs of running chats`);
  startObservationPrune();
  startReplySync();
  console.log('[app] conversation reply lines follow the Beeper monitor assessment, once a minute');
  console.log(`[app] interaction observations are kept for ${RETENTION_DAYS} days`);
  // goal_wait retry timers (rev5/waits.mjs): a due one posts a wake into its chat. ff.js imports this module, so it is loaded lazily.
  startRetryWakes({
    deliver: async (text, opts) => {
      const { resolveConversation, settle } = await import('./ff.js');
      return storeDeliver({ store: app.store, runner: app.runner, resolveConversation, settle })(text, opts);
    },
    probe: async (args) => { const { resolveConversation } = await import('./ff.js'); return storeProbe(app.store, resolveConversation)(args); },
    // The goal's work row through the webchat's own door to the shared store: a due wait whose goal is gone, closed or
    // handed to another chat is deleted instead of fired (rev5/wait-sweeper.mjs point 7).
    getWork: async (id) => { const { getTaskAsync } = await import('./tasks-bridge.js'); return getTaskAsync(id); },
    escalate: async ({ kind, sessionId, wait, detail }) => {
      // Queued into the once-a-day #tophat digest (discord-post.mjs queues everything but --reply-to/--immediate).
      if (!process.env.TOPHAT_CHAT_POST_MODULE) throw new Error('no chat-post module configured (TOPHAT_CHAT_POST_MODULE)');
      const { post } = await import(process.env.TOPHAT_CHAT_POST_MODULE);
      await post(`goal retry timer gave up (${kind}): runner session ${sessionId}, goal ${wait.goal_id} "${wait.text}": ${detail}`, { ping: false });
    }
  });
  console.log(`[app] goal retry timers are swept every ${RETRY_SWEEP_MS / 1000}s`);
  // A move whose derived-memory step failed stays `memory-pending`; it is retried by its id (scopes.js resumePending), once after boot and every ten minutes.
  const sweepScopeMoves = () => {
    try { const scopes = scopeServiceFor(app.store, { runner: app.runner }); if (scopes.enabled) scopes.resumePending().catch(() => {}); } catch { /* scopes misconfigured: nothing to resume */ }
  };
  setTimeout(sweepScopeMoves, 60_000).unref?.();
  setInterval(sweepScopeMoves, 600_000).unref?.();
}

