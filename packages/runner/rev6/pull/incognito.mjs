// Incognito chats. Add it to hamburger menu in nav pill.
//
// The webchat starts an incognito chat's runner with TOPHAT_INCOGNITO=1 (webchat/src/lib/server/incognito.js). This
// file is the runner's half: the one place that turns that flag into "nothing durable". Everything else about the
// turn is the same code as a normal chat.
//
//   - the ledger is `:memory:` (sessions, messages, push_queue, agents, jobs, mail_outbox, cua_tabs die with the process)
//   - push, the turn push and the chat work item are off, and the memory CLI is refused every command that writes
//     (ingest, push, apply, tasks other than list), whatever asks for it
//   - the goal hook is off, so no goals JSON, no goal tools and no retry timers that could wake the chat later
//   - task_update and memory_apply are not offered, to the root or to a subagent
//   - every cache that would hold derived content (vision downscales, read_document extraction, computer-use
//     screenshots) points into one private directory that is removed when the process exits
//   - no request/response trace files
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const isIncognito = (env) => env?.TOPHAT_INCOGNITO === '1';

/** Tools an incognito chat is never offered: the two that write shared memory and tasks. Goal tools go with the hook. */
export const INCOGNITO_TOOLS_OFF = Object.freeze(new Set(['task_update', 'memory_apply']));

/** Memory CLI commands that only read. Anything else is refused in incognito. */
const MEMORY_READS = new Set(['search', 'read', 'status', 'list']);

/** null when the memory CLI may run `command` with `payload` here, else the refusal. */
export function incognitoMemoryRefusal(command, payload, env) {
  if (!isIncognito(env)) return null;
  if (MEMORY_READS.has(command)) return null;
  if (command === 'tasks' && payload?.op === 'list') return null;
  return { ok: false, reason: 'incognito', detail: `memory ${command} refused: this is an incognito chat and writes nothing to memory` };
}

let made = null;
function scratchDir(env) {
  if (env.TOPHAT_INCOGNITO_DIR) return env.TOPHAT_INCOGNITO_DIR;
  // The webchat names one root for every incognito chat and removes <root>/<conversation id> when the chat ends.
  const id = String(env.TOPHAT_CONVERSATION_ID || '');
  if (env.TOPHAT_INCOGNITO_ROOT && /^[\w.-]+$/.test(id)) return join(env.TOPHAT_INCOGNITO_ROOT, id);
  // A runner started by hand with the flag and no directory still gets a private one, gone at exit.
  if (!made) {
    made = mkdtempSync(join(tmpdir(), 'tophat-incognito-'));
    process.once('exit', () => { try { rmSync(made, { recursive: true, force: true }); } catch { /* already gone */ } });
  }
  return made;
}

/** The environment an incognito runner works in. Idempotent; a normal env comes back untouched. */
export function incognitoEnv(env = process.env) {
  if (!isIncognito(env)) return env;
  if (env.TOPHAT_RUNNER_RUNNER_DB === ':memory:' && env.TOPHAT_INCOGNITO_DIR) return env;
  const dir = scratchDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = {
    ...env,
    TOPHAT_INCOGNITO_DIR: dir,
    TOPHAT_RUNNER_RUNNER_DB: ':memory:',
    TOPHAT_RUNNER_PUSH: '0',
    TOPHAT_RUNNER_TURN_PUSH: '0',
    TOPHAT_RUNNER_CHAT_WORK: '0',
    TOPHAT_RUNNER_GOAL_HOOK: '0',
    TOPHAT_RUNNER_GOALS_DIR: join(dir, 'goals'),
    TOPHAT_RUNNER_WAITS_DIR: join(dir, 'waits'),
    TOPHAT_RUNNER_ATTACHMENT_DIR: join(dir, 'attachments'),
    TOPHAT_RUNNER_VISION_DIR: join(dir, 'vision'),
    TOPHAT_RUNNER_CUA_IMAGES: join(dir, 'cua'),
  };
  delete out.TOPHAT_RUNNER_TRACE_DIR;
  return out;
}

/** Removes the scratch directory the server gave this runner; called on the way out. */
export function removeIncognitoScratch(env = process.env) {
  if (!isIncognito(env)) return;
  const id = String(env.TOPHAT_CONVERSATION_ID || '');
  const dir = env.TOPHAT_INCOGNITO_DIR || (env.TOPHAT_INCOGNITO_ROOT && /^[\w.-]+$/.test(id) ? join(env.TOPHAT_INCOGNITO_ROOT, id) : null);
  if (!dir) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

/** What the model is told, so a shell command does not write the trace the tools no longer can. */
export const INCOGNITO_NOTE = 'This is an incognito chat. The owner asked that it leave no trace: nothing from it is'
  + ' saved to the chat store, memory, tasks, goals, notes or any other durable store, and it is gone when he closes it.'
  + ' Memory and task writes are unavailable here. Do not work around that through the shell or files (no tophat-tasks,'
  + ' no memory CLI writes, no notes, no journal or log files about this conversation). Reading memory and sources is'
  + ' fine, and actions he explicitly asks for in the world (an email, a purchase, a file he names) still happen.';
