// The goal ledger and the no-stop continuation hook.
//
// So the assistant writes down the outstanding items of a multi-step task (goal_add),
// closes each as it actually lands (goal_close), and when a turn would end with items
// still open the runner hands the turn back to the assistant with those items named
// instead of returning to him.
//
// Two hard-won rules from the previous harness are built in:
//
//  * A goal set and cleared inside one turn must clear. Here the ledger is a
//    plain JSON file, read fresh from disk at every stop check, so an item
//    opened and closed in the same turn is closed; goal_list prints it and the
//    file path; and goal_close (status dropped, or stand_down) is an escape the
//    assistant can use on its own. A ledger that cannot be read never holds a
//    stop: a wedged hook is worse than no hook.
//  * Blocked means the owner has to act. The continuation names the
//    outstanding items themselves and says in so many words that a build, a
//    test or another agent is unfinished work to stay on, never that the
//    assistant is blocked.
//  * The stop check is a completion sweep, not just a goal check: the
//    continuation re-reads the owner's own messages and checks every ask
//    against what landed, because the ask that gets dropped is the one
//    displaced by newer work, and the ledger only holds what the assistant
//    thought to write down. See continuationMessage().
//
// A continuation is decided from the ledger and the text of the reply, never from a clock
// (model.mjs timeoutMs 0, same reason). The one clock that touches a goal is goal_wait
// (rev5/waits.mjs): an item blocked on something that changes with time stays open with a
// retry time, the webchat server wakes the owning chat when it falls due, and `dropped`
// is refused unless it names a real reason (cancelled, satisfied, superseded).
import { taskRequest } from './tasks.mjs';
import { owner, ownerPossessive } from '../owner.mjs';
import { scrubForStore } from '../src/vault/scrub-store.mjs';
import { checkDrop, openWaits } from './waits.mjs';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// Consecutive continuations with nothing closed between them; then the turn ends and the owner gets the floor.
export const CONTINUATION_CAP = 8;
// Continuations in one turn however much gets closed: a ledger that grows as fast as it is closed still ends.
export const CONTINUATION_TOTAL_CAP = 24;
// A turn with no ledger is swept only once it has really been working: a one-tool lookup ends when it
// is answered (the owner's 30s target), a turn that ran this many tool calls is where an ask gets buried.
export const SWEEP_MIN_CALLS = 3;

export function goalsDir(env = process.env) {
  return env.TOPHAT_RUNNER_GOALS_DIR || join(env.TOPHAT_STATE_DIR || join(homedir(), '.local', 'state', 'tophat'), 'rev5', 'goals');
}

