

import { SIGNALS } from '../translate.js';

export { SIGNALS };

export function emptyContext() {
  return {
    threadId: null,
    turnId: null,
    model: null,
    contextWindow: null,
    
    
    
    
    
    items: {},
    
    
    
    
    
    agents: {},
    
    
    
    
    agentThreads: {},
    compacting: false,
    ready: false
  };
}

const METHOD_SIGNALS = new Map(Object.entries({
  
  'item/agentMessage/delta': SIGNALS.TURN_OUTPUT,
  'item/plan/delta': SIGNALS.TURN_OUTPUT,
  'item/reasoning/textDelta': SIGNALS.TURN_OUTPUT,
  'item/reasoning/summaryTextDelta': SIGNALS.TURN_OUTPUT,
  'item/reasoning/summaryPartAdded': SIGNALS.TURN_OUTPUT,
  'item/commandExecution/outputDelta': SIGNALS.TURN_OUTPUT,
  'item/commandExecution/terminalInteraction': SIGNALS.TURN_OUTPUT,
  'item/fileChange/outputDelta': SIGNALS.TURN_OUTPUT,
  'item/fileChange/patchUpdated': SIGNALS.TURN_OUTPUT,
  'item/mcpToolCall/progress': SIGNALS.TURN_OUTPUT,
  'command/exec/outputDelta': SIGNALS.TURN_OUTPUT,
  'process/outputDelta': SIGNALS.TURN_OUTPUT,
  'process/exited': SIGNALS.TURN_OUTPUT,
  'turn/diff/updated': SIGNALS.TURN_OUTPUT,
  'turn/plan/updated': SIGNALS.TURN_OUTPUT,
  
  
  
  
  'item/started': null,
  'item/completed': null,

  
  'turn/completed': SIGNALS.TURN_ENDED,

  
  'thread/started': SIGNALS.READY,

  
  'thread/compacted': SIGNALS.COMPACTED,

  
  'error': SIGNALS.CONTROL,
  'warning': SIGNALS.CONTROL,
  'guardianWarning': SIGNALS.CONTROL,
  'configWarning': SIGNALS.CONTROL,
  'deprecationNotice': SIGNALS.CONTROL,
  'turn/started': SIGNALS.CONTROL,
  'turn/moderationMetadata': SIGNALS.CONTROL,
  'thread/status/changed': SIGNALS.CONTROL,
  'thread/tokenUsage/updated': SIGNALS.CONTROL,
  'thread/settings/updated': SIGNALS.CONTROL,
  'thread/name/updated': SIGNALS.CONTROL,
  'thread/goal/updated': SIGNALS.CONTROL,
  'thread/goal/cleared': SIGNALS.CONTROL,
  'thread/archived': SIGNALS.CONTROL,
  'thread/unarchived': SIGNALS.CONTROL,
  'thread/deleted': SIGNALS.CONTROL,
  'thread/closed': SIGNALS.CONTROL,
  'thread/environment/connected': SIGNALS.CONTROL,
  'thread/environment/disconnected': SIGNALS.CONTROL,
  'hook/started': SIGNALS.CONTROL,
  'hook/completed': SIGNALS.CONTROL,
  'item/autoApprovalReview/started': SIGNALS.CONTROL,
  'item/autoApprovalReview/completed': SIGNALS.CONTROL,
  'serverRequest/resolved': SIGNALS.CONTROL,
  'skills/changed': SIGNALS.CONTROL,
  'mcpServer/startupStatus/updated': SIGNALS.CONTROL,
  'mcpServer/oauthLogin/completed': SIGNALS.CONTROL,
  'account/updated': SIGNALS.CONTROL,
  'account/rateLimits/updated': SIGNALS.CONTROL,
  'account/login/completed': SIGNALS.CONTROL,
  'app/list/updated': SIGNALS.CONTROL,
  'remoteControl/status/changed': SIGNALS.CONTROL,
  'externalAgentConfig/import/progress': SIGNALS.CONTROL,
  'externalAgentConfig/import/completed': SIGNALS.CONTROL,
  'fs/changed': SIGNALS.CONTROL,
  'model/rerouted': SIGNALS.CONTROL,
  'model/verification': SIGNALS.CONTROL,
  'model/safetyBuffering/updated': SIGNALS.CONTROL,
  'fuzzyFileSearch/sessionUpdated': SIGNALS.CONTROL,
  'fuzzyFileSearch/sessionCompleted': SIGNALS.CONTROL,
  'thread/realtime/started': SIGNALS.CONTROL,
  'thread/realtime/itemAdded': SIGNALS.CONTROL,
  'thread/realtime/transcript/delta': SIGNALS.CONTROL,
  'thread/realtime/transcript/done': SIGNALS.CONTROL,
  'thread/realtime/outputAudio/delta': SIGNALS.CONTROL,
  'thread/realtime/sdp': SIGNALS.CONTROL,
  'thread/realtime/error': SIGNALS.CONTROL,
  'thread/realtime/closed': SIGNALS.CONTROL,
  'windows/worldWritableWarning': SIGNALS.CONTROL,
  'windowsSandbox/setupCompleted': SIGNALS.CONTROL
}));


