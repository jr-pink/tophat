
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SIGNALS = Object.freeze({
  
  
  
  TURN_OUTPUT: 'turn_output',
  
  TURN_ENDED: 'turn_ended',
  
  
  
  
  USER_REPLAY: 'user_replay',
  
  
  CONTROL: 'control',
  
  
  
  COMPACTING: 'compacting',
  
  COMPACTED: 'compacted',
  
  
  
  
  READY: 'ready',
  
  
  
  UNKNOWN: 'unknown',
});

const STREAM_OUTPUT = new Set([
  'content_block_start', 'content_block_delta', 'content_block_stop',
  'message_delta', 'message_stop',
]);
const STREAM_CONTROL = new Set(['message_start']);

export function shapeOf(msg) {
  const type = typeof msg?.type === 'string' ? msg.type : `<${typeof msg?.type}>`;
  
  
  
  if (type === 'system') {
    if (msg.subtype === 'status') return `system/status/${msg.status ?? 'null'}`;
    return `system/${msg.subtype || '-'}`;
  }
  if (type === 'stream_event') {
    const event = msg.event || {};
    if (event.type === 'content_block_delta') return `stream_event/content_block_delta/${event.delta?.type || '-'}`;
    if (event.type === 'content_block_start') return `stream_event/content_block_start/${event.content_block?.type || '-'}`;
    return `stream_event/${event.type || '-'}`;
  }
  if (type === 'result') return `result/${msg.subtype || '-'}`;
  if (type === 'user') {
    const content = msg.message?.content;
    if (Array.isArray(content)) return `user/${content[0]?.type || '-'}`;
    if (typeof content === 'string') return 'user/text';
    return 'user/-';
  }
  return type;
}

export function classify(msg) {
  const shape = shapeOf(msg);
  switch (msg?.type) {
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    case 'system': {
      if (msg.subtype === 'compact_boundary') return { signal: SIGNALS.COMPACTED, shape };
      
      
      
      
      
      
      
      
      if (msg.subtype === 'init') return { signal: SIGNALS.READY, shape };
      if (msg.subtype !== 'status') return { signal: SIGNALS.CONTROL, shape };
      if (msg.status === 'compacting') return { signal: SIGNALS.COMPACTING, shape };
      // Failed is finished: the machine's compaction deadline and its compacting flag come down either way.
      if (msg.status === 'compact_failed') return { signal: SIGNALS.COMPACTED, shape };
      
      
      
      // A turn that is recovering (a retry, a model switch, a wait before the chain starts again) or
      // continuing a completion cut at the output ceiling is a live child, not a silent one: read as
      // control traffic it moved no deadline, and a recovery longer than the silence ceiling had the
      // child killed for a hang it was not having. rev5/pull.mjs emits both.
      if (msg.status === 'recovering' || msg.status === 'continuing') return { signal: SIGNALS.TURN_OUTPUT, shape };
      if (msg.status === 'requesting' || msg.status == null) return { signal: SIGNALS.CONTROL, shape };
      return { signal: SIGNALS.UNKNOWN, shape };
    }
    case 'stream_event': {
      const event = msg.event?.type;
      if (STREAM_OUTPUT.has(event)) return { signal: SIGNALS.TURN_OUTPUT, shape };
      if (STREAM_CONTROL.has(event)) return { signal: SIGNALS.CONTROL, shape };
      return { signal: SIGNALS.UNKNOWN, shape };
    }
    
    case 'assistant':
      return { signal: SIGNALS.TURN_OUTPUT, shape };
    
    
    
    
    
    
    
    
    
    case 'user':
      return { signal: isUserReplay(msg) ? SIGNALS.USER_REPLAY : SIGNALS.TURN_OUTPUT, shape };
    case 'result':
      return { signal: SIGNALS.TURN_ENDED, shape };
    
    
    case 'control_response':
    case 'control_request':
    case 'control_cancel_request':
      return { signal: SIGNALS.CONTROL, shape };
    
    
    case 'command_lifecycle':
      return { signal: SIGNALS.CONTROL, shape };
    
    
    
    
    case 'tool_progress':
      return { signal: SIGNALS.TURN_OUTPUT, shape };
    default:
      return { signal: SIGNALS.UNKNOWN, shape };
  }
}

