// The goal ledger: a chat's outstanding items as shared tasks in memory.sqlite (owner_kind chat, bound
// `chat-goal:<session>:<gN>`), and the continuation decision that hands a turn back to the model while items stay
// open or the reply shows a loose end. rev5's per-session JSON files are still written by the live rev5 runner, so
// they are only read here: their hook state and any items never moved to shared tasks. goal_wait: an item blocked
// on something that changes with time stays open with a retry time in <state>/rev5/waits/<session>.json; the
// webchat server (retry-wakes.js, through rev5/waits.mjs's dueWaits and fired) wakes the chat when it falls due,
// and `dropped` is refused unless it names a real reason. The runner half (checkDrop, arm, clear, read) is here
// and writes rev5/waits.mjs's file format byte for byte, under its lock.
import { spawnSync } from 'node:child_process';
import { owner, ownerPossessive } from '../../owner.mjs';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goalsDir, memoryDb } from '../base/paths.mjs';

export const CONTINUATION_CAP = 8, CONTINUATION_TOTAL_CAP = 24, SWEEP_MIN_CALLS = 3;
const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The shared task ledger (rev5/cli.py tasks), synchronously; throws with `current` on a stale write. */
export function taskRequest(request, env = process.env, command = 'tasks') {
  const repo = env.TOPHAT_REPO || REPO;
  const result = spawnSync(process.execPath, [join(repo, 'store', 'cli.mjs'), '--db', memoryDb(env), command], {
    cwd: repo, env: { ...env, PYTHONPATH: repo }, input: JSON.stringify(request), encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  let answer;
  try { answer = JSON.parse(result.stdout); } catch { throw Error(result.error?.message || 'Shared work unavailable'); }
  if (!answer.ok) throw Object.assign(Error(answer.detail || answer.reason || 'Task refused'), { current: answer.current });
  return answer;
}

// ---- retry timers (rev5/waits.mjs, the runner half).
export const DROP_WHYS = Object.freeze({
  owner_cancelled: `${owner()} said, in this conversation, that he no longer wants it`,
  already_satisfied: 'the outcome already exists (name the proof)',
  superseded: 'another goal or task now carries exactly this outcome (name its id)',
  duplicate: 'the same outcome is already a live item (name its id)' });
const MAX_WAIT_DAYS = 30;
const safeName = (sessionId) => `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`;
export const waitsPath = (sessionId, env = process.env) => join(env.TOPHAT_RUNNER_WAITS_DIR || join(dirname(goalsDir(env)), 'waits'), safeName(sessionId));
/** null when a drop is allowed, else the refusal text. */
export function checkDrop({ why, note }) {
  const key = String(why || '').trim();
  if (!Object.hasOwn(DROP_WHYS, key)) return `Not closed. status dropped needs why, one of: ${Object.entries(DROP_WHYS).map(([k, v]) => `${k} (${v})`).join('; ')}.`
    + `${key ? ` You gave ${JSON.stringify(key.slice(0, 60))}, which is not one.` : ''}`
    + ' A blocker is none of these: slots not open, store closed, page down, reply pending, a build or another agent unfinished.'
    + ' For those call goal_wait with retry_at or retry_in_minutes and the goal stays open and is retried by a timer that wakes this chat;'
    + ` if it truly needs ${owner()}, tell him the exact action in chat in this same turn and leave the goal open.`;
  if (String(note || '').trim().length < 8) return `Not closed. A dropped item needs a note naming the proof for why=${key}: ${DROP_WHYS[key]}.`;
  return null;
}
/** retry_at (ISO with a zone) or retry_in_minutes as epoch ms; throws a sentence on anything unusable. */
export function resolveRetry({ retry_at, retry_in_minutes }, nowMs) {
  let at;
  if (retry_in_minutes !== undefined && retry_in_minutes !== null && retry_in_minutes !== '') {
    const n = Number(retry_in_minutes);
    if (!Number.isFinite(n) || n < 1) throw Error('retry_in_minutes must be a number of at least 1');
    at = nowMs + Math.round(n * 60e3);
  } else if (retry_at) {
    const text = String(retry_at).trim();
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) throw Error('retry_at must be an ISO instant with a zone, e.g. 2026-10-17T07:30:00-07:00 or ...Z; or use retry_in_minutes');
    at = Date.parse(text);
    if (!Number.isFinite(at)) throw Error(`retry_at ${JSON.stringify(text)} is not a time`);
  } else throw Error('goal_wait needs retry_at or retry_in_minutes: a wait without a time is a drop under another name');
  if (at < nowMs + 30e3) throw Error('that time is already past (or under 30 seconds away); pick when the blocker could actually change');
  if (at > nowMs + MAX_WAIT_DAYS * 86400e3) throw Error(`a retry more than ${MAX_WAIT_DAYS} days out is not a retry; tell ${owner()} instead`);
  return at;
}
function withLock(path, fn) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 100; i++) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > 15000) rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ }
      const until = Date.now() + 20;
      while (Date.now() < until) { /* short spin: the critical section is one small file */ }
      if (i === 99) throw Error(`waits lock busy: ${lock}`);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}