const TOOL_ITEMS = Object.freeze({
  commandExecution: 'Bash',
  fileChange: 'Edit',
  mcpToolCall: 'MCP',
  dynamicToolCall: 'Tool',
  webSearch: 'WebSearch',
  imageView: 'Read',
  imageGeneration: 'ImageGeneration',
  sleep: 'Sleep'
});


const AGENT_ITEMS = new Set(['collabAgentToolCall', 'subAgentActivity']);

const COLLAB_TOOLS = Object.freeze({
  spawnAgent: 'spawn agent',
  sendInput: 'send input',
  resumeAgent: 'resume agent',
  wait: 'wait',
  closeAgent: 'close agent',
  sendMessage: 'send message',
  followupTask: 'followup task',
  interruptAgent: 'interrupt agent',
  listAgents: 'list agents'
});

const CLOSING_TOOLS = Object.freeze({ closeAgent: false, interruptAgent: true });

const AGENT_TERMINAL = Object.freeze({
  completed: false,
  shutdown: false,
  interrupted: true,
  errored: true,
  notFound: true
});


const ACTIVITY_CLOSES = Object.freeze({ completed: false, interrupted: true });

function firstLine(text, max = 90) {
  const line = String(text ?? '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function collabLabel(tool) {
  return Object.hasOwn(COLLAB_TOOLS, tool) ? COLLAB_TOOLS[tool] : String(tool || 'collab');
}


function agentKeyOf(ctx, threadId) {
  if (!threadId) return null;
  return ctx.agentThreads?.[threadId] || threadId;
}


function linkThread(next, threadId, key) {
  if (!threadId || !key) return;
  if (next.agentThreads?.[threadId] === key) return;
  next.agentThreads = { ...(next.agentThreads || {}), [threadId]: key };
}

function openAgent(next, events, key, fields, { upgrade = false } = {}) {
  if (!key) return;
  linkThread(next, fields.threadId, key);
  const record = next.agents?.[key];
  
  
  
  
  
  
  
  
  if (record?.done) return;
  if (record && !upgrade) return;
  if (!record) {
    next.agents = { ...(next.agents || {}), [key]: { threadId: fields.threadId || null, done: false, result: null } };
  }
  events.push({
    kind: 'agent.started',
    content: {
      agentId: key,
      parentAgentId: null,
      agentType: fields.agentType || undefined,
      description: fields.description || undefined,
      
      
      prompt: fields.prompt || undefined
    }
  });
}

function closeAgentCard(next, events, key, { isError = false, result = null } = {}) {
  const record = key ? next.agents?.[key] : null;
  if (!record || record.done) return;
  next.agents = { ...next.agents, [key]: { ...record, done: true } };
  events.push({
    kind: 'agent.completed',
    
    
    
    
    content: { agentId: key, result: result ?? record.result ?? null, isError }
  });
}


function recordAgentResult(next, key, text) {
  const record = key ? next.agents?.[key] : null;
  if (!record || record.done || !text) return;
  next.agents = { ...next.agents, [key]: { ...record, result: text } };
}


function toolRow(next, events, { itemId, tool, agentId = null, started, input = null, output = null, isError = false }) {
  if (started) {
    next.items = { ...next.items, [itemId]: { type: 'collab', tool, agentId } };
    events.push({ kind: 'tool.started', content: { itemId, tool, input, agentId } });
    return;
  }
  const items = { ...next.items };
  delete items[itemId];
  next.items = items;
  events.push({ kind: 'tool.completed', content: { itemId, tool, output, isError, agentId } });
}

function collabInput(item) {
  const input = {};
  if (item.prompt) input.prompt = item.prompt;
  if (item.model) input.model = item.model;
  if (item.reasoningEffort) input.reasoningEffort = item.reasoningEffort;
  if (Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length) input.agents = item.receiverThreadIds;
  return Object.keys(input).length ? input : null;
}

function agentStates(item) {
  const states = item.agentsStates;
  return states && typeof states === 'object' ? states : {};
}

function collabOutput(item, threadId) {
  const states = agentStates(item);
  const state = threadId ? states[threadId] : null;
  if (state) return { status: state.status ?? null, message: state.message ?? null };
  return Object.keys(states).length ? states : null;
}

function agentClosure(item, threadId) {
  const state = threadId ? agentStates(item)[threadId] : null;
  const status = state?.status;
  if (status && Object.hasOwn(AGENT_TERMINAL, status)) {
    return { isError: AGENT_TERMINAL[status], result: state.message || null };
  }
  const failed = item.status === 'failed' || item.status === 'interrupted';
  if (failed) {
    if (item.tool !== 'spawnAgent') return null;
    return { isError: true, result: state?.message || null };
  }
  if (item.status === 'completed' && Object.hasOwn(CLOSING_TOOLS, item.tool)) {
    return { isError: CLOSING_TOOLS[item.tool], result: state?.message || null };
  }
  return null;
}


function translateCollab(next, events, item, started) {
  const label = collabLabel(item.tool);
  const threads = (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).filter(Boolean);
  const fieldsFor = (threadId) => ({
    threadId,
    agentType: item.model || undefined,
    description: firstLine(item.prompt) || label,
    prompt: item.prompt || undefined
  });

  if (item.tool === 'spawnAgent') {
    
    
    
    const threadId = threads[0] || null;
    
    
    
    
    const key = (next.agents?.[item.id] ? item.id : null) || agentKeyOf(next, threadId) || item.id;
    openAgent(next, events, key, fieldsFor(threadId), { upgrade: !started });
    if (!started) {
      const closing = agentClosure(item, threadId);
      if (closing) closeAgentCard(next, events, key, closing);
    }
    return;
  }

  
  
  if (!threads.length) {
    toolRow(next, events, {
      itemId: item.id,
      tool: label,
      started,
      input: collabInput(item),
      output: collabOutput(item, null),
      isError: item.status === 'failed'
    });
    return;
  }

  for (const threadId of threads) {
    const key = agentKeyOf(next, threadId);
    
    
    openAgent(next, events, key, fieldsFor(threadId));
    toolRow(next, events, {
      
      
      itemId: threads.length > 1 ? `${item.id}:${threadId}` : item.id,
      tool: label,
      agentId: key,
      started,
      input: collabInput(item),
      output: collabOutput(item, threadId),
      isError: item.status === 'failed'
    });
    if (!started) {
      const closing = agentClosure(item, threadId);
      if (closing) closeAgentCard(next, events, key, closing);
    }
  }
}

function translateActivity(next, events, item, started) {
  const path = String(item.agentPath || '');
  const name = path.split('/').filter(Boolean).pop() || path;
  const key = agentKeyOf(next, item.agentThreadId) || item.id;
  const open = () => openAgent(next, events, key, {
    threadId: item.agentThreadId,
    agentType: name || undefined,
    
    
    description: path && path !== name ? path : undefined
  });
  open();
  if (Object.hasOwn(ACTIVITY_CLOSES, item.kind)) {
    closeAgentCard(next, events, key, { isError: ACTIVITY_CLOSES[item.kind] });
    return;
  }
  
  
  
  if (item.kind !== 'started') {
    toolRow(next, events, { itemId: item.id, tool: String(item.kind || 'activity'), agentId: key, started });
  }
}

function signalForItem(item) {
  const type = item?.type;
  
  
  
  if (type === 'userMessage') return SIGNALS.USER_REPLAY;
  if (type === 'contextCompaction') return null; 
  if (type === 'hookPrompt') return SIGNALS.CONTROL;
  return SIGNALS.TURN_OUTPUT;
}

export function shapeOf(msg) {
  if (!msg || typeof msg !== 'object') return `<${typeof msg}>`;
  if (typeof msg.method !== 'string') {
    if (msg.error !== undefined) return 'rpc/error';
    if (msg.result !== undefined) return 'rpc/result';
    return 'rpc/-';
  }
  const method = msg.method;
  if (method === 'item/started' || method === 'item/completed') {
    const item = msg.params?.item;
    const type = item?.type || '-';
    
    
    
    
    if (type === 'collabAgentToolCall') return `${method}/${type}:${item.tool || '-'}`;
    if (type === 'subAgentActivity') return `${method}/${type}:${item.kind || '-'}`;
    return `${method}/${type}`;
  }
  return method;
}

export function threadRole(ctx, msg) {
  const threadId = msg?.params?.threadId;
  if (!threadId || !ctx?.threadId || threadId === ctx.threadId) return { role: 'main', agentId: null };
  const agentId = ctx.agentThreads?.[threadId] || null;
  return { role: agentId ? 'sub' : 'foreign', agentId };
}

const SUB_THREAD_METHODS = new Set([
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta'
]);


const SUB_THREAD_FORBIDDEN = new Set([
  'conversation.meta',
  'run.status',
  'run.completed',
  'run.cancelled',
  'run.error'
]);

function translateSubThread(ctx, msg, agentId) {
  const next = { ...ctx };
  if (msg.method === 'turn/completed') {
    
    
    
    
    
    const abnormal = Boolean(msg.params?.turn?.status && msg.params.turn.status !== 'completed');
    const events = [];
    for (const [id, item] of Object.entries(next.items || {})) {
      if (item.agentId !== agentId) continue;
      toolRow(next, events, { itemId: id, tool: item.tool, agentId, started: false, isError: abnormal });
    }
    return { ctx: next, events };
  }
  if (!SUB_THREAD_METHODS.has(msg.method)) return { ctx: next, events: [] };
  
  
  
  const inner = translate({ ...ctx, threadId: msg.params.threadId }, msg);
  next.items = inner.ctx.items;
  next.agents = inner.ctx.agents;
  next.agentThreads = inner.ctx.agentThreads;
  const events = [];
  for (const event of inner.events) {
    if (SUB_THREAD_FORBIDDEN.has(event.kind)) continue;
    
    
    if (event.kind === 'agent.started') {
      events.push({ ...event, content: { ...event.content, parentAgentId: event.content?.parentAgentId || agentId } });
      continue;
    }
    if (event.kind === 'agent.completed') {
      events.push(event);
      continue;
    }
    
    if (event.kind === 'assistant.message') recordAgentResult(next, agentId, event.content?.text);
    events.push({ ...event, content: { ...event.content, agentId: event.content?.agentId || agentId } });
  }
  
  
  for (const [id, item] of Object.entries(next.items || {})) {
    if (!item.agentId && !ctx.items?.[id]) next.items = { ...next.items, [id]: { ...item, agentId } };
  }
  return { ctx: next, events };
}


export function classify(msg) {
  const shape = shapeOf(msg);
  
  if (!msg || typeof msg.method !== 'string') return { signal: SIGNALS.CONTROL, shape };
  const method = msg.method;
  if (method === 'item/started' || method === 'item/completed') {
    const item = msg.params?.item;
    if (item?.type === 'contextCompaction') {
      return {
        signal: method === 'item/started' ? SIGNALS.COMPACTING : SIGNALS.COMPACTED,
        shape
      };
    }
    return { signal: signalForItem(item), shape };
  }
  if (!METHOD_SIGNALS.has(method)) return { signal: SIGNALS.UNKNOWN, shape };
  return { signal: METHOD_SIGNALS.get(method) ?? SIGNALS.CONTROL, shape };
}

function toolInput(item) {
  switch (item.type) {
    case 'commandExecution': return { command: item.command, cwd: item.cwd ?? null };
    case 'fileChange': return { changes: item.changes ?? null };
    case 'mcpToolCall': return item.arguments ?? null;
    case 'dynamicToolCall': return item.arguments ?? null;
    case 'webSearch': return { query: item.query ?? null };
    case 'imageView': return { path: item.path ?? null };
    case 'imageGeneration': return { prompt: item.revisedPrompt ?? null };
    case 'sleep': return { durationMs: item.durationMs ?? null };
    default: return null;
  }
}

function toolName(item) {
  if (item.type === 'mcpToolCall') {
    return item.server ? `${item.server}__${item.tool || 'call'}` : (item.tool || 'MCP');
  }
  if (item.type === 'dynamicToolCall') return item.tool || 'Tool';
  return TOOL_ITEMS[item.type] || item.type;
}

function toolOutput(item) {
  switch (item.type) {
    case 'commandExecution': return item.aggregatedOutput ?? '';
    case 'fileChange': return item.changes ?? null;
    case 'mcpToolCall': return item.error ?? item.result ?? null;
    case 'dynamicToolCall': return item.contentItems ?? null;
    case 'webSearch': return item.results ?? null;
    case 'imageGeneration': return item.savedPath ?? null;
    default: return null;
  }
}

function toolIsError(item) {
  if (item.type === 'commandExecution') return typeof item.exitCode === 'number' && item.exitCode !== 0;
  if (item.type === 'mcpToolCall') return Boolean(item.error);
  if (item.type === 'dynamicToolCall') return item.success === false;
  return item.status === 'failed';
}

export function translate(ctx, msg) {
  const next = { ...ctx };
  const events = [];
  if (!msg || typeof msg.method !== 'string') return { ctx: next, events };
  const params = msg.params || {};
  const method = msg.method;

  
  
  const { role, agentId } = threadRole(ctx, msg);
  if (role === 'sub') return translateSubThread(next, msg, agentId);
  if (role === 'foreign') return { ctx: next, events };

  switch (method) {
    case 'thread/started': {
      const thread = params.thread || {};
      next.threadId = thread.id || null;
      next.ready = true;
      events.push({
        kind: 'conversation.meta',
        content: {
          sessionId: thread.id || null,
          provider: 'codex',
          settings: { model: next.model, permissionMode: null },
          fastModeState: null,
          tools: []
        }
      });
      events.push({ kind: 'run.status', content: { state: 'running' } });
      return { ctx: next, events };
    }

    case 'turn/started': {
      next.turnId = params.turn?.id || null;
      return { ctx: next, events };
    }

    case 'thread/tokenUsage/updated': {
      const window = params.tokenUsage?.modelContextWindow;
      if (typeof window === 'number' && window > 0) next.contextWindow = window;
      return { ctx: next, events };
    }

    case 'item/agentMessage/delta': {
      if (!params.delta) return { ctx: next, events };
      events.push({
        kind: 'assistant.delta',
        content: { itemId: params.itemId, text: params.delta, agentId: null }
      });
      return { ctx: next, events };
    }

    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      if (!params.delta) return { ctx: next, events };
      events.push({
        kind: 'thinking.delta',
        
        
        
        
        content: {
          itemId: method.endsWith('summaryTextDelta') ? `${params.itemId}:summary` : params.itemId,
          text: params.delta,
          agentId: null
        }
      });
      return { ctx: next, events };
    }

    case 'item/started':
    case 'item/completed': {
      const item = params.item;
      if (!item || !item.type) return { ctx: next, events };
      const started = method === 'item/started';
      const id = item.id;

      if (item.type === 'userMessage') return { ctx: next, events };

      if (item.type === 'contextCompaction') {
        next.compacting = started;
        events.push({
          kind: 'run.status',
          content: started
            ? {
                state: 'running',
                note: 'Compacting the conversation to fit the context window. This takes a few minutes and produces no output until it is done.'
              }
            : { state: 'running', note: 'Compacted; picking the turn back up.' }
        });
        return { ctx: next, events };
      }

      if (item.type === 'hookPrompt') {
        if (started) {
          const text = (item.fragments || [])
            .map((f) => (typeof f === 'string' ? f : f?.text || ''))
            .join('\n')
            .trim();
          if (text) events.push({ kind: 'hook.fired', content: { itemId: id, source: 'codex', text, agentId: null } });
        }
        return { ctx: next, events };
      }

      if (item.type === 'agentMessage') {
        
        
        
        if (!started) {
          events.push({ kind: 'assistant.message', content: { itemId: id, text: item.text || '', agentId: null } });
        }
        return { ctx: next, events };
      }

      if (item.type === 'reasoning' || item.type === 'plan') return { ctx: next, events };

      if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
        if (started) {
          events.push({
            kind: 'run.status',
            content: {
              state: 'running',
              note: item.type === 'enteredReviewMode' ? 'Entered review mode.' : 'Left review mode.'
            }
          });
        }
        return { ctx: next, events };
      }

      if (AGENT_ITEMS.has(item.type)) {
        if (item.type === 'collabAgentToolCall') translateCollab(next, events, item, started);
        else translateActivity(next, events, item, started);
        return { ctx: next, events };
      }

      
      const tool = toolName(item);
      if (started) {
        next.items = { ...next.items, [id]: { type: item.type, tool, agentId: null } };
        events.push({ kind: 'tool.started', content: { itemId: id, tool, input: toolInput(item), agentId: null } });
      } else {
        const items = { ...next.items };
        delete items[id];
        next.items = items;
        events.push({
          kind: 'tool.completed',
          content: {
            itemId: id,
            tool: ctx.items?.[id]?.tool || tool,
            output: toolOutput(item),
            isError: toolIsError(item),
            agentId: null
          }
        });
      }
      return { ctx: next, events };
    }

    case 'turn/completed': {
      const turn = params.turn || {};
      const abnormal = turn.status && turn.status !== 'completed';
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      for (const [id, item] of Object.entries(next.items || {})) {
        events.push({
          kind: 'tool.completed',
          content: {
            itemId: id,
            tool: item.tool,
            output: null,
            isError: Boolean(abnormal),
            
            
            
            agentId: item.agentId ?? null
          }
        });
      }
      next.items = {};
      
      
      
      for (const [id, record] of Object.entries(next.agents || {})) {
        
        
        if (record?.done) continue;
        events.push({ kind: 'agent.completed', content: { agentId: id, result: record?.result ?? null, isError: false } });
      }
      next.agents = {};
      next.agentThreads = {};
      next.turnId = null;
      if (turn.status === 'cancelled' || turn.status === 'interrupted') {
        events.push({ kind: 'run.cancelled', content: { reason: turn.status } });
      } else if (turn.status === 'failed' || turn.error) {
        events.push({ kind: 'run.error', content: { message: errorText(turn.error) || 'The run failed.' } });
      } else {
        events.push({
          kind: 'run.completed',
          content: {
            costUsd: 0,
            durationMs: turn.durationMs || 0,
            turns: 1,
            fastModeState: null,
            usage: null
          }
        });
      }
      return { ctx: next, events };
    }

    case 'error': {
      events.push({ kind: 'run.error', content: { message: errorText(params.error) || 'The run failed.' } });
      return { ctx: next, events };
    }

    case 'thread/compacted': {
      next.compacting = false;
      return { ctx: next, events };
    }

    default:
      return { ctx: next, events };
  }
}