function isUserReplay(msg) {
  if (msg?.isReplay === true) return true;
  if (msg?.isSynthetic) return false;
  const content = msg?.message?.content;
  if (!Array.isArray(content) || !content.length) return false;
  return content.every((part) => part?.type === 'text');
}

/**
 * One stream state per agent lane.
 *
 * The rev 5 direct runner streams a whole conversation down a single pipe: the parent turn and every
 * subagent running under it, whose events carry parent_tool_use_id = the Agent tool_use id. Those streams
 * interleave, and a block index (0, 1, ...) or an ordinal message name means nothing outside the agent that
 * sent it. So everything that tracks "the message being streamed right now" lives in a lane keyed by the
 * agent, never once for the whole child process.
 */
function blankLane() {
  return {
    
    blocks: {},
    
    
    messageOrdinal: 0,
    lastIndex: -1,
    
    messageId: null,
    
    
    
    
    textBlocks: {},
    
    
    
    textClaim: null,
    
    textSettled: {}
  };
}

export const PARENT_LANE = '';

/** The parent's events carry no parent_tool_use_id; they are a lane like any other. */
export function laneKey(agentId) {
  return agentId || PARENT_LANE;
}

/** The lane this message belongs to, copied into the draft context so ctx is never mutated. */
function laneOf(draft, agentId) {
  const key = laneKey(agentId);
  const prior = draft.lanes[key] || blankLane();
  const lane = {
    ...prior,
    blocks: { ...prior.blocks },
    textBlocks: { ...prior.textBlocks },
    textSettled: { ...prior.textSettled }
  };
  draft.lanes[key] = lane;
  return lane;
}

/**
 * The name of a message whose message_start never arrived.
 *
 * The ordinal counts inside the lane, and carries the lane with it, so two agents streaming at once cannot
 * both call their first message "m1" and land their paragraphs on one row.
 */
function ordinalMessageId(lane, key) {
  return key ? `${key}/m${lane.messageOrdinal}` : `m${lane.messageOrdinal}`;
}

export function emptyContext() {
  return {
    sessionId: null,
    
    lanes: {},
    
    
    tools: {},
    
    agents: {},
    model: null,
    
    
    compacting: false
  };
}

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

// What the CLI puts on the assistant message it writes in the model's place when the account is at its limit
// (`error` on a stream-json assistant message), and the words it uses, for a CLI that does not say.
const LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);
const LIMIT_TEXT = /\bhit your (?:[\w'’]+ )*(?:limit|budget)\b|\busage limit reached\b/iu;

function agentIdOf(msg) {
  return msg.parent_tool_use_id || null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : ''))
    .join('');
}

function toolResultText(part) {
  if (typeof part.content === 'string') return part.content;
  if (Array.isArray(part.content)) return textOf(part.content);
  return '';
}

const HOOK_FEEDBACK = /^([A-Za-z][A-Za-z ]{0,40}?) hook feedback:\s*/u;

export function hookFeedback(text) {
  const match = HOOK_FEEDBACK.exec(text || '');
  if (!match) return null;
  return { source: match[1].trim().toLowerCase(), text: text.slice(match[0].length) };
}

/**
 * Reading the compaction summary back out of the rev 5 runner ledger.
 *
 * `compact_boundary` on the wire carries the trigger, the size of the cut and the seq of the row it wrote; the
 * summary itself is a row in the runner's own sqlite ledger (messages, role 'user', kind 'summary') and would
 * double the bytes of every boundary event if it travelled, so the text is fetched here, read-only, by that seq.
 * Nothing is ever written to that file, and every failure degrades to a card without the summary.
 */
export function runnerLedgerPath(env = process.env) {
  // Mirrors ledgerPath() in rev5/pull.mjs; the webchat's own launchd job sets TOPHAT_RUNNER_RUNNER_DB.
  return env.TOPHAT_RUNNER_RUNNER_DB
    || join(env.TOPHAT_STATE_DIR || join(homedir(), '.local', 'state', 'tophat'), 'rev5', 'runner.sqlite');
}

const SUMMARY_HEADER =
  /^\[Compacted context summary written (\S+) by ([^;\]]+); (\d+) earlier messages[^\]]*\]\n?/u;

