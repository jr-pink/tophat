// The webchat's one door to the shared work store: `python3 -m rev5.cli ... tasks`.
//
// There is no second task database here and no second protocol. This spawns the CLI that landed
// with the shared task operations (rev5/store.py task_list/task_apply, rev5/cli.py `tasks`), hands
// it the request it already documents, and gives back what it answered. Three rules:
//
// 1. The caller supplies the operation id. It is the work store's receipt key, so the same id with
//    the same content replays the first result instead of applying twice; that is what makes a
//    retry after a lost answer safe.
// 2. A refusal is a value, not an exception: `{ok:false, reason:'conflict', current}` comes back
//    as it stands, because a stale write must return current state rather than overwrite a newer
//    owner edit or handoff.
// 3. Nothing here decides task identity. It passes ids and revisions the caller already holds.
//
// HOW THE CHILD IS STARTED IS ONE RULE WITH TWO CALLERS, AND rev5/tasks.mjs OWNS IT. That file
// says so in its own header and exports the three resolvers so this side can be held to them. It
// read only TOPHAT_PYTHON while the runner read TOPHAT_RUNNER_PYTHON first, so on a machine where
// that names the interpreter holding the python dependencies (launchd hands a service a minimal
// PATH, which is the same lesson src/retrieval/ripgrep.mjs was written for) the webchat ran a
// different python from everything else; and it took node's 1 MB spawnSync default, so a list of a
// thousand open work items failed with ENOBUFS and was reported `unavailable` while the store was
// perfectly healthy. The wrappers below keep this module's own call shapes and nothing else.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_MAX_BUFFER as SHARED_TASK_MAX_BUFFER, rev5Python, rev5Repo as sharedRev5Repo } from '../../../../runner/rev5/tasks.mjs';
import { rev5MemoryPath } from './state-report.js';
import { settleWaitsForWork, settleWaitsForWorkAsync } from '../../../../runner/rev5/waits.mjs';

/** The repository the CLI lives in, as rev5/tasks.mjs resolves it. */
export function rev5Repo({ env = process.env } = {}) {
  return sharedRev5Repo(env);
}

/** The interpreter, as rev5/tasks.mjs resolves it: TOPHAT_RUNNER_PYTHON, then TOPHAT_PYTHON, then python3. */
export const pythonBin = ({ env = process.env } = {}) => rev5Python(env);

/** The stdout budget rev5/tasks.mjs gives the child; node's own default is 1 MB. */
export const TASK_MAX_BUFFER = SHARED_TASK_MAX_BUFFER;

/**
 * One request. The database is named explicitly on the command line, so a test points at its own
 * scratch file and can never reach the installed store by default.
 */
export function tasksCli(request, { env = process.env, db = null, repo = null, timeoutMs = 20_000 } = {}) {
  const path = db || rev5MemoryPath({ env });
  const cwd = repo || rev5Repo({ env });
  if (!existsSync(path)) {
    return { ok: false, reason: 'unavailable', detail: `no work store at ${path}` };
  }
  if (!existsSync(join(cwd, 'store', 'cli.mjs'))) {
    return { ok: false, reason: 'unavailable', detail: `no rev5 cli under ${cwd}` };
  }
  let result;
  try {
    result = spawnSync(process.execPath, [join(cwd, 'store', 'cli.mjs'), '--db', path, 'tasks'], {
      cwd, input: JSON.stringify(request), encoding: 'utf8', timeout: timeoutMs,
      maxBuffer: TASK_MAX_BUFFER,
      env: { ...env, PYTHONPATH: cwd }
    });
  } catch (cause) {
    return { ok: false, reason: 'unavailable', detail: String(cause?.message || cause) };
  }
  if (result.error) return { ok: false, reason: 'unavailable', detail: String(result.error.message || result.error) };
  const text = String(result.stdout || '').trim();
  if (!text) {
    return { ok: false, reason: 'unavailable', detail: `the task cli said nothing (exit ${result.status})` };
  }
  try {
    return JSON.parse(text.split('\n').pop());
  } catch (cause) {
    return { ok: false, reason: 'unavailable', detail: `unparsable task cli answer: ${String(cause?.message || cause)}` };
  }
}

/** The same request without stopping the server. `tasksCli` is a spawnSync, which holds the one
 * thread for the whole interpreter start and the query behind it: the notes reconciliation paged
 * three thousand work rows through it, four spawns of about a second each, and every request in
 * every tab (chat streams, notes, reader, even /api/health) waited ten seconds behind it.
 * Anything that runs on a page load or a timer uses this one.
 */