function errorText(error) {
  if (!error) return null;
  if (typeof error === 'string') return error;
  return error.message || error.error || null;
}

export function machineInputs(ctx, msg) {
  const { ctx: nextCtx, events } = translate(ctx, msg);
  const classified = classify(msg);
  
  
  
  
  
  
  
  
  
  const { role } = threadRole(ctx, msg);
  const signal = role === 'main' || classified.signal === SIGNALS.TURN_OUTPUT
    ? classified.signal
    : SIGNALS.CONTROL;
  const shape = role === 'main' ? classified.shape : `${classified.shape}@${role}`;
  const inputs = [];
  for (const event of events) {
    if (event.kind === 'tool.started') {
      
      
      
      inputs.push({ type: 'tool_started', id: event.content?.itemId, background: false });
    }
    if (event.kind === 'tool.completed') {
      inputs.push({ type: 'tool_completed', id: event.content?.itemId });
    }
    if (event.kind === 'run.cancelled' && event.content?.reason) {
      inputs.push({ type: 'child_aborted' });
    }
  }
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  if (msg?.method === 'thread/tokenUsage/updated' && role === 'main') {
    const tokens = msg.params?.tokenUsage?.last?.inputTokens;
    if (typeof tokens === 'number' && tokens > 0) inputs.push({ type: 'context_observed', tokens });
  }
  
  
  
  
  if (msg?.method === 'error' && msg.params?.willRetry === false && role === 'main') {
    inputs.push({ type: 'child_aborted' });
  }
  if (signal === SIGNALS.TURN_OUTPUT) inputs.push({ type: 'child_spoke' });
  if (signal === SIGNALS.TURN_ENDED) inputs.push({ type: 'turn_completed' });
  if (signal === SIGNALS.COMPACTING) inputs.push({ type: 'child_compacting' });
  if (signal === SIGNALS.COMPACTED) inputs.push({ type: 'child_compacted' });
  if (signal === SIGNALS.READY) inputs.push({ type: 'child_ready' });
  return { ctx: nextCtx, emit: events, inputs, signal, shape };
}


export function knownMethods() {
  return [...METHOD_SIGNALS.keys()];
}
