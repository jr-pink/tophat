// One streaming request to Anthropic Messages or OpenAI Responses, returned as one Anthropic-shaped
// assistant message. Everything the provider sees is built here: request repair, prompt-cache
// breakpoints, effort, image hydration, the byte ceiling. OpenAI events are mapped onto Anthropic's.
import { readFileSync } from 'node:fs';
import { redactSecrets } from '../tools/runner/redact.mjs';
import { cut, toWireJSON } from '../base/text.mjs';
import { anthropicHeaders, openaiAuthMode, openaiHeaders, openaiRequestUrl } from './credentials.mjs';
import { hydrateImageBlocks, imageBytesIn } from './context.mjs';

export const MODELS = JSON.parse(readFileSync(new URL('./models.json', import.meta.url), 'utf8'));
const OPENAI_WIRE = new RegExp(MODELS.openaiWire, 'i');
const ANTHROPIC_BLOCKS = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'image', 'document']);
export const isOpenAIModel = (model) => OPENAI_WIRE.test(String(model || ''));

export class ModelError extends Error {
  constructor(reason, detail, { status = null, retryable = false } = {}) {
    super(`${reason}: ${detail}`);
    Object.assign(this, { reason, detail, status, retryable });
  }
}

export const sanitize = (text, max = 400) => cut(redactSecrets(String(text ?? '')).text.replace(/\s+/g, ' ').trim(), max);
export const modelFor = (requested, env = process.env) => requested || env.TOPHAT_RUNNER_MODEL || MODELS.default;
export const baseUrl = (env = process.env) => (env.TOPHAT_RUNNER_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');

export function limits(env = process.env) {
  const L = MODELS.limits, n = (name, fallback) => { const v = Number(env[name]); return v > 0 ? v : fallback; };
  return { maxTokens: n('TOPHAT_RUNNER_MAX_TOKENS', L.maxTokens), maxTokensCeiling: L.maxTokensCeiling, timeoutMs: n('TOPHAT_RUNNER_TIMEOUT_MS', L.timeoutMs),
    inputBytes: L.inputBytes, retries: env.TOPHAT_RUNNER_RETRIES === undefined ? L.retries : Math.max(0, Number(env.TOPHAT_RUNNER_RETRIES) || 0) };
}

const CREDENTIAL_REFUSAL = /api key is not scoped to a workspace|workspace `?[\w-]+`? not found|invalid x-api-key|anthropic-workspace-id/i;
function classify(status, body, openai = false) {
  let type = '', code = '', message = '';
  try { const e = JSON.parse(body)?.error; type = e?.type || ''; code = e?.code || ''; message = e?.message || ''; } catch { message = body; }
  const detail = sanitize(openai ? `HTTP ${status} ${type} ${code} ${message}` : `HTTP ${status} ${type} ${message}`);
  if (status === 401 || status === 403) return new ModelError('auth', detail, { status });
  // A credential the provider refuses for its setup rather than its request: a key that needs the
  // anthropic-workspace-id header, or a workspace the key does not belong to. Anthropic answers these 400
  // / 404; read as 'invalid' they were retried and the chain re-walked with waits for minutes, a turn that
  // looked hung. They are auth: no attempt on the same key heals them.
  if ((status === 400 || status === 404) && CREDENTIAL_REFUSAL.test(`${type} ${message}`)) return new ModelError('auth', detail, { status });
  if (status === 429) {
    const billing = openai && /quota|billing/i.test(`${code} ${message}`);
    return new ModelError(billing ? 'auth' : 'rate_limited', detail, { status, retryable: !billing });
  }
  if ((!openai && status === 529) || status >= 500) return new ModelError('overloaded', detail, { status, retryable: true });
  return new ModelError('invalid', detail, { status });
}
export const classifyStatus = (status, body) => classify(status, body, false);
export const classifyOpenAIStatus = (status, body) => classify(status, body, true);

export function parseFrame(frame) {
  let data = '';
  for (const line of frame.split('\n')) if (line.startsWith('data:')) data += line.slice(5).trim();
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

/** Accumulates stream events into a message. Tool arguments that are not whole JSON are marked, never run. */
export function createAssembler() {
  const message = { id: null, model: null, role: 'assistant', content: [], stop_reason: null, usage: {} };
  const partial = {}, parsedWhole = new Set(), closed = new Set();
  const closeArgs = (index, raw) => {
    const block = message.content[index];
    if (!block || block.type !== 'tool_use' || raw === undefined) return;
    closed.add(index);
    if (!raw) { block.input = block.input || {}; return; }
    try { block.input = JSON.parse(raw); parsedWhole.add(index); delete block.input_error; delete block.input_partial_json; } catch {
      block.input = {}; block.input_partial_json = raw;
      block.input_error = `the model sent ${raw.length} characters of arguments for this tool call that are not valid JSON, so it was not run`;
    }
  };
  const closeMessage = () => {
    for (const key of Object.keys(partial)) if (!closed.has(Number(key))) closeArgs(Number(key), partial[key]);
    if (message.stop_reason !== 'max_tokens') return;
    message.content.forEach((block, index) => {
      if (!block || block.type !== 'tool_use' || parsedWhole.has(index)) return;
      const raw = partial[index] || block.input_partial_json || '';
      block.input = {};
      if (raw) block.input_partial_json = raw;
      block.input_error = `the completion stopped at the output ceiling (max_tokens) with ${raw.length} characters of arguments written for this call, so it was never run`;
    });
  };
  return { message, take(event) {
    const block = message.content[event?.index], delta = event?.delta || {};
    switch (event?.type) {
      case 'message_start': Object.assign(message, { id: event.message?.id ?? null, model: event.message?.model ?? null, usage: { ...(event.message?.usage || {}) } }); break;
      case 'content_block_start': {
        const b = { ...(event.content_block || {}) };
        if (b.type === 'tool_use') { partial[event.index] = ''; b.input = b.input ?? {}; }
        if (b.type === 'text') b.text = b.text || '';
        if (b.type === 'thinking') b.thinking = b.thinking || '';
        message.content[event.index] = b; break;
      }
      case 'content_block_delta':
        if (!block) break;
        if (delta.type === 'text_delta') block.text += delta.text || '';
        else if (delta.type === 'thinking_delta') block.thinking += delta.thinking || '';
        else if (delta.type === 'signature_delta') block.signature = (block.signature || '') + (delta.signature || '');
        else if (delta.type === 'input_json_delta') partial[event.index] += delta.partial_json || '';
        break;
      case 'content_block_stop': {
        if (!block) break;
        const { arguments: args, ...finished } = event.content_block || {};
        Object.assign(block, finished);
        closeArgs(event.index, args !== undefined ? args : partial[event.index]); break;
      }
      case 'message_delta':
        if (event.delta?.stop_reason) message.stop_reason = event.delta.stop_reason;
        if (event.usage) Object.assign(message.usage, event.usage);
        closeMessage(); break;
      case 'message_stop': closeMessage(); break;
      default: break;
    }
  } };
}

// ---- request repair: the API refuses orphan results, unanswered calls, empty blocks and a leading assistant turn.
export const MISSING_RESULT_TEXT = 'No result was recorded for this tool call: the turn was cut off before it finished. Its outcome is unknown: check before repeating anything with a side effect.';
const blocksOf = (m) => (Array.isArray(m?.content) ? m.content.filter((b) => b && typeof b === 'object') : typeof m?.content === 'string' && m.content ? [{ type: 'text', text: m.content }] : []);
const textOfBlock = (b) => (typeof b?.text === 'string' ? b.text : '');

export function repairMessages(input = []) {
  const notes = [], plural = (n, one, many) => (n === 1 ? one : many);
  const cleaned = (Array.isArray(input) ? input.filter((m) => m && typeof m === 'object') : []).map((message, mi) => {
    const kept = [], ids = new Set();
    for (const block of blocksOf(message)) {
      if (block.type === 'text') { if (textOfBlock(block).trim()) kept.push(block); else notes.push('dropped an empty text block'); continue; }
      if (block.type === 'tool_result') {
        const c = block.content;
        kept.push(c === undefined || c === null || c === '' || (Array.isArray(c) && !c.length) ? { ...block, content: '[no output]' } : block); continue;
      }
      if (block.type === 'tool_use') {
        const b = block.id ? block : { ...block, id: `toolu_repaired_${mi}_${kept.length}` };
        if (ids.has(b.id)) { notes.push(`dropped a second tool_use with the same id in one message (${b.id})`); continue; }
        ids.add(b.id); kept.push(b); continue;
      }
      kept.push(block);
    }
    return { message, kept };
  });
  const claimed = new Set(), answers = new Map();
  cleaned.forEach(({ kept }, i) => {
    const calls = kept.filter((b) => b.type === 'tool_use');
    if (!calls.length) return;
    const results = [];
    let moved = 0, missing = 0;
    for (const call of calls) {
      let found = null;
      search: for (let j = i + 1; j < cleaned.length; j++) {
        const blocks = cleaned[j].kept;
        for (let k = 0; k < blocks.length; k++) {
          const b = blocks[k];
          if (b.type === 'tool_use' && b.id === call.id) break search;
          if (b.type !== 'tool_result' || b.tool_use_id !== call.id || claimed.has(`${j}:${k}`)) continue;
          claimed.add(`${j}:${k}`); found = { block: b, at: j }; break search;
        }
      }
      if (found) { if (found.at !== i + 1 || cleaned[found.at].message.role !== 'user') moved += 1; results.push(found.block); }
      else { missing += 1; results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: MISSING_RESULT_TEXT }); }
    }
    answers.set(i, results);
    if (moved) notes.push(`moved ${moved} tool result${plural(moved, '', 's')} into the message right after ${plural(moved, 'its call', 'their calls')}`);
    if (missing) notes.push(`answered ${missing} tool call${plural(missing, '', 's')} left hanging by an interrupted turn`);
  });
  const out = [];
  cleaned.forEach(({ message, kept }, i) => {
    const before = answers.get(i - 1);
    const own = kept.filter((b, k) => {
      if (b.type !== 'tool_result' || claimed.has(`${i}:${k}`)) return b.type !== 'tool_result';
      const id = b.tool_use_id;
      const issued = id && cleaned.slice(0, i).some((c) => c.kept.some((x) => x.type === 'tool_use' && x.id === id));
      notes.push(issued ? `dropped a tool_result for a call already answered (${id})` : `dropped a tool_result for a call that was never made (${id || 'no id'})`);
      return false;
    });
    if (before && message.role === 'user') { out.push({ ...message, content: [...before, ...own] }); return; }
    if (before) out.push({ role: 'user', content: before });
    if (!own.length) { notes.push(`dropped an empty ${message.role || 'unknown'} message`); return; }
    out.push({ ...message, content: own });
  });
  const trailing = answers.get(cleaned.length - 1);
  if (trailing) out.push({ role: 'user', content: trailing });
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '[the earlier part of this conversation is not in this request]' }] });
    notes.push('prefixed the request with a user message: it began on an assistant turn');
  }
  const last = out[out.length - 1];
  if (last?.role === 'assistant') {
    const at = last.content.length - 1, tail = last.content[at];
    if (tail?.type === 'text' && textOfBlock(tail) !== textOfBlock(tail).trimEnd()) {
      const trimmed = textOfBlock(tail).trimEnd(), content = last.content.slice(0, at);
      if (trimmed) content.push({ ...tail, text: trimmed });
      if (content.length) { out[out.length - 1] = { ...last, content }; notes.push('trimmed trailing whitespace from the assistant prefill'); }
      else { out.pop(); notes.push('dropped a whitespace-only assistant prefill'); }
    }
  }
  return { messages: out, notes };
}

