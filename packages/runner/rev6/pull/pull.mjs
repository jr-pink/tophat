#!/usr/bin/env node
// Pull: one process per conversation, speaking the webchat's stream-json protocol on stdin/stdout exactly as
// rev5/pull.mjs does, so the webchat runner, translator and relay are unchanged. A turn starts on an owner
// message or on a wake (a subagent report, a check-in, an arrival posted by push into the conversation).
//   node rev6/pull/pull.mjs (--session-id ID | --resume ID [--fork-session]) --model M --permission-mode P --cwd DIR [--add-dir DIR]...
//   node rev6/pull/pull.mjs --drain-pending | --reconcile-pending [--apply]
import { createInterface } from 'node:readline';
import { owner, ownerPossessive } from '../../owner.mjs';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { redactSecrets } from '../tools/runner/redact.mjs';
import { costOf } from './call.mjs';
import { modelFor } from './wire.mjs';
import { providersAvailable, resolveCredentials } from './credentials.mjs';
import { buildMessages, compactionCut, ledgerPath, openLedger } from './ledger.mjs';
import { DATES_RULE, baselinePrompt, contextBlock, createInstructions, imageBlocksFor, landedImageBlocks, liveBlock, publicPrompt, rootSystem, withLiveContext } from './context.mjs';
import { continuationDecision, openGoals } from './goals.mjs';
import { agentEnv, createTools, memoryCli, memoryStore, receiptComplete, rootAgentId, searchDeps, warmMemoryStore } from './tools.mjs';
import { createAgents } from './agents.mjs';
import { BACKGROUND_CALL_NOTE, BACKGROUND_CANCEL_MARK, BACKGROUND_FORK_NOTE, BACKGROUND_MARK, BACKGROUND_NOTE, BACKGROUND_TURN_PREFIX, backgroundGist, backgroundMinGeneratingMs, backgroundReportText,
  backgroundResult, createLiveView, isBackgroundTurn } from './background.mjs';
import { diffSince, snapshotCalls } from './background-diff.mjs';
import { checkInText } from './progress.mjs';
import { createChatTools } from './chat.mjs';
import { INBOX_RULE, endsWithInboxRule } from '../base/inbox-rule.mjs';
import { prefetchPasses, warmSearch } from './prefetch.mjs';
import { drainPushes, reconcilePending, transcriptRecords } from './pushq.mjs';
import { runnerChatVerdict } from './chat-scope.mjs';
import { emptyUsage, runAgent, textOf } from './loop.mjs';
import { abortableSleep, raceAbort, streamMessage } from './wire.mjs';
import { INCOGNITO_NOTE, incognitoEnv, isIncognito, removeIncognitoScratch } from './incognito.mjs';
import { installProcessGuards } from './process-guard.mjs';
import { harnessFeatures, memoryStatusLine, prefetchWaitMs, settleWithin } from './harness-v2.mjs';

export const COMPACT_COMMAND = '/compact';
export const PACE_CUT_MARK = '[the ten-minute checkpoint cut this message off here]';
export const OWNER_CUT_MARK = '[the owner wrote while this message was being written, so it was cut off here]';
export const OWNER_CUT_NOTE = 'The owner wrote mid-message, and the request in flight was cut so you would see his words now rather than when it happened to finish. Any tool calls still running were moved to the background and their results reach you when they finish. His message is in the history just above: answer it first, briefly, then carry on with what you were doing if that is still the way to his goal.';
export const PACE_CUT_NOTE = 'The ten-minute checkpoint interrupted you mid-message, and any tool calls still running were moved to the background (their results reach you when they finish; nothing was cancelled). The checkpoint itself is in the history just above. Answer it now, then carry on from where you were if that is still the way to his goal.';
export const BUSY_CHECK_IN_MS = 15_000, AGENT_SETTLE_WAKE_MS = 120;
export const TERMINAL_CAUSES = Object.freeze({ restart: 'server-restart', owner: 'interrupted' });
export const interruptCause = ({ restarting = false } = {}) => (restarting ? TERMINAL_CAUSES.restart : TERMINAL_CAUSES.owner);
/** An automated event's text: the webchat's inbound path ends it with INBOX_RULE (withInboxRule). */
export const isAutomatedEvent = (text) => endsWithInboxRule(text);
const BUDGET = () => ({ compactTokens: Number(process.env.TOPHAT_RUNNER_COMPACT_TOKENS) || 300_000, compactHardTokens: Number(process.env.TOPHAT_RUNNER_COMPACT_HARD_TOKENS) || 800_000,
  summaryTokens: Number(process.env.TOPHAT_RUNNER_COMPACT_SUMMARY_TOKENS) || 16_000, keepRecent: 6 });

/** The owner-message watchdog. An owner message that no request has carried within this many ms is logged and the step
 * restarted (its abort). Running subagents are left alone. TOPHAT_RUNNER_OWNER_WATCHDOG_MS, 0 turns it off.
 */
export const ownerWatchdogMs = (env = process.env) => { const v = Number(env.TOPHAT_RUNNER_OWNER_WATCHDOG_MS); return env.TOPHAT_RUNNER_OWNER_WATCHDOG_MS !== undefined && env.TOPHAT_RUNNER_OWNER_WATCHDOG_MS !== '' && Number.isFinite(v) && v >= 0 ? v : 20_000; };
/** The compaction summary request's own ceiling: it carries no turn's abort, so it needs one (models.json timeoutMs is 0). */
const compactTimeoutMs = (env = process.env) => { const v = Number(env.TOPHAT_RUNNER_COMPACT_TIMEOUT_MS); return Number.isFinite(v) && v > 0 ? v : 10 * 60_000; };

export function parseArgs(argv) {
  const out = { addDirs: [] }, takes = { '--session-id': 'sessionId', '--resume': 'resume', '--model': 'model', '--permission-mode': 'permissionMode', '--cwd': 'cwd', '--reasoning-effort': 'reasoningEffort' };
  const flags = { '--fork-session': 'fork', '--drain-pending': 'drainPending', '--reconcile-pending': 'reconcilePending', '--apply': 'apply' };
  for (let i = 0; i < argv.length; i++) {
    if (takes[argv[i]]) out[takes[argv[i]]] = argv[++i];
    else if (argv[i] === '--add-dir') out.addDirs.push(argv[++i]);
    else if (flags[argv[i]]) out[flags[argv[i]]] = true;
  }
  return out;
}

/** TOPHAT_RUNNER_CLOCK_AT replays from a fixed instant (it must carry a zone); otherwise the wall clock. */
export function clockFrom(env = process.env, warn = (line) => process.stderr.write(`${line}\n`)) {
  const given = env.TOPHAT_RUNNER_CLOCK_AT;
  if (given && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(given.trim())) { warn(`[rev6 pull] TOPHAT_RUNNER_CLOCK_AT "${given}" has no zone; an instant needs a Z or an offset like -07:00. Using the wall clock.`); return () => new Date().toISOString(); }
  const base = given ? Date.parse(given) : NaN;
  if (Number.isNaN(base)) return () => new Date().toISOString();
  const started = Date.now();
  return () => new Date(base + (Date.now() - started)).toISOString();
}

/**
 * The runner. `factories` (tests and replay) can replace the tools, the agents, the memory CLI, the prefetch passes and the model stream.
 */
const uploadHoldMs = (env) => { const v = Number(env.TOPHAT_RUNNER_UPLOAD_HOLD_MS); return Number.isFinite(v) && v >= 0 ? v : 8000; };