/** The ledger stores content as the API's block array; the summary is one text block. */
export function ledgerBlocksText(content) {
  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    if (typeof parsed === 'string') return parsed;
    if (!Array.isArray(parsed)) return '';
    return parsed.map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : '')).join('');
  } catch {
    return typeof content === 'string' ? content : '';
  }
}

/** Splits the stamped header pull.mjs writes off the front of the summary. */
export function parseCompactSummary(text, fallback = {}) {
  const body = String(text || '');
  const match = SUMMARY_HEADER.exec(body);
  if (!match) return { summary: body, writtenAt: fallback.writtenAt ?? null, model: null, messages: fallback.messages ?? null };
  return {
    summary: body.slice(match[0].length),
    writtenAt: match[1],
    model: match[2].trim(),
    messages: Number(match[3])
  };
}

function ledgerSummary(sessionId, env = process.env, seq = null) {
  if (!sessionId) return null;
  const path = runnerLedgerPath(env);
  if (!existsSync(path)) return null;
  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    // The boundary names the row it wrote; the newest summary of the session is only the fallback, and with two
    // boundaries a minute apart that fallback shows the wrong one's text.
    const row = Number.isFinite(seq)
      ? db.prepare("SELECT content, created_at FROM messages WHERE session_id = ? AND seq = ? AND kind = 'summary'").get(sessionId, seq)
      : db.prepare("SELECT content, created_at FROM messages WHERE session_id = ? AND role = 'user' AND kind = 'summary' ORDER BY seq DESC LIMIT 1").get(sessionId);
    if (!row) return null;
    // pull.mjs stamps every row it cut with the summary's own timestamp, so the count is exact even when the
    // header in front of the summary is missing or reworded.
    const counted = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND compacted_at = ?')
      .get(sessionId, row.created_at);
    return parseCompactSummary(ledgerBlocksText(row.content), {
      writtenAt: row.created_at,
      messages: Number(counted?.n) || null
    });
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {  }
  }
}

let summarySource = ledgerSummary;

/** Tests (and any host that can hand the summary over directly) swap the ledger read out here. */
export function setCompactSummarySource(source) {
  summarySource = source || ledgerSummary;
}

export function readCompactSummary(sessionId, env = process.env, seq = null) {
  try {
    return summarySource(sessionId, env, seq) || null;
  } catch {
    return null;
  }
}

