// The webchat side of `hooks.removeDerivedMemory` (scopes.js): a chat moved to a more private scope has its derived memory
// taken out of the memory-cloud groups that scope no longer has. The work is rev6/push/scope-retract.mjs, run in a child
// process (`rev6/push/cli.mjs scope-retract`) so the server never opens the 3 GB memory file on its own event loop; the
// child opens it through the memory cloud's own door (rev6/memcloud/live.mjs), the same TenantStore the heartbeat uses.
//
// Active only while ~/.config/tophat/memory-cloud.json says `mode: primary` (TOPHAT_MEMORY_CLOUD_CONFIG overrides the path).
// Off or shadow, there are no groups to take anything out of and the hook answers `skipped`. In primary mode every failure
// throws: scopes.js records the move as memory-pending and retries it by its id (resumePending), and the child's work is
// idempotent, so a retry only finishes what is left. Counts and ids are logged, never text.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rev5Db } from '../../../../runner/rev5/tasks.mjs';

// Path arithmetic, not `new URL(literal, import.meta.url)`: Vite rewrites that pattern into an asset URL
// whenever the module is transformed for the browser (a jsdom test that imports app.js), and
// fileURLToPath then throws on the http URL it gets.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..') + '/';
const CLI = join(REPO, 'rev6/push/cli.mjs');
const REVIEW_CAP = 100;

export const memoryCloudConfigPath = (env = process.env) => env.TOPHAT_MEMORY_CLOUD_CONFIG || join(env.HOME || homedir(), '.config/tophat/memory-cloud.json');

/** The memory cloud's mode from its config file: 'primary', 'shadow', or 'off' (missing, unreadable or any other value). */
export async function memoryCloudMode(env = process.env) {
  try {
    const mode = JSON.parse(await readFile(memoryCloudConfigPath(env), 'utf8'))?.mode;
    return mode === 'primary' || mode === 'shadow' ? mode : 'off';
  } catch { return 'off'; }
}

/** Run the child and return its one JSON answer; any non-answer is an error. */
export function runScopeRetract(request, { env = process.env, timeoutMs = 120_000, node = process.execPath } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [CLI, '--caller', 'local', '--db', rev5Db(env), 'scope-retract'], { cwd: REPO, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`scope-retract did not finish in ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => { out = (out + chunk).slice(-200_000); });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-1_000); });
    child.on('error', (cause) => { clearTimeout(timer); reject(cause); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let answer = null;
      try { answer = JSON.parse(out.trim().split('\n').pop()); } catch { /* handled below */ }
      if (code === 0 && answer?.ok) resolve(answer);
      else reject(new Error(`scope-retract failed (exit ${code}): ${String(answer?.error || answer?.detail || err || 'no answer').slice(0, 200)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

/**
 * Every id a chat's raw memory rows are keyed by. The memory plane keys a chat's rows `webchat/<runner session>/<seq>`, not by
 * the conversation id, and a chat can have had several sessions: the conversation's current session plus every sessionId a
 * `conversation.meta` event ever recorded for it. Reads one conversation's few meta events; returns [] when the chat is not in `store`.
 */
export function conversationThreads(store, conversationId) {
  const ids = new Set();
  try {
    const sessionId = store?.conversation?.(conversationId)?.sessionId;
    if (sessionId) ids.add(sessionId);
    for (const id of store?.sessionIdsOf?.(conversationId) || []) ids.add(String(id));
  } catch { /* a store without the events table names none */ }
  return [...ids];
}

/**
 * The hook scopes.js calls. `run`, `readMode` and `threadsFor` are seams: `threadsFor(conversationId)` names the chat's session ids.
 * Returns { status, removed, review }: status 'ok' | 'needs-review' | 'noop' | 'unmapped-scope' | 'skipped'.
 */
export function createRemoveDerivedMemory({ env = process.env, run = runScopeRetract, readMode = memoryCloudMode, threadsFor = () => [], log = console.log } = {}) {
  return async function removeDerivedMemory({ conversationId, from, to, moveId = null, actor = null }) {
    const mode = await readMode(env);
    if (mode !== 'primary') return { status: 'skipped', reason: 'memory-cloud-not-primary', removed: null, review: [] };
    const answer = await run({ conversation_id: conversationId, threads: await threadsFor(conversationId), from, to, move_id: moveId, actor }, { env });
    // The child skips when its store did not open as a TenantStore even though the config says primary: that is a failure to retry, not a result.
    if (answer.status === 'skipped') throw new Error(`memory cloud store not open in primary mode (${answer.reason || 'unknown'})`);
    const review = Array.isArray(answer.review) ? answer.review : [];
    const removed = answer.removed || null;
    log(`[scope-memory] move ${moveId || '-'} ${from} -> ${to}: ${answer.status}`
      + (removed ? ` raw=${removed.raw} notes=${removed.notes} work=${removed.work} entities=${removed.entities} narrowed=${removed.narrowed} derived=${removed.derived}` : '')
      + ` review=${review.length}`);
    return {
      status: answer.status, removed, review: review.slice(0, REVIEW_CAP), ...(review.length > REVIEW_CAP ? { reviewTotal: review.length } : {}),
      ...(answer.scope ? { scope: answer.scope } : {})
    };
  };
}
