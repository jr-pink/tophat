// Retry timers for goal items that are blocked on something that changes with time.
//
// Root cause, in mechanism: goal_close accepted status `dropped` with any note, its own description offered "no
// longer wanted or already satisfied" and the continuation message said "close it yourself", so a blocker could be
// filed as a closure; and no clock in the system could start a turn for a goal (goals.mjs: "Nothing here arms a
// timer"; the only timers were subagent check-ins). The note in todos.md was a memo nobody reads at 22:50.
//
// The fix has two halves, both here and in goals.mjs:
//  * `dropped` needs a `why` from DROP_WHYS (the owner cancelled it, it is already satisfied, it was replaced).
//    A blocker is none of those, so it cannot be a drop; it is a goal_wait.
//  * goal_wait keeps the goal open and records WHEN to look again. The webchat server sweeps these files
//    (webchat/src/lib/server/retry-wakes.js) and posts a wake into the owning chat when one falls due, the same path
//    a push wake takes. A fired wait re-arms itself with a growing gap until the goal is closed, so a turn that
//    crashed or forgot cannot leave the item silent. Only goal_close (done, or dropped with a real why) clears it.
//
// One JSON file per chat, written atomically under a lock directory, because the runner (goal tools) and the server
// (sweeper) both write.
import { scrubForStore } from '../src/vault/scrub-store.mjs';
import { owner, ownerPossessive } from '../owner.mjs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import fsp from 'node:fs/promises';
import { goalsDir } from './goals.mjs';

export const DROP_WHYS = Object.freeze({
  owner_cancelled: `${owner()} said, in this conversation, that he no longer wants it`,
  already_satisfied: 'the outcome already exists (name the proof)',
  superseded: 'another goal or task now carries exactly this outcome (name its id)',
  duplicate: 'the same outcome is already a live item (name its id)'
});
export const MAX_WAIT_DAYS = 30;
export const REARM_FIRST_MS = 30 * 60e3;
export const REARM_MAX_MS = 6 * 3600e3;

