// The second model path: OpenAI's Responses API over fetch with server-sent
// events, for gpt-6-astra and its family. Nothing else in rev 5 learns a second
// wire shape: the runner keeps talking in Messages-API blocks (text, tool_use,
// tool_result) and stream events (message_start, content_block_*), and this
// file converts both ways at the edge. What the Responses API needs preserved
// verbatim for a correct continuation, its encrypted reasoning items, rides on
// a `reasoning` block with the native item under `native`; the Anthropic path
// drops those blocks and this path drops Anthropic thinking blocks.
//
// Stateless by design: `store: false`, every request rebuilt from the ledger,
// reasoning carried by `include: ["reasoning.encrypted_content"]`. The ledger
// is the durable state, not the provider.
//
// Two ways to authenticate, because this Mac has only one of them. A platform API key is pay-per-token; the ChatGPT
// subscription Codex already signs in with is not, and its backend accepts the same Responses requests at a different
// origin with the OAuth token and the account id beside it.
//
//   TOPHAT_RUNNER_OPENAI_API_KEY_FILE  file holding the platform API key (pay-per-token path)
//   TOPHAT_RUNNER_OPENAI_API_BASE      default https://api.openai.com
//   TOPHAT_RUNNER_CHATGPT_AUTH_FILE    Codex's OAuth file, default ~/.codex/auth.json (subscription path)
//   TOPHAT_RUNNER_OPENAI_AUTH          'api-key' or 'chatgpt' to choose; default: key file if present, else subscription
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelError, sanitize } from './model.mjs';

export const OPENAI_MODEL = /^(gpt-|o\d|chatgpt-)/i;
// Efforts gpt-6-astra documents (developers.openai.com/api/docs/models/gpt-6-astra); `none` is not offered there.
export const OPENAI_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const OPENAI_LIMITS = Object.freeze({ maxOutputCeiling: 128_000, contextWindow: 1_050_000 });

export function isOpenAIModel(model) { return OPENAI_MODEL.test(String(model || '')); }

export function openaiBaseUrl(env = process.env) {
  return (env.TOPHAT_RUNNER_OPENAI_API_BASE || 'https://api.openai.com').replace(/\/+$/, '');
}

export const CHATGPT_RESPONSES_BASE = 'https://chatgpt.com/backend-api/codex';

/** Codex's own OAuth file. Named here, read only when a request is actually being signed. */
export function chatgptAuthFile(env = process.env) {
  return env.TOPHAT_RUNNER_CHATGPT_AUTH_FILE || '';
}

const keyFilePresent = (env) => Boolean(env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE) && existsSync(env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE);

/**
 * Which credential this process would use for a gpt model, without reading either one: the
 * explicit choice when there is one, else the platform key if its file is there, else the
 * subscription. Null means no gpt model can run here at all.
 */
export function openaiAuthMode(env = process.env) {
  const asked = env.TOPHAT_RUNNER_OPENAI_AUTH;
  if (asked === 'api-key') return keyFilePresent(env) ? 'api-key' : null;
  if (asked === 'chatgpt') return existsSync(chatgptAuthFile(env)) ? 'chatgpt' : null;
  if (keyFilePresent(env)) return 'api-key';
  return existsSync(chatgptAuthFile(env)) ? 'chatgpt' : null;
}

export function openaiConfigured(env = process.env) {
  return Boolean(openaiAuthMode(env));
}

/** Where a gpt request goes: the two auth modes are two origins, not one origin with two keys. */
export function openaiRequestUrl(env = process.env) {
  return openaiAuthMode(env) === 'chatgpt'
    ? `${CHATGPT_RESPONSES_BASE}/responses`
    : `${openaiBaseUrl(env)}/v1/responses`;
}

/** The ChatGPT token and account id, read at request time, never held or echoed. */
function chatgptHeaders(env) {
  const file = chatgptAuthFile(env);
  let auth;
  try { auth = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new ModelError('auth', `ChatGPT auth file unreadable (${error.code || 'error'})`); }
  const token = auth?.tokens?.access_token;
  const account = auth?.tokens?.account_id;
  if (!token || !account) throw new ModelError('auth', 'ChatGPT auth file has no access token and account id; run `codex login`');
  return {
    authorization: `Bearer ${token}`,
    'chatgpt-account-id': account,
    'openai-beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    session_id: randomUUID()
  };
}

