import { resolve } from 'node:path';


import { spawn } from 'node:child_process';
import { UPLOAD_ROOT } from '../uploads.js';
import { effectiveFastMode, newId } from '../../core/contract.js';
import { capabilitiesOf } from '../../core/providers.js';
import { emptyContext, machineInputs } from '../translate.js';
import { rootAgentId } from './agent-id.js';

const CLAUDE_BIN = process.env.WEBCHAT_CLAUDE_BIN || 'claude';

const CONTROL_TIMEOUT_MS = Number(process.env.WEBCHAT_CONTROL_TIMEOUT_MS || 10_000);

function modelArg(settings) {
  return settings.model;
}

export function argsFor({ sessionId, resumeFrom, fork, settings, cwd, uploadRoot = UPLOAD_ROOT }) {
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--forward-subagent-text',
    
    
    
    '--replay-user-messages',
    '--verbose',
    '--model', modelArg(settings),
    '--permission-mode', settings.permissionMode
  ];
  const contextHook = process.env.TOPHAT_CONTEXT_HOOK || resolve(process.cwd(), 'scripts/context-hook.mjs');
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(contextHook)}` }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(contextHook)}` }] }]
  };
  if (resumeFrom) {
    args.push('--resume', resumeFrom);
    if (fork) args.push('--fork-session');
  } else if (sessionId) {
    args.push('--session-id', sessionId);
  }
  const flags = { precomputeCompactionEnabled: true, hooks };
  if (effectiveFastMode(settings)) flags.fastMode = true;
  args.push('--settings', JSON.stringify(flags));
  if (cwd) args.push('--add-dir', cwd);
  args.push('--add-dir', uploadRoot);
  return args;
}

export function controlRequestsFor(before = {}, after = {}) {
  const requests = [];
  if (before.model !== after.model) requests.push({ subtype: 'set_model', model: after.model });
  if (effectiveFastMode(before) !== effectiveFastMode(after)) {
    requests.push({ subtype: 'apply_flag_settings', settings: { fastMode: effectiveFastMode(after) } });
  }
  if (before.permissionMode !== after.permissionMode) {
    requests.push({ subtype: 'set_permission_mode', mode: after.permissionMode });
  }
  return requests;
}

export function envFor({ conversationId, contextWindow, extra = {} }) {
  return {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: 'webchat',
    TOPHAT_CONVERSATION_ID: conversationId,
    TOPHAT_AGENT_ID: rootAgentId(conversationId),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow),
    BASH_DEFAULT_TIMEOUT_MS: process.env.BASH_DEFAULT_TIMEOUT_MS || '10000',
    BASH_MAX_TIMEOUT_MS: process.env.BASH_MAX_TIMEOUT_MS || '10000',
    ...extra
  };
}

export function makeClaudeAdapter({ id = 'claude', bin = CLAUDE_BIN, envExtra = () => ({}) } = {}) {
  return {
    id,
    capabilities: capabilitiesOf(id),

    emptyContext,

    

    orphanMarker: '--input-format stream-json',

    spawn({ conversationId, sessionId, resumeFrom, fork, settings, cwd, contextWindow, spawnImpl = spawn, uploadRoot = UPLOAD_ROOT }) {
      const args = argsFor({ sessionId, resumeFrom, fork, settings, cwd, uploadRoot });
      const child = spawnImpl(bin, args, {
        cwd,
        env: envFor({ conversationId, contextWindow, extra: envExtra(settings) }),
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
        const response = message.response || {};
        const waiter = link.controlWaiters?.get(response.request_id);
        if (waiter) {
          link.controlWaiters.delete(response.request_id);
          waiter(response);
        }
      }
      return machineInputs(ctx, message);
    },

    

    deliver(link, text, { clockContext } = {}) {
      const stdin = link.child?.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) throw new Error('the child has no usable stdin');
      stdin.write(`${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }, ...(clockContext ? [{ type: 'text', text: clockContext }] : [])] }
      })}\n`);
      return true;
    },

    pace(link, text) {
      return this.deliver(link, text);
    },

    interrupt(link) {
      try {
        link.child.stdin.write(`${JSON.stringify({
          type: 'control_request',
          request_id: newId(),
          request: { subtype: 'interrupt', cancel_queued: false }
        })}\n`);
      } catch {  }
    },

    controlRequests: controlRequestsFor,

    control(link, request, done) {
      const requestId = newId();
      const timer = setTimeout(() => {
        if (!link.controlWaiters.delete(requestId)) return;
        done({ subtype: 'error', error: `no answer to ${request.subtype} in ${CONTROL_TIMEOUT_MS}ms` });
      }, CONTROL_TIMEOUT_MS);
      timer.unref?.();
      link.controlWaiters.set(requestId, (response) => {
        clearTimeout(timer);
        done(response);
      });
      try {
        link.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`);
      } catch (error) {
        clearTimeout(timer);
        link.controlWaiters.delete(requestId);
        done({ subtype: 'error', error: error.message });
      }
    },

    
    dispose() {}
  };
}

export const claudeAdapter = makeClaudeAdapter();