function readWaits(path, sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { session_id: parsed.session_id ?? sessionId, next: Number(parsed.next) || 1, waits: Array.isArray(parsed.waits) ? parsed.waits.filter((w) => w && w.goal_id) : [] };
  } catch (error) {
    if (error.code !== 'ENOENT') try { renameSync(path, `${path}.unreadable-${Date.now()}`); } catch { /* nothing to keep */ }
    return { session_id: sessionId, next: 1, waits: [] };
  }
}
export function openWaits({ sessionId, env = process.env, now = () => new Date().toISOString(), path = waitsPath(sessionId, env) }) {
  const mutate = (fn) => withLock(path, () => {
    const state = readWaits(path, sessionId), out = fn(state), tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...state, updated_at: now() }, null, 1), { mode: 0o600 }); renameSync(tmp, path);
    return out;
  });
  return {
    path, read: () => readWaits(path, sessionId).waits,
    arm({ goal_id, work_id = null, text = '', reason, retry_at, retry_in_minutes, deadline = null }) {
      const at = resolveRetry({ retry_at, retry_in_minutes }, Date.parse(now()));
      const due = deadline ? Date.parse(String(deadline)) : null;
      if (deadline && !Number.isFinite(due)) throw Error(`deadline ${JSON.stringify(String(deadline))} is not a time (ISO instant with a zone)`);
      return mutate((state) => {
        let wait = state.waits.find((w) => w.goal_id === goal_id);
        if (!wait) { wait = { id: `w${state.next++}`, goal_id, created_at: now(), fires: 0 }; state.waits.push(wait); }
        Object.assign(wait, { work_id, text: String(text).slice(0, 300), reason: String(reason || '').slice(0, 500), retry_at: new Date(at).toISOString(),
          deadline: due ? new Date(due).toISOString() : (wait.deadline || null), awake: false, updated_at: now() });
        return { ...wait };
      });
    },
    clear(goalIds) {
      const ids = new Set(goalIds.map(String));
      if (!ids.size || !existsSync(path)) return 0;
      return mutate((state) => { const before = state.waits.length; state.waits = state.waits.filter((w) => !ids.has(String(w.goal_id)) && !ids.has(String(w.work_id))); return before - state.waits.length; });
    },
  };
}