export function createRunner({ args, env = process.env, write = (line) => process.stdout.write(`${line}\n`), now = () => new Date().toISOString(), ledger = openLedger(ledgerPath(incognitoEnv(env))), factories = {} }) {
  env = resolveCredentials(incognitoEnv(env)).env;
  const incognito = isIncognito(env);
  // TOPHAT_RUNNER_TRANSCRIPTS=0: this runner writes none of a chat's words to the memory store, whatever the chat's scope. For an instance whose visitors must never reach shared memory; incognito implies it.
  const keepsNoTranscript = incognito || env.TOPHAT_RUNNER_TRANSCRIPTS === '0';
  const cwd = args.cwd || process.cwd();
  mkdirSync(cwd, { recursive: true });
  const cli = factories.memoryCli || memoryCli;
  let model = modelFor(args.model, env), permissionMode = args.permissionMode || 'bypassPermissions', reasoningEffort = args.reasoningEffort || env.TOPHAT_RUNNER_REASONING_EFFORT || null;
  const startedAt = now();
  let sessionId;
  if (args.resume && args.fork) { sessionId = randomUUID(); ledger.ensureSession(sessionId, { model, cwd, forkedFrom: args.resume, at: startedAt }); ledger.fork(args.resume, sessionId); }
  else { sessionId = args.resume || args.sessionId || randomUUID(); ledger.ensureSession(sessionId, { model, cwd, at: startedAt }); }
  const startupSeq = ledger.lastSeq(sessionId), store = memoryStore(env);
  let seq = 0;
  const emit = (payload) => write(JSON.stringify({ ...payload, session_id: sessionId, uuid: `${sessionId}-${++seq}` }));
  const state = { pendingImages: [], turn: null, queue: [], running: null, pushing: null, lastInputTokens: 0, compactRequested: false, compacting: null, compactGeneration: 0, ownerWaiters: new Set(), paceWaiters: new Set(), stopIds: new Set(),
    chatWork: null, checkInTimer: null, settleTimer: null, started: false, stopped: false, restarting: false,
    // the watchdog's view: when the oldest owner message no request has carried yet arrived, and when a request last left
    ownerPendingSince: null, lastRequestAt: 0, watchdogTimer: null, compactAbort: null };
  const agents = env.TOPHAT_RUNNER_AGENTS === '0' ? null : (factories.agents || createAgents)({ ledger, parentSessionId: sessionId, cwd, roots: args.addDirs, env, permissionMode, model, now,
    emit: (p) => emit(p), onOwnerWord: (cb) => { state.ownerWaiters.add(cb); return () => state.ownerWaiters.delete(cb); },
    onSettled: (id) => { if (state.stopIds.delete(id)) return settledByStop(id); announceBackground(id); return scheduleAgentWake(); }, systemContext: () => (publicPrompt(env) ? `Your tools: ${tools.specs.map((t) => t.name).join(', ')}.${incognito ? ` ${INCOGNITO_NOTE}` : ''}` : `Workspace: ${cwd}. Allowed file roots: ${tools.roots.join(', ')}. ${DATES_RULE}${incognito ? ` ${INCOGNITO_NOTE}` : ''}`), toolFactories: factories.childTools || {}, stream: factories.streamMessage || null });
  const instructions = createInstructions({ cwd, roots: args.addDirs, env });
  const goals = env.TOPHAT_RUNNER_GOAL_HOOK === '0' ? null : (factories.goals ? factories.goals(sessionId) : openGoals({ sessionId, env, now }));
  const toolEnv = agentEnv(env.TOPHAT_AGENT_ID || rootAgentId(env.TOPHAT_CONVERSATION_ID || sessionId), env);
  // chat_rename / chat_archive on the chat this runner serves. An incognito chat is not in the webchat's store,
  // so it gets neither; TOPHAT_RUNNER_CHAT_TOOLS=0 turns them off.
  const chatTools = incognito || env.TOPHAT_RUNNER_CHAT_TOOLS === '0' ? null : (factories.chat ? factories.chat(env) : createChatTools({ env }));
  // The turn remembers what chat_archive it called, so a wake-born turn can be filed when it ends (archiveWakeChat).
  const chat = chatTools && { ...chatTools, chat_archive(i) { if (state.turn) state.turn.archiveCall = i?.archived !== false; return chatTools.chat_archive(i); } };
  const tools = (factories.tools || createTools)({ db: ledger.db, sessionId, cwd, roots: args.addDirs, env: toolEnv, permissionMode, now, agents, goals, chat, onPath: (path) => {
    const text = instructions.touch(path);
    if (!text) return;
    const block = contextBlock('Instructions', text);
    if (state.turn && !state.turn.interrupted) state.turn.arrivals.push(block); else ledger.append(sessionId, 'user', 'injected', [block], now());
  } });
  agents?.resumeInterrupted();
  let stableSystem = null;
  const systemPrompt = () => (stableSystem ??= rootSystem({ cwd, tools, store, goals, agents, baseline: baselinePrompt({ env, now }), instructions: instructions.prompt(), v2: hf.size ? hf : false, env }) + (incognito ? `\n\n${INCOGNITO_NOTE}` : ''));
  const inject = (blocks) => { ledger.append(sessionId, 'user', 'injected', blocks, now()); for (const b of blocks) emit({ type: 'user', message: { role: 'user', content: [b] }, isSynthetic: true, parent_tool_use_id: null }); };
  const stream = factories.streamMessage || streamMessage;
  const hf = harnessFeatures(env);
  // Harness memstatus: the memory store's status in the Now block, cached and refreshed in the background at most
  // every ten minutes.
  const memStatus = { line: null, at: 0, pending: null };
  const refreshMemStatus = () => {
    if (!hf.has('memstatus') || !store.installed || memStatus.pending || Date.now() - memStatus.at < 600_000) return;
    const checked = now();
    memStatus.pending = cli('status', {}, { env }).then((r) => { const line = memoryStatusLine(r, env, checked); if (line) { memStatus.line = line; memStatus.at = Date.now(); } })
      .catch(() => {}).finally(() => { memStatus.pending = null; });
  };
  refreshMemStatus();
  // a warm search worker before the first owner message, so its prefetch does not pay module load and table parsing
  if (hf.has('unify') && !factories.prefetchPasses) { try { warmSearch(env); } catch { /* the first search starts one */ } try { if (!factories.memoryCli) warmMemoryStore(env); } catch { /* the first search starts one */ } }

  // `home` is the turn the blocks belong to. A message that arrives while a turn (or a compaction) runs starts its
  // prefetch at once with the running turn as its home (null during a compaction); a fresh turn that later carries it
  // adopts the same passes rather than starting a second search, so the block is never duplicated.
  function prefetch(turn, text, saidAt, { home = { turn }, prefix = '' } = {}) {
    const all = [];
    home.staged = [];
    // sourcePartialMs: the source leg hands over what its fast corpora found by then (unified-search.mjs), so the
    // first request carries source hits instead of waiting the 3 to 6 s the slowest corpus takes
    const partialMs = env.TOPHAT_REV6_SOURCE_PARTIAL_MS === undefined || env.TOPHAT_REV6_SOURCE_PARTIAL_MS === '' ? 450 : Number(env.TOPHAT_REV6_SOURCE_PARTIAL_MS);
    const unified = hf.has('unify') ? { deps: { ...searchDeps({ env, sessionId, clock: now }), sourcePartialMs: partialMs }, context: ledger.previousOwnerText(sessionId) } : null;
    for (const [pass, promise, staged] of (factories.prefetchPasses || prefetchPasses)(text, saidAt, { env, now, storeInstalled: store.installed, memorySearch: (p) => cli('search', p, { env }), unified })) {
      const started = Date.now(), key = `${prefix}${pass}`;
      const landed = promise.then((block) => {
        if (!block) return;
        if (home.turn?.timings) home.turn.timings[key] = Date.now() - started;
        if (!home.turn) (home.landed ||= []).push(block); // joined during a compaction: the turn that adopts it carries it
        else if (state.turn === home.turn && !home.turn.interrupted) home.turn.arrivals.push(block);
      }).catch(() => {});
      // A staged pass (harness unify): the hold waits for its fast legs only, and each request takes what has settled.
      if (staged) { const entry = { ...staged, key, started }; home.staged.push(entry); home.turn?.staged.push(entry); all.push(staged.ready.catch(() => {})); } else all.push(landed);
    }
    home.ready = all;
    return all;
  }
  /** A fresh turn (or a later request) takes over a joined message's passes: their blocks now land in this turn. */
  function adopt(home, turn) {
    if (!home || home.turn === turn) return;
    home.turn = turn;
    if (home.landed?.length) turn.arrivals.push(...home.landed.splice(0));
    for (const entry of home.staged || []) if (!turn.staged.includes(entry)) turn.staged.push(entry);
  }
  /** The prefetch for an owner message that joins a running turn (mid-run, queued, steering), started when it arrives. */
  function joinPrefetch(text) {
    const home = { turn: state.turn, arrivedMs: Date.now(), held: false };
    try { prefetch(state.turn, text, now(), { home, prefix: 'joined_' }); } catch (error) { process.stderr.write(`[rev6 pull] joined-message prefetch failed: ${error.message}\n`); return null; }
    return home;
  }
  const checkInBlocks = () => (agents ? agents.checkIns().map((a) => contextBlock('Subagent check-in', checkInText(a))) : []);
  function jobBlocks() {
    const jobs = tools.jobs.undelivered().map((j) => contextBlock('Background job', `job ${j.job_id} (${j.tool}) is ${j.status}${j.exit_code !== null && j.exit_code !== undefined ? ` with exit code ${j.exit_code}` : ''}.\n${j.output_tail}`));
    const reports = agents ? agents.undelivered().map((a) => (isBackgroundTurn(a.agent_id) ? contextBlock('Background turn report', backgroundReportText(a))
      : contextBlock('Subagent report', `subagent ${a.agent_id} (${a.description}) is ${a.status}${a.cost_usd != null ? `, cost ${a.cost_usd} USD` : ''}.\n${a.result || ''}`))) : [];
    return [...jobs, ...reports, ...checkInBlocks()];
  }
  function armCheckIn() {
    if (!agents) return;
    clearTimeout(state.checkInTimer);
    state.checkInTimer = null;
    const dueAt = agents.nextCheckInAt();
    if (dueAt === null) return;
    state.checkInTimer = setTimeout(checkInTick, Math.max(dueAt - Date.parse(now()), state.turn || state.running ? BUSY_CHECK_IN_MS : 0));
    state.checkInTimer.unref?.();
  }
  // A subagent report or check-in that wakes an idle chat is an automated event too. The turn reads its own transcript to
  // tell which.
  const SUBAGENT_INBOX = 'If the work this subagent belongs to began with an automated event (push wake, projects-watch, goal retry timer) '
    + `rather than a message from ${owner()}, apply the inbox rule to this wake; if ${owner()} asked for it, leave the chat as it is. ` + INBOX_RULE;
  function wakeTurn(blocks, reason) {
    if (chat) blocks = [...blocks, contextBlock('Inbox', SUBAGENT_INBOX)];
    inject(blocks);
    emit({ type: 'system', subtype: 'status', status: 'continuing', reason, goal_items: [], continuation: 0 });
    runTurn(blocks[0].text, { prefetch: false });
  }
  function checkInTick() {
    state.checkInTimer = null;
    try {
      if (!state.turn && !state.running) { const blocks = checkInBlocks(); if (blocks.length) return wakeTurn(blocks, 'a subagent has not reported for its check-in interval'); }
    } catch (error) { process.stderr.write(`[rev6 pull] subagent check-in failed: ${error.message}\n`); }
    armCheckIn();
  }
  function scheduleAgentWake() {
    if (!agents || state.stopped || state.restarting || state.settleTimer) return;
    state.settleTimer = setTimeout(() => { state.settleTimer = null; wakeForAgents(); }, AGENT_SETTLE_WAKE_MS);
    state.settleTimer.unref?.();
  }
  function wakeForAgents() {
    if (!agents || state.stopped || state.restarting || !state.started || state.turn || state.running) return;
    try { if (!agents.pendingReports()) return; const blocks = jobBlocks(); if (blocks.length) wakeTurn(blocks, 'a subagent finished'); }
    catch (error) { process.stderr.write(`[rev6 pull] subagent wake failed: ${error.message}\n`); }
  }

  function intake(texts, kind) {
    const blocks = [], kinds = [];
    for (const text of texts) { const { text: clean, redactions } = redactSecrets(text); kinds.push(...redactions); blocks.push({ type: 'text', text: clean }); }
    const spoken = [...blocks];
    if (kind === 'owner') for (const said of spoken) {
      try {
        const { blocks: refs, notes, pending } = imageBlocksFor(said.text, { env });
        for (const n of notes) blocks.push({ type: 'text', text: n });
        blocks.push(...refs);
        // Still uploading: checked again before every model call (landImages) and added as an image once it lands.
        for (const p of pending) if (!state.pendingImages.some((q) => q.path === p.path)) state.pendingImages.push({ path: p.path, since: Date.now() });
      }
      catch (error) { process.stderr.write(`[rev6 pull] attached images were not prepared: ${error.message}\n`); }
    }
    const last = ledger.lastRow(sessionId);
    const already = kind === 'owner' && last?.kind === 'owner' && !last.compacted_at && JSON.stringify(last.content) === JSON.stringify(blocks);
    return { blocks, spoken, redactions: kinds, seq: already ? last.seq : ledger.append(sessionId, 'user', kind, blocks, now(), kinds.length ? kinds : null) };
  }

  // An owner attachment that was still uploading when its message was taken in (imageBlocksFor `pending`): once the file
  // lands, the next model call carries it as an image. The first request of a turn holds up to TOPHAT_RUNNER_UPLOAD_HOLD_MS
  // (8 s) for it, since the image is usually what the message is about. Written to the ledger only (an image reference is
  // not a chat event for the webchat to draw; the owner's message already shows the attachment).
  async function landImages({ holdMs = 0, stop = () => false } = {}) {
    if (!state.pendingImages.length) return;
    const until = Date.now() + holdMs;
    while (holdMs > 0 && Date.now() < until && !stop() && state.pendingImages.some((p) => !existsSync(p.path) && !existsSync(`${p.path}.failed`))) await new Promise((r) => setTimeout(r, 200));
    try {
      const { blocks, still } = landedImageBlocks(state.pendingImages, { env });
      state.pendingImages = still;
      if (blocks.length) ledger.append(sessionId, 'user', 'injected', blocks, now());
    } catch (error) { process.stderr.write(`[rev6 pull] a landed upload was not added as an image: ${error.message}\n`); }
  }

  async function turn(first, { prefetch: wantPrefetch = true, joined = null, holder = null } = {}) {
    const turnStart = Date.now(), fromSeq = pushFromSeq(), budget = BUDGET();
    const thisTurn = state.turn = { controller: new AbortController(), requestStop: null, paceCut: false, ownerCut: false, interrupted: false, arrivals: [], staged: [], timings: { first_token_ms: null, retrieval_ms: null, source_search_ms: null },
      automated: isAutomatedEvent(first), ownerJoined: false, archiveCall: null,
      // Background-turn state (backgroundTurn()): `sid` is the session this turn writes to, the main one until it is
      // moved; `bg` is set when it is; `opts` is the runAgent options object, whose sessionId is retargeted then.
      sid: sessionId, bg: null, opts: null, first, fromSeq, streaming: false, streamText: '', live: createLiveView(), gen: { since: null, last: null, ms: 0 }, calls: null, wakes: new Set(), log: [], snap: null, diffs: [] };
    if (holder) holder.turn = thisTurn;
    const out = (p) => { if (!thisTurn.bg && !thisTurn.abandoned) emit(p); };
    const lastOwnerSeq = ledger.lastOwnerSeq(sessionId);
    let ownerCursor = Math.min(fromSeq, lastOwnerSeq ? lastOwnerSeq - 1 : fromSeq), prefetchStarted = false, measuredGeneration = 0, requestStart = 0, said = false, cacheRead = 0, cacheWrite = 0;
    let firstStep = true, continuations = 0, sinceProgress = 0, closedSeen = goals ? goals.read().items.filter((i) => i.status !== 'todo').length : 0, goalStop = null, callsThisTurn = 0, looseEndsChecked = false;
    const sourceIds = [], usage = emptyUsage();
    // Harness v2: the prefetch starts with the turn rather than after the ingest round trip (audit: it reached the
    // first request in 50 of 714 owner turns). TOPHAT_REV6_PREFETCH_WAIT_MS can hold the first request for it; the
    // default is 0 because the passes take 1.7 to 7 s at the median (bench/README.md).
    let prefetchPending = [];
    refreshMemStatus();
    // A queued message whose prefetch began when it arrived: this turn adopts those passes (no second search) and holds
    // for them as a joined message's request does, up to the wait counted from its arrival.
    if (joined) { prefetchStarted = true; adopt(joined, thisTurn); }
    else if (hf.has('early') && wantPrefetch) { prefetchStarted = true; prefetchPending = prefetch(thisTurn, first, now()); }
    await tools.ready();
    const opts = thisTurn.opts = { role: 'root', ledger, sessionId, env, now, emit: out, parent: null, tools, usage,
      getModel: () => model, setModel: (m) => { model = m; }, canCompact: true, compact: (t) => (thisTurn.bg ? Promise.resolve('nothing') : raceAbort(startCompact(t), thisTurn.requestStop?.signal)),
      request: (m) => ({ model: m, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}), system: systemPrompt(), cache_tail_skip: 1, tools: tools.specs, max_tokens: 16_000 }),
      async beforeStep() {
        if (thisTurn.interrupted) return 'stop';
        // The first round of calls has completed (onStep): no further request is made.
        if (thisTurn.bg?.stopAfterCall) return 'stop';
        if (thisTurn.abandoned) return 'stop';
        // The preparation has its own abort, which his message and the stop fire like a request's: every wait below races it.
        if (!thisTurn.bg) thisTurn.requestStop = new AbortController();
        const prep = thisTurn.requestStop?.signal;
        const bounded = (p) => raceAbort(p, prep);
        if (!thisTurn.bg && env.TOPHAT_RUNNER_TEST_STALL_STEP_MS && state.queue.some((q) => !q.pace)) await new Promise((r) => setTimeout(r, Number(env.TOPHAT_RUNNER_TEST_STALL_STEP_MS)));
        if (thisTurn.abandoned) return 'stop';
        // A new request is a new generation segment.
        thisTurn.gen = { since: null, last: null, ms: 0 }; thisTurn.live.reset();
        if (thisTurn.bg) {
          // A background turn drains only its own arrivals and what agent_send queued for it; the conversation's
          // jobs, reports, owner words, prefetch and compaction belong to the main session's turns.
          const mine = [...thisTurn.arrivals.splice(0), ...thisTurn.bg.queue.splice(0).map((text) => contextBlock('Steering', text))];
          if (mine.length) ledger.append(thisTurn.sid, 'user', 'injected', mine, now());
          thisTurn.requestStop = new AbortController();
          thisTurn.streaming = true; thisTurn.streamText = '';
          return undefined;
        }
        const through = ledger.lastSeq(sessionId);
        const ownerRecords = transcriptRecords(ledger, sessionId, ownerCursor, through).filter((rec) => rec.role === 'owner');
        ownerCursor = through;
        // A chat the instance's scope does not serve writes nothing to the store (chat-scope.mjs): the store files rows under the instance's own group.
        const scopeHold = ownerRecords.length && store.installed && !keepsNoTranscript ? runnerChatVerdict(sessionId, env) : null;
        if (ownerRecords.length && store.installed && goals && !state.chatWork && env.TOPHAT_RUNNER_CHAT_WORK !== '0' && !keepsNoTranscript && !scopeHold) {
          state.chatWork = cli('tasks', { op: 'chat', session: sessionId, title: String(ownerRecords[0].text || '').slice(0, 200) }, { env })
            .then((res) => { if (res?.ok === false) process.stderr.write(`[rev6 pull] chat work item not made: ${res.detail || res.reason}\n`); return res; });
          // Awaited before the first request: a turn that answers fast must not end before the chat's work item exists.
          await state.chatWork.catch((error) => { process.stderr.write(`[rev6 pull] chat work item not made: ${error?.message || error}\n`); return null; });
        }
        if (scopeHold) thisTurn.sourceContext = 'The scope of this chat is not one this instance stores memory for (or could not be confirmed), so its words were not stored as raw memory rows. Do not invent source_refs.';
        else if (ownerRecords.length && store.installed && !keepsNoTranscript) {
          const receipt = await bounded(cli('ingest', { records: ownerRecords }, { env, timeoutMs: 2000 }));
          if (receiptComplete(ownerRecords, receipt).complete) {
            sourceIds.push(...ownerRecords.map((rec) => rec.id));
            thisTurn.sourceContext = `Stored owner-message source_refs for this turn: ${sourceIds.join(', ')}. These identify the owner's actual words, not proof that any requested action was performed. Use memory_read kind=raw to inspect before citing.`;
          } else thisTurn.sourceContext = 'Current owner words are durable in the conversation but their raw-memory ingest was not confirmed. Do not invent source_refs; later push will retry.';
        }
        if (thisTurn.interrupted) return 'stop';
        if (wantPrefetch && !prefetchStarted) { prefetchStarted = true; prefetch(thisTurn, first, now()); }
        if (prefetchPending.length) { const waiting = prefetchPending; prefetchPending = []; await bounded(settleWithin(waiting, prefetchWaitMs(env) - (Date.now() - turnStart))); }
        // Owner messages that joined this run (and a queued one this turn opened with): the request that first carries
        // them waits for their fast legs, but only inside the hold window counted from when each arrived; a message
        // that has waited longer than that gets what is ready and no extra hold.
        const joinedNow = [...(joined ? [joined] : []), ...state.queue.filter((q) => q.home).map((q) => q.home)].filter((h) => !h.held);
        for (const h of joinedNow) { h.held = true; adopt(h, thisTurn); }
        if (joinedNow.length && !thisTurn.interrupted) {
          await bounded(Promise.all(joinedNow.map((h) => settleWithin(h.ready || [], prefetchWaitMs(env) - (Date.now() - h.arrivedMs)))));
        }
        for (const s of thisTurn.staged) {
          const block = thisTurn.interrupted ? null : s.take();
          if (!block) continue;
          const ms = Date.now() - s.started;
          if (s.partial()) thisTurn.timings[`${s.key.replace(/_ms$/u, '')}_partial_ms`] = ms; else thisTurn.timings[s.key] = ms;
          thisTurn.arrivals.push(block);
          process.stderr.write(`[rev6 prefetch] ${new Date().toISOString()} session ${sessionId} ${s.key.startsWith('joined_') ? 'joined-message ' : ''}${s.partial() ? 'partial' : 'whole'} search block taken ${ms}ms after the prefetch began, ${Date.now() - turnStart}ms into the turn${s.summary?.() ? ` (${s.summary()})` : ''}\n`);
        }
        await landImages({ holdMs: firstStep ? uploadHoldMs(env) : 0, stop: () => thisTurn.interrupted || Boolean(prep?.aborted) });
        firstStep = false;
        const pending = [...thisTurn.arrivals.splice(0), ...jobBlocks(), ...state.queue.splice(0).filter((q) => !q.seq).flatMap((q) => q.blocks)];
        if (pending.length) inject(pending);
        const ownerWaiting = ownerRecords.length > 0 || state.queue.some((q) => !q.pace);
        if (state.compactRequested) { state.compactRequested = false; if (ownerWaiting) startCompact('manual'); else await bounded(startCompact('manual')); }
        else if (state.lastInputTokens > budget.compactHardTokens) { if (ownerWaiting) startCompact('auto-blocking'); else await bounded(startCompact('auto-blocking')); }
        else if (state.lastInputTokens > budget.compactTokens) startCompact('auto');
        thisTurn.requestStop = new AbortController();
        thisTurn.paceCut = false; thisTurn.ownerCut = false;
        if (thisTurn.interrupted || thisTurn.abandoned) return 'stop';
        requestStart = Date.now(); said = false; cacheRead = 0; cacheWrite = 0;
        // This request carries every owner message in the ledger: none is waiting on a request any more.
        state.lastRequestAt = requestStart; state.ownerPendingSince = null;
        thisTurn.streaming = true; thisTurn.streamText = '';
        return undefined;
      },
      messages() {
        const { messages } = buildMessages(ledger.active(thisTurn.sid));
        measuredGeneration = state.compactGeneration;
        return withLiveContext(messages, liveBlock({ now: now(), env, sourceContext: state.turn?.sourceContext, jobs: tools.jobs.running(), agents: agents?.running() || [], memoryStatus: hf.has('memstatus') ? memStatus.line : null }));
      },
      signal: () => thisTurn.requestStop.signal,
      onEvent(event) {
        thisTurn.live.take(event);
        if (event.type === 'content_block_delta') { const at = Date.now(); thisTurn.gen.since ??= at; thisTurn.gen.last = at; }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') thisTurn.streamText += event.delta.text || '';
        if (thisTurn.bg) return;
        if (event.type === 'message_start') { cacheRead = event.message?.usage?.cache_read_input_tokens || 0; cacheWrite = event.message?.usage?.cache_creation_input_tokens || 0; }
        if (thisTurn.timings.first_token_ms === null && event.type === 'content_block_delta') thisTurn.timings.first_token_ms = Date.now() - turnStart;
        if (!said && event.type === 'content_block_delta') {
          said = true;
          process.stderr.write(`[rev6 timing] ${new Date().toISOString()} session ${sessionId} first token ${Date.now() - requestStart}ms after the request, ${Date.now() - turnStart}ms after the turn began (the request left ${requestStart - turnStart}ms into the turn); cache read ${cacheRead}, written ${cacheWrite}${cacheWrite > cacheRead ? ' (COLD: the context was processed again)' : ''}\n`);
        }
        if (event.type !== 'ping') out({ type: 'stream_event', event, parent_tool_use_id: null });
      },
      onAborted(partial, res) {
        thisTurn.streaming = false; closeGeneration(thisTurn);
        if (thisTurn.abandoned) return 'stop';
        const text = partial.message.content.filter((p) => p?.type === 'text' && p.text);
        if (partial.message.id) { usage.requests += 1; for (const k of Object.keys(usage)) if (k !== 'requests') usage[k] += partial.message.usage?.[k] || 0; }
        if ((thisTurn.paceCut || thisTurn.ownerCut) && !thisTurn.interrupted) {
          const byOwner = thisTurn.ownerCut && !thisTurn.paceCut;
          thisTurn.paceCut = false; thisTurn.ownerCut = false;
          if (text.length) { ledger.append(sessionId, 'assistant', 'interrupted', [...text, { type: 'text', text: byOwner ? OWNER_CUT_MARK : PACE_CUT_MARK }], now()); res.finalText = textOf(text); }
          thisTurn.arrivals.push(byOwner ? contextBlock('Owner', OWNER_CUT_NOTE) : contextBlock('Pace', PACE_CUT_NOTE));
          return 'continue';
        }
        thisTurn.interrupted = true;
        if (text.length && thisTurn.bg) { ledger.append(thisTurn.sid, 'assistant', 'interrupted', [...text, { type: 'text', text: BACKGROUND_CANCEL_MARK }], now()); res.finalText = textOf(text); }
        else if (text.length) {
          ledger.append(sessionId, 'assistant', 'interrupted', [...text, { type: 'text', text: state.restarting
            ? '[the runner was restarted here; the rest of this turn was never written, so nothing below it is done]' : '[the owner interrupted here]' }], now());
          res.finalText = textOf(text);
        }
        return 'stop';
      },
      onStop() { const late = thisTurn.arrivals.splice(0); if (late.length) ledger.append(thisTurn.sid, 'user', 'injected', late, now()); },
      onAssistant(message) {
        thisTurn.streaming = false; closeGeneration(thisTurn);
        thisTurn.calls = message.stop_reason === 'tool_use' ? message.content.filter((p) => p.type === 'tool_use') : null;
        if (thisTurn.bg) return;
        const stale = measuredGeneration !== state.compactGeneration;
        if (!stale) state.lastInputTokens = (message.usage?.input_tokens || 0) + (message.usage?.cache_read_input_tokens || 0) + (message.usage?.cache_creation_input_tokens || 0);
        out({ type: 'assistant', message: { id: message.id, role: 'assistant', model: message.model || model, content: message.content, stop_reason: message.stop_reason, usage: message.usage }, ...(stale ? { context_stale: true } : {}), parent_tool_use_id: null });
      },
      nudge: (text) => thisTurn.arrivals.push(contextBlock('Recovery', text)),
      cancelled: () => (thisTurn.interrupted ? 'interrupted by the owner before this ran' : null),
      preempt: () => (thisTurn.bg ? null : { already: state.queue.length > 0, subscribe(wake) {
        state.ownerWaiters.add(wake); state.paceWaiters.add(wake); thisTurn.wakes.add(wake);
        return () => { state.ownerWaiters.delete(wake); state.paceWaiters.delete(wake); thisTurn.wakes.delete(wake); };
      } }),
      // The disk as it stands just before a round of calls (every turn: a turn is moved to the background while its call
      // runs, so the snapshot cannot wait for the move); read back in onStep once the turn is a background one.
      beforeCalls(calls) {
        try { thisTurn.snap = snapshotCalls(calls, { cwd, env }); } catch (error) { thisTurn.snap = null; process.stderr.write(`[rev6 pull] pre-call snapshot failed: ${error.message}\n`); }
      },
      onStep() {
        const calls = thisTurn.calls, snap = thisTurn.snap;
        thisTurn.calls = null; thisTurn.snap = null;
        if (!thisTurn.bg || !calls) return;
        // The turn ends here: its report (with the diff of what this round changed) is delivered by backgroundResult.
        thisTurn.bg.stopAfterCall = true;
        try { const d = diffSince(snap); if (d.text || d.note) thisTurn.diffs.push(d); }
        catch (error) { thisTurn.diffs.push({ text: '', note: `the diff of its edits could not be read (${error.message})` }); }
        // What the background turn did after the interrupt, read back from the results row it just wrote.
        const last = ledger.lastRow(thisTurn.sid);
        const byId = new Map((last?.content || []).filter((b) => b.type === 'tool_result').map((b) => [b.tool_use_id, b]));
        for (const c of calls) { const b = byId.get(c.id); thisTurn.log.push({ name: c.name, input: c.input, content: b ? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) : '', isError: Boolean(b?.is_error) }); }
      },
      countCalls: (n) => { callsThisTurn += n; },
      onFinal({ text }) {
        if (thisTurn.bg) {
          if (thisTurn.bg.queue.length && !thisTurn.interrupted) return { continue: true };
          if (thisTurn.arrivals.length) ledger.append(thisTurn.sid, 'user', 'injected', thisTurn.arrivals.splice(0), now());
          return { continue: false };
        }
        if (state.queue.length && !thisTurn.interrupted) return { continue: true };
        if (goals) {
          const ledgerState = goals.read(), closedNow = ledgerState.items.filter((i) => i.status !== 'todo').length;
          if (closedNow > closedSeen) { sinceProgress = 0; closedSeen = closedNow; }
          const decision = continuationDecision({ ledger: ledgerState, text, consecutive: sinceProgress, total: continuations, ownerWaiting: state.queue.length > 0, interrupted: thisTurn.interrupted,
            worked: callsThisTurn, workersRunning: agents ? agents.running().length : 0, looseEndsChecked, toolsAvailable: tools.specs.length > 0 });
          goalStop = decision.reason;
          if (decision.continue) {
            if (decision.loose) looseEndsChecked = true; else { continuations += 1; sinceProgress += 1; }
            out({ type: 'system', subtype: 'status', status: 'continuing', reason: decision.reason, goal_items: decision.items.map((i) => `${i.id}: ${i.text}`), continuation: continuations });
            thisTurn.arrivals.push(contextBlock('Continuation', decision.message));
            return { continue: true };
          }
        }
        if (thisTurn.arrivals.length) ledger.append(sessionId, 'user', 'injected', thisTurn.arrivals.splice(0), now());
        return { continue: false };
      } , stream };
    const r = await runAgent(opts);
    // A turn the watchdog abandoned says nothing more: a fresh turn owns the chat now (ownerWatchdog()).
    if (thisTurn.abandoned) return undefined;
    if (thisTurn.bg) {
      return thisTurn.bg.finish({ status: r.failure ? 'failed' : thisTurn.interrupted ? 'cancelled' : 'done', finalText: r.finalText, failure: r.failure,
        usage, cost: costOf(model, usage, env), calls: r.calls, log: thisTurn.log, diffs: thisTurn.diffs, stopped: Boolean(thisTurn.bg.stopAfterCall) && !r.failure && !thisTurn.interrupted });
    }
    const durationMs = Date.now() - turnStart, cost = costOf(model, usage, env);
    const base = { duration_ms: durationMs, num_turns: r.numTurns, usage, total_cost_usd: cost, recoveries: r.recoveries, truncations: r.truncations, model,
      cost: cost === null ? 'unknown; see usage' : 'from the provider price table (rev5/model.mjs PRICES)', timings: { ...thisTurn.timings, turn_ms: durationMs },
      ...(goals ? { goal_continuations: continuations, goal_stop: goalStop, goal_open: goals.read().items.filter((i) => i.status === 'todo').map((i) => `${i.id}: ${i.text}`) } : {}) };
    if (thisTurn.interrupted) emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'interrupted', terminal_cause: interruptCause(state), result: r.finalText, ...base });
    else if (r.failure) emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'error', result: `The model request failed (${r.failure}).`, ...base });
    else emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: r.finalText, unfinished_jobs: tools.jobs.running().map((j) => j.id), ...base });
    if (state.turn === thisTurn) state.turn = null;
    await archiveWakeChat(thisTurn, r);
    ledger.queuePush(sessionId, fromSeq, ledger.lastSeq(sessionId), now());
    pushLater();
  }
  // A turn an automated event started (push wake, relay, goal retry: the webchat appends INBOX_RULE to its text) ends
  // archived unless the turn itself called chat_archive archived=false. The rule asked the model to archive; now not
  // archiving is the default. An owner message that joined the turn, an interrupted or failed turn, and subagent wakes
  // are left as they are.
  async function archiveWakeChat(t, r) {
    if (!chat || !t.automated || t.ownerJoined || t.interrupted || r?.failure || t.archiveCall !== null) return;
    // A turn that ends by asking the owner something is not resolved: leave it in the sidebar. Question in the closing 600
    // characters.
    if (/\?/u.test(String(r?.finalText ?? '').slice(-600))) return;
    try {
      const out = await chatTools.chat_archive({ archived: true });
      if (out?.error) process.stderr.write(`[rev6 pull] wake chat not auto-archived: ${out.error}\n`);
    } catch (error) { process.stderr.write(`[rev6 pull] wake chat not auto-archived: ${error.message}\n`); }
  }

  const pushFromSeq = () => Math.max(ledger.lastPushedSeq(sessionId), startupSeq);
  function startCompact(trigger) {
    if (!state.compacting) state.compacting = compact(trigger).finally(() => { state.compacting = null; state.compactAbort = null; });
    return state.compacting;
  }
  async function compact(trigger) {
    const rows = ledger.active(sessionId), preTokens = state.lastInputTokens > 0 ? state.lastInputTokens : null, budget = BUDGET();
    const cut = compactionCut(rows, budget.keepRecent);
    if (!cut) return 'nothing';
    emit({ type: 'system', subtype: 'status', status: 'compacting' });
    const older = rows.slice(0, cut), { messages } = buildMessages(older);
    const instruction = 'Write a compact summary of the conversation above for your own later use. Keep verbatim, in this order: every instruction, preference and correction the owner gave; open work and what is awaited; decisions taken; file paths, ids and numbers you may need. Mark anything uncertain as uncertain. Do not invent completions.';
    let summary;
    try {
      // The summary request ends on the stop control (abortTurn) and on its own ceiling; it used to carry neither.
      const stopper = state.compactAbort = new AbortController();
      const signal = AbortSignal.any([stopper.signal, AbortSignal.timeout(compactTimeoutMs(env))]);
      const message = await stream({ model, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}), system: 'You are summarising your own conversation context. Output only the summary.',
        messages: [...messages, { role: 'user', content: [{ type: 'text', text: instruction }] }], max_tokens: budget.summaryTokens }, { env, signal });
      summary = textOf(message.content);
    } catch (error) {
      process.stderr.write(`[rev6 pull] compaction failed: ${error.message}\n`);
      emit({ type: 'system', subtype: 'status', status: 'compact_failed', trigger, detail: error?.message || 'the summary request failed' });
      return 'failed';
    }
    const at = now();
    ledger.compact(sessionId, older.map((row) => row.seq), at);
    const summarySeq = ledger.append(sessionId, 'user', 'summary', [{ type: 'text', text: `[Compacted context summary written ${at} by ${model}; ${older.length} earlier messages are retained in the runner ledger but not in this context]\n${summary}` }], at);
    state.lastInputTokens = 0;
    state.compactGeneration += 1;
    emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger, pre_tokens: preTokens, messages: older.length, summary_seq: summarySeq } });
    return 'compacted';
  }
  function pushLater() {
    if (!store.installed || env.TOPHAT_RUNNER_PUSH === '0' || keepsNoTranscript) return;
    state.pushing = (state.pushing || Promise.resolve()).then(() => new Promise((res) => setTimeout(res, 10)))
      .then(() => drainPushes({ ledger, sessionId, env, now, cli })).catch((error) => process.stderr.write(`[rev6 pull] push drain failed: ${error.message}\n`));
  }

  const abortTurn = () => { if (state.turn) { state.turn.interrupted = true; state.turn.controller.abort(); state.turn.requestStop?.abort(); tools.abortForeground(); } state.compactAbort?.abort(); };
  function control(message) {
    const request = message.request || {};
    const ok = (extra = {}) => emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, ...extra } });
    switch (request.subtype) {
      case 'interrupt': {
        // The stop control (the stop button, Esc, /api/agent op interrupt) fully stops whatever is going on: the live
        // turn is aborted, foreground tool calls are killed, every background turn and every running subagent is
        // cancelled, and none of them wakes the chat afterwards. Typing is not this: a message typed mid-turn moves the
        // turn to the background (handle(), backgroundTurn()). cancel_background:false keeps only the abort of the live
        // turn.
        const hard = request.cancel_background !== false;
        abortTurn();
        const cancelled = hard ? cancelAllWork() : [];
        if (hard) tools.abortForeground();
        if (request.cancel_queued) state.queue.length = 0;
        return ok({ response: { still_queued: state.queue.length, cancelled } });
      }
      case 'restart': state.restarting = true; abortTurn(); return ok({ response: { still_queued: state.queue.length, restarting: true } });
      case 'set_model': model = modelFor(request.model, env); return ok();
      case 'set_permission_mode': permissionMode = request.mode || permissionMode; tools.setPermissionMode(permissionMode); return ok();
      case 'set_reasoning_effort': reasoningEffort = request.effort || null; return ok();
      case 'apply_flag_settings': return ok();
      default: return emit({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: `no such control ${request.subtype}` } });
    }
  }
  function handle(message) {
    if (message?.type === 'control_request') return control(message);
    if (message?.type !== 'user') return undefined;
    const texts = (message.message?.content || []).filter((p) => p.type === 'text').map((p) => p.text || ''), primary = texts[0] || '';
    if (primary.trim() === COMPACT_COMMAND) {
      ledger.append(sessionId, 'user', 'command', [{ type: 'text', text: COMPACT_COMMAND }], now());
      if (state.turn) { state.compactRequested = true; return undefined; }
      const started = Date.now();
      const compacted = state.running = startCompact('manual').then((outcome) => emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed',
        result: outcome === 'compacted' ? '' : outcome === 'failed' ? 'the compaction failed; the context is unchanged' : 'nothing to compact yet', duration_ms: Date.now() - started, num_turns: 0, total_cost_usd: 0 }))
        .finally(() => { if (state.running === compacted) state.running = null; startQueuedTurn(); });
      return undefined;
    }
    const pace = primary.startsWith('<runtime-clock>');
    // including the subagent launch which is often what i interrupt) and then that should go in background, hidden /
    // ephemeral... "its not about the stop/interrupt control, it's the typing interrupt"). The turn is not cut: it moves to
    // a fork and carries on out of sight, and this message is a fresh turn on the main session at once. Done before intake
    // so the rows that close the main session's side of the turn (streamed text, calls answered as still running, the note)
    // sit above his message in the history. Pace checks and automated events keep the old behaviour; so does a turn between
    // requests (nothing to move yet).
    if (!pace && !isAutomatedEvent(primary) && backgroundable(state.turn) && keepsInBackground(state.turn)) backgroundTurn(state.turn);
    const { blocks, spoken, redactions, seq: at } = intake(texts, pace ? 'pace' : 'owner');
    if (!pace) emit({ type: 'user', message: { role: 'user', content: spoken }, isReplay: true, parent_tool_use_id: null });
    if (redactions.length) process.stderr.write(`[rev6 pull] redacted ${redactions.join(', ')} from an owner message before it reached the model\n`);
    if (state.turn || state.running) {
      if (!pace && state.turn && !isAutomatedEvent(blocks[0].text)) state.turn.ownerJoined = true;
      if (!pace || state.turn) state.queue.push({ blocks, seq: at, pace, arrivedMs: Date.now(), home: pace ? null : joinPrefetch(blocks[0].text) });
      if (!pace) armOwnerWatchdog();
      if (!pace) {
        for (const cb of [...state.ownerWaiters]) { state.ownerWaiters.delete(cb); try { cb(); } catch { /* waiter gone */ } }
        if (state.turn && !state.turn.interrupted) { state.turn.ownerCut = true; state.turn.requestStop?.abort(); }
      } else if (state.turn && !state.turn.interrupted) {
        state.turn.paceCut = true;
        state.turn.requestStop?.abort();
        for (const cb of [...state.paceWaiters]) { state.paceWaiters.delete(cb); try { cb(); } catch { /* waiter gone */ } }
      }
      return undefined;
    }
    if (pace) return undefined;
    armOwnerWatchdog();
    return runTurn(blocks[0].text);
  }
  function runTurn(first, options) {
    // holder.turn tells a turn the owner moved to the background apart: its end is the agents registry's business,
    // and the floor was handed back when it was moved.
    const holder = {};
    const run = turn(first, { ...options, holder }).catch((error) => {
      if (holder.turn?.bg) { holder.turn.bg.fail(error); return; }
      if (holder.turn?.abandoned) return;
      process.stderr.write(`[rev6 pull] turn failed: ${error.message}\n`);
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'error', result: `The runner failed (${error.message}).`, duration_ms: 0, num_turns: 0, total_cost_usd: 0 });
      if (!state.turn || state.turn === holder.turn) state.turn = null;
      ledger.queuePush(sessionId, pushFromSeq(), ledger.lastSeq(sessionId), now());
      pushLater();
    }).finally(() => {
      if (holder.turn?.bg || holder.turn?.abandoned) return;
      if (state.running === run) state.running = null;
      startQueuedTurn(); armCheckIn(); scheduleAgentWake();
    });
    state.running = run;
  }

  /** How long the turn's current generation segment (its latest model request) has streamed: live while it streams, its final length after. */
  const generatingMs = (t) => (t.gen.since !== null ? Date.now() - t.gen.since : t.gen.ms);
  const closeGeneration = (t) => { if (t.gen.since !== null) { t.gen.ms = t.gen.last - t.gen.since; t.gen.since = null; } };
  /** A turn whose latest segment streamed for less is not moved: the old path runs (his message is queued, the request cut, calls
   * detached; nothing forks). The threshold is config.json rev5.backgroundTurnMinGeneratingMs; unset is a loud refusal to fork,
   * never a code default.
   */
  function keepsInBackground(t) {
    try { return generatingMs(t) > (factories.backgroundMinGeneratingMs ? factories.backgroundMinGeneratingMs() : backgroundMinGeneratingMs({ env })); }
    catch (error) {
      process.stderr.write(`[rev6 pull] background turn not kept: ${error.message}\n`);
      emit({ type: 'system', subtype: 'status', status: 'background_turn_config_missing', detail: error.message });
      return false;
    }
  }
  /** A turn can be moved only while its model request streams or its tool calls run, and only once its loop has started. */
  const backgroundable = (t) => Boolean(t && !t.interrupted && !t.bg && t.opts && (t.streaming || t.calls?.length) && agents && typeof agents.adopt === 'function' && !state.restarting);
  /** Its model request keeps streaming and its tool calls (an Agent launch included) keep running; every row it writes
   * from now on goes to the fork, and it stops talking to the transcript. The main session is closed at that point:
   * streamed text kept and marked, each outstanding call answered as still running in the background, a note; the caller
   * then starts his message as a fresh turn (nothing is emitted as a result: to the chat it is one run, and the new turn
   * ends it). agents.adopt() owns the rest: listed, agent_cancel, resumed after a restart, and its report reaches the
   * main session at its next boundary or wakes an idle chat, announced to the transcript as one collapsed automated event
   * when it ends (announceBackground). Returns the id, or null when it could not be moved (then the old path runs).
   */
  function backgroundTurn(t) {
    const id = `${BACKGROUND_TURN_PREFIX}${randomUUID().slice(0, 8)}`, fork = `${sessionId}/agent/${id}`, gist = backgroundGist(t.first);
    // What the turn has written so far, taken before anything moves: the new turn reads it in the note (BACKGROUND_NOTE).
    const view = { generatingMs: generatingMs(t), streaming: t.streaming, blocks: t.live.blocks(), calls: t.calls || [] };
    try {
      ledger.ensureSession(fork, { model, cwd, forkedFrom: sessionId, at: now() });
      // Only the rows still in context, summary first, as active() orders them.
      const copy = ledger.db.prepare('INSERT INTO messages (session_id, role, kind, content, created_at, compacted_at, redactions) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const r of ledger.db.prepare("SELECT role, kind, content, created_at, redactions FROM messages WHERE session_id = ? AND compacted_at IS NULL ORDER BY CASE WHEN kind = 'summary' THEN 0 ELSE 1 END, seq").all(sessionId)) {
        copy.run(fork, r.role, r.kind, r.content, r.created_at, null, r.redactions);
      }
    } catch (error) { process.stderr.write(`[rev6 pull] background fork failed, the old path runs: ${error.message}\n`); return null; }
    let finish, fail;
    const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const adopted = agents.adopt({ id, sessionId: fork, description: `Background turn: ${gist}`, model, done });
    if (adopted.error) {
      ledger.db.prepare('DELETE FROM messages WHERE session_id = ?').run(fork);
      process.stderr.write(`[rev6 pull] background turn refused (${adopted.error}); the old path runs\n`);
      return null;
    }
    adopted.signal.addEventListener('abort', () => { t.interrupted = true; t.requestStop?.abort(); }, { once: true });
    // JavaScript runs all of this before the turn's next step, so from here every write of the turn lands in the fork.
    t.bg = { id, queue: adopted.queue, fail, finish: (res) => finish({ status: res.status, result: backgroundResult(res), usage: res.usage, cost: res.cost, calls: res.calls, stopReason: null }) };
    t.sid = fork;
    t.opts.sessionId = fork;
    t.opts.canCompact = false;
    t.arrivals.push(contextBlock('Background', BACKGROUND_FORK_NOTE));
    for (const w of t.wakes) { state.ownerWaiters.delete(w); state.paceWaiters.delete(w); }
    t.wakes.clear();
    const said = t.streaming && t.streamText ? t.streamText : '';
    if (said) ledger.append(sessionId, 'assistant', 'interrupted', [{ type: 'text', text: said }, { type: 'text', text: BACKGROUND_MARK(id) }], now());
    if (t.calls?.length) {
      const answered = t.calls.map((call) => ({ type: 'tool_result', tool_use_id: call.id, content: BACKGROUND_CALL_NOTE(id) }));
      ledger.append(sessionId, 'user', 'tool_result', answered, now());
      for (const b of answered) emit({ type: 'user', message: { role: 'user', content: [b] }, tool_use_result: b.content, parent_tool_use_id: null });
    }
    ledger.append(sessionId, 'user', 'injected', [contextBlock('Background turn', BACKGROUND_NOTE(id, view))], now());
    if (state.turn === t) state.turn = null;
    state.running = null;
    return id;
  }
  /**
   * The stop control's other half: every background turn and every running subagent of this conversation is cancelled,
   * and none of them wakes the chat (settledByStop). Returns the ids.
   */
  function cancelAllWork() {
    if (!agents) return [];
    const ids = agents.running().map((a) => a.id);
    for (const agentId of ids) { state.stopIds.add(agentId); agents.cancel({ agent_id: agentId }); }
    return ids;
  }
  /** A run the stop control cancelled has nothing to report: its row is marked delivered so no wake or boundary block carries it. */
  function settledByStop(id) {
    try { ledger.db.prepare('UPDATE agents SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?').run(now(), id); }
    catch (error) { process.stderr.write(`[rev6 pull] stopped run not marked delivered: ${error.message}\n`); }
  }
  /**
   * A background turn that ended tells the transcript, once, as an automated event: the webchat draws it as the muted
   * collapsed bubble automated events use (core/automated-event.js), the result inside. The same text reaches the model
   * as a 'Background turn report' block at its next boundary. Nothing is shown while it runs.
   */
  function announceBackground(id) {
    if (!isBackgroundTurn(id) || state.stopped) return;
    try {
      const row = ledger.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
      if (row) emit({ type: 'system', subtype: 'background_turn', state: row.status, background_id: id, gist: String(row.description || '').replace(/^Background turn: /u, ''),
        result: row.result || '', calls: row.calls, cost_usd: row.cost_usd, started_at: row.created_at, ended_at: row.ended_at });
    } catch (error) { process.stderr.write(`[rev6 pull] background turn announce failed: ${error.message}\n`); }
  }
  /** Starts the watchdog clock for an owner message that has just arrived (the oldest one still waiting keeps its time). */
  function armOwnerWatchdog() {
    const limit = ownerWatchdogMs(env);
    if (!(limit > 0) || state.stopped) return;
    state.ownerPendingSince ??= Date.now();
    if (state.watchdogTimer) return;
    state.watchdogTimer = setInterval(ownerWatchdog, Math.max(250, Math.min(5000, Math.round(limit / 4))));
    state.watchdogTimer.unref?.();
  }
  /** An owner message no request has carried within the limit. First the step is restarted (its abort, which every wait in
   * the root loop races). Loud on stderr either way: this firing means some wait in the loop is not bounded, and that is
   * a bug to fix.
   */
  function ownerWatchdog() {
    const since = state.ownerPendingSince, limit = ownerWatchdogMs(env);
    if (since === null || state.stopped) { clearInterval(state.watchdogTimer); state.watchdogTimer = null; return; }
    const waited = Date.now() - since, t = state.turn;
    if (waited < limit) return;
    if (t && !t.abandoned && waited < limit * 1.5) {
      if (t.watchdogKicked) return;
      t.watchdogKicked = true;
      process.stderr.write(`[rev6 pull] WATCHDOG ${new Date().toISOString()} session ${sessionId}: an owner message has waited ${waited} ms with no model request carrying it (last request ${state.lastRequestAt ? `${Date.now() - state.lastRequestAt} ms ago` : 'never'}); restarting the step\n`);
      t.ownerCut = true; t.requestStop?.abort();
      return;
    }
    process.stderr.write(`[rev6 pull] WATCHDOG ${new Date().toISOString()} session ${sessionId}: an owner message has waited ${waited} ms and the step restart did not free it; ${t ? 'abandoning the stuck turn and starting a fresh one' : 'starting its turn'} (subagents are left running)\n`);
    emit({ type: 'system', subtype: 'status', status: 'recovering', action: 'watchdog', reason: 'owner message waited', detail: `no model request carried it for ${waited} ms`, model, recoveries: 0 });
    state.ownerPendingSince = Date.now();
    if (t) abandonTurn(t);
    else if (state.running && !state.compacting) return; // a turn being set up (tools.ready): the next tick sees it
    state.running = null;
    if (state.queue.some((q) => !q.pace)) startQueuedTurn();
    else if (t) runTurn(t.first, { prefetch: false });
  }
  /** The watchdog's last resort: the turn keeps whatever wait holds it but can no longer write, emit or end the run. */
  function abandonTurn(t) {
    t.abandoned = true; t.interrupted = true;
    try { t.requestStop?.abort(); t.controller.abort(); } catch { /* aborted */ }
    for (const w of t.wakes) { state.ownerWaiters.delete(w); state.paceWaiters.delete(w); }
    t.wakes.clear();
    if (state.turn === t) state.turn = null;
  }
  function startQueuedTurn() {
    if (state.turn || state.running) return;
    const at = state.queue.findIndex((q) => !q.pace);
    if (at < 0) return;
    const next = state.queue.splice(at, 1)[0];
    runTurn(next.blocks[0].text, next.home ? { joined: next.home } : undefined);
  }

  return {
    sessionId,
    get model() { return model; },
    start() {
      ledger.claim(sessionId, process.pid);
      emit({ type: 'system', subtype: 'init', cwd, model, permissionMode, reasoning_effort: reasoningEffort, providers: providersAvailable(env), tools: tools.specs.map((t) => t.name), runner: 'rev5-direct' });
      pushLater();
      state.started = true;
      armCheckIn();
      scheduleAgentWake();
    },
    handle,
    busy: () => Boolean(state.turn || state.running),
    settled: () => state.running || Promise.resolve(),
    drained: () => state.pushing || Promise.resolve(),
    stop() { this.stopKeepLedger(); ledger.close(); },
    stopKeepLedger() {
      state.stopped = true;
      clearTimeout(state.checkInTimer); clearTimeout(state.settleTimer); clearInterval(state.watchdogTimer); state.checkInTimer = null; state.settleTimer = null; state.watchdogTimer = null;
      tools.jobs.stopAll(); tools.abortForeground(); agents?.cancelAll(); tools.closeBrowser?.().catch(() => {});
      try { ledger.claim(sessionId, null); } catch { /* ledger closed */ }
    },
  };
}

