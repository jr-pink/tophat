#!/usr/bin/env node
// The one path from rev 5 to a model: a direct Anthropic Messages API client
// over fetch with server-sent events. No CLI harness, no SDK, no provider
// branch anywhere else. The page writer reaches it as a subprocess
// (`node rev5/model.mjs`, JSON in, JSON out); the pull runner imports
// `streamMessage` and forwards the raw stream events.
//
// The key is read from the file named by TOPHAT_RUNNER_API_KEY_FILE at request
// time and never leaves this process: errors carry the HTTP status and the
// API's error type, never the request or a response body that could hold it.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redactSecrets } from '../src/agent/redact.mjs';
import { writeTrace } from '../src/vault/trace-write.mjs';
import { classifyOpenAIStatus, createEventMapper, isOpenAIModel, openaiAuthMode, openaiHeaders, openaiRequestUrl, toResponsesRequest } from './openai.mjs';
import { cut, toWireJSON } from './unicode.mjs';
import { hydrateImageBlocks, imageBytesIn } from './vision.mjs';
import { repairMessages, repairRequest } from './request-repair.mjs';
import { fallbackChain } from './resilience.mjs';

export const API_VERSION = '2023-06-01';
// Block types the Messages API accepts; anything else in the ledger (OpenAI reasoning items) is the other provider's and is dropped here.
const ANTHROPIC_BLOCKS = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'image', 'document']);
// USD per million tokens. The one table is rev6/pull/models.json `prices` (provider pages and Anthropic's own cost_report are
// cited where each rate was set, in git history); this module, rev6/pull/call.mjs and rev6/push/budget.mjs all read it, so a
// model is priced in one place. A model not listed costs "unknown", never zero (costOf returns null).
export const PRICES = Object.freeze(JSON.parse(readFileSync(new URL('../rev6/pull/models.json', import.meta.url), 'utf8')).prices);
export const DEFAULT_MODEL = 'claude-opus-5';
// Prompt caching. Breakpoints go on the stable prefix (the last tool, the last system block) and roll along the
// messages, ephemeral, the API's default 5 minute TTL. TOPHAT_RUNNER_CACHE=0 turns the whole thing off without an edit.
// The API refuses more than 4 breakpoints in one request, and a prefix under the model's documented minimum is silently
// not cached (a wasted write), so a breakpoint is only placed once the prefix is plausibly over it. Minimums per
// docs.anthropic.com/en/docs/build-with-claude/prompt-caching; an unlisted model gets the largest documented minimum
// rather than an optimistic guess.
const CACHE_MAX_BREAKPOINTS = 4;
const CACHE_MIN_TOKENS = Object.freeze({ 'claude-opus-5-5': 512, 'claude-opus-5': 512, 'claude-fable-5': 512, 'claude-mythos-5': 512,
  'claude-opus-4-8': 1024, 'claude-sonnet-5': 1024, 'claude-sonnet-4-6': 1024, 'claude-sonnet-4-5': 1024,
  'claude-opus-4-7': 2048, 'claude-opus-4-6': 4096, 'claude-opus-4-5': 4096, 'claude-haiku-4-5': 4096 });
const CACHE_MIN_DEFAULT = 4096;
// The ceiling stays a ceiling; a caller may ask for less. timeoutMs 0 = no wall-clock abort on a
// completion. How many times a completion cut at the output ceiling is resumed before the caller is
// told.
const MAX_CONTINUATIONS = 4;
// Resuming a cut completion. The Messages API's own way is an assistant prefill: what arrived goes
// back as the last message and the model carries on from inside it. Some models refuse that outright
// -- claude-opus-5 answers `HTTP 400 invalid_request_error This model does not support assistant
// message prefill. The refusal is read off the 400, never off the model name, and the fallback keeps
// the conversation ending on a user turn: the part that arrived stays a complete assistant turn and a
// user turn asks for the rest and nothing else.
const PREFILL_REFUSED = /prefill|must end with a user message/i;
const CONTINUE_PROMPT = [
  'Your previous message hit the output limit and stopped mid-answer.',
  'Continue it from exactly where it stopped: reply with the remaining text only, beginning at the very next character.',
  'Do not repeat any part of what you already wrote, do not restate it, do not apologise, do not add a preamble or a code fence.',
  'Your previous message and this one, concatenated with nothing in between, must read as the one answer that was asked for;',
  'if that answer is a JSON object, this reply must close that same object.'
].join(' ');
// Models already measured answering a prefill with that 400. The runtime learning below still
// stands, and an unlisted model is assumed nothing about in either direction.
const PREFILL_REFUSED_BY = ['claude-opus-5'];
/** Models that answered an assistant prefill with a 400: the measured ones, plus what this process learns. */
const prefillRefusers = new Set(PREFILL_REFUSED_BY);
/** Distinct repairs already reported by this process; a repair is said once, not per request. */
const saidRepairs = new Set();
// The self-imposed ceiling on a request body is about text: a 4 MB transcript is a defect, not a conversation.
// Attached images are bytes the owner chose to send, so they are allowed on top of it, up to the provider's own
// documented body limit. Without this an owner message carrying photos died before the wire with "over the byte
// ceiling".
const PROVIDER_BODY_BYTES = 32 * 1024 * 1024;
const LIMITS = Object.freeze({ maxTokens: 16_000, maxTokensCeiling: 128_000, timeoutMs: 0, inputBytes: 4 * 1024 * 1024, retries: 1 });