export const goalsPath = (sessionId, env = process.env) => join(goalsDir(env), `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);
function readLegacy(path) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { return error.code === 'ENOENT' ? { items: [] } : { items: [], unreadable: error.code ? String(error.code) : 'the ledger file is not JSON' }; }
  return { hook: parsed?.hook === 'off' ? 'off' : 'on', stand_down_reason: parsed?.stand_down_reason ?? null, shared_work: parsed?.shared_work === true,
    has_goals: parsed?.has_goals === true, next_goal: parsed?.next_goal, items: Array.isArray(parsed?.items) ? parsed.items.filter((i) => i && typeof i.text === 'string') : [] };
}

export function openGoals({ sessionId, env = process.env, now, call = (r) => taskRequest(r, env) }) {
  const path = goalsPath(sessionId, env), waits = openWaits({ sessionId, env, ...(now ? { now } : {}) });
  const binding = (id) => ({ source: 'chat-goal', native_id: `${sessionId}:${id}` });
  const bound = (id) => call({ op: 'list', binding: binding(id) }).tasks.length > 0;
  const local = { hook: null, stand_down_reason: null };
  let chatWorkId = null;
  function ensureChat(title = null) {
    if (chatWorkId) return chatWorkId;
    try { chatWorkId = call({ op: 'chat', session: sessionId, ...(title ? { title: String(title).slice(0, 200) } : {}) }).work?.id || null; } catch { chatWorkId = null; }
    return chatWorkId;
  }
  function rows() {
    const old = readLegacy(path);
    if (old.unreadable) throw Error(old.unreadable);
    if (!old.shared_work) for (const item of old.items) {
      if (bound(item.id)) continue;
      call({ op: 'apply', actor: `chat:${sessionId}`, op_id: `goal-migrate:${sessionId}:${item.id}`,
        tasks: [{ title: item.text, body: item.note || '', status: item.status, owner_kind: 'chat', owner_ref: sessionId, bindings: [binding(item.id)] }] });
    }
    const found = [];
    let offset = 0;
    do { const r = call({ op: 'list', owner_kind: 'chat', owner_ref: sessionId, limit: 200, offset }); found.push(...r.tasks); offset = r.next_offset; } while (offset !== null && offset !== undefined);
    const prefix = `${sessionId}:`;
    const items = found.filter((row) => !(row.bindings || []).some((b) => b.source === 'chat-goal' && b.native_id === `${sessionId}:chat`)).map((row) => ({
      id: row.bindings?.find((b) => b.source === 'chat-goal' && b.native_id.startsWith(prefix))?.native_id.slice(prefix.length) || row.id,
      work_id: row.id, text: row.title, status: row.status, version: row.version, owner_kind: row.owner_kind, owner_ref: row.owner_ref }));
    return { session_id: sessionId, hook: local.hook || old.hook || 'on', stand_down_reason: local.stand_down_reason ?? old.stand_down_reason ?? null,
      has_goals: old.has_goals || (old.items.length > 0 && !old.shared_work), next_goal: old.next_goal, items, path };
  }
  // Items with an armed retry timer carry waiting_until: the stop hook does not hold a turn open for them.
  const annotate = (state) => {
    let by;
    try { by = new Map(waits.read().filter((w) => !w.awake).map((w) => [String(w.goal_id), w])); } catch { by = new Map(); }
    if (!by.size || !Array.isArray(state.items)) return state;
    return { ...state, items: state.items.map((i) => (i.status === 'todo' && by.has(String(i.id)) ? { ...i, waiting_until: by.get(String(i.id)).retry_at } : i)) };
  };
  const read = () => annotate((() => { try { return rows(); } catch (error) { return { session_id: sessionId, hook: 'on', stand_down_reason: null, items: [], path, unreadable: error.message }; } })());
  return {
    path, read, ensureChat, waits, todos: () => read().items.filter((i) => i.status === 'todo'),
    add(texts, note = null, workIds = []) {
      const state = rows(), added = [];
      let next = Math.max(state.next_goal || 1, ...state.items.map((i) => (/^g[0-9]+$/.test(i.id) ? Number(i.id.slice(1)) + 1 : 1)));
      for (const id of workIds) {
        const row = call({ op: 'get', id }).work;
        if (row.owner_kind !== 'chat' || row.owner_ref !== sessionId) throw Error('Task is not owned by this chat; hand it off through tasks first');
        added.push(state.items.find((i) => i.work_id === id));
      }
      for (const raw of texts || []) {
        const text = String(raw).trim();
        if (!text) continue;
        const existing = state.items.find((i) => i.text === text);
        if (existing) { added.push(existing); continue; }
        while (bound(`g${next}`)) next++;
        const id = `g${next++}`, parent = ensureChat();
        const result = call({ op: 'apply', actor: `chat:${sessionId}`, op_id: `goal-add:${sessionId}:${id}`,
          tasks: [{ title: text, body: note || '', owner_kind: 'chat', owner_ref: sessionId, bindings: [binding(id)], ...(parent ? { parent_id: parent } : {}) }] });
        const row = { id, work_id: result.work[0].id, text, status: 'todo', version: 1 };
        state.items.push(row); added.push(row);
      }
      return { state: rows(), added };
    },
    close({ ids = [], all = false, status = 'done', note = null, stand_down = false } = {}) {
      const state = rows(), wanted = new Set(ids || []), closed = [], final = status === 'dropped' ? 'dropped' : 'done';
      const missing = (ids || []).filter((id) => !state.items.some((i) => i.id === id || i.work_id === id));
      for (const item of state.items) {
        if (!all && !wanted.has(item.id) && !wanted.has(item.work_id)) continue;
        if (item.status !== 'todo') { closed.push(item); continue; }
        call({ op: 'apply', actor: `chat:${sessionId}`, op_id: `goal-close:${sessionId}:${item.work_id}:${item.version}:${status}`,
          tasks: [{ id: item.work_id, expected_version: item.version, status: final, ...(note ? { body: note } : {}) }] });
        closed.push({ ...item, status: final });
      }
      if (stand_down) Object.assign(local, { hook: 'off', stand_down_reason: note || 'the assistant stood the continuation hook down' });
      return { state: rows(), closed, missing };
    },
  };
}

// ---- the continuation decision.
export function questionForOwner(text) {
  const whole = String(text || '').trim();
  if (!whole) return false;
  const paragraphs = whole.split(/\n\s*\n/).filter((p) => p.trim());
  return (paragraphs[paragraphs.length - 1] || '').includes('?') || /\b(?:let me know|your call|tell me which|say the word|which would you prefer|want me to|shall i|should i)\b/i.test(whole);
}
const OFFER = [/\b(?:do you )?want me to\b/i, /\bwould you like me to\b/i, /\b(?:should|shall) i\b/i, /\blet me know if you(?:'d| would)? (?:like|want|prefer)\b/i,
  /\b(?:i|i'd be happy to|happy to)\b[^.\n?]{0,200}\bif you(?:'d| would)? (?:want|like|prefer)\b/i, /\bsay the word\b/i];
const LOOSE = [
  /\bi (?:did not|didn't|do not|don't|have not|haven't|could not|couldn't|was not able to|wasn't able to|never|can't|cannot) (?:\w+ ){0,2}(?:see|seen|find|found|check(?:ed)?|look(?:ed)?|search(?:ed)?|verif(?:y|ied)|confirm(?:ed)?|open(?:ed)?|read|access(?:ed)?|tell|reach(?:ed)?|pull(?:ed)?|fetch(?:ed)?|test(?:ed)?)\b/i,
  /\b(?:not yet|never|not) (?:been )?(?:verified|checked|confirmed|searched|tested)\b|\b(?:unverified|unchecked|unconfirmed)\b/i,
  /\bi(?:'m| am)? (?:assume|assuming|guess|guessing)\b|\b(?:presumably|from memory|if i recall|if i remember)\b/i,
  /\bi(?:'d| would|'ll| will)? need to (?:check|look|sign|open|search|read|verify|run|fetch|pull|log|call|find)\b/i];
export function trailingOffer(text) {
  const paragraphs = String(text || '').trim().split(/\n\s*\n/).filter((p) => p.trim());
  return OFFER.some((re) => re.test(paragraphs[paragraphs.length - 1] || ''));
}
export const looseEnds = (text) => [...(trailingOffer(text) ? ['offer'] : []), ...(LOOSE.some((re) => re.test(String(text || ''))) ? ['unchecked'] : [])];
export function needsOwnerAction(text) {
  const t = String(text || '');
  return /\b(?:blocked|blocker|waiting|waits|wait|stuck)\b[^.\n]{0,100}\b(?:you|your|owner|the owner)\b/i.test(t) || /\b(?:needs?|require[sd]?|awaiting)\s+(?:you|your|owner|the owner)\b/i.test(t)
    || /\b(?:only|just)\s+(?:you|owner|the owner)\s+(?:can|could|may)\b/i.test(t) || /\b(?:you|owner|the owner)\s+(?:have|has|had|need|needs|must|will need)\s+to\b/i.test(t);
}

const ASKS = `Re-read ${ownerPossessive()} messages in this conversation and check every ask he made, one by one, against what actually landed, the ones displaced by newer work included. An ask you answered but never delivered, or delegated and never verified, is still open: dispatch is not completion.`;
export const looseEndMessage = () => [
  `Before this turn ends, read your reply for loose ends that keep ${ownerPossessive()} question from being fully answered. Seriousness is the quality of attention that does that work: a friend who announces a plan and never looked anything up is not serious, and neither is an answer said with casual confidence that a few more checks would confirm or overturn.`,
  'Look for: an offer to do something your tools can do ("want me to...", "I can... if you want"); a lookup the answer rests on that you did not run; a source you did not check; "I didn\'t see X" or "couldn\'t find X" where a store, mailbox, account or API was not searched; a claim carried from memory or inference that one read would verify.',
  'Chase each one down now, in this turn, with your tools, then give the full answer with the result, each claim tagged with its source.',
  `Leave a question only where it truly needs ${owner()}: spending money he has not authorized, an email or message to someone outside (mail waits on his go), a choice only he can make, a credential or action only he can supply. Say exactly which and why.`,
  'If nothing is loose, end the turn without repeating the answer. This check does not repeat in this turn.'].join('\n');
export const continuationMessage = (todos) => ['Your goal ledger for this conversation still has open items and this turn has not closed them:', ...todos.map((i) => `- ${i.id}: ${i.text}`),
  `${ASKS} Anything of his still unaddressed, listed above or not: goal_add it now.`,
  'Carry on with them now, in this turn: take the next concrete step instead of describing it, and goal_close each item the moment it actually lands, status done with a note saying what proves it. Close an item only on what proves it.',
  `Satisfied, retracted by ${owner()}, or replaced: goal_close dropped with why (owner_cancelled, already_satisfied, superseded, duplicate) and the proof. Blocked on something that changes with time (slots, store hours, a reply): never a drop; goal_wait with retry_at or retry_in_minutes and a timer wakes this chat.`,
  `Your own unfinished work is not a blocker: a build still running, a test not green, a subagent still working, another process holding a file. Wait for it, work around it, or take it back and finish it. Only something ${owner()} himself has to do is worth ending the turn on, and then name exactly that action.`,
  `Do not hand the turn back to ${owner()} while an ask of his is unaddressed.`,
  'If the ledger itself is wrong, goal_close with stand_down true ends these continuations for the rest of the conversation.'].join('\n');
export const sweepMessage = () => ['Before this turn ends: nothing was declared in the goal ledger, so check by hand.', ASKS,
  'Anything of his still unaddressed: goal_add it now and take the next concrete step in this turn.',
  'If every ask of his has actually landed, say nothing further and end the turn; this sweep does not repeat.'].join('\n');

/** Whether a turn that just ended goes back to the model, and with what message. */
export function continuationDecision({ ledger, text = '', consecutive = 0, total = 0, ownerWaiting = false, interrupted = false, enabled = true, worked = 0, workersRunning = 0, looseEndsChecked = false, toolsAvailable = true } = {}) {
  const no = (reason) => ({ continue: false, reason }), plural = (n, a, b) => (n === 1 ? a : b);
  if (!enabled) return no('the goal hook is switched off (TOPHAT_RUNNER_GOAL_HOOK=0)');
  if (interrupted) return no('the owner interrupted this turn');
  if (ownerWaiting) return no('the owner has sent a message; he has the floor');
  const state = ledger || {};
  if (state.unreadable) return no(`the goal ledger could not be read (${state.unreadable}); an unreadable ledger never holds a stop`);
  if (state.hook === 'off') return no(`the hook was stood down in this conversation${state.stand_down_reason ? `: ${state.stand_down_reason}` : ''}`);
  if (toolsAvailable && !looseEndsChecked) {
    const loose = looseEnds(text);
    if (loose.length) return { continue: true, loose, reason: `the reply shows a loose end (${loose.join(', ')}); chase it down before ending`, items: [], message: looseEndMessage() };
  }
  const openItems = (state.items || []).filter((i) => i.status === 'todo'), todos = openItems.filter((i) => !i.waiting_until);
  // Every open item sleeps on a retry timer (goal_wait): the chat's wake, not another pass of this model, looks at them next.
  if (openItems.length && !todos.length) return no(`${openItems.length} open item${openItems.length === 1 ? ' waits' : 's wait'} on a retry timer (goal_wait); the timer wakes this chat when it falls due`);
  const ownerTurn = () => (questionForOwner(text) ? no('the reply asks the owner a question') : needsOwnerAction(text) ? no('the reply names something only the owner can do') : null);
  if (!todos.length) {
    if ((state.items || []).length) return no('every goal item is closed');
    if (state.has_goals) return no('every goal item is closed or handed off');
    if (worked < SWEEP_MIN_CALLS) return no(`nothing was declared and this turn made ${worked} tool call${plural(worked, '', 's')}; too short to bury an ask`);
    if (total > 0 || consecutive > 0) return no('the completion sweep found nothing outstanding');
    return ownerTurn() || { continue: true, reason: 'nothing was declared this turn; completion sweep', items: [], message: sweepMessage() };
  }
  if (workersRunning > 0) return no(`${workersRunning} subagent${plural(workersRunning, ' is', 's are')} still running; ${plural(workersRunning, 'its report or check-in', 'their reports and check-ins')} wake this conversation, and the ${todos.length} open item${plural(todos.length, ' stays', 's stay')} open`);
  if (consecutive >= CONTINUATION_CAP) return no(`${consecutive} continuations in a row closed nothing; the owner gets the floor`);
  if (total >= CONTINUATION_TOTAL_CAP) return no(`${total} continuations in this turn is the ceiling; the owner gets the floor`);
  return ownerTurn() || { continue: true, reason: `${todos.length} goal item${plural(todos.length, '', 's')} still open`, items: todos, message: continuationMessage(todos) };
}

export function goalHandlers(goals) {
  const waits = goals.waits || null;
  const view = (s) => ({ path: goals.path, hook: s.hook, ...(s.stand_down_reason ? { stand_down_reason: s.stand_down_reason } : {}), ...(s.unreadable ? { unreadable: s.unreadable } : {}),
    open: s.items.filter((i) => i.status === 'todo').length, items: s.items.map((i) => ({ id: i.id, text: i.text, status: i.status, ...(i.waiting_until ? { waiting_until: i.waiting_until } : {}), ...(i.work_id ? { work_id: i.work_id, version: i.version } : {}) })) });
  return {
    async goal_add(input) { const { state, added } = goals.add(input.items, input.note ?? null, input.work_ids || []); return { added: added.map((i) => ({ id: i.id, text: i.text })), ...view(state) }; },
    async goal_close(input) {
      if (input.status === 'dropped') { const refusal = checkDrop({ why: input.why, note: input.note }); if (refusal) return { error: refusal, closed: [], ...view(goals.read()) }; }
      const { state, closed, missing } = goals.close({ ids: input.ids, all: input.all, status: input.status, note: input.status === 'dropped' ? `[dropped: ${input.why}] ${input.note}` : input.note, stand_down: input.stand_down });
      // Closed for real: its retry timer goes with it (a stale timer wakes once and the chat clears it).
      try { waits?.clear(closed.filter((i) => i.status !== 'todo').flatMap((i) => [i.id, i.work_id].filter(Boolean))); } catch { /* the close stands */ }
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
    async goal_list() { return view(goals.read()); },
  };
}
