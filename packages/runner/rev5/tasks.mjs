// Shared work is the only task authority. Callers provide replay IDs and revisions.
//
// HOW THIS CHILD IS STARTED IS ONE RULE WITH TWO CALLERS. webchat/src/lib/server/tasks-bridge.js is
// the webchat's door to the same `python3 -m rev5.cli ... tasks`. This file owns the rule, and the
// three resolvers below are exported so the other side can be held to them and so a test can read
// them without spawning anything.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { isLive, liveRoots, realHome, underTest } from '../src/live-state-guard.mjs';
import { scrubForStore } from '../src/vault/scrub-store.mjs';
import { storeRepo } from '../src/store-repo.mjs';
import { settleWaitsForWork } from './waits.mjs';

/** The checkout holding rev5/cli.py: this file's own, unless the environment names another. */
export function rev5Repo(env = process.env) {
  const local = dirname(dirname(fileURLToPath(import.meta.url)));
  // the first of TOPHAT_REPO, this checkout and the runtime dirs still holding store/cli.mjs (src/store-repo.mjs)
  try { return storeRepo(env, local); } catch { return env.TOPHAT_REPO || local; }
}

/** The interpreter. src/core/rev5-heartbeat.mjs reads the first of these; the webchat reads both. */
export const rev5Python = (env = process.env) =>
  env.TOPHAT_RUNNER_PYTHON || env.TOPHAT_PYTHON || 'python3';

/**
 * The store. TOPHAT_REV5_MEMORY is the older spelling webchat/src/lib/server/state-report.js still
 * accepts; honouring it here is what stops one side opening a database the other does not.
 */
export const rev5Db = (env = process.env) => refuseLiveRev5UnderTest(env.TOPHAT_RUNNER_DB || env.TOPHAT_REV5_MEMORY
  || join(env.TOPHAT_STATE_DIR || join(homedir(), '.local/state/tophat'), 'rev5/memory.sqlite'));

/** A test process never resolves the live rev5 store.
 *
 * WHAT COUNTS AS A TEST PROCESS, AND WHAT COUNTS AS LIVE, HAS ONE OWNER:
 * src/live-state-guard.mjs. Until tonight this file spelled both out again, with a header saying
 * the copy was there "because the installed release's rev5/ tree is self-contained" -- three lines
 * above its own `import { scrubForStore } from '../src/vault/scrub-store.mjs'`, and beside
 * rev5/context.mjs (four src/core imports), rev5/unicode.mjs (a pure re-export of src/core) and
 * rev5/browser.mjs (src/vault). rev5 has not been self-contained with respect to src for some
 * time, so the one thing the copy bought was the chance to drift: a data-safety rule whose two
 * halves disagree fails open on the half nobody is reading.
 *
 * What is still this file's own is the WORDING, because the fix a rev5 caller needs is a temp
 * TOPHAT_RUNNER_DB rather than a temp home. Verdicts are the owner's; the sentence is ours.
 */
export function refuseLiveRev5UnderTest(target, proc = process) {
  if (!underTest(proc.env, proc.argv, proc.execArgv)) return target;
  if (typeof target !== 'string' || !target) return target;
  if (!isLive(target, liveRoots(realHome(proc.env)))) return target;
  throw new Error(`live-state guard: rev5 store resolves to ${target}, the owner's live tophat state, inside a test process. `
    + 'Pass a temp TOPHAT_RUNNER_DB or run the suite through scripts/test.sh.');
}

/** A list of a thousand open items is well past node's 1 MB spawnSync default. */
export const TASK_MAX_BUFFER = 8 * 1024 * 1024;

export function taskRequest(request, env = process.env, command = 'tasks') {
  const repo = rev5Repo(env);
  // Titles and bodies are model-written (task_update, goal_add, goal_wait): exact vault values out
  // before they reach the shared work store.
  request = scrubForStore(request, { env, label: 'tasks' }).value;
  const result = spawnSync(process.execPath, [join(repo, 'store', 'cli.mjs'), '--db', rev5Db(env), command], {
    cwd: repo, env: { ...env, PYTHONPATH: repo }, input: JSON.stringify(request), encoding: 'utf8',
    timeout: 20000, maxBuffer: TASK_MAX_BUFFER
  });
  let answer;
  try { answer = JSON.parse(result.stdout); } catch { throw Error(result.error?.message || 'Shared work unavailable'); }
  if (!answer.ok) { const error = Error(answer.detail || answer.reason || 'Task refused'); error.current = answer.current; throw error; }
  // A row this apply closed or handed to another chat takes its goal_wait timer with it (rev5/waits.mjs, "Orphans").
  if (request.op === 'apply' && Array.isArray(answer.work)) settleWaitsForWork(answer.work, { env, getRow: (id) => taskRequest({ op: 'get', id }, env).work });
  return answer;
}

/**
 * taskRequest without blocking the calling thread, for read requests from the webchat server's sweeper.
 * Never throws: { ok:false, reason:'unavailable' } when the store or the CLI cannot be reached, so a caller can tell
 * "the store said no such work" (reason 'refused', message 'no work <id>') from "nobody answered".
 */
export function taskRequestAsync(request, env = process.env, { timeoutMs = 30_000 } = {}) {
  let db;
  try { db = rev5Db(env); } catch (error) { return Promise.resolve({ ok: false, reason: 'unavailable', detail: error.message }); }
  if (!existsSync(db)) return Promise.resolve({ ok: false, reason: 'unavailable', detail: `no work store at ${db}` });
  const repo = rev5Repo(env);
  return new Promise((resolve) => {
    let out = '', settled = false, timer = null, child;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    try { child = spawn(process.execPath, [join(repo, 'store', 'cli.mjs'), '--db', db, 'tasks'], { cwd: repo, env: { ...env, PYTHONPATH: repo }, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (error) { return finish({ ok: false, reason: 'unavailable', detail: String(error?.message || error) }); }
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ ok: false, reason: 'unavailable', detail: 'the task cli timed out' }); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (error) => finish({ ok: false, reason: 'unavailable', detail: String(error?.message || error) }));
    child.on('close', (code) => {
      try { finish(JSON.parse(out.trim().split('\n').pop())); }
      catch { finish({ ok: false, reason: 'unavailable', detail: `no answer from the task cli (exit ${code})` }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(scrubForStore(request, { env, label: 'tasks' }).value));
  });
}