// ---- prompt cache: breakpoints on tools, system, and the last two user messages once past the model's minimum.
export const cacheTtl = (env = process.env) => (['5m', '1h'].includes(env.TOPHAT_RUNNER_CACHE_TTL || '1h') ? env.TOPHAT_RUNNER_CACHE_TTL || '1h' : '1h');
const minCacheTokens = (model = '') => {
  const key = Object.keys(MODELS.cache.minTokens).filter((n) => model.startsWith(n)).sort((a, b) => b.length - a.length)[0];
  return key ? MODELS.cache.minTokens[key] : MODELS.cache.minDefault;
};
const marked = (block, ttl = '5m') => ({ ...block, cache_control: ttl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl } });
const asSystem = (s) => (typeof s === 'string' && s ? [{ type: 'text', text: s }] : Array.isArray(s) ? s.slice() : []);

export function withCacheControl(body, env = process.env, { tailSkip = 0, systemTail = '' } = {}) {
  if (env.TOPHAT_RUNNER_CACHE === '0') return systemTail ? { ...body, system: [...asSystem(body.system), { type: 'text', text: systemTail }] } : body;
  const ttl = cacheTtl(env);
  const prefixTtl = ttl === '1h' ? '1h' : (['5m', '1h'].includes(env.TOPHAT_RUNNER_CACHE_PREFIX_TTL) ? env.TOPHAT_RUNNER_CACHE_PREFIX_TTL : '1h');
  const min = minCacheTokens(body.model || ''), out = { ...body };
  let left = MODELS.cache.maxBreakpoints, chars = 0;
  const place = (size) => { chars += size; if (left > 0 && Math.floor(chars / 4) >= min) { left -= 1; return true; } return false; };
  if (Array.isArray(out.tools) && out.tools.length && place(JSON.stringify(out.tools).length)) out.tools = out.tools.map((t, i) => (i === out.tools.length - 1 ? marked(t, prefixTtl) : t));
  const system = typeof out.system === 'string' && out.system ? [{ type: 'text', text: out.system }] : Array.isArray(out.system) && out.system.length ? out.system.slice() : null;
  if (system && place(JSON.stringify(system).length)) { system[system.length - 1] = marked(system[system.length - 1], prefixTtl); out.system = system; }
  if (systemTail) { out.system = [...asSystem(out.system), { type: 'text', text: systemTail }]; chars += systemTail.length; }
  if (env.TOPHAT_RUNNER_CACHE === 'prefix') return out;
  const messages = Array.isArray(out.messages) ? out.messages : [];
  const sizes = messages.map((m) => JSON.stringify(m ?? null).length);
  const users = messages.map((m, i) => (m?.role === 'user' ? i : -1)).filter((i) => i >= 0).slice(-2);
  const next = [...messages], newest = messages.length - 1;
  let touched = false;
  for (const at of users) {
    if (left <= 0 || Math.floor((chars + sizes.slice(0, at + 1).reduce((a, b) => a + b, 0)) / 4) < min) continue;
    const message = next[at], content = message.content, skip = at === newest ? tailSkip : 0;
    if (typeof content === 'string' && content) { if (skip) continue; next[at] = { ...message, content: [marked({ type: 'text', text: content }, ttl)] }; }
    else if (Array.isArray(content) && content.length > skip && content[content.length - 1 - skip] && typeof content[content.length - 1 - skip] === 'object') {
      const blocks = content.slice(); blocks[blocks.length - 1 - skip] = marked(blocks[blocks.length - 1 - skip], ttl);
      next[at] = { ...message, content: blocks };
    } else continue;
    left -= 1; touched = true;
  }
  if (touched) out.messages = next;
  return out;
}