export function translate(ctx, msg) {
  const events = [];
  // A child line that parses to `null`, a number or a string is not a message. JSON.parse of a
  // blank line, of a bare `null`, or of a log line the child wrote to the wrong stream gives one,
  // and reading `.parent_tool_use_id` off it threw inside the stream reader -- one garbage line and
  // the turn ended with the conversation half written. classify() and shapeOf() already read this
  // shape as "unknown"; so does this now.
  if (!msg || typeof msg !== 'object') return { ctx, events };
  const next = { ...ctx, tools: { ...ctx.tools }, agents: { ...ctx.agents }, lanes: { ...(ctx.lanes || {}) } };
  const agentId = agentIdOf(msg);
  const lane = laneOf(next, agentId);

  if (msg.type === 'system' && msg.subtype === 'init') {
    next.sessionId = msg.session_id;
    next.model = msg.model;
    events.push({
      kind: 'conversation.meta',
      content: {
        sessionId: msg.session_id,
        settings: { model: msg.model, permissionMode: msg.permissionMode },
        fastModeState: msg.fast_mode_state ?? null,
        tools: msg.tools || []
      }
    });
    events.push({ kind: 'run.status', content: { state: 'running' } });
    return { ctx: next, events };
  }

  
  
  
  if (msg.type === 'system' && msg.subtype === 'status' && msg.status === 'compacting') {
    if (ctx.compacting) return { ctx: next, events };
    next.compacting = true;
    events.push({
      kind: 'run.status',
      content: {
        state: 'running',
        note: 'Compacting in background'
      }
    });
    return { ctx: next, events };
  }

  // the runner says nothing while it runs and one system line when it ends, which becomes one background.turn event that
  // the reducer draws as an automated-event bubble. A line that says it is still running is ignored.
  if (msg.type === 'system' && msg.subtype === 'background_turn') {
    const id = String(msg.background_id || '');
    if (!id || !msg.state || msg.state === 'running') return { ctx: next, events };
    events.push({
      kind: 'background.turn',
      content: {
        itemId: `bg:${id}`,
        backgroundId: id,
        state: msg.state || 'running',
        gist: msg.gist || '',
        result: msg.result || '',
        calls: Number.isFinite(msg.calls) ? msg.calls : null,
        costUsd: Number.isFinite(msg.cost_usd) ? msg.cost_usd : null,
        startedAt: msg.started_at || null,
        endedAt: msg.ended_at || null
      }
    });
    return { ctx: next, events };
  }

  // A compaction that never reaches a boundary still has to end: the 'compacting' note is the only thing the owner
  // can see of it, and pull.mjs says so rather than leaving the chat reading "compacting" for the rest of the turn.
  if (msg.type === 'system' && msg.subtype === 'status' && msg.status === 'compact_failed') {
    next.compacting = false;
    events.push({
      kind: 'run.status',
      content: { state: 'running', note: `The compaction failed (${msg.detail || 'no detail given'}); carrying on with the context as it is.` }
    });
    return { ctx: next, events };
  }

  // A boundary is the one moment the transcript loses messages, so it leaves a row behind rather than a
  // status note that disappears....
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    next.compacting = false;
    const meta = msg.compact_metadata || {};
    const sessionId = msg.session_id || ctx.sessionId || null;
    // The summary does not travel on the wire, so it is read back out of the runner ledger (read-only) by the
    // row this boundary names, falling back to the session's newest summary for an older runner that names none.
    const written = readCompactSummary(sessionId, process.env, Number.isFinite(meta.summary_seq) ? meta.summary_seq : null);
    events.push({
      kind: 'context.compacted',
      content: {
        itemId: msg.uuid || `${sessionId || 'session'}:compact:${written?.writtenAt || meta.pre_tokens || ''}`,
        sessionId,
        trigger: meta.trigger || 'auto',
        // pre_tokens is absent when nothing measured the context that was cut; the count of rows replaced is
        // always known, so the card can be honest about the size of the cut even then.
        preTokens: Number.isFinite(meta.pre_tokens) ? meta.pre_tokens : null,
        messages: written?.messages ?? (Number.isFinite(meta.messages) ? meta.messages : null),
        summary: written?.summary || '',
        summaryAt: written?.writtenAt || null,
        model: written?.model || ctx.model || null
      }
    });
    events.push({
      kind: 'run.status',
      content: { state: 'running', note: 'Compacted; picking the turn back up.' }
    });
    return { ctx: next, events };
  }

  if (msg.type === 'stream_event') {
    const event = msg.event || {};
    const key = `${event.index}`;
    const mine = laneKey(agentId);
    if (event.type === 'message_start') {
      
      lane.blocks = {};
      lane.messageOrdinal += 1;
      lane.lastIndex = -1;
      lane.messageId = event.message?.id || ordinalMessageId(lane, mine);
      return { ctx: next, events };
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block || {};
      
      
      
      if (event.index <= lane.lastIndex) {
        lane.blocks = {};
        lane.messageOrdinal += 1;
        lane.messageId = ordinalMessageId(lane, mine);
      }
      lane.lastIndex = event.index;
      if (block.type === 'tool_use') {
        
        
        lane.blocks[key] = { type: 'tool', itemId: block.id, tool: block.name };
        next.tools[block.id] = { tool: block.name, agentId };
        if (SUBAGENT_TOOLS.has(block.name)) {
          next.agents[block.id] = { agentType: block.input?.subagent_type || null };
          events.push({ kind: 'agent.started', content: { agentId: block.id, parentAgentId: agentId, agentType: block.input?.subagent_type || 'agent', description: block.input?.description || 'Subagent' } });
        } else {
          events.push({ kind: 'tool.started', content: { itemId: block.id, tool: block.name, agentId } });
        }
      } else {
        const messageId = lane.messageId || ordinalMessageId(lane, mine);
        lane.messageId = messageId;
        const itemId = `${messageId}:${event.index}`;
        lane.blocks[key] = { type: block.type, itemId };
        if (block.type === 'text') lane.textBlocks[messageId] = [...(lane.textBlocks[messageId] || []), itemId];
      }
      return { ctx: next, events };
    }
    if (event.type === 'content_block_delta') {
      const block = lane.blocks[key];
      const delta = event.delta || {};
      
      const loose = `${lane.messageId || ordinalMessageId(lane, mine)}:${event.index}`;
      if (delta.type === 'text_delta' && delta.text) {
        events.push({ kind: 'assistant.delta', content: { itemId: block?.itemId || loose, text: delta.text, agentId } });
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        events.push({ kind: 'thinking.delta', content: { itemId: block?.itemId || loose, text: delta.thinking, agentId } });
      } else if (delta.type === 'input_json_delta' && delta.partial_json && block?.type === 'tool') {
        const target = next.agents[block.itemId] ? 'agent' : 'tool';
        if (target === 'tool') {
          events.push({ kind: 'tool.input_delta', content: { itemId: block.itemId, tool: block.tool, partial: delta.partial_json, agentId } });
        }
      }
      return { ctx: next, events };
    }
    return { ctx: next, events };
  }

  if (msg.type === 'assistant') {
    // `content` is an array of blocks or, just as legally, one string: the API accepts both and a
    // child that sends the string form used to throw here on `.forEach` and end the turn. A string
    // is the one text block it stands for -- which is how the `user` branch below already reads it
    // -- and anything else is nothing.
    const raw = msg.message?.content;
    const content = Array.isArray(raw)
      ? raw.filter((part) => part && typeof part === 'object')
      : typeof raw === 'string' && raw ? [{ type: 'text', text: raw }] : [];
    const messageId = msg.message?.id || msg.uuid;
    // A limit is said twice, as this message and as the turn's error result with the same text. It is held until the
    // result, so the chat shows it once, as the error. The field exists only while one is held (never in emptyContext),
    // so the handover structure (code-shape.js) is unchanged.
    if (!agentIdOf(msg) && LIMIT_ERRORS.has(msg.error)) {
      next.limitReply = { itemId: `${messageId}:0`, text: textOf(content) };
      return { ctx: next, events };
    }
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    // The settle is matched inside this agent's lane only: another agent's in-flight message is not a
    // candidate, so a subagent can never adopt the row the parent is streaming into (and back).
    const inFlight = lane.messageId || ordinalMessageId(lane, laneKey(agentId));
    const own = lane.textBlocks[messageId];
    const adopted = !own && lane.textClaim !== inFlight ? (lane.textBlocks[inFlight] || []) : [];
    const streamed = own || adopted;
    
    
    if (adopted.length) lane.textBlocks[messageId] = adopted;
    
    
    if (streamed.length) lane.textClaim = inFlight;
    let textOrdinal = lane.textSettled[messageId] || 0;
    content.forEach((part, index) => {
      const itemId = `${messageId}:${index}`;
      if (part.type === 'text') {
        const settledId = streamed[textOrdinal] || itemId;
        textOrdinal += 1;
        lane.textSettled[messageId] = textOrdinal;
        events.push({ kind: 'assistant.message', content: { itemId: settledId, text: part.text || '', agentId } });
      } else if (part.type === 'tool_use') {
        if (SUBAGENT_TOOLS.has(part.name)) {
          next.agents[part.id] = { agentType: part.input?.subagent_type || null };
          events.push({ kind: 'agent.started', content: { agentId: part.id, parentAgentId: agentId, agentType: part.input?.subagent_type || 'agent', description: part.input?.description || 'Subagent', prompt: part.input?.prompt || '' } });
        } else {
          next.tools[part.id] = { tool: part.name, agentId };
          events.push({ kind: 'tool.started', content: { itemId: part.id, tool: part.name, input: part.input ?? null, agentId } });
        }
      }
    });
    return { ctx: next, events };
  }

  if (msg.type === 'user') {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        // A null or a bare string in the block list is not a block; reading .type off it threw.
        if (!part || typeof part !== 'object') continue;
        
        
        
        
        
        
        
        
        if (part.type === 'text' && msg.isSynthetic) {
          const hook = hookFeedback(part.text || '');
          if (hook) {
            events.push({ kind: 'hook.fired', content: { itemId: msg.uuid || `${msg.session_id}:hook`, source: hook.source, text: hook.text, agentId } });
            continue;
          }
        }
        if (part.type !== 'tool_result') continue;
        const id = part.tool_use_id;
        if (next.agents[id]) {
          events.push({ kind: 'agent.completed', content: { agentId: id, result: toolResultText(part), isError: Boolean(part.is_error) } });
          delete next.agents[id];
          continue;
        }
        events.push({
          kind: 'tool.completed',
          content: {
            itemId: id,
            tool: next.tools[id]?.tool || null,
            output: msg.tool_use_result ?? toolResultText(part),
            isError: Boolean(part.is_error),
            agentId: next.tools[id]?.agentId ?? agentId
          }
        });
        delete next.tools[id];
      }
    } else if (typeof content === 'string' && agentId) {
      
      events.push({ kind: 'assistant.delta', content: { itemId: `${msg.uuid}:0`, text: content, agentId } });
    }
    return { ctx: next, events };
  }

  if (msg.type === 'result') {
    for (const id of Object.keys(next.agents)) {
      events.push({ kind: 'agent.completed', content: { agentId: id, isError: false } });
    }
    next.agents = {};
    
    
    const aborted = ['aborted_streaming', 'interrupted', 'cancelled'].includes(msg.terminal_reason);
    const failed = !aborted && (msg.is_error || msg.subtype === 'error_during_execution');
    const held = next.limitReply;
    if (held) delete next.limitReply;
    if (held && !(failed && msg.result === held.text)) {
      events.push({ kind: 'assistant.message', content: { itemId: held.itemId, text: held.text, agentId: null } });
    }
    if (aborted) {
      events.push({ kind: 'run.cancelled', content: { reason: msg.terminal_reason } });
    } else if (failed) {
      const message = msg.result || msg.error || 'The run failed.';
      // Marked so the server can carry the turn on in another provider (claude-fallback.js).
      const limit = Boolean(held) || msg.api_error_status === 429 || LIMIT_TEXT.test(message);
      events.push({ kind: 'run.error', content: { message, ...(limit ? { limit: true } : {}) } });
    } else {
      events.push({
        kind: 'run.completed',
        content: {
          costUsd: msg.total_cost_usd || 0,
          durationMs: msg.duration_ms || 0,
          turns: msg.num_turns || 0,
          fastModeState: msg.fast_mode_state ?? null,
          usage: msg.usage || null
        }
      });
    }
    return { ctx: next, events };
  }

  return { ctx: next, events };
}