export function waitsDir(env = process.env) {
  return env.TOPHAT_RUNNER_WAITS_DIR || join(dirname(goalsDir(env)), 'waits');
}
export function waitsPath(sessionId, env = process.env) {
  return join(waitsDir(env), `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);
}

/** The words a refusal of a `dropped` close says; also what the tool description points at. */
export function dropRefusal(why) {
  const named = Object.entries(DROP_WHYS).map(([k, v]) => `${k} (${v})`).join('; ');
  return `Not closed. status dropped needs why, one of: ${named}.`
    + `${why ? ` You gave ${JSON.stringify(String(why).slice(0, 60))}, which is not one.` : ''}`
    + ' A blocker is none of these: slots not open, store closed, page down, reply pending, a build or another agent unfinished.'
    + ' For those call goal_wait with retry_at or retry_in_minutes and the goal stays open and is retried by a timer that wakes this chat;'
    + ` if it truly needs ${owner()}, tell him the exact action in chat in this same turn and leave the goal open.`;
}

/** null when a drop is allowed; otherwise the refusal text. */
export function checkDrop({ why, note }) {
  const key = String(why || '').trim();
  if (!Object.hasOwn(DROP_WHYS, key)) return dropRefusal(key);
  if (String(note || '').trim().length < 8) return `Not closed. A dropped item needs a note naming the proof for why=${key}: ${DROP_WHYS[key]}.`;
  return null;
}

function withLock(path, fn, { tries = 100, staleMs = 15000 } = {}) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let i = 0; i < tries; i++) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ }
      const until = Date.now() + 20;
      while (Date.now() < until) { /* short spin: the critical section is one small file */ }
      if (i === tries - 1) throw new Error(`waits lock busy: ${lock}`);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

function readFile(path, sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { session_id: parsed.session_id ?? sessionId, next: Number(parsed.next) || 1, waits: Array.isArray(parsed.waits) ? parsed.waits.filter((w) => w && w.goal_id) : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { session_id: sessionId, next: 1, waits: [] };
    // A file that is not JSON is preserved aside, never overwritten silently.
    try { renameSync(path, `${path}.unreadable-${Date.now()}`); } catch { /* nothing to keep */ }
    return { session_id: sessionId, next: 1, waits: [] };
  }
}

function writeFile(path, state, now) {
  const tmp = `${path}.${process.pid}.tmp`;
  // Wait text and reasons are model-written: exact vault values out first.
  writeFileSync(tmp, JSON.stringify(scrubForStore({ ...state, updated_at: now() }, { label: 'waits' }).value, null, 1), { mode: 0o600 });
  renameSync(tmp, path);
}

/** retry_at (an ISO instant with a zone) or retry_in_minutes, as epoch ms; throws a sentence on anything unusable. */
export function resolveRetry({ retry_at, retry_in_minutes }, nowMs) {
  let at;
  if (retry_in_minutes !== undefined && retry_in_minutes !== null && retry_in_minutes !== '') {
    const n = Number(retry_in_minutes);
    if (!Number.isFinite(n) || n < 1) throw new Error('retry_in_minutes must be a number of at least 1');
    at = nowMs + Math.round(n * 60e3);
  } else if (retry_at) {
    const text = String(retry_at).trim();
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) throw new Error('retry_at must be an ISO instant with a zone, e.g. 2026-10-17T07:30:00-07:00 or ...Z; or use retry_in_minutes');
    at = Date.parse(text);
    if (!Number.isFinite(at)) throw new Error(`retry_at ${JSON.stringify(text)} is not a time`);
  } else throw new Error('goal_wait needs retry_at or retry_in_minutes: a wait without a time is a drop under another name');
  if (at < nowMs + 30e3) throw new Error('that time is already past (or under 30 seconds away); pick when the blocker could actually change');
  if (at > nowMs + MAX_WAIT_DAYS * 86400e3) throw new Error(`a retry more than ${MAX_WAIT_DAYS} days out is not a retry; tell ${owner()} instead`);
  return at;
}

export function openWaits({ sessionId, env = process.env, now = () => new Date().toISOString(), path = waitsPath(sessionId, env) }) {
  const mutate = (fn) => withLock(path, () => { const state = readFile(path, sessionId); const out = fn(state); writeFile(path, state, now); return out; });
  return {
    path,
    read: () => readFile(path, sessionId).waits,
    /** Arm (or re-arm) the wait for one goal item. */
    arm({ goal_id, work_id = null, text = '', reason, retry_at, retry_in_minutes, deadline = null }) {
      const nowMs = Date.parse(now());
      const at = resolveRetry({ retry_at, retry_in_minutes }, nowMs);
      const due = deadline ? Date.parse(String(deadline)) : null;
      if (deadline && !Number.isFinite(due)) throw new Error(`deadline ${JSON.stringify(String(deadline))} is not a time (ISO instant with a zone)`);
      return mutate((state) => {
        let wait = state.waits.find((w) => w.goal_id === goal_id);
        if (!wait) { wait = { id: `w${state.next++}`, goal_id, created_at: now(), fires: 0 }; state.waits.push(wait); }
        Object.assign(wait, { work_id, text: String(text).slice(0, 300), reason: String(reason || '').slice(0, 500), retry_at: new Date(at).toISOString(),
          deadline: due ? new Date(due).toISOString() : (wait.deadline || null), awake: false, updated_at: now() });
        // A chat that calls goal_wait again has read its wake: that is the strongest acknowledgement there is.
        if (wait.pending) { wait.acked_at = now(); wait.last_acked_fire = wait.pending.fire; wait.pending = null; }
        delete wait.escalated_at;
        return { ...wait };
      });
    },
    /** Drop the waits of closed goals. Returns how many were removed. */
    clear(goalIds) {
      const ids = new Set(goalIds.map(String));
      if (!ids.size || !existsSync(path)) return 0;
      return mutate((state) => { const before = state.waits.length; state.waits = state.waits.filter((w) => !ids.has(String(w.goal_id)) && !ids.has(String(w.work_id))); return before - state.waits.length; });
    },
    /** Goal ids whose timer is armed and not yet due-and-fired: the hook must not hold a stop for these. */
    sleeping() { return new Set(readFile(path, sessionId).waits.filter((w) => !w.awake).map((w) => String(w.goal_id))); },
    /** A fired wait re-arms by itself; this records the fire and the next look. Returns the wait. */
    fired(waitId) {
      return mutate((state) => {
        const wait = state.waits.find((w) => w.id === waitId);
        if (!wait) return null;
        wait.fires = (wait.fires || 0) + 1;
        wait.awake = true; wait.last_fired_at = now();
        wait.retry_at = new Date(Date.parse(now()) + Math.min(REARM_FIRST_MS * 2 ** (wait.fires - 1), REARM_MAX_MS)).toISOString();
        return { ...wait };
      });
    },
    /**
     * A wake reached the chat (message appended, turn started or steered). Not yet a fire that counts: `pending` holds it
     * until the chat is seen running a turn that follows it (acked) or the sweeper gives up and escalates. The first
     * delivery of a fire re-arms the wait (fires, awake, widening gap); a redelivery of the same fire only refreshes pending.
     */
    delivered(waitId, { cursor = null, dueAt = null } = {}) {
      return mutate((state) => {
        const wait = state.waits.find((w) => w.id === waitId);
        if (!wait) return null;
        const at = now();
        if (wait.pending && !wait.pending.escalated) {
          wait.pending = { ...wait.pending, delivered_at: at, cursor, attempts: wait.pending.attempts + 1 };
        } else {
          wait.fires = (wait.fires || 0) + 1;
          wait.awake = true; wait.last_fired_at = at;
          wait.retry_at = new Date(Date.parse(at) + Math.min(REARM_FIRST_MS * 2 ** (wait.fires - 1), REARM_MAX_MS)).toISOString();
          wait.pending = { fire: wait.fires, due_at: dueAt || wait.retry_at, first_delivered_at: at, delivered_at: at, cursor, attempts: 1 };
        }
        return { ...wait };
      });
    },
    /** Make the wait due now and forget any pending delivery: the sweeper's next pass wakes the chat (tophat-timer fire). */
    forceDue(waitId) {
      return mutate((state) => {
        const wait = state.waits.find((w) => w.id === waitId);
        if (!wait) return null;
        wait.retry_at = new Date(Date.parse(now()) - 1000).toISOString(); wait.pending = null; delete wait.escalated_at;
        return { ...wait };
      });
    },
    /** The chat ran a turn after the wake. */
    acked(waitId) {
      return mutate((state) => {
        const wait = state.waits.find((w) => w.id === waitId);
        if (!wait || !wait.pending) return null;
        wait.acked_at = now(); wait.last_acked_fire = wait.pending.fire; wait.pending = null; delete wait.escalated_at;
        return { ...wait };
      });
    },
    /** Delivery was given up on: kept visible (pending.escalated) so `tophat-timer check` reports it until the chat acts. */
    escalated(waitId) {
      return mutate((state) => {
        const wait = state.waits.find((w) => w.id === waitId);
        if (!wait) return null;
        wait.escalated_at = now();
        if (wait.pending) wait.pending = { ...wait.pending, escalated: true };
        return { ...wait };
      });
    }
  };
}

/** Every chat's waits, undue ones too: [{ session_id, wait }]. Pure reads; the CLI and the sweeper share it. */
export function allWaits({ env = process.env, dir = waitsDir(env) } = {}) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'sweeper.json'); } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const state = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      for (const wait of Array.isArray(state.waits) ? state.waits : []) if (wait?.goal_id) out.push({ session_id: state.session_id ?? name.replace(/\.json$/, ''), wait });
    } catch { /* an unreadable file is skipped, and quarantined by the next writer */ }
  }
  return out;
}

/** allWaits without blocking the calling thread: the webchat server's sweeper runs every 30 s on the HTTP
 * thread, and the synchronous version read 106 files one after another. With the boot disk saturated
 * each read took 30-140 ms, so one pass held the server 2-5 s. Reads go through fs/promises a few at a
 * time, so the libuv pool is never filled by this one job.
 */
export async function allWaitsAsync({ env = process.env, dir = waitsDir(env), concurrency = 3 } = {}) {
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json') && n !== 'sweeper.json'); } catch { return []; }
  const states = new Array(names.length);
  let next = 0;
  const lane = async () => {
    while (next < names.length) {
      const i = next++;
      try { states[i] = JSON.parse(await fsp.readFile(join(dir, names[i]), 'utf8')); } catch { states[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, lane));
  const out = [];
  states.forEach((state, i) => {
    if (!state) return;
    for (const wait of Array.isArray(state.waits) ? state.waits : []) if (wait?.goal_id) out.push({ session_id: state.session_id ?? names[i].replace(/\.json$/, ''), wait });
  });
  return out;
}

/** beatSweeper for the server: the same pulse file, written without blocking the thread. */
export async function beatSweeperAsync({ env = process.env, now = () => new Date().toISOString(), extra = {} } = {}) {
  try {
    await fsp.mkdir(waitsDir(env), { recursive: true, mode: 0o700 });
    const path = join(waitsDir(env), 'sweeper.json');
    await fsp.writeFile(`${path}.tmp`, JSON.stringify({ at: now(), pid: process.pid, ...extra }));
    await fsp.rename(`${path}.tmp`, path);
  } catch { /* best effort */ }
}

/** Append-only record of every delivery, ack, escalation and failure, with timestamps (the server log had none). */
export function logFire(record, { env = process.env, now = () => new Date().toISOString() } = {}) {
  try {
    mkdirSync(waitsDir(env), { recursive: true, mode: 0o700 });
    appendFileSync(join(waitsDir(env), 'fire-log.jsonl'), JSON.stringify(scrubForStore({ at: now(), ...record }, { label: 'waits' }).value) + '\n');
  } catch { /* the log never blocks a wake */ }
}

/** The sweeper's own pulse: written every pass, so a dead or hung sweeper is detectable from outside the server. */
export function beatSweeper({ env = process.env, now = () => new Date().toISOString(), extra = {} } = {}) {
  try {
    mkdirSync(waitsDir(env), { recursive: true, mode: 0o700 });
    const path = join(waitsDir(env), 'sweeper.json');
    writeFileSync(`${path}.tmp`, JSON.stringify({ at: now(), pid: process.pid, ...extra }));
    renameSync(`${path}.tmp`, path);
  } catch { /* best effort */ }
}
export function readSweeperBeat({ env = process.env } = {}) {
  try { return JSON.parse(readFileSync(join(waitsDir(env), 'sweeper.json'), 'utf8')); } catch { return null; }
}

export const OVERDUE_MS = 5 * 60e3;
export const UNACKED_MS = 3 * 60e3;
export const SWEEPER_STALE_MS = 3 * 60e3;

/** What is wrong right now, for `tophat-timer check` and the health sweep: [{ kind, session_id, wait, detail }]. */
export function problems({ env = process.env, nowMs = Date.now(), checkSweeper = true } = {}) {
  const out = [];
  for (const { session_id, wait } of allWaits({ env })) {
    const lateMs = nowMs - Date.parse(wait.retry_at);
    if (!wait.pending && lateMs > OVERDUE_MS) out.push({ kind: 'overdue', session_id, wait, detail: `due ${wait.retry_at}, ${Math.round(lateMs / 60e3)} min late, never delivered` });
    if (wait.pending && wait.pending.escalated) out.push({ kind: 'escalated', session_id, wait, detail: `fire ${wait.pending.fire} delivered ${wait.pending.attempts}x since ${wait.pending.first_delivered_at}, no turn ever read it` });
    else if (wait.pending && nowMs - Date.parse(wait.pending.delivered_at) > UNACKED_MS) out.push({ kind: 'unacked', session_id, wait, detail: `fire ${wait.pending.fire} delivered ${wait.pending.delivered_at} (attempt ${wait.pending.attempts}), no turn seen after it` });
  }
  if (checkSweeper) {
    const beat = readSweeperBeat({ env });
    const age = beat ? nowMs - Date.parse(beat.at) : Infinity;
    if (allWaits({ env }).length && age > SWEEPER_STALE_MS) out.push({ kind: 'sweeper-stale', session_id: null, wait: null, detail: beat ? `sweeper last beat ${beat.at}` : 'sweeper has never beaten' });
  }
  return out;
}

/** Every chat's due waits across the directory: [{ session_id, wait }], oldest due first. Pure reads. */
export function dueWaits({ env = process.env, nowMs = Date.now(), dir = waitsDir(env) } = {}) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const state = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      for (const wait of Array.isArray(state.waits) ? state.waits : []) {
        if (wait?.goal_id && Date.parse(wait.retry_at) <= nowMs) out.push({ session_id: state.session_id, wait });
      }
    } catch { /* an unreadable file is skipped, and quarantined by the next writer */ }
  }
  return out.sort((a, b) => Date.parse(a.wait.retry_at) - Date.parse(b.wait.retry_at));
}

/** The text a due wait posts into its chat. */
export function wakeText(wait, nowIso, tz = process.env.TOPHAT_RUNNER_TIMEZONE || 'America/Los_Angeles', { attempt = 1 } = {}) {
  const local = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
  const late = wait.deadline && Date.parse(wait.deadline) < Date.parse(nowIso);
  return [
    `[Automated event from the goal retry timer, not a message from ${owner()}]`,
    `You set a retry for goal ${wait.goal_id}: ${wait.text || '(no text)'}`,
    `Blocked on: ${wait.reason || '(no reason recorded)'}`,
    `Now ${local(nowIso)}; this is fire ${attempt > 1 ? wait.fires : wait.fires + 1}${attempt > 1 ? ` (delivery ${attempt}: the earlier one produced no turn)` : ''}.${wait.deadline ? ` the owner's deadline for it: ${local(wait.deadline)}${late ? ' (already passed: tell him now what landed and what did not)' : ''}.` : ''}`,
    'Check whether the blocker has changed and finish the task now. If it has landed, goal_close it with the proof. If it is still blocked, call goal_wait again with the next time to look.',
    'This timer re-arms itself until the goal is closed; it is not a reason to stop. Never goal_close dropped for a blocker.'
  ].join('\n');
}