// ---- OpenAI Responses mapping.
const asText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p?.type === 'text' ? p.text : typeof p === 'string' ? p : JSON.stringify(p))).join('\n') : String(c ?? ''));
const dataUrl = (s) => `data:${s.media_type || 'image/jpeg'};base64,${s.data}`;

export function toInputItems(messages) {
  const items = [];
  for (const message of messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (message.role === 'user') {
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          if (parts.length) items.push({ role: 'user', content: parts.splice(0) });
          items.push({ type: 'function_call_output', call_id: b.tool_use_id, output: Array.isArray(b.content) && b.content.some((p) => p.type === 'image')
            ? b.content.map((p) => (p.type === 'image' ? { type: 'input_image', image_url: `data:${p.source.media_type};base64,${p.source.data}` } : { type: 'input_text', text: p.text || '' }))
            : asText(b.content) + (b.is_error ? '\n[this tool call failed]' : '') });
        } else if (b.type === 'text') parts.push({ type: 'input_text', text: b.text });
        else if (b.type === 'image' && b.source?.type === 'base64' && b.source.data) parts.push({ type: 'input_image', image_url: dataUrl(b.source) });
      }
      if (parts.length) items.push({ role: 'user', content: parts });
    } else for (const b of blocks) {
      if (b.type === 'text' && b.text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: b.text }] });
      else if (b.type === 'tool_use') items.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      else if (b.type === 'reasoning' && b.native?.encrypted_content) items.push({ type: 'reasoning', id: b.native.id, encrypted_content: b.native.encrypted_content, summary: b.native.summary || [] });
    }
  }
  return items;
}