function limits(env = process.env) {
  const n = (name, fallback) => { const v = Number(env[name]); return v > 0 ? v : fallback; };
  return {
    maxTokens: n('TOPHAT_RUNNER_MAX_TOKENS', LIMITS.maxTokens),
    maxTokensCeiling: LIMITS.maxTokensCeiling,
    timeoutMs: n('TOPHAT_RUNNER_TIMEOUT_MS', LIMITS.timeoutMs),
    inputBytes: LIMITS.inputBytes,
    retries: env.TOPHAT_RUNNER_RETRIES === undefined ? LIMITS.retries : Math.max(0, Number(env.TOPHAT_RUNNER_RETRIES) || 0)
  };
}

export function modelFor(requested, env = process.env) {
  return requested || env.TOPHAT_RUNNER_MODEL || DEFAULT_MODEL;
}

export function baseUrl(env = process.env) {
  return (env.TOPHAT_RUNNER_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
}

/** Which provider paths have a key file named and present; the files are never read here. */
export function providersAvailable(env = process.env) {
  const present = (name) => Boolean(env[name]) && existsSync(env[name]);
  // The gpt path has two credentials: the platform key file, and the ChatGPT subscription Codex
  // signed in with. Either one makes gpt models available here.
  return { anthropic: present('TOPHAT_RUNNER_API_KEY_FILE'), openai: Boolean(openaiAuthMode(env)) };
}

/** The spend in USD for a model with a known price, else null: unknown is not zero. TOPHAT_RUNNER_PRICES (JSON) may add models. */
export function costOf(model, usage = {}, env = process.env) {
  // A gpt turn on the ChatGPT subscription is metered by the plan, not per token: billing it at
  // the platform price table would put a few dollars a day of imaginary spend in the ledger.
  if (isOpenAIModel(model) && openaiAuthMode(env) === 'chatgpt') return 0;
  let table = PRICES;
  if (env.TOPHAT_RUNNER_PRICES) { try { table = { ...PRICES, ...JSON.parse(env.TOPHAT_RUNNER_PRICES) }; } catch {  } }
  const price = table[model];
  if (!price) return null;
  const cached = usage.cache_read_input_tokens || 0;
  const written = usage.cache_creation_input_tokens || 0;
  // Responses counts cached tokens inside input_tokens; the Messages API reports reads and writes beside it.
  const fresh = isOpenAIModel(model) ? Math.max(0, (usage.input_tokens || 0) - cached) : (usage.input_tokens || 0);
  // Every breakpoint this runner places is cacheTtl(env) long, and a one-hour write costs 2x base input, not the
  // 1.25x five-minute price in the table: priced at the table rate, recorded costs understated writes by 37%.
  // When the response said which TTL each write got (usage.cache_creation, or its flattened fields) that split is
  // priced: 1h at 2x base input, 5m at the table's cache_write. Otherwise every write is assumed this env's TTL.
  // Still an ESTIMATE for budgets; the bill is rev5/billing.mjs.
  const writeRate = cacheTtl(env) === '1h' ? price.input * 2 : (price.cache_write ?? price.input);
  const split = writeSplit(usage);
  const hasSplit = split.cache_creation_5m_input_tokens !== undefined || split.cache_creation_1h_input_tokens !== undefined;
  const w1h = split.cache_creation_1h_input_tokens || 0, w5m = split.cache_creation_5m_input_tokens || 0;
  const writes = hasSplit && w1h + w5m === written
    ? w1h * price.input * 2 + w5m * (price.cache_write ?? price.input)
    : written * writeRate;
  const spend = fresh * price.input + cached * (price.cached_input ?? price.input)
    + writes + (usage.output_tokens || 0) * price.output;
  return Math.round(spend / 1e6 * 1e6) / 1e6;
}

/** The key, read at request time; the caller never sees a path with a value in it. */
export function readKey(env = process.env) {
  const file = env.TOPHAT_RUNNER_API_KEY_FILE;
  if (!file) throw new ModelError('auth', 'TOPHAT_RUNNER_API_KEY_FILE is not set');
  let key = '';
  try { key = readFileSync(file, 'utf8').trim(); } catch (error) { throw new ModelError('auth', `key file unreadable (${error.code || 'error'})`); }
  if (!key) throw new ModelError('auth', 'key file is empty');
  return key;
}

// Who is calling, so the provider can bill each purpose to its own key. The keys are separate api_key_ids in
// the same org and workspace; the routing is only which FILE is read. A caller's key lives beside the
// default key file as `<default>-<caller>` (~/.config/tophat/secrets/anthropic-api-key-push,...); when that
// file is absent the default key answers, so a test env or a fresh machine never fails for want of a purpose
// key. What each key actually cost comes from the provider's own reports (rev5/billing.mjs), never from
// costOf below.
export const CALLERS = Object.freeze(['direct-chat', 'subagent-search', 'subagent-build', 'push', 'pipes']);
/** The caller a request bills to: the request's own, else TOPHAT_RUNNER_CALLER, else direct chat (the pull runner's turns). */
export function callerOf(caller, env = process.env) {
  const named = caller || env.TOPHAT_RUNNER_CALLER || 'direct-chat';
  return CALLERS.includes(named) ? named : 'direct-chat';
}
/** Which key file a caller reads, and whether it is its own; paths and booleans only, never key bytes. */
export function keyRoute(caller, env = process.env) {
  const base = env.TOPHAT_RUNNER_API_KEY_FILE;
  const who = callerOf(caller, env);
  const own = base ? `${base}-${who}` : null;
  let routed = false;
  if (own) { try { routed = readFileSync(own, 'utf8').trim().length > 0; } catch { routed = false; } }
  return { caller: who, file: routed ? own : base, routed };
}

/** Request headers with the credential, read now; a key not scoped to a workspace needs the workspace id beside it. */
export function authHeaders(env = process.env, caller = null) {
  const route = keyRoute(caller, env);
  const headers = { 'x-api-key': readKey(route.routed ? { ...env, TOPHAT_RUNNER_API_KEY_FILE: route.file } : env), 'anthropic-version': API_VERSION };
  const file = env.TOPHAT_RUNNER_WORKSPACE_ID_FILE;
  if (file) {
    try { const id = readFileSync(file, 'utf8').trim(); if (id) headers['anthropic-workspace-id'] = id; }
    catch (error) { throw new ModelError('auth', `workspace id file unreadable (${error.code || 'error'})`); }
  }
  return headers;
}

export class ModelError extends Error {
  constructor(reason, detail, { status = null, retryable = false } = {}) {
    super(`${reason}: ${detail}`);
    this.reason = reason; this.detail = detail; this.status = status; this.retryable = retryable;
  }
}

/** Never let a response body or header echo a credential into a log or a reply. */
export function sanitize(text, max = 400) {
  return cut(redactSecrets(String(text ?? '')).text.replace(/\s+/g, ' ').trim(), max);
}

function classifyStatus(status, body) {
  let type = '', message = '';
  try { const parsed = JSON.parse(body); type = parsed?.error?.type || ''; message = parsed?.error?.message || ''; } catch { message = body; }
  const detail = sanitize(`HTTP ${status} ${type} ${message}`);
  if (status === 401 || status === 403) return new ModelError('auth', detail, { status });
  if (status === 429) return new ModelError('rate_limited', detail, { status, retryable: true });
  if (status === 529 || status >= 500) return new ModelError('overloaded', detail, { status, retryable: true });
  return new ModelError('invalid', detail, { status });
}

/** Parse one SSE frame ("event: x\ndata: {...}") into its JSON payload, or null for a keepalive. */
export function parseFrame(frame) {
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

/** Fold stream events into the final message the non-streaming API would have returned.
 *
 * A tool call's arguments are kept as text when they do not parse, and a message the provider cut at the output
 * ceiling marks the call it was still writing. 209.88 USD of work and not one of the files written. A caller cannot
 * tell that from a genuine no-argument call unless this says so, which is why the marking happens here and not in
 * each run loop.
 */
export function createAssembler() {
  const message = { id: null, model: null, role: 'assistant', content: [], stop_reason: null, usage: {} };
  const partial = {};       // index -> that tool call's arguments as they accumulate
  const parsedWhole = new Set(); // indices whose arguments arrived complete and parsed
  const closed = new Set();      // indices already finished, so the end of the message does not redo them
  const closeArgs = (index, raw) => {
    const block = message.content[index];
    if (!block || block.type !== 'tool_use' || raw === undefined) return;
    closed.add(index);
    if (!raw) { block.input = block.input || {}; return; }
    try { block.input = JSON.parse(raw); parsedWhole.add(index); delete block.input_error; delete block.input_partial_json; }
    catch {
      // The partial text is kept rather than thrown away: it names the file the model was writing, which is the
      // difference between a parent that can reissue the call and one that only knows something went wrong.
      block.input = {};
      block.input_partial_json = raw;
      block.input_error = `the model sent ${raw.length} characters of arguments for this tool call that are not valid JSON, so it was not run`;
    }
  };
  // stop_reason lands after the blocks do, so the cut is only visible at the end of the message: anything still open
  // is parsed from whatever reached us, and on max_tokens every call whose arguments did not arrive whole is marked.
  const closeMessage = () => {
    for (const key of Object.keys(partial)) { const index = Number(key); if (!closed.has(index)) closeArgs(index, partial[index]); }
    if (message.stop_reason !== 'max_tokens') return;
    message.content.forEach((block, index) => {
      // An argument text that did not parse is reported as the ceiling cutting it, not as the model writing bad
      // JSON: on a max_tokens stop the cut is the cause, and that is what the next request has to act on.
      if (!block || block.type !== 'tool_use' || parsedWhole.has(index)) return;
      const raw = partial[index] || block.input_partial_json || '';
      block.input = {};
      if (raw) block.input_partial_json = raw;
      block.input_error = `the completion stopped at the output ceiling (max_tokens) with ${raw.length} characters of arguments written for this call, so it was never run`;
    });
  };
  // A stream can lose a content_block_start (a dropped frame, an interrupted and resumed stream, a provider that skips a
  // block type): the blocks after it keep their indices, so the array gets a hole, and every reader of message.content
  // (`part.type`) threw on it and ended the turn ("Cannot read properties of null"). Holes are closed when the message is.
  const sealHoles = () => { message.content = Array.from(message.content).filter(Boolean); };
  return {
    message,
    take(event) {
      switch (event?.type) {
        case 'message_start':
          Object.assign(message, { id: event.message?.id ?? null, model: event.message?.model ?? null, usage: { ...(event.message?.usage || {}) } });
          break;
        case 'content_block_start': {
          const block = { ...(event.content_block || {}) };
          if (block.type === 'tool_use') { partial[event.index] = ''; block.input = block.input ?? {}; }
          if (block.type === 'text') block.text = block.text || '';
          if (block.type === 'thinking') block.thinking = block.thinking || '';
          message.content[event.index] = block;
          break;
        }
        case 'content_block_delta': {
          const block = message.content[event.index];
          const delta = event.delta || {};
          if (!block) break;
          if (delta.type === 'text_delta') block.text += delta.text || '';
          else if (delta.type === 'thinking_delta') block.thinking += delta.thinking || '';
          else if (delta.type === 'signature_delta') block.signature = (block.signature || '') + (delta.signature || '');
          else if (delta.type === 'input_json_delta') partial[event.index] += delta.partial_json || '';
          break;
        }
        case 'content_block_stop': {
          const block = message.content[event.index];
          if (!block) break;
          // The Responses path hands the finished item here (final arguments, encrypted reasoning); the Messages API sends nothing.
          const { arguments: finalArgs, ...finished } = event.content_block || {};
          Object.assign(block, finished);
          closeArgs(event.index, finalArgs !== undefined ? finalArgs : partial[event.index]);
          break;
        }
        case 'message_delta':
          if (event.delta?.stop_reason) message.stop_reason = event.delta.stop_reason;
          if (event.usage) Object.assign(message.usage, event.usage);
          closeMessage();
          sealHoles();
          break;
        // A stream can end without content_block_stop for the block it was in the middle of; the buffer is read out
        // here too rather than dropped with the assembler.
        case 'message_stop':
          closeMessage();
          sealHoles();
          break;
        default: break;
      }
    }
  };
}

/**
 * One streaming Messages request. `request` is the API body minus `stream`;
 * `onEvent` sees every parsed stream event as it lands. Resolves to the
 * assembled message. Throws ModelError; never throws anything holding the key.
 */
export async function streamMessage(request, { signal, onEvent = () => {}, env = process.env, fetchImpl = fetch } = {}) {
  const lim = limits(env);
  const plan = planFor(request, env, lim);
  // Image bytes raise the ceiling by exactly what they are, never past the provider's own body limit.
  const ceiling = Math.min(PROVIDER_BODY_BYTES, lim.inputBytes + plan.imageBytes);
  if (Buffer.byteLength(plan.body) > ceiling) throw new ModelError('invalid', `request is ${Buffer.byteLength(plan.body)} bytes, over the ${ceiling} byte ceiling${plan.imageBytes ? ` (${lim.inputBytes} for the conversation plus ${plan.imageBytes} of attached image data)` : ''}`);
  const headers = plan.headers();
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    // A completion is never aborted on a clock; only the caller's signal ends it.
    const timer = lim.timeoutMs > 0 ? setTimeout(() => controller.abort(new ModelError('timeout', `no completion in ${lim.timeoutMs}ms`)), lim.timeoutMs) : null;
    timer?.unref?.();
    const onAbort = () => controller.abort(new ModelError('aborted', 'interrupted'));
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await attemptOnce({ plan, headers, controller, onEvent, fetchImpl });
    } catch (error) {
      const failure = error instanceof ModelError ? error
        : controller.signal.aborted && controller.signal.reason instanceof ModelError ? controller.signal.reason
          : new ModelError('failed', sanitize(error?.code || error?.name || error?.message || 'request failed'), { retryable: true });
      if (failure.retryable && attempt < lim.retries && !signal?.aborted) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw failure;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** The documented minimum cacheable prefix for a model id (a dated snapshot matches its family), in tokens. */
function minCacheTokens(model = '') {
  const key = Object.keys(CACHE_MIN_TOKENS).filter((name) => model.startsWith(name)).sort((a, b) => b.length - a.length)[0];
  return key ? CACHE_MIN_TOKENS[key] : CACHE_MIN_DEFAULT;
}

// Only ever used to refuse a prefix that is clearly too short to cache; ~4 characters per token is the conservative side of the API's tokenizer.
const approxTokens = (chars) => Math.floor(chars / 4);
/** How long a written breakpoint lives. A one-hour write costs twice base input instead of 1.25x on the NEW tokens
 * only, so it is paid once an hour and saves a full re-write every time he comes back to a chat. '5m' restores the
 * default, TOPHAT_RUNNER_CACHE=0 still turns caching off entirely.
 */
export const CACHE_TTLS = Object.freeze(['5m', '1h']);
export function cacheTtl(env = process.env) {
  const asked = env.TOPHAT_RUNNER_CACHE_TTL || '1h';
  return CACHE_TTLS.includes(asked) ? asked : '1h';
}
const marked = (block, ttl = '5m') => ({ ...block, cache_control: ttl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl } });

/**
 * Anthropic cache breakpoints on an already-built Messages body, at most CACHE_MAX_BREAKPOINTS of them:
 * the last tool and the last system block (the prefix that never changes), then a rolling one on the last
 * content block of each of the two most recent user messages -- the newer one writes this turn's grown
 * prefix while the older one still reads the prefix the last turn wrote. A section whose prefix is under
 * the model's minimum cacheable length is left alone: the API would drop the write silently.
 * Nothing is marked when TOPHAT_RUNNER_CACHE is "0"; the body comes back untouched (same shapes, no array
 * rewriting) whenever a breakpoint is not placed.
 */
export function withCacheControl(body, env = process.env, { tailSkip = 0, systemTail = '' } = {}) {
  // The request-specific end of the system prompt (a subagent's task description) goes AFTER the stable system
  // block's breakpoint, so every request with the same tools and stable system shares one cache entry.
  const withTail = (b) => {
    if (!systemTail) return b;
    const sys = typeof b.system === 'string' && b.system ? [{ type: 'text', text: b.system }] : Array.isArray(b.system) ? b.system.slice() : [];
    return { ...b, system: [...sys, { type: 'text', text: systemTail }] };
  };
  if (env.TOPHAT_RUNNER_CACHE === '0') return withTail(body);
  // Two tiers. The stable prefix (tools, stable system) is shared across requests and conversations, so it is
  // written for an hour; the rolling message breakpoints follow cacheTtl (5m for subagents, 1h for root chats).
  // The API requires every 1h breakpoint to precede every 5m one, which this order guarantees; a 1h message
  // tier forces a 1h prefix. TOPHAT_RUNNER_CACHE=prefix marks the stable prefix only and never a message: the
  // shape for one-shot batch bodies (push packets), whose unique content no later call can read.
  const ttl = cacheTtl(env);
  const prefixTtl = ttl === '1h' ? '1h' : (CACHE_TTLS.includes(env.TOPHAT_RUNNER_CACHE_PREFIX_TTL) ? env.TOPHAT_RUNNER_CACHE_PREFIX_TTL : '1h');
  const prefixOnly = env.TOPHAT_RUNNER_CACHE === 'prefix';
  const min = minCacheTokens(body.model || '');
  const out = { ...body };
  let left = CACHE_MAX_BREAKPOINTS;
  let chars = 0;
  const place = (size) => { chars += size; if (left > 0 && approxTokens(chars) >= min) { left -= 1; return true; } return false; };

  if (Array.isArray(out.tools) && out.tools.length && place(JSON.stringify(out.tools).length)) {
    out.tools = out.tools.map((tool, i) => (i === out.tools.length - 1 ? marked(tool, prefixTtl) : tool));
  }
  const system = typeof out.system === 'string' && out.system ? [{ type: 'text', text: out.system }]
    : Array.isArray(out.system) && out.system.length ? out.system.slice() : null;
  if (system && place(JSON.stringify(system).length)) {
    system[system.length - 1] = marked(system[system.length - 1], prefixTtl);
    out.system = system;
  }
  if (systemTail) {
    const sys = Array.isArray(out.system) ? out.system : typeof out.system === 'string' && out.system ? [{ type: 'text', text: out.system }] : [];
    out.system = [...sys, { type: 'text', text: systemTail }];
    chars += systemTail.length;
  }
  if (prefixOnly) return out;

  const messages = Array.isArray(out.messages) ? out.messages : [];
  const sizes = messages.map((m) => JSON.stringify(m ?? null).length);
  const users = messages.map((m, i) => (m?.role === 'user' ? i : -1)).filter((i) => i >= 0).slice(-2);
  let next = [...messages];
  let touched = false;
  // Trailing blocks of the newest user message that are true of this request only (rev5/pull.mjs liveContext: the
  // clock, the source refs, what is still running). They must stay BEHIND the breakpoint, or every request would
  // write a prefix no later request can match, which is the whole defect this guards against.
  const newest = messages.length ? messages.length - 1 : -1;
  for (const at of users) {
    const before = sizes.slice(0, at + 1).reduce((a, b) => a + b, 0);
    // Each breakpoint is judged on the whole prefix ahead of it, not on this message alone.
    if (left <= 0 || approxTokens(chars + before) < min) continue;
    const message = next[at];
    const content = message.content;
    const skip = at === newest ? tailSkip : 0;
    if (typeof content === 'string' && content) { if (skip) continue; next[at] = { ...message, content: [marked({ type: 'text', text: content }, ttl)] }; }
    else if (Array.isArray(content) && content.length > skip && content[content.length - 1 - skip] && typeof content[content.length - 1 - skip] === 'object') {
      const blocks = content.slice();
      blocks[blocks.length - 1 - skip] = marked(blocks[blocks.length - 1 - skip], ttl);
      next[at] = { ...message, content: blocks };
    } else continue;
    left -= 1;
    touched = true;
  }
  if (touched) out.messages = next;
  return out;
}

/**
 * One request plan per provider: where it goes, how it authenticates, the wire body, how HTTP failures read,
 * and a mapper from its stream events to Messages-API stream events. The runner, the ledger and the webchat
 * only ever see the Messages shape; a gpt model is chosen by name (rev5/openai.mjs) and needs its own key file.
 */
function planFor(fullRequest, env, lim) {
  // Never reaches either provider's wire: it says how many trailing blocks of the last user message are
  // request-local (rev5/pull.mjs liveContext), so the Anthropic breakpoint is placed in front of them.
  // `caller` never reaches the wire either: it picks which purpose key authenticates (keyRoute above).
  // `system_tail` is the request-specific end of the system prompt, placed behind the stable prefix's breakpoint.
  const { cache_tail_skip: tailSkip = 0, caller, system_tail: systemTail = '', ...stableRequest } = fullRequest;
  const request = stableRequest;
  const model = modelFor(request.model, env);
  // The ledger carries a reference per attached image (rev5/vision.mjs), never the base64; the bytes are read
  // here, on the way to the wire, so replay, compaction and the push hand-off stay cheap and a file deleted in
  // the meantime degrades to a sentence instead of a 400.
  const hydrated = { ...request, messages: hydrateImageBlocks(request.messages, { env }) };
  const imageBytes = imageBytesIn(hydrated.messages);
  if (isOpenAIModel(model)) {
    const { request: mended } = repairRequest({ ...hydrated, model, ...(systemTail ? { system: [hydrated.system, systemTail].filter(Boolean).join('\n') } : {}) });
    const body = toWireJSON(toResponsesRequest(mended, { omitMaxOutput: openaiAuthMode(env) === 'chatgpt' }));
    return { url: openaiRequestUrl(env), headers: () => openaiHeaders(env), body, imageBytes, classify: classifyOpenAIStatus, mapper: createEventMapper() };
  }
  const { reasoning_effort, metadata, ...restRequest } = hydrated;
  // Effort goes out as output_config.effort on the 5.x models; Haiku 4.5 and older refuse the field, so they get none.
  // `ultra` is the picker's top rung and has no Messages equivalent, so it is sent as max.
  const wireEffort = reasoning_effort === 'ultra' ? 'max' : reasoning_effort;
  const takesEffort = /^claude-(opus|sonnet|haiku|fable)-5/.test(model) && ['low', 'medium', 'high', 'xhigh', 'max'].includes(wireEffort);
  const rest = takesEffort ? { ...restRequest, output_config: { ...(restRequest.output_config || {}), effort: wireEffort } } : restRequest;
  // Blocks the other provider owns go first, then the structure is repaired, so a message this
  // filter emptied and a call whose result it removed are both mended rather than sent as a 400.
  const filtered = (rest.messages || []).map((m) => (Array.isArray(m.content)
    ? { ...m, content: m.content.filter((b) => ANTHROPIC_BLOCKS.has(b?.type)).map(({ native, ...b }) => b) } : m));
  const { messages, notes } = repairMessages(filtered);
  // A repair that keeps happening is a defect upstream, so each distinct one is said once per
  // process: silent mending would hide the next class of this bug instead of ending it.
  for (const note of notes) if (!saidRepairs.has(note.replace(/\(.*\)/, ''))) {
    saidRepairs.add(note.replace(/\(.*\)/, ''));
    process.stderr.write(`[rev5 model] request repaired on the way out: ${note}\n`);
  }
  const body = toWireJSON(withCacheControl({ ...rest, messages, model, stream: true, max_tokens: Math.min(request.max_tokens || lim.maxTokens, lim.maxTokensCeiling) }, env, { tailSkip, systemTail }));
  const mapper = (event) => {
    if (event.type === 'error') throw new ModelError(event.error?.type === 'overloaded_error' ? 'overloaded' : 'failed',
      sanitize(`${event.error?.type || 'error'} ${event.error?.message || ''}`), { retryable: event.error?.type === 'overloaded_error' });
    return [event];
  };
  return { url: `${baseUrl(env)}/v1/messages`, headers: () => authHeaders(env, caller), body, imageBytes, classify: classifyStatus, mapper };
}

async function attemptOnce({ plan, headers, controller, onEvent, fetchImpl }) {
  const response = await fetchImpl(plan.url, {
    method: 'POST', signal: controller.signal, body: plan.body, headers: { 'content-type': 'application/json', ...headers }
  });
  if (!response.ok) throw plan.classify(response.status, cut(await response.text().catch(() => ''), 2000));
  const assembler = createAssembler();
  const decoder = new TextDecoder();
  let buffer = '', stopped = false;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      const raw = parseFrame(buffer.slice(0, at));
      buffer = buffer.slice(at + 2);
      if (!raw) continue;
      for (const event of plan.mapper(raw)) {
        assembler.take(event);
        onEvent(event);
        if (event.type === 'message_stop') stopped = true;
      }
    }
  }
  if (!stopped) throw new ModelError('failed', 'the stream ended before message_stop', { retryable: true });
  return assembler.message;
}