export function goalsPath(sessionId, env = process.env) {
  return join(goalsDir(env), `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);
}

const empty = (sessionId) => ({ session_id: sessionId, hook: 'on', stand_down_reason: null, items: [] });

/**
 * One conversation's ledger, on disk as JSON. Every call reads the file again:
 * the file is the truth, not anything held in this process, so an item closed
 * a moment ago is closed for the stop check that follows.
 */
export function openLegacyGoals(options) {
  return withSleeping(openPlainGoals(options), options);
}

function openPlainGoals({ sessionId, env = process.env, now = () => new Date().toISOString(), path = goalsPath(sessionId, env) }) {
  const read = () => {
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch (error) {
      // No file yet is an empty ledger; anything else unreadable is stated, and an unreadable ledger never holds a stop.
      return error.code === 'ENOENT' ? { ...empty(sessionId), path } : { ...empty(sessionId), path, unreadable: `${error.code || 'error'}` };
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { ...empty(sessionId), path, unreadable: 'the ledger file is not JSON' }; }
    const items = Array.isArray(parsed?.items) ? parsed.items.filter((i) => i && typeof i.text === 'string') : [];
    return { next_goal: parsed.next_goal, shared_work: parsed.shared_work === true, has_goals: parsed.has_goals === true, session_id: parsed?.session_id ?? sessionId, hook: parsed?.hook === 'off' ? 'off' : 'on', stand_down_reason: parsed?.stand_down_reason ?? null, items, path };
  };
  const write = (state) => {
    mkdirSync(goalsDir(env), { recursive: true, mode: 0o700 });
    // Goal text is model-written: exact vault values out before it touches the disk.
    const clean = scrubForStore({ session_id: state.session_id, hook: state.hook, stand_down_reason: state.stand_down_reason, updated_at: now(), shared_work: state.shared_work, has_goals: state.has_goals, next_goal: state.next_goal, items: state.items }, { env, label: 'goals' }).value;
    const body = JSON.stringify(clean, null, 1);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
    return read();
  };
  return {
    path,
    read,
    todos() { return read().items.filter((i) => i.status === 'todo'); },
    /** Declare open items. Same text as a live todo is not added twice, so a re-declared goal does not multiply. */
    add(texts, note = null) {
      const state = read();
      if (state.unreadable) Object.assign(state, empty(sessionId), { path });
      let next = state.items.reduce((max, i) => Math.max(max, Number(String(i.id || '').replace(/\D/g, '')) || 0), 0);
      const added = [];
      for (const raw of [].concat(texts || [])) {
        // Compared in its stored (scrubbed) form, or a goal naming a vault value would be re-added on every declare.
        const text = scrubForStore(String(raw ?? '').trim(), { env, label: 'goals' }).value;
        if (!text) continue;
        const live = state.items.find((i) => i.status === 'todo' && i.text === text);
        if (live) { added.push(live); continue; }
        const item = { id: `g${++next}`, text, status: 'todo', note, created_at: now(), updated_at: now() };
        state.items.push(item);
        added.push(item);
      }
      return { state: write(state), added };
    },
    /** Close items by id, or all of them. `stand_down` switches the hook off for this conversation whatever the items say. */
    close({ ids = null, all = false, status = 'done', note = null, stand_down = false } = {}) {
      const state = read();
      if (state.unreadable) Object.assign(state, empty(sessionId), { path });
      const want = status === 'dropped' ? 'dropped' : 'done';
      const wanted = new Set((ids || []).map(String));
      const closed = [], missing = [...wanted].filter((id) => !state.items.some((i) => String(i.id) === id));
      for (const item of state.items) {
        if (!(all || wanted.has(String(item.id)))) continue;
        if (item.status !== 'todo' && !all) { closed.push(item); continue; }
        if (item.status !== 'todo') continue;
        item.status = want; item.updated_at = now(); if (note) item.note = note;
        closed.push(item);
      }
      if (stand_down) { state.hook = 'off'; state.stand_down_reason = note || 'the assistant stood the continuation hook down'; }
      return { state: write(state), closed, missing };
    }
  };
}

/** Items with an armed retry timer carry waiting_until: the stop hook does not hold a turn open for them. */
function withSleeping(api, { sessionId, env = process.env, now }) {
  const waits = openWaits({ sessionId, env, ...(now ? { now } : {}) });
  const annotate = (state) => {
    let by;
    try { by = new Map(waits.read().filter((w) => !w.awake).map((w) => [String(w.goal_id), w])); } catch { by = new Map(); }
    if (!by.size || !Array.isArray(state.items)) return state;
    return { ...state, items: state.items.map((i) => (i.status === 'todo' && by.has(String(i.id)) ? { ...i, waiting_until: by.get(String(i.id)).retry_at } : i)) };
  };
  const read = () => annotate(api.read());
  return { ...api, sessionId, env, waits, read, todos: () => read().items.filter((i) => i.status === 'todo') };
}

/** JSON retains hook settings and legacy aliases; every task state is read from shared work. */
export function openGoals(options) {
  return withSleeping(openSharedGoals(options), options);
}

function openSharedGoals(options) {
  const { sessionId, env = process.env } = options;
  const legacy = openLegacyGoals(options);
  const call = (request) => taskRequest(request, env);
  const binding = (id) => ({ source: 'chat-goal', native_id: `${sessionId}:${id}` });
  // The chat itself is a work item (rev5/chats.py), bound `<session>:chat`; goals are its children.
  // It is the chat, not one of its goals, so the ledger and the stop hook never list it.
  const isChat = (row) => (row.bindings || []).some(b => b.source === 'chat-goal' && b.native_id === `${sessionId}:chat`);
  let chatWorkId = null;
  /** The chat's work item, created on first use; null when the store cannot make one (goals still work). */
  function ensureChat(title = null) {
    if (chatWorkId) return chatWorkId;
    try { chatWorkId = call({ op: 'chat', session: sessionId, ...(title ? { title: String(title).slice(0, 200) } : {}) }).work?.id || null; }
    catch { chatWorkId = null; }
    return chatWorkId;
  }
  function remember(old) {
    mkdirSync(dirname(legacy.path), { recursive: true, mode: 0o700 });
    const tmp = `${legacy.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(scrubForStore({ ...old, shared_work: true, has_goals: true }, { env, label: 'goals' }).value), { mode: 0o600 });
    renameSync(tmp, legacy.path);
  }
  function rows() {
    const old = legacy.read();
    if (old.unreadable) throw Error(old.unreadable);
    // Legacy migration is explicit identity preservation, never text matching across tasks.
    for (const item of old.shared_work ? [] : old.items) {
      if (call({ op: 'list', binding: binding(item.id) }).tasks.length) continue;
      call({ op: 'apply', actor: `chat:${sessionId}`, op_id: `goal-migrate:${sessionId}:${item.id}`,
        tasks: [{ title: item.text, body: item.note || '', status: item.status, owner_kind: 'chat', owner_ref: sessionId, bindings: [binding(item.id)] }] });
    }
    if (!old.shared_work && old.items.length) { remember(old); old.has_goals = true; }
    const found = [];
    let offset = 0;
    do {
      const result = call({ op: 'list', owner_kind: 'chat', owner_ref: sessionId, limit: 200, offset });
      found.push(...result.tasks); offset = result.next_offset;
    } while (offset !== null);
    return { ...old, items: found.filter(row => !isChat(row)).map(row => ({ id: row.bindings.find(b => b.source === 'chat-goal' && b.native_id.startsWith(`${sessionId}:`))?.native_id.slice(sessionId.length + 1) || row.id,
      work_id: row.id, text: row.title, status: row.status, version: row.version, owner_kind: row.owner_kind, owner_ref: row.owner_ref })) };
  }
  const read = () => { try { return rows(); } catch (error) { return { ...empty(sessionId), path: legacy.path, unreadable: error.message }; } };
  return {
    path: legacy.path, read, ensureChat, todos: () => read().items.filter(i => i.status === 'todo'),
    add(texts, note = null, workIds = []) {
      const state = rows(), added = [];
      let next = Math.max(legacy.read().next_goal || 1, ...state.items.map(i => /^g[0-9]+$/.test(i.id) ? Number(i.id.slice(1)) + 1 : 1));
      // Explicit shared IDs attach existing outcomes; never steal another chat's responsibility.
      for (const id of workIds) {
        const row = call({ op: 'get', id }).work;
        if (row.owner_kind !== 'chat' || row.owner_ref !== sessionId) throw Error('Task is not owned by this chat; hand it off through tasks first');
        added.push(state.items.find(i => i.work_id === id));
      }
      for (const raw of texts || []) {
        // Compared in its stored (scrubbed) form: the shared store keeps the scrubbed title (rev5/tasks.mjs), so the raw
        // text of a goal naming a vault value never matches and every re-declare would add a duplicate.
        const text = scrubForStore(String(raw).trim(), { env, label: 'goals' }).value; if (!text) continue;
        const existing = state.items.find(i => i.text === text);
        if (existing) { added.push(existing); continue; }
        const id = `g${next++}`;
        const parent = ensureChat();
        const result = call({ op: 'apply', actor: `chat:${sessionId}`, op_id: `goal-add:${sessionId}:${id}`,
          tasks: [{ title: text, body: note || '', owner_kind: 'chat', owner_ref: sessionId, bindings: [binding(id)], ...(parent ? { parent_id: parent } : {}) }] });
        const row = { id, work_id: result.work[0].id, text, status: 'todo', version: 1 };
        state.items.push(row); added.push(row);
      }
      if (added.length) remember({ ...legacy.read(), has_goals: true, next_goal: next });
      return { state: rows(), added };
    },
    close({ ids = [], all = false, status = 'done', note = null, stand_down = false } = {}) {
      const state = rows(), wanted = new Set(ids), closed = [];
      const missing = ids.filter(id => !state.items.some(i => i.id === id || i.work_id === id));
      for (const item of state.items) {
        if (!all && !wanted.has(item.id) && !wanted.has(item.work_id)) continue;
        if (item.status !== 'todo') { closed.push(item); continue; }
        call({ op: 'apply', actor: `chat:${sessionId}`, op_id: `goal-close:${sessionId}:${item.work_id}:${item.version}:${status}`,
          tasks: [{ id: item.work_id, expected_version: item.version, status: status === 'dropped' ? 'dropped' : 'done', ...(note ? { body: note } : {}) }] });
        closed.push({ ...item, status: status === 'dropped' ? 'dropped' : 'done' });
      }
      if (stand_down) legacy.close({ ids: [], stand_down, note });
      return { state: rows(), closed, missing };
    }
  };
}