/** Settle every session's pending push slices from a process that holds no conversation (skips sessions a live runner holds). */
export async function drainPending({ env = process.env, write = () => {}, ledger = openLedger(ledgerPath(env)), now = () => new Date().toISOString(), factories = {} } = {}) {
  const report = [], alive = (pid) => { if (!pid || pid === process.pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const sessionId of ledger.sessionsWithPending()) {
    const row = ledger.session(sessionId);
    if (alive(row?.runner_pid)) { report.push({ session: sessionId, skipped_live_runner: row.runner_pid, pending_after: ledger.pendingPushes(sessionId).length }); continue; }
    const runner = createRunner({ args: { resume: sessionId, model: row?.model, cwd: row?.cwd || process.cwd(), addDirs: [] }, env, write, now, ledger, factories });
    runner.start();
    await runner.drained();
    report.push({ session: sessionId, pending_after: ledger.pendingPushes(sessionId).length });
    runner.stopKeepLedger();
  }
  ledger.close();
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.reconcilePending) {
    const ledger = openLedger(ledgerPath(process.env));
    const report = reconcilePending({ ledger, apply: Boolean(args.apply), now: clockFrom() });
    ledger.close();
    return process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  if (args.drainPending) return process.stdout.write(`${JSON.stringify({ drained_sessions: await drainPending({ now: clockFrom() }) })}\n`);
  const runner = createRunner({ args, now: clockFrom() });
  process.once('exit', () => removeIncognitoScratch(process.env));
  runner.start();
  // Leaving, for a signal or for a lost parent: take the turn wherever it is (the restart control request), hand off
  // the queued push, then go; the grace window is bounded and a second call leaves at once.
  let leaving = false;
  const leave = (why = 'SIGTERM') => {
    const go = () => { try { runner.stop(); } catch { /* closed */ } process.exit(0); };
    if (leaving) return go();
    leaving = true;
    try { runner.handle({ type: 'control_request', request_id: `restart-${why}`, request: { subtype: 'restart' } }); } catch { /* best effort */ }
    setTimeout(go, Number(process.env.TOPHAT_RUNNER_RESTART_GRACE_MS || 2000)).unref?.();
    return runner.settled().then(() => runner.drained()).then(go, go);
  };
  // Uncaught throws are reported and survived as before; a broken stdio pipe, a dead parent or an exception storm
  // leaves instead of spinning.
  const guard = installProcessGuards({ label: 'rev6 pull', leave: (why) => { guard.log(`[rev6 pull] leaving: ${why}`); leave('orphaned'); } });
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    try { runner.handle(message); } catch (error) { guard.log(`[rev6 pull] ${error.message}`); }
  });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => { runner.settled().then(() => runner.drained()).then(() => { runner.stop(); process.exit(0); }); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, leave);
  return undefined;
}

const invokedDirectly = () => { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } };
if (invokedDirectly()) await main();