export function toResponsesRequest(request, { maxOutput, omitMaxOutput = false } = {}) {
  const effort = request.reasoning_effort;
  if (effort && !MODELS.effort.levels.includes(effort)) throw new ModelError('invalid', `reasoning effort "${effort}" is not offered by ${request.model}; use one of ${MODELS.effort.levels.join(', ')}`);
  const body = { model: request.model, input: toInputItems(request.messages || []), stream: true, store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: true,
    ...(omitMaxOutput ? {} : { max_output_tokens: Math.min(request.max_tokens || 16_000, maxOutput || MODELS.limits.openaiMaxOutput) }) };
  if (request.system) body.instructions = request.system;
  if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
  if (request.tool_choice?.type === 'tool') body.tool_choice = { type: 'function', name: request.tool_choice.name };
  if (effort) body.reasoning = { effort, summary: 'auto' };
  if (request.metadata) body.metadata = request.metadata;
  return body;
}

const usageFrom = (u = {}) => ({ input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.input_tokens_details?.cached_tokens ?? 0,
  cache_creation_input_tokens: 0, reasoning_output_tokens: u.output_tokens_details?.reasoning_tokens ?? 0 });
const native = (item) => ({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content ?? null, summary: item.summary || [] });

export function createEventMapper() {
  let sawToolCall = false;
  return function map(event) {
    const item = event?.item || {}, index = event?.output_index;
    switch (event?.type) {
      case 'response.created':
        return [{ type: 'message_start', message: { id: event.response?.id ?? null, type: 'message', role: 'assistant', model: event.response?.model ?? null, content: [], stop_reason: null, usage: {} } }];
      case 'response.output_item.added': {
        let block;
        if (item.type === 'message') block = { type: 'text', text: '' };
        else if (item.type === 'function_call') { block = { type: 'tool_use', id: item.call_id, name: item.name, input: {} }; sawToolCall = true; }
        else if (item.type === 'reasoning') block = { type: 'reasoning', thinking: '', native: native(item) };
        else block = { type: item.type || 'unknown', native: item };
        return [{ type: 'content_block_start', index, content_block: block }];
      }
      case 'response.output_text.delta': return [{ type: 'content_block_delta', index, delta: { type: 'text_delta', text: event.delta || '' } }];
      case 'response.function_call_arguments.delta': return [{ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: event.delta || '' } }];
      case 'response.reasoning_summary_text.delta': return [{ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: event.delta || '' } }];
      case 'response.output_item.done':
        return [{ type: 'content_block_stop', index, content_block: item.type === 'reasoning' ? { native: native(item) }
          : item.type === 'function_call' ? { id: item.call_id, name: item.name, arguments: item.arguments } : item.type === 'message' ? {} : { native: item } }];
      case 'response.completed': case 'response.incomplete': {
        const response = event.response || {};
        const stop = event.type === 'response.incomplete' ? (response.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn') : sawToolCall ? 'tool_use' : 'end_turn';
        return [{ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: usageFrom(response.usage) }, { type: 'message_stop' }];
      }
      case 'response.failed': {
        const e = event.response?.error || {};
        throw new ModelError(/rate/i.test(e.code || '') ? 'rate_limited' : 'failed', sanitize(`${e.code || 'failed'} ${e.message || ''}`), { retryable: false });
      }
      case 'error': throw new ModelError('failed', sanitize(`${event.code || event.error?.code || 'error'} ${event.message || event.error?.message || ''}`), { retryable: false });
      default: return [];
    }
  };
}