/** The credential, read at request time, never held or echoed. */
export function openaiHeaders(env = process.env) {
  const mode = openaiAuthMode(env);
  if (mode === 'chatgpt') return chatgptHeaders(env);
  const file = env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE;
  if (!file) throw new ModelError('auth', 'no OpenAI credential here: set TOPHAT_RUNNER_OPENAI_API_KEY_FILE, or sign Codex in so its ChatGPT auth file exists');
  let key = '';
  try { key = readFileSync(file, 'utf8').trim(); } catch (error) { throw new ModelError('auth', `OpenAI key file unreadable (${error.code || 'error'})`); }
  if (!key) throw new ModelError('auth', 'OpenAI key file is empty');
  return { authorization: `Bearer ${key}` };
}

const asText = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p?.type === 'text' ? p.text : typeof p === 'string' ? p : JSON.stringify(p))).join('\n') : String(content ?? '');

/**
 * Messages-API history to Responses input items. Tool results pair with their calls by id (call_id here);
 * an assistant turn keeps its item order, so a reasoning item still precedes the function call it led to.
 */
export function toInputItems(messages) {
  const items = [];
  for (const message of messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (message.role === 'user') {
      const parts = [];
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          if (parts.length) { items.push({ role: 'user', content: parts.splice(0) }); }
          items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: Array.isArray(block.content) && block.content.some(p => p.type === 'image')
            ? block.content.map(p => p.type === 'image' ? { type: 'input_image', image_url: `data:${p.source.media_type};base64,${p.source.data}` } : { type: 'input_text', text: p.text || '' })
            : asText(block.content) + (block.is_error ? '\n[this tool call failed]' : '') });
        } else if (block.type === 'text') parts.push({ type: 'input_text', text: block.text });
        // An owner-attached image (rev5/vision.mjs, hydrated in rev5/model.mjs) travels as a data URL here;
        // dropping it would leave this provider blind to a photo the other one can see.
        else if (block.type === 'image' && block.source?.type === 'base64' && block.source.data) {
          parts.push({ type: 'input_image', image_url: `data:${block.source.media_type || 'image/jpeg'};base64,${block.source.data}` });
        }
      }
      if (parts.length) items.push({ role: 'user', content: parts });
    } else {
      for (const block of blocks) {
        if (block.type === 'text' && block.text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text }] });
        else if (block.type === 'tool_use') items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
        else if (block.type === 'reasoning' && block.native?.encrypted_content) items.push({ type: 'reasoning', id: block.native.id, encrypted_content: block.native.encrypted_content, summary: block.native.summary || [] });
        // Anthropic thinking blocks have no meaning here and are dropped.
      }
    }
  }
  return items;
}

export function toTools(tools = []) {
  return tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false }));
}

/** The Messages-shaped request the runner builds, as a Responses body. */
export function toResponsesRequest(request, { maxOutput, omitMaxOutput = false } = {}) {
  const effort = request.reasoning_effort;
  if (effort && !OPENAI_EFFORTS.includes(effort)) throw new ModelError('invalid', `reasoning effort "${effort}" is not offered by ${request.model}; use one of ${OPENAI_EFFORTS.join(', ')}`);
  const body = {
    model: request.model, input: toInputItems(request.messages || []), stream: true, store: false,
    include: ['reasoning.encrypted_content'], parallel_tool_calls: true,
    // The ChatGPT backend answers "Unsupported parameter: max_output_tokens" to the field the
    // platform requires, so the cap is the caller's business on that path, not the wire's.
    ...(omitMaxOutput ? {} : { max_output_tokens: Math.min(request.max_tokens || 16_000, maxOutput || OPENAI_LIMITS.maxOutputCeiling) })
  };
  if (request.system) body.instructions = request.system;
  if (request.tools?.length) body.tools = toTools(request.tools);
  if (request.tool_choice?.type === 'tool') body.tool_choice = { type: 'function', name: request.tool_choice.name };
  if (effort) body.reasoning = { effort, summary: 'auto' };
  if (request.metadata) body.metadata = request.metadata;
  return body;
}

/** Responses usage in the runner's field names; reasoning tokens are counted, not hidden. */
export function usageFrom(usage = {}) {
  return { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.input_tokens_details?.cached_tokens ?? 0, cache_creation_input_tokens: 0,
    reasoning_output_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0 };
}

