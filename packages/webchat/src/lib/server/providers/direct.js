// The rev 5 direct provider: a child running `node rev5/pull.mjs`, which talks
// to the Messages API itself and speaks the same stream-json the Claude CLI
// does, so the translator, session machine and store are reused unchanged.
// What differs from claude.js is only how the child is found and started.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { UPLOAD_ROOT } from '../uploads.js';
import { newId } from '../../core/contract.js';
import { capabilitiesOf } from '../../core/providers.js';
import { emptyContext, machineInputs } from '../translate.js';
import { rootAgentId } from './agent-id.js';

const CONTROL_TIMEOUT_MS = Number(process.env.WEBCHAT_CONTROL_TIMEOUT_MS || 10_000);

/**
 * The tested release's copy of the runtime when there is one (deploy.sh puts
 * `rev5/` and `src/` under the build's `runtime/`, and serve.mjs names it),
 * else the checkout this server was started from.
 */
export function runtimeDir(env = process.env) {
  return env.TOPHAT_RUNNER_RUNTIME_DIR || env.TOPHAT_RUNTIME_DIR || resolve(process.cwd(), '..');
}

// same argv, same stream-json, same runner.sqlite). TOPHAT_PULL_SCRIPT names another file, relative to the runtime
// dir or absolute, without a deploy.
export function pullScript(env = process.env) {
  return resolve(runtimeDir(env), env.TOPHAT_PULL_SCRIPT || join('rev6', 'pull', 'pull.mjs'));
}

export function chatgptAuthFile(env = process.env) {
  return env.TOPHAT_RUNNER_CHATGPT_AUTH_FILE || join(homedir(), '.codex', 'auth.json');
}

/** Whether a gpt model has a credential here: the platform key file, or the ChatGPT subscription
 *  Codex signed in with, which rev5/openai.mjs sends to the Codex backend instead. Neither is read. */
export function openaiCredentialPresent(env = process.env) {
  if (env.TOPHAT_RUNNER_OPENAI_AUTH === 'api-key') return Boolean(env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE) && existsSync(env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE);
  if (env.TOPHAT_RUNNER_OPENAI_AUTH === 'chatgpt') return existsSync(chatgptAuthFile(env));
  return (Boolean(env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE) && existsSync(env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE))
    || existsSync(chatgptAuthFile(env));
}

/** What this provider needs before a child of it can do anything, and the sentence to say when it
 * has it not. The key file is named and present (never read here: it is a credential store) and
 * the pull script is where runtimeDir() says it is.
 *
 * A gpt model is answered about separately: its credential is the OpenAI one, which is either the
 * platform key file or the ChatGPT subscription Codex is signed in with.
 */
export function directReadiness(env = process.env, model = null) {
  const gpt = model ? /^(gpt-|o\d|chatgpt-)/i.test(model) : null;
  if (gpt === true || gpt === null) {
    const anthropic = Boolean(env.TOPHAT_RUNNER_API_KEY_FILE) && existsSync(env.TOPHAT_RUNNER_API_KEY_FILE);
    if (!openaiCredentialPresent(env) && (gpt === true || !anthropic)) {
      return { ok: false, missing: 'key-file',
        reason: gpt === true
          ? `${model} needs an OpenAI credential here: TOPHAT_RUNNER_OPENAI_API_KEY_FILE, or a signed-in Codex at ${chatgptAuthFile(env)}`
          : 'Missing API key file: TOPHAT_RUNNER_API_KEY_FILE or TOPHAT_RUNNER_OPENAI_API_KEY_FILE' };
    }
  } else if (!(env.TOPHAT_RUNNER_API_KEY_FILE && existsSync(env.TOPHAT_RUNNER_API_KEY_FILE))) {
    return { ok: false, missing: env.TOPHAT_RUNNER_API_KEY_FILE ? 'key-file' : 'TOPHAT_RUNNER_API_KEY_FILE',
      reason: 'Missing API key file: TOPHAT_RUNNER_API_KEY_FILE' };
  }
  const script = pullScript(env);
  if (!existsSync(script)) return { ok: false, missing: 'pull-script', reason: `the pull runner is not at ${script}` };
  return { ok: true, missing: null, reason: '' };
}

/** Available when the key file is named and present; the file is never read here. */
export function directAvailable(env = process.env) {
  return directReadiness(env).ok;
}

/**
 * The one environment a direct child is ever given. Every spawn path goes through this, so a cold
 * spawn, a boot resume, a revive and an ordinary send all hand the child the same variables; the
 * only things added are which conversation it belongs to and which agent it is. The second is what
 * a per-agent tool scopes by: TOPHAT_AGENT_ID is this conversation's own `root_<8 hex>` here, and
 * rev5/agents.mjs replaces it with `agent_<8 hex>` in every subagent's shells.
 */