const saidRepairs = new Set();
/** What goes on the wire for this request: url, header thunk, body bytes, status classifier and event mapper. */
export function planFor(fullRequest, env = process.env, lim = limits(env)) {
  const { cache_tail_skip: tailSkip = 0, caller, system_tail: systemTail = '', ...request } = fullRequest;
  const model = modelFor(request.model, env);
  const hydrated = { ...request, messages: hydrateImageBlocks(request.messages, { env }) };
  const imageBytes = imageBytesIn(hydrated.messages);
  if (isOpenAIModel(model)) {
    const { messages } = repairMessages(hydrated.messages);
    const mended = { ...hydrated, model, messages, ...(systemTail ? { system: [hydrated.system, systemTail].filter(Boolean).join('\n') } : {}) };
    return { url: openaiRequestUrl(env), headers: () => openaiHeaders(env), imageBytes, classify: classifyOpenAIStatus, mapper: createEventMapper(),
      body: toWireJSON(toResponsesRequest(mended, { omitMaxOutput: openaiAuthMode(env) === 'chatgpt' })) };
  }
  const { reasoning_effort: effort, metadata, ...rest0 } = hydrated;
  const wireEffort = effort === 'ultra' ? 'max' : effort;
  const withEffort = new RegExp(MODELS.effort.anthropicModels).test(model) && MODELS.effort.levels.includes(wireEffort)
    ? { ...rest0, output_config: { ...(rest0.output_config || {}), effort: wireEffort } } : rest0;
  // Opus 5 thinks adaptively by default but streams the thinking with display "omitted": a thinking_delta event with
  // zero characters and a signature, so the chat had nothing to show for the seconds the model spent thinking. Ask for
  // the summary on every model that takes it, unless the caller set its own thinking or forces a tool (a forced
  // tool_choice refuses thinking).
  const forcesTool = ['any', 'tool'].includes(withEffort.tool_choice?.type);
  // Chat turns only (no caller, direct-chat, subagents): push and pipeline calls keep the thinking behaviour they had.
  const chatCaller = !caller || caller === 'direct-chat' || String(caller).startsWith('subagent-');
  const rest = withEffort.thinking === undefined && !forcesTool && chatCaller && MODELS.thinking?.display && new RegExp(MODELS.thinking.models).test(model)
    ? { ...withEffort, thinking: { type: 'adaptive', display: MODELS.thinking.display } } : withEffort;
  const filtered = (rest.messages || []).map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => ANTHROPIC_BLOCKS.has(b?.type)).map(({ native: _n, ...b }) => b) } : m));
  const { messages, notes } = repairMessages(filtered);
  for (const note of notes) {
    const key = note.replace(/\(.*\)/, '');
    if (!saidRepairs.has(key)) { saidRepairs.add(key); process.stderr.write(`[rev6 model] request repaired on the way out: ${note}\n`); }
  }
  const body = toWireJSON(withCacheControl({ ...rest, messages, model, stream: true, max_tokens: Math.min(request.max_tokens || lim.maxTokens, lim.maxTokensCeiling) }, env, { tailSkip, systemTail }));
  const mapper = (event) => {
    if (event.type === 'error') throw new ModelError(event.error?.type === 'overloaded_error' ? 'overloaded' : 'failed',
      sanitize(`${event.error?.type || 'error'} ${event.error?.message || ''}`), { retryable: event.error?.type === 'overloaded_error' });
    return [event];
  };
  return { url: `${baseUrl(env)}/v1/messages`, headers: () => anthropicHeaders(env, caller), body, imageBytes, classify: classifyStatus, mapper };
}