/** Tokens the API said it read and wrote; `null` fields mean the API did not say. */
export function usageOf(message) {
  const u = message?.usage || {};
  return { input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null,
    cache_read_input_tokens: u.cache_read_input_tokens ?? null, cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
    ...(u.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: u.reasoning_output_tokens } : {}),
    // The provider's own TTL split of the writes, flattened so additive counters carry it; costOf prices from it.
    ...writeSplit(u) };
}
function writeSplit(u = {}) {
  const c = u.cache_creation;
  if (c && typeof c === 'object') return { cache_creation_5m_input_tokens: c.ephemeral_5m_input_tokens || 0, cache_creation_1h_input_tokens: c.ephemeral_1h_input_tokens || 0 };
  const out = {};
  if (typeof u.cache_creation_5m_input_tokens === 'number') out.cache_creation_5m_input_tokens = u.cache_creation_5m_input_tokens;
  if (typeof u.cache_creation_1h_input_tokens === 'number') out.cache_creation_1h_input_tokens = u.cache_creation_1h_input_tokens;
  return out;
}

/**
 * One resumption of a completion cut at the output ceiling. Prefill is tried first, because a model
 * that accepts it carries on from inside the text with nothing to re-emit; a 400 that says prefill is
 * not supported is remembered for this model and the same resumption is asked again with the partial
 * answer as a finished assistant turn followed by a user turn. Either way nothing is returned half
 * written: a failure here throws and the caller reports the whole call as failed.
 */