/** The reply hands the floor back on its own: it asks him something. */
export function questionForOwner(text) {
  const whole = String(text || '').trim();
  if (!whole) return false;
  const paragraphs = whole.split(/\n\s*\n/).filter((p) => p.trim());
  const tail = paragraphs[paragraphs.length - 1] || '';
  if (tail.includes('?')) return true;
  return /\b(?:let me know|your call|tell me which|say the word|which would you prefer|want me to|shall i|should i)\b/i.test(whole);
}

/** Loose ends in the reply: anything that keeps the question from being fully answered, not just a trailing
 * offer ("want me to check x?") but anything left to chase down. Some quality of attention is missing when an
 * answer announces a plan and never looked anything up, or says something clearly wrong with casual confidence.
 *
 * This is deliberately a cheap trigger. The offer test reads the last paragraph only; the others read the whole
 * reply. Whether a loose end is real, and whether it needs him, is judged by the model in looseEndMessage(). A
 * false positive costs one extra pass that ends with nothing to add.
 */
const OFFER_PATTERNS = [
  /\b(?:do you )?want me to\b/i,
  /\bwould you like me to\b/i,
  /\b(?:should|shall) i\b/i,
  /\blet me know if you(?:'d| would)? (?:like|want|prefer)\b/i,
  /\b(?:i|i'd be happy to|happy to)\b[^.\n?]{0,200}\bif you(?:'d| would)? (?:want|like|prefer)\b/i,
  /\bsay the word\b/i
];
const LOOSE_PATTERNS = [
  // a lookup not run, a source not checked, "I didn't see X" with the store unsearched
  /\bi (?:did not|didn't|do not|don't|have not|haven't|could not|couldn't|was not able to|wasn't able to|never|can't|cannot) (?:\w+ ){0,2}(?:see|seen|find|found|check(?:ed)?|look(?:ed)?|search(?:ed)?|verif(?:y|ied)|confirm(?:ed)?|open(?:ed)?|read|access(?:ed)?|tell|reach(?:ed)?|pull(?:ed)?|fetch(?:ed)?|test(?:ed)?)\b/i,
  /\b(?:not yet|never|not) (?:been )?(?:verified|checked|confirmed|searched|tested)\b|\b(?:unverified|unchecked|unconfirmed)\b/i,
  // a claim carried by inference or memory
  /\bi(?:'m| am)? (?:assume|assuming|guess|guessing)\b|\b(?:presumably|from memory|if i recall|if i remember)\b/i,
  // a step named and not taken
  /\bi(?:'d| would|'ll| will)? need to (?:check|look|sign|open|search|read|verify|run|fetch|pull|log|call|find)\b/i
];
export function trailingOffer(text) {
  const paragraphs = String(text || '').trim().split(/\n\s*\n/).filter((p) => p.trim());
  const tail = paragraphs[paragraphs.length - 1] || '';
  return OFFER_PATTERNS.some((re) => re.test(tail));
}
/** Which kinds of loose end the reply shows, by regex alone: [] when none. */
export function looseEnds(text) {
  const t = String(text || '');
  return [...(trailingOffer(t) ? ['offer'] : []), ...(LOOSE_PATTERNS.some((re) => re.test(t)) ? ['unchecked'] : [])];
}

/** Handed back once per turn when the reply shows a loose end. The judgment is the model's; the trigger is a regex. */
export function looseEndMessage() {
  return [
    `Before this turn ends, read your reply for loose ends that keep ${ownerPossessive()} question from being fully answered. Seriousness is the quality of attention that does that work: a friend who announces a plan and never looked anything up is not serious, and neither is an answer said with casual confidence that a few more checks would confirm or overturn.`,
    'Look for: an offer to do something your tools can do ("want me to...", "I can... if you want"); a lookup the answer rests on that you did not run; a source you did not check; "I didn\'t see X" or "couldn\'t find X" where a store, mailbox, account or API was not searched; a claim carried from memory or inference that one read would verify.',
    'Chase each one down now, in this turn, with your tools, then give the full answer with the result, each claim tagged with its source.',
    `Leave a question only where it truly needs ${owner()}: spending money he has not authorized, an email or message to someone outside (mail waits on his go), a choice only he can make, a credential or action only he can supply. Say exactly which and why.`,
    'If nothing is loose, end the turn without repeating the answer. This check does not repeat in this turn.'
  ].join('\n');
}

/**
 * The reply names something only the owner can do. Deliberately narrow: the word "blocked" beside a build, a test or
 * another agent is the assistant's own unfinished work and does not end a turn.
 */
export function needsOwnerAction(text) {
  const t = String(text || '');
  return /\b(?:blocked|blocker|waiting|waits|wait|stuck)\b[^.\n]{0,100}\b(?:you|your|owner|the owner)\b/i.test(t)
    || /\b(?:needs?|require[sd]?|awaiting)\s+(?:you|your|owner|the owner)\b/i.test(t)
    || /\b(?:only|just)\s+(?:you|owner|the owner)\s+(?:can|could|may)\b/i.test(t)
    || /\b(?:you|owner|the owner)\s+(?:have|has|had|need|needs|must|will need)\s+to\b/i.test(t);
}

/**
 * The words injected instead of yielding: the items themselves, the completion
 * sweep, and no suggestion that anything is blocked.
 *
 * The ledger alone only tracks what the assistant thought to write down; the
 * asks the owner made are the other half, and the ones that get dropped are the
 * ones displaced by newer work. Delegation is where the sweep earns its keep:
 * handing an ask to a subagent and never reading the report back is a failure,
 * and dispatch, a partial answer, a draft or an unreviewed artifact is not
 * completion.
 *
 * Kept to a few lines on purpose: this text is injected into a live turn, every
 * turn that continues.
 */
export function continuationMessage(todos) {
  return [
    'Your goal ledger for this conversation still has open items and this turn has not closed them:',
    ...todos.map((i) => `- ${i.id}: ${i.text}`),
    `Re-read ${ownerPossessive()} messages in this conversation and check every ask he made, one by one, against what actually landed, the ones displaced by newer work included. An ask you answered but never delivered, or delegated and never verified, is still open: dispatch is not completion. Anything of his still unaddressed, listed above or not: goal_add it now.`,
    'Carry on with them now, in this turn: take the next concrete step instead of describing it, and goal_close each item the moment it actually lands, status done with a note saying what proves it. Close an item only on what proves it.',
    `Satisfied, retracted by ${owner()}, or replaced: goal_close dropped with why (owner_cancelled, already_satisfied, superseded, duplicate) and the proof. Blocked on something that changes with time (slots, store hours, a reply): never a drop; goal_wait with retry_at or retry_in_minutes and a timer wakes this chat.`,
    `Your own unfinished work is not a blocker: a build still running, a test not green, a subagent still working, another process holding a file. Wait for it, work around it, or take it back and finish it. Only something ${owner()} himself has to do is worth ending the turn on, and then name exactly that action.`,
    `Do not hand the turn back to ${owner()} while an ask of his is unaddressed.`,
    'If the ledger itself is wrong, goal_close with stand_down true ends these continuations for the rest of the conversation.'
  ].join('\n');
}

/** One pass, then the turn ends. */
export function sweepMessage() {
  return [
    'Before this turn ends: nothing was declared in the goal ledger, so check by hand.',
    `Re-read ${ownerPossessive()} messages in this conversation and check every ask he made, one by one, against what actually landed, the ones displaced by newer work included. An ask you answered but never delivered, or delegated and never verified, is still open: dispatch is not completion.`,
    'Anything of his still unaddressed: goal_add it now and take the next concrete step in this turn.',
    'If every ask of his has actually landed, say nothing further and end the turn; this sweep does not repeat.'
  ].join('\n');
}

/**
 * The stop hook's decision, as a value: whether the runner re-enters the loop
 * with a continuation, and the reason either way. Pure, so the runner's
 * behaviour is testable without a model.
 */
export function continuationDecision({ ledger, text = '', consecutive = 0, total = 0, ownerWaiting = false, interrupted = false, enabled = true, worked = 0, workersRunning = 0, looseEndsChecked = false, toolsAvailable = true } = {}) {
  const no = (reason) => ({ continue: false, reason });
  if (!enabled) return no('the goal hook is switched off (TOPHAT_RUNNER_GOAL_HOOK=0)');
  if (interrupted) return no('the owner interrupted this turn');
  if (ownerWaiting) return no('the owner has sent a message; he has the floor');
  const state = ledger || {};
  if (state.unreadable) return no(`the goal ledger could not be read (${state.unreadable}); an unreadable ledger never holds a stop`);
  if (state.hook === 'off') return no(`the hook was stood down in this conversation${state.stand_down_reason ? `: ${state.stand_down_reason}` : ''}`);
  // A turn whose reply shows a loose end (an offer the tools can do, an unrun lookup, an unsearched store) goes back
  // once, ledger or no ledger: that is exactly the continuation nobody wrote down. It comes before the question
  // checks below, which treat "want me to" as the reply handing the floor back.
  if (toolsAvailable && !looseEndsChecked) {
    const loose = looseEnds(text);
    if (loose.length) return { continue: true, loose, reason: `the reply shows a loose end (${loose.join(', ')}); chase it down before ending`, items: [], message: looseEndMessage() };
  }
  const openItems = (state.items || []).filter((i) => i.status === 'todo');
  const todos = openItems.filter((i) => !i.waiting_until);
  // Every open item is asleep on a retry timer (goal_wait): the chat's wake, not another pass of this model, is what
  // looks at them next. They stay open; the timer re-arms itself until they close.
  if (openItems.length && !todos.length) return no(`${openItems.length} open item${openItems.length === 1 ? ' waits' : 's wait'} on a retry timer (goal_wait); the timer wakes this chat when it falls due`);
  // Ported here for a turn that did work and declared nothing: one sweep, then the turn ends. A turn
  // that called no tool at all is a plain answer and is not worth a second model call; the owner's 30s
  // target for a finished lookup is what that would spend.
  if (!todos.length) {
    if ((state.items || []).length) return no('every goal item is closed');
    if (state.has_goals) return no('every goal item is closed or handed off');
    if (worked < SWEEP_MIN_CALLS) return no(`nothing was declared and this turn made ${worked} tool call${worked === 1 ? '' : 's'}; too short to bury an ask`);
    if (total > 0 || consecutive > 0) return no('the completion sweep found nothing outstanding');
    if (questionForOwner(text)) return no('the reply asks the owner a question');
    if (needsOwnerAction(text)) return no('the reply names something only the owner can do');
    return { continue: true, reason: 'nothing was declared this turn; completion sweep', items: [], message: sweepMessage() };
  }
  // Open items with delegates still running are waiting on those delegates, not on another pass of this
  // model: a continuation here only re-reads the ledger and writes another status-only final. Each wake
  // (a subagent finishing, or its check-in falling due: rev5/pull.mjs wakeForAgents, checkInTick) then
  // started a fresh turn whose counters were zero, so the per-turn caps never bit and a parent with four
  // live workers produced dozens of finals. The items stay open and the hook stays on; the turn ends,
  // and the delegates' own reports wake it.
  if (workersRunning > 0) return no(`${workersRunning} subagent${workersRunning === 1 ? ' is' : 's are'} still running; ${workersRunning === 1 ? 'its report or check-in' : 'their reports and check-ins'} wake this conversation, and the ${todos.length} open item${todos.length === 1 ? ' stays' : 's stay'} open`);
  if (consecutive >= CONTINUATION_CAP) return no(`${consecutive} continuations in a row closed nothing; the owner gets the floor`);
  if (total >= CONTINUATION_TOTAL_CAP) return no(`${total} continuations in this turn is the ceiling; the owner gets the floor`);
  if (questionForOwner(text)) return no('the reply asks the owner a question');
  if (needsOwnerAction(text)) return no('the reply names something only the owner can do');
  return { continue: true, reason: `${todos.length} goal item${todos.length === 1 ? '' : 's'} still open`, items: todos, message: continuationMessage(todos) };
}

export function goalToolSpecs() {
  const s = (name, description, properties, required = []) => ({ name, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
  return [
    s('goal_add', 'Read task_list first. Attach existing work_ids already assigned to this chat; use task_update to hand off responsibility, never duplicate another owner’s outcome. Create genuinely distinct outstanding items with items. Open items keep this chat responsible until done, dropped or handed off.',
      { work_ids: { type: 'array', items: { type: 'string' }, description: 'existing shared work IDs already assigned to this chat' }, items: { type: 'array', items: { type: 'string' }, description: 'one outstanding item per entry' }, note: { type: 'string', description: 'optional context carried on each item' } }, ['items']),
    s('goal_close', `Close goal items: done when it actually landed. dropped ONLY with why = owner_cancelled (${owner()} said he no longer wants it), already_satisfied, superseded or duplicate, and a note naming the proof; a blocker (slots not open, store closed, page down, reply pending) is never a drop, use goal_wait. stand_down true ends the continuations for this conversation when the ledger itself is wrong.`,
      { ids: { type: 'array', items: { type: 'string' }, description: 'item ids from goal_add or goal_list' }, all: { type: 'boolean', description: 'close every open item' },
        status: { type: 'string', description: 'done | dropped, default done' }, why: { type: 'string', description: 'required for dropped: owner_cancelled | already_satisfied | superseded | duplicate' }, note: { type: 'string', description: 'what proves it, or why it was dropped' }, stand_down: { type: 'boolean', description: 'stop the continuation hook for this conversation' } }),
    s('goal_wait', `Keep a goal OPEN and set the time to look again, for anything blocked on something that changes with time: delivery slots not open yet, a store closed, a page down, a reply pending, a build you cannot wait for. A timer wakes this chat when it falls due and re-arms itself until you goal_close the item, so you never need to drop it or leave a note. Give retry_at (ISO instant with zone) or retry_in_minutes; pick when the blocker could really change, not a guess of minutes. Add deadline (ISO) when ${owner()} named one, so the wake can check the result against it.`,
      { id: { type: 'string', description: 'goal item id from goal_add or goal_list' }, reason: { type: 'string', description: 'what it is blocked on and what you will do when the timer fires' },
        retry_at: { type: 'string', description: 'ISO instant with a zone, e.g. 2026-10-17T07:30:00-07:00' }, retry_in_minutes: { type: 'number', description: 'alternative to retry_at; at least 1' }, deadline: { type: 'string', description: `ISO instant ${owner()} needs it by, if he named one` } }, ['id', 'reason']),
    s('goal_list', 'The goal ledger for this conversation as it stands on disk: every item with its status, and the file holding them.', {})
  ];
}

/** The three handlers, in the shape rev5/tools.mjs registers. */
export function createGoalTools(goals) {
  const waits = goals.waits || null;
  // The tool result is read by a model in the middle of a turn: it carries the ledger, not the ledger's history.
  // Notes and timestamps stay in the file (goals.path) and out of the context.
  const view = (state) => ({ path: goals.path, hook: state.hook, ...(state.stand_down_reason ? { stand_down_reason: state.stand_down_reason } : {}),
    ...(state.unreadable ? { unreadable: state.unreadable } : {}), open: state.items.filter((i) => i.status === 'todo').length,
    items: state.items.map((i) => ({ id: i.id, text: i.text, status: i.status, ...(i.waiting_until ? { waiting_until: i.waiting_until } : {}), ...(i.work_id ? { work_id: i.work_id, version: i.version } : {}) })) });
  return {
    async goal_add(input) {
      const { state, added } = goals.add(input.items, input.note ?? null, input.work_ids || []);
      return { added: added.map((i) => ({ id: i.id, text: i.text })), ...view(state) };
    },
    async goal_close(input) {
      if (input.status === 'dropped') {
        const refusal = checkDrop({ why: input.why, note: input.note });
        if (refusal) return { error: refusal, closed: [], ...view(goals.read()) };
      }
      const { state, closed, missing } = goals.close({ ids: input.ids, all: input.all, status: input.status, note: input.status === 'dropped' ? `[dropped: ${input.why}] ${input.note}` : input.note, stand_down: input.stand_down });
      // Closed for real (landed, or dropped with a real reason): its retry timer goes with it.
      try { waits?.clear(closed.filter((i) => i.status !== 'todo').flatMap((i) => [i.id, i.work_id].filter(Boolean))); } catch { /* the close stands; a stale timer wakes once and the chat clears it */ }
      return { closed: closed.map((i) => ({ id: i.id, text: i.text, status: i.status })), ...(missing.length ? { no_such_id: missing } : {}), ...view(state) };
    },
    async goal_wait(input) {
      const item = goals.read().items.find((i) => i.id === String(input.id) || i.work_id === String(input.id));
      if (!item) return { error: `no goal item ${JSON.stringify(input.id)}; goal_list shows the ids` };
      if (item.status !== 'todo') return { error: `goal ${item.id} is already ${item.status}; a wait is only for an open item` };
      if (!waits) return { error: 'retry timers are not available in this runner' };
      if (!String(input.reason || '').trim()) return { error: 'goal_wait needs a reason: what it is blocked on' };
      try {
        const wait = waits.arm({ goal_id: item.id, work_id: item.work_id || null, text: item.text, reason: input.reason, retry_at: input.retry_at, retry_in_minutes: input.retry_in_minutes, deadline: input.deadline });
        return { waiting: { goal: item.id, retry_at: wait.retry_at, ...(wait.deadline ? { deadline: wait.deadline } : {}), fires_so_far: wait.fires }, note: 'The goal stays open. A timer wakes this chat at retry_at, and again on a widening gap until you goal_close it.', ...view(goals.read()) };
      } catch (error) { return { error: error.message }; }
    },
    async goal_list() { return view(goals.read()); }
  };
}