export function tasksCliAsync(request, { env = process.env, db = null, repo = null, timeoutMs = 30_000, command = 'tasks' } = {}) {
  const path = db || rev5MemoryPath({ env });
  const cwd = repo || rev5Repo({ env });
  if (!existsSync(path)) return Promise.resolve({ ok: false, reason: 'unavailable', detail: `no work store at ${path}` });
  if (!existsSync(join(cwd, 'store', 'cli.mjs'))) return Promise.resolve({ ok: false, reason: 'unavailable', detail: `no rev5 cli under ${cwd}` });
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let timer = null;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let child;
    try {
      child = spawn(process.execPath, [join(cwd, 'store', 'cli.mjs'), '--db', path, command], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (cause) { return resolve({ ok: false, reason: 'unavailable', detail: String(cause?.message || cause) }); }
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ ok: false, reason: 'unavailable', detail: 'the task cli timed out' }); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (cause) => finish({ ok: false, reason: 'unavailable', detail: String(cause?.message || cause) }));
    child.on('close', (code) => {
      const text = out.trim();
      if (!text) return finish({ ok: false, reason: 'unavailable', detail: `the task cli said nothing (exit ${code})` });
      try { finish(JSON.parse(text.split('\n').pop())); }
      catch (cause) { finish({ ok: false, reason: 'unavailable', detail: `unparsable task cli answer: ${String(cause?.message || cause)}` }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

// Reads are cached for a breath, writes clear the cache.
//
// A notes GET refreshes bound task lines and asks for the same list each time, which made that
// half second a per-request cost. The cache holds only read answers, only for READ_TTL_MS, and any
// apply drops it, so a change the server itself made is never served stale.
export const READ_TTL_MS = Number(process.env.WEBCHAT_TASK_READ_TTL_MS || 2000);
const reads = new Map();

export function clearTaskCache() { reads.clear(); }

function cachedRead(key, run) {
  const now = Date.now();
  const hit = reads.get(key);
  if (hit && now - hit.at < READ_TTL_MS) return hit.value;
  const value = run();
  // A refusal is not worth remembering: the store may be back on the next request.
  if (value && value.ok !== false) reads.set(key, { at: now, value });
  if (reads.size > 64) for (const k of [...reads.keys()].slice(0, 32)) reads.delete(k);
  return value;
}

/** The key is the store this call would actually reach, not the argument: the path is resolved from
 *  the environment when no db is named, and that environment moves. */
const readKey = (op, options) => {
  const env = options?.env || process.env;
  return `${op}:${options?.db || rev5MemoryPath({ env })}:${options?.repo || rev5Repo({ env })}`;
};

/** One row, read through an async child (never cached, like `getTask`). */
export const getTaskAsync = (id, options) => tasksCliAsync({ op: 'get', id }, options);

/** `applyTasks` without stopping the server: absolute changes by id and revision, under one operation id. */
export async function applyTasksAsync({ opId, actor, tasks, sourceRefs = null }, options) {
  clearTaskCache();
  const answer = await tasksCliAsync({ op: 'apply', op_id: opId, actor, tasks, ...(sourceRefs ? { source_refs: sourceRefs } : {}) }, options);
  clearTaskCache();
  // A row closed or handed off here (a notes check-off, an owner edit) takes its goal_wait timer with it (rev5/waits.mjs, "Orphans").
  if (answer?.ok && Array.isArray(answer.work)) await settleWaitsForWorkAsync(answer.work, { env: options?.env || process.env, log: console.log, getRow: async (id) => { const got = await getTaskAsync(id, options); return got?.ok ? got.work : null; } });
  return answer;
}

export const listTasksAsync = (filter = {}, options) => tasksCliAsync({ op: 'list', ...filter }, options);

export const listTasks = (filter = {}, options) =>
  cachedRead(readKey(`list:${JSON.stringify(filter)}`, options), () => tasksCli({ op: 'list', ...filter }, options));

// Deliberately NOT cached. A single row is read to learn the revision a change will be applied
// against, so a stale answer here turns a good write into a conflict, or worse into a write that
// claims a revision that has moved. Only the list, which exists to paint status, is cached.
export const getTask = (id, options) => tasksCli({ op: 'get', id }, options);

/** Absolute changes by id and revision, under one operation id. Never a toggle. */
export const applyTasks = ({ opId, actor, tasks, sourceRefs = null }, options) => {
  clearTaskCache();
  const answer = tasksCli({ op: 'apply', op_id: opId, actor, tasks, ...(sourceRefs ? { source_refs: sourceRefs } : {}) }, options);
  clearTaskCache();
  if (answer?.ok && Array.isArray(answer.work)) settleWaitsForWork(answer.work, { env: options?.env || process.env, log: console.log, getRow: (id) => { const got = getTask(id, options); return got?.ok ? got.work : null; } });
  return answer;
};