async function resume(request, text, model, options, stream = streamMessage) {
  const ask = (prefill) => stream({ ...request, messages: prefill
    ? [...request.messages, { role: 'assistant', content: text }]
    : [...request.messages, { role: 'assistant', content: text }, { role: 'user', content: CONTINUE_PROMPT }] }, options);
  if (prefillRefusers.has(model)) return ask(false);
  try {
    return await ask(true);
  } catch (error) {
    if (!(error instanceof ModelError) || error.status !== 400 || !PREFILL_REFUSED.test(error.detail || '')) throw error;
    prefillRefusers.add(model);
    process.stderr.write(`[rev5 model] ${model} refuses an assistant prefill; resuming from a user turn instead\n`);
    return ask(false);
  }
}
// rev5/call.mjs continues a cut answer the same way, through its own (injectable) stream function.
export { resume, MAX_CONTINUATIONS };
export const MAX_TOKENS_CEILING = LIMITS.maxTokensCeiling;

/**
 * The page writer's shape: {system,user,input?,model?,schema?,max_tokens?} in,
 * {ok,text,model,usage,reason?,detail?,stop_reason,elapsed_ms} out. A schema
 * forces one tool call whose input is the structured answer, so `text` is the
 * JSON the API validated against it. A failure is a value, never a throw.
 */
