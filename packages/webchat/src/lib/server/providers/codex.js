

import { spawn } from 'node:child_process';
import { capabilitiesOf } from '../../core/providers.js';
import { COMPACT_COMMAND } from '../session-machine.js';
import { emptyContext, machineInputs } from './codex-translate.js';
import { retrieveTurnContext } from './turn-context.js';
import { rootAgentId } from './agent-id.js';

const CODEX_BIN = process.env.WEBCHAT_CODEX_BIN || 'codex';
const REQUEST_TIMEOUT_MS = Number(process.env.WEBCHAT_CODEX_RPC_MS || 30_000);

export function policyFor(permissionMode) {
  switch (permissionMode) {
    case 'plan':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'manual':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    case 'acceptEdits':
    case 'auto':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'dontAsk':
    case 'bypassPermissions':
    default:
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
}

export class CodexLink {
  constructor({ child, push, conversationId }) {
    this.child = child;
    this.push = push || (() => {});
    this.conversationId = conversationId;
    this.nextId = 0;
    this.pending = new Map();
    this.threadId = null;
    this.activeTurnId = null;
    this.ready = false;
    this.closed = false;
    this.announced = false;
    
    
    
    this.queue = [];
    this.settings = null;
    this.compacting = false;
    
    
    
    
    this.compactTurnId = null;
    this.flushing = false;
    
    
    
    
    
    
    
    
    
    
    
    this.interrupting = false;
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('the codex link is closed'));
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(new Error('the child has no usable stdin'));
    }
    const id = ++this.nextId;
    let settle;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      settle.reject(new Error(`no answer to ${method} in ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    this.pending.set(id, { settle, timer, method });
    try {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      return Promise.reject(error);
    }
    return promise;
  }

  notify(method, params) {
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {  }
  }

  
  respond(id, result) {
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    } catch {  }
  }

  

  fail(message) {
    this.push({
      jsonrpc: '2.0',
      method: 'error',
      params: { error: { message }, threadId: this.threadId, turnId: this.activeTurnId, willRetry: false }
    });
  }

  close() {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.settle.reject(new Error('the codex link closed'));
    }
    this.pending.clear();
  }
}

export async function openThread(link, { resumeFrom, fork, settings, cwd }) {
  const policy = policyFor(settings.permissionMode);
  const base = {
    cwd: cwd || undefined,
    model: settings.model,
    approvalPolicy: policy.approvalPolicy,
    sandbox: policy.sandbox
  };
  if (resumeFrom && fork) return link.request('thread/fork', { threadId: resumeFrom, ...base });
  if (resumeFrom) return link.request('thread/resume', { threadId: resumeFrom, ...base });
  return link.request('thread/start', base);
}

export async function handshake(link, opts) {
  await link.request('initialize', {
    clientInfo: { name: 'tophat-webchat', title: 'tophat', version: '1' }
  });
  link.notify('initialized', {});
  const started = await openThread(link, opts);
  const threadId = started?.thread?.id;
  if (!threadId) throw new Error('codex returned no thread id');
  link.threadId = threadId;
  link.ready = true;
  
  
  
  
  
  
  if (!link.announced) {
    link.announced = true;
    link.push({ jsonrpc: '2.0', method: 'thread/started', params: { thread: started.thread } });
  }
  await flushQueue(link);
}

export async function sendTurn(link, text, injected, clockContext) {
  if (text === COMPACT_COMMAND) {
    link.compacting = true;
    link.compactTurnId = null;
    try {
      await link.request('thread/compact/start', { threadId: link.threadId });
    } catch (error) {
      
      
      
      link.compacting = false;
      throw error;
    }
    return;
  }
  const generation = link.contextGeneration || 0;
  const input = [{ type: 'text', text }];
  if (link.retrieveContext) {
    const context = await link.retrieveContext(text, { cwd: link.cwd, previousPrompt: link.previousPrompt || '' });
    if (link.closed || generation !== (link.contextGeneration || 0)) return;
    if (context) input.push({ type: 'text', text: context });
    if (!text.startsWith('<') && !text.startsWith('/') && text.trim().split(/\s+/u).length >= 3) link.previousPrompt = text;
  }
  // Evaluate at the RPC boundary, after retrieval/queue waits and again on fallback.
  const timedInput = () => {
    const clock = typeof clockContext === 'function' ? clockContext() : clockContext;
    return clock ? [...input, { type: 'text', text: clock }] : input;
  };
  const settings = link.settings || {};
  const policy = policyFor(settings.permissionMode);
  
  
  
  
  
  if (injected && link.activeTurnId) {
    try {
      await link.request('turn/steer', {
        threadId: link.threadId,
        expectedTurnId: link.activeTurnId,
        input: timedInput()
      });
      return;
    } catch (error) {
      if (!/expected|precondition|no active turn|not.*active|turn.*not found/i.test(String(error.message))) throw error;
    }
  }
  try {
    const started = await link.request('turn/start', {
      threadId: link.threadId,
      input: timedInput(),
      model: settings.model,
      effort: settings.reasoningEffort || undefined,
      approvalPolicy: policy.approvalPolicy
    });
    if (started?.turn?.id) link.activeTurnId = started.turn.id;
  } catch (error) {
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    if (/NotSteerable|ActiveTurn|active turn/i.test(String(error.message))) {
      link.queue.push({ text, injected: false, ...(clockContext ? { clockContext } : {}) });
      return;
    }
    throw error;
  }
}

export async function flushQueue(link) {
  if (link.flushing || link.closed) return;
  link.flushing = true;
  try {
    while (link.queue.length && link.ready && link.threadId && !link.compacting && !link.interrupting) {
      const item = link.queue.shift();
      try {
        await sendTurn(link, item.text, item.injected, item.clockContext);
      } catch (error) {
        if (link.closed) return;
        link.fail(`codex refused the turn: ${error.message}`);
      }
    }
  } finally {
    link.flushing = false;
  }
}

export const codexAdapter = {
  id: 'codex',
  capabilities: capabilitiesOf('codex'),
  emptyContext,
  
  
  
  orphanMarker: 'app-server',

  spawn({ conversationId, resumeFrom, fork, settings, cwd, spawnImpl = spawn, push, uploadRoot }) {
    
    
    
    
    
    
    
    
    
    
    const args = ['app-server'];
    if (uploadRoot) args.push('-c', `tophat_upload_root=${JSON.stringify(uploadRoot)}`);
    const child = spawnImpl(CODEX_BIN, args, {
      cwd,
      env: {
        ...process.env,
        TOPHAT_CONVERSATION_ID: conversationId,
        TOPHAT_AGENT_ID: rootAgentId(conversationId),
        
        
        
        BASH_DEFAULT_TIMEOUT_MS: process.env.BASH_DEFAULT_TIMEOUT_MS || '10000',
        BASH_MAX_TIMEOUT_MS: process.env.BASH_MAX_TIMEOUT_MS || '10000'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });
    const link = new CodexLink({ child, push, conversationId });
    link.settings = settings;
    link.cwd = cwd;
    link.retrieveContext = retrieveTurnContext;
    
    
    
    
    handshake(link, { resumeFrom, fork, settings, cwd }).catch((error) => {
      if (link.closed) return;
      link.fail(`codex could not open a thread: ${error.message}`);
    });
    return { child, link };
  },

  parse(line) {
    try { return JSON.parse(line); } catch { return null; }
  },

  ingest(link, ctx, message) {
    
    if (message && message.id !== undefined && message.method === undefined) {
      const entry = link.pending.get(message.id);
      if (entry) {
        link.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.settle.reject(new Error(JSON.stringify(message.error)));
        else entry.settle.resolve(message.result);
      }
      
      
      return machineInputs(ctx, message);
    }
    
    
    
    
    
    
    if (message && message.id !== undefined && typeof message.method === 'string') {
      const approve = policyFor(link.settings?.permissionMode).approvalPolicy === 'never';
      link.respond(message.id, { decision: approve ? 'approved' : 'denied' });
      return machineInputs(ctx, message);
    }
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    const ours = !message?.params?.threadId
      || !link.threadId
      || message.params.threadId === link.threadId;
    if (ours && message?.method === 'turn/started') link.activeTurnId = message.params?.turn?.id || null;
    
    
    
    
    
    if (ours && message?.method === 'item/started' && message.params?.item?.type === 'contextCompaction') {
      link.compacting = true;
      link.compactTurnId = message.params?.turnId || link.activeTurnId || null;
    }
    if (ours && message?.method === 'turn/completed') {
      const finished = message.params?.turn?.id || null;
      link.activeTurnId = null;
      
      
      
      if (link.compacting && (!link.compactTurnId || finished === link.compactTurnId)) {
        link.compacting = false;
        link.compactTurnId = null;
      }
      
      
      
      link.interrupting = false;
      
      
      
      if (link.queue.length) flushQueue(link);
    }
    if (message?.method === 'thread/started') {
      link.announced = true;
      if (!link.threadId) link.threadId = message.params?.thread?.id || null;
    }
    if (ours && message?.method === 'thread/compacted') {
      link.compacting = false;
      link.compactTurnId = null;
      if (link.queue.length) flushQueue(link);
    }
    return machineInputs(ctx, message);
  },

  deliver(link, text, { injected = false, clockContext } = {}) {
    const stdin = link.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) throw new Error('the child has no usable stdin');
    
    
    
    
    
    
    
    const busy = (link.compacting && text !== COMPACT_COMMAND) || link.interrupting;
    if (!link.ready || !link.threadId || busy) {
      link.queue.push({ text, injected, clockContext });
      return true;
    }
    
    
    link.queue.push({ text, injected, clockContext });
    flushQueue(link);
    return true;
  },

  pace(link, text) {
    if (!link.ready || link.closed || !link.activeTurnId || link.compacting || link.interrupting) return false;
    // Never fall back to turn/start: completion racing this timer is a dropped reminder.
    link.request('turn/steer', { threadId: link.threadId,
      expectedTurnId: link.activeTurnId, input: [{ type: 'text', text }] }).catch(() => {});
    return true;
  },

  interrupt(link) {
    link.contextGeneration = (link.contextGeneration || 0) + 1;
    if (!link.threadId || !link.activeTurnId) return;
    link.interrupting = true;
    link.request('turn/interrupt', { threadId: link.threadId, turnId: link.activeTurnId })
      .catch(() => {
        
        
        
        
        
        link.interrupting = false;
        if (link.queue.length) flushQueue(link);
      });
  },

  

  controlRequests(before, after, link) {
    if (link) link.settings = after;
    return [];
  },

  settingsAreLive: true,

  control(_link, request, done) {
    done({ subtype: 'error', error: `codex takes no control request ${request?.subtype}` });
  },

  dispose(link) {
    link?.close();
  },

  
  flushQueue
};