/**
 * Responses stream events to Messages stream events, one at a time. `output_index` is the block index.
 * Returns an array (0, 1 or more Messages events) per Responses event; throws ModelError on `error`/`response.failed`.
 */
export function createEventMapper() {
  const blocks = {};
  let sawToolCall = false, stopReason = null;
  return function map(event) {
    const out = [];
    switch (event?.type) {
      case 'response.created':
        out.push({ type: 'message_start', message: { id: event.response?.id ?? null, type: 'message', role: 'assistant', model: event.response?.model ?? null, content: [], stop_reason: null, usage: {} } });
        break;
      case 'response.output_item.added': {
        const item = event.item || {};
        const index = event.output_index;
        let block;
        if (item.type === 'message') block = { type: 'text', text: '' };
        else if (item.type === 'function_call') { block = { type: 'tool_use', id: item.call_id, name: item.name, input: {} }; sawToolCall = true; }
        // `thinking` collects the summary text the API streams, so the webchat shows it like Anthropic thinking; `native` is what goes back.
        else if (item.type === 'reasoning') block = { type: 'reasoning', thinking: '', native: { type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content ?? null, summary: item.summary || [] } };
        else block = { type: item.type || 'unknown', native: item };
        blocks[index] = block;
        out.push({ type: 'content_block_start', index, content_block: block });
        break;
      }
      case 'response.output_text.delta':
        out.push({ type: 'content_block_delta', index: event.output_index, delta: { type: 'text_delta', text: event.delta || '' } });
        break;
      case 'response.function_call_arguments.delta':
        out.push({ type: 'content_block_delta', index: event.output_index, delta: { type: 'input_json_delta', partial_json: event.delta || '' } });
        break;
      case 'response.reasoning_summary_text.delta':
        out.push({ type: 'content_block_delta', index: event.output_index, delta: { type: 'thinking_delta', thinking: event.delta || '' } });
        break;
      case 'response.output_item.done': {
        const item = event.item || {};
        const index = event.output_index;
        // The finished item is authoritative: the encrypted reasoning arrives here, and so do final arguments.
        const finished = item.type === 'reasoning' ? { native: { type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content ?? null, summary: item.summary || [] } }
          : item.type === 'function_call' ? { id: item.call_id, name: item.name, arguments: item.arguments }
            : item.type === 'message' ? {} : { native: item };
        out.push({ type: 'content_block_stop', index, content_block: finished });
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response || {};
        if (event.type === 'response.incomplete') stopReason = response.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn';
        else stopReason = sawToolCall ? 'tool_use' : 'end_turn';
        out.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: usageFrom(response.usage) });
        out.push({ type: 'message_stop' });
        break;
      }
      case 'response.failed': {
        const error = event.response?.error || {};
        throw new ModelError(/rate/i.test(error.code || '') ? 'rate_limited' : 'failed', sanitize(`${error.code || 'failed'} ${error.message || ''}`), { retryable: false });
      }
      case 'error':
        throw new ModelError('failed', sanitize(`${event.code || event.error?.code || 'error'} ${event.message || event.error?.message || ''}`), { retryable: false });
      default: break;
    }
    return out;
  };
}

/** HTTP failures in the runner's vocabulary; the body is sanitised and never holds the key. */
export function classifyOpenAIStatus(status, body) {
  let type = '', message = '', code = '';
  try { const parsed = JSON.parse(body); type = parsed?.error?.type || ''; code = parsed?.error?.code || ''; message = parsed?.error?.message || ''; } catch { message = body; }
  const detail = sanitize(`HTTP ${status} ${type} ${code} ${message}`);
  if (status === 401 || status === 403) return new ModelError('auth', detail, { status });
  if (status === 429) return new ModelError(/quota|billing/i.test(`${code} ${message}`) ? 'auth' : 'rate_limited', detail, { status, retryable: !/quota|billing/i.test(`${code} ${message}`) });
  if (status >= 500) return new ModelError('overloaded', detail, { status, retryable: true });
  return new ModelError('invalid', detail, { status });
}

/** Parse one SSE frame into {event, data}; the Responses API names the event on its own line and repeats it in data.type. */
export function parseResponsesFrame(frame) {
  let data = '';
  for (const line of frame.split('\n')) if (line.startsWith('data:')) data += line.slice(5).trim();
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}