async function attemptOnce({ plan, headers, controller, onEvent, fetchImpl }) {
  const response = await fetchImpl(plan.url, { method: 'POST', signal: controller.signal, body: plan.body, headers: { 'content-type': 'application/json', ...headers } });
  if (!response.ok) throw plan.classify(response.status, cut(await response.text().catch(() => ''), 2000));
  const assembler = createAssembler(), decoder = new TextDecoder();
  let buffer = '', stopped = false;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      const raw = parseFrame(buffer.slice(0, at));
      buffer = buffer.slice(at + 2);
      if (!raw) continue;
      for (const event of plan.mapper(raw)) { assembler.take(event); onEvent(event); if (event.type === 'message_stop') stopped = true; }
    }
  }
  if (!stopped) throw new ModelError('failed', 'the stream ended before message_stop', { retryable: true });
  return assembler.message;
}

/** One request, streamed. Transport failures retry `retries` times; an abort from `signal` is ModelError('aborted'). */
export async function streamMessage(request, { signal, onEvent = () => {}, env = process.env, fetchImpl = fetch } = {}) {
  const lim = limits(env), plan = planFor(request, env, lim);
  const ceiling = Math.min(MODELS.limits.providerBodyBytes, lim.inputBytes + plan.imageBytes), size = Buffer.byteLength(plan.body);
  if (size > ceiling) throw new ModelError('invalid', `request is ${size} bytes, over the ${ceiling} byte ceiling${plan.imageBytes ? ` (${lim.inputBytes} for the conversation plus ${plan.imageBytes} of attached image data)` : ''}`);
  const headers = plan.headers();
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = lim.timeoutMs > 0 ? setTimeout(() => controller.abort(new ModelError('timeout', `no completion in ${lim.timeoutMs}ms`)), lim.timeoutMs) : null;
    timer?.unref?.();
    const onAbort = () => controller.abort(new ModelError('aborted', 'interrupted'));
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try { return await attemptOnce({ plan, headers, controller, onEvent, fetchImpl }); } catch (error) {
      const failure = error instanceof ModelError ? error : controller.signal.aborted && controller.signal.reason instanceof ModelError ? controller.signal.reason
        : new ModelError('failed', sanitize(error?.code || error?.name || error?.message || 'request failed'), { retryable: true });
      if (failure.retryable && attempt < lim.retries && !signal?.aborted) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw failure;
    } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
}

export function writeSplit(u = {}) {
  const c = u.cache_creation;
  if (c && typeof c === 'object') return { cache_creation_5m_input_tokens: c.ephemeral_5m_input_tokens || 0, cache_creation_1h_input_tokens: c.ephemeral_1h_input_tokens || 0 };
  const out = {};
  for (const k of ['cache_creation_5m_input_tokens', 'cache_creation_1h_input_tokens']) if (typeof u[k] === 'number') out[k] = u[k];
  return out;
}
export function usageOf(message) {
  const u = message?.usage || {};
  return { input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null, cache_read_input_tokens: u.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? null, ...(u.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: u.reasoning_output_tokens } : {}), ...writeSplit(u) };
}