export function childEnv(conversationId, env = process.env) {
  return { ...env, TOPHAT_CONVERSATION_ID: conversationId, TOPHAT_AGENT_ID: rootAgentId(conversationId) };
}

/** The error a spawn refuses with rather than forking a child whose first model call is doomed. */
export function notReadyError(readiness) {
  const error = new Error(`the rev 5 direct provider is not usable in this process: ${readiness.reason}`);
  error.code = 'provider-not-ready';
  error.readiness = readiness;
  return error;
}

export function argsFor({ sessionId, resumeFrom, fork, settings, cwd, uploadRoot = UPLOAD_ROOT, env = process.env }) {
  const args = [pullScript(env), '--model', settings.model, '--permission-mode', settings.permissionMode];
  if (settings.reasoningEffort) args.push('--reasoning-effort', settings.reasoningEffort);
  if (resumeFrom) {
    args.push('--resume', resumeFrom);
    if (fork) args.push('--fork-session');
  } else if (sessionId) {
    args.push('--session-id', sessionId);
  }
  if (cwd) args.push('--cwd', cwd);
  args.push('--add-dir', uploadRoot);
  return args;
}

export function controlRequestsFor(before = {}, after = {}) {
  const requests = [];
  if (before.model !== after.model) requests.push({ subtype: 'set_model', model: after.model });
  if (before.permissionMode !== after.permissionMode) requests.push({ subtype: 'set_permission_mode', mode: after.permissionMode });
  if (before.reasoningEffort !== after.reasoningEffort) requests.push({ subtype: 'set_reasoning_effort', effort: after.reasoningEffort });
  return requests;
}

export const directAdapter = {
  id: 'direct',
  capabilities: capabilitiesOf('direct'),
  emptyContext,
  // Both runners: a rev5 child spawned before the switch is still an orphan to sweep.
  orphanMarker: '/pull.mjs',
  // A child under a relay outlives the server; the next server adopts it (runner.adoptHandoff). This
  // link holds nothing but the child and the waiters of control requests in flight, so a fresh one is
  // as good as the old: a response to a request the old server made finds no waiter and is dropped.
  handover: true,
  adoptLink(child) { return { child, controlWaiters: new Map() }; },

  /** Whether a child started here could work at all, asked before anything is killed or forked. */
  ready(env = process.env, model = null) { return directReadiness(env, model); },

  spawn({ conversationId, sessionId, resumeFrom, fork, settings, cwd, spawnImpl = spawn, uploadRoot = UPLOAD_ROOT, env = process.env }) {
    // Refused rather than forked: a child with no key reaches the Messages API, fails auth, writes
    // a run.error into the conversation, and on the way there claims the session's ledger row from
    // the child that is really working. The caller is told; nothing of the live run is touched.
    const readiness = directReadiness(env, settings.model);
    if (!readiness.ok) throw notReadyError(readiness);
    const child = spawnImpl(process.execPath, argsFor({ sessionId, resumeFrom, fork, settings, cwd, uploadRoot, env }), {
      cwd,
      env: childEnv(conversationId, env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });
    return { child, link: { child, controlWaiters: new Map() } };
  },

  parse(line) {
    try { return JSON.parse(line); } catch { return null; }
  },

  ingest(link, ctx, message) {
    if (message?.type === 'control_response') {
      const waiter = link.controlWaiters?.get(message.response?.request_id);
      if (waiter) { link.controlWaiters.delete(message.response.request_id); waiter(message.response); }
    }
    return machineInputs(ctx, message);
  },

  deliver(link, text, { clockContext } = {}) {
    const stdin = link.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) throw new Error('the child has no usable stdin');
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }, ...(clockContext ? [{ type: 'text', text: clockContext }] : [])] } })}\n`);
    return true;
  },

  pace(link, text) { return this.deliver(link, text); },

  // A plain interrupt moves the live turn to the background (rev5/pull.mjs backgroundTurn()); cancelBackground is the
  // owner's hard stop, which aborts the turn and cancels every background turn too.
  interrupt(link, { cancelBackground = false } = {}) {
    try { link.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: newId(), request: { subtype: 'interrupt', cancel_queued: false, ...(cancelBackground ? { cancel_background: true } : {}) } })}\n`); } catch {  }
  },

  controlRequests: controlRequestsFor,

  control(link, request, done) {
    const requestId = newId();
    const timer = setTimeout(() => {
      if (!link.controlWaiters.delete(requestId)) return;
      done({ subtype: 'error', error: `no answer to ${request.subtype} in ${CONTROL_TIMEOUT_MS}ms` });
    }, CONTROL_TIMEOUT_MS);
    timer.unref?.();
    link.controlWaiters.set(requestId, (response) => { clearTimeout(timer); done(response); });
    try { link.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`); }
    catch (error) { clearTimeout(timer); link.controlWaiters.delete(requestId); done({ subtype: 'error', error: error.message }); }
  },

  dispose() {}
};