export function machineInputs(ctx, msg) {
  const { ctx: nextCtx, events } = translate(ctx, msg);
  const { signal, shape } = classify(msg);
  const inputs = [];
  for (const event of events) {
    
    
    
    
    
    
    if (event.kind === 'tool.started') {
      inputs.push({
        type: 'tool_started',
        id: event.content?.itemId,
        background: Boolean(event.content?.input?.run_in_background),
      });
    }
    if (event.kind === 'tool.completed') {
      inputs.push({ type: 'tool_completed', id: event.content?.itemId });
    }
    
    
    
    if (event.kind === 'run.cancelled' && event.content?.reason) {
      inputs.push({ type: 'child_aborted' });
    }
  }
  
  
  
  
  
  
  
  
  
  
  
  // A call in flight when a compaction landed reports the size of the context it went out on, which the boundary has
  // since cut; rev5 marks such a message. Counting it put the pre-compaction size back on a freshly compacted chat
  // and the machine then compacted it again the moment it went idle.
  if (msg?.type === 'assistant' && msg.message?.usage && !msg.context_stale) {
    const u = msg.message.usage;
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (tokens > 0) inputs.push({ type: 'context_observed', tokens });
  }
  
  
  if (signal === SIGNALS.TURN_OUTPUT) inputs.push({ type: 'child_spoke' });
  if (signal === SIGNALS.TURN_ENDED) inputs.push({ type: 'turn_completed' });
  if (signal === SIGNALS.COMPACTING) inputs.push({ type: 'child_compacting' });
  if (signal === SIGNALS.COMPACTED) inputs.push({ type: 'child_compacted' });
  if (signal === SIGNALS.READY) inputs.push({ type: 'child_ready' });
  return { ctx: nextCtx, emit: events, inputs, signal, shape };
}

export function translateAll(messages, ctx = emptyContext()) {
  const events = [];
  let current = ctx;
  for (const msg of messages) {
    const step = translate(current, msg);
    current = step.ctx;
    events.push(...step.events);
  }
  return { ctx: current, events };
}