export async function complete(input, options = {}) {
  const started = Date.now();
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid', detail: 'input must be a JSON object', elapsed_ms: 0 };
  const user = [input.user, input.input].filter((part) => typeof part === 'string' && part).join('\n\n');
  if (!user) return { ok: false, reason: 'invalid', detail: 'user text is required', elapsed_ms: 0 };
  const ceiling = Math.min(input.max_tokens || limits(options.env || process.env).maxTokens, LIMITS.maxTokensCeiling);
  // The bridge's callers are the memory push (no purpose: push.py, pages, bootstrap lanes) and one-shot
  // pipelines that name a purpose (nightly-understanding); an explicit `caller` wins over both.
  const request = { model: input.model, max_tokens: input.max_tokens, messages: [{ role: 'user', content: user }],
    caller: input.caller || (options.env || process.env).TOPHAT_RUNNER_CALLER || (input.purpose && input.purpose !== 'push' ? 'pipes' : 'push') };
  if (typeof input.system === 'string' && input.system) request.system = input.system;
  if (input.reasoning_effort) request.reasoning_effort = input.reasoning_effort;
  if (input.schema) {
    request.tools = [{ name: 'emit', description: 'Return the structured result.', input_schema: input.schema }];
    request.tool_choice = { type: 'tool', name: 'emit' };
  }
  const textOfMessage = (message) => message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('');
  const usage = {};
  const addUsage = (u = {}) => { for (const [k, v] of Object.entries({ ...u, ...writeSplit(u) })) if (typeof v === 'number') usage[k] = (usage[k] || 0) + v; };
  // Held outside the try because a failure part way through is still a failure that cost tokens, and
  // the caller is owed both the count and whatever text was already paid for.
  let continuations = 0;
  let budget = ceiling;
  let text = '';
  try {
    const model = modelFor(input.model, options.env);
    let message = await streamMessage(request, options);
    addUsage(message.usage);
    budget = ceiling;
    text = textOfMessage(message);
    // A cut answer with nothing to carry on from is not an answer at all: a structured call whose tool
    // input never closed, or a completion whose whole budget went before the first text block. Neither
    // can be resumed, so the whole thing is asked for again with the budget raised, which is the one
    // thing that can make it fit.
    if (message.stop_reason === 'max_tokens' && budget < LIMITS.maxTokensCeiling && (input.schema || !text.trim())) {
      continuations += 1;
      budget = LIMITS.maxTokensCeiling;
      message = await streamMessage({ ...request, max_tokens: budget }, options);
      addUsage(message.usage);
      text = textOfMessage(message);
    }
    // Prose that did arrive is resumed instead, from exactly where it stopped.
    while (!input.schema && message.stop_reason === 'max_tokens' && continuations < MAX_CONTINUATIONS && text.trim()) {
      continuations += 1;
      // The turn that arrived is already paid for. A resumption that fails leaves the answer
      // unfinished, which is what `truncated` means.
      try {
        message = await resume(request, text, model, options);
      } catch (error) {
        return { ok: false, reason: 'truncated', text, continuations,
          detail: `the answer was cut at ${budget} output tokens and the resumption failed: ${sanitize(error?.detail || error?.message || 'request failed')}`,
          model: modelFor(input.model, options.env), usage: usageOf({ usage }), stop_reason: 'max_tokens',
          status: error?.status ?? null, elapsed_ms: Date.now() - started };
      }
      addUsage(message.usage);
      const more = textOfMessage(message);
      if (!more) break;
      // A model told to carry on may instead start the whole answer again; that replaces what we hold,
      // it is never appended to it, so no answer is ever doubled back into the store.
      text = more.startsWith(text) ? more : text + more;
    }
    const elapsed_ms = Date.now() - started;
    const base = { model: message.model || model, usage: usageOf({ usage }), stop_reason: message.stop_reason, elapsed_ms,
      ...(continuations ? { continuations } : {}) };
    // So the next model in the ladder is asked once, and the refused call's tokens stay in the usage the caller is
    // billed for.
    if (message.stop_reason === 'refusal' && input.refusal_fallback !== false) {
      const next = fallbackChain(model, options.env || process.env)[0];
      if (next) {
        const again = await complete({ ...input, model: next, refusal_fallback: false }, options);
        const summed = { ...base.usage };
        for (const [k, v] of Object.entries(again.usage || {})) if (typeof v === 'number') summed[k] = (summed[k] || 0) + v;
        return { ...again, usage: summed, refused_by: model };
      }
    }
    if (message.stop_reason === 'refusal') return { ok: false, reason: 'refused', detail: 'the model declined', ...base };
    if (input.schema) {
      const call = message.content.find((block) => block?.type === 'tool_use');
      if (!call || call.input_error) {
        const detail = message.stop_reason === 'max_tokens'
          ? `the structured answer did not fit in ${LIMITS.maxTokensCeiling} output tokens; ask for fewer records at a time`
          : call?.input_error || 'no structured answer came back';
        return { ok: false, reason: message.stop_reason === 'max_tokens' ? 'truncated' : 'failed', detail, ...base };
      }
      return { ok: true, text: JSON.stringify(call.input), ...base };
    }
    if (message.stop_reason === 'max_tokens') return { ok: false, reason: 'truncated', detail: `still unfinished after ${continuations} continuation${continuations === 1 ? '' : 's'} at ${budget} output tokens each`, text, ...base };
    return { ok: true, text, ...base };
  } catch (error) {
    const reason = error instanceof ModelError ? error.reason : 'failed';
    return { ok: false, reason, detail: sanitize(error?.detail || error?.message || 'request failed'), status: error?.status ?? null,
      model: modelFor(input.model, options.env), elapsed_ms: Date.now() - started,
      ...(Object.keys(usage).length ? { usage: usageOf({ usage }) } : {}), ...(text ? { text, continuations } : {}) };
  }
}

/**
 * TOPHAT_RUNNER_TRACE_DIR, when set, gets one file per bridge call holding the exact request and result, so a
 * background push's packets can be inspected against the raw data afterwards. The directory is private state;
 * the file holds no credential because none ever enters `input` or `result`.
 */
function trace(input, result, env = process.env) {
  // Retrieved text in `input` can still carry a vault value: scrubbed and written 0600.
  writeTrace(env.TOPHAT_RUNNER_TRACE_DIR, input, result, { env, label: 'rev5 model' });
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { process.stdout.write(JSON.stringify({ ok: false, reason: 'invalid', detail: 'stdin was not JSON' }) + '\n'); process.exitCode = 1; return; }
  const result = await complete(input);
  trace(input, result);
  process.stdout.write(JSON.stringify(result) + '\n');
}

/** Node realpaths the main module while argv keeps the path given; through a symlinked directory the two differ and the bridge would print nothing. */
function invokedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (invokedDirectly()) await main();
