// The one model call: pricing, the fallback ladder, recovery steps, a USD cap and continuations.
// The agent loop uses the recovery steps around its own streamed requests; scripts and push use call().
import { readFileSync } from 'node:fs';
import { configFile } from '../base/paths.mjs';
import { MODELS, ModelError, isOpenAIModel, sanitize, streamMessage, usageOf, writeSplit, cacheTtl } from './wire.mjs';
import { describe, openaiAuthMode, providersAvailable, resolveCredentials } from './credentials.mjs';

// One import for every call() user: nightly-understanding, tophat-multiplayer, src/core/structured-call.
export { describe, resolveCredentials, anthropicHeaders as authHeaders } from './credentials.mjs';
export { baseUrl, sanitize } from './wire.mjs';
export const PRICES = MODELS.prices;
const CAPS = MODELS.caps;
export const ATTEMPTS_PER_MODEL = CAPS.attemptsPerModel, TRUNCATION_CAP = CAPS.truncations, MAX_CONTINUATIONS = CAPS.maxContinuations, DEFAULT_MAX_USD = CAPS.maxUsd;
const isOpenAI = (model = '') => new RegExp(MODELS.openaiModel).test(model);
const round = (usd) => Math.round(usd * 1e6) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readConfig(env = process.env) {
  try { return JSON.parse(readFileSync(env.TOPHAT_CONFIG || configFile({ ...env, TOPHAT_CONFIG: undefined }), 'utf8')); } catch { return {}; }
}

/** A named model, else TOPHAT_RUNNER_MODEL, else the config's purposeModels[purpose], else the default. */
export function chooseModel({ model, purpose } = {}, env = process.env, config = null) {
  if (model) return model;
  if (env.TOPHAT_RUNNER_MODEL) return env.TOPHAT_RUNNER_MODEL;
  const table = (config || readConfig(env))?.rev5?.purposeModels;
  return purpose && typeof table?.[purpose] === 'string' && table[purpose] ? table[purpose] : MODELS.default;
}

function priceTable(env) {
  if (!env.TOPHAT_RUNNER_PRICES) return MODELS.prices;
  try { return { ...MODELS.prices, ...JSON.parse(env.TOPHAT_RUNNER_PRICES) }; } catch { return MODELS.prices; }
}

/** USD for a usage record, from models.json prices (TOPHAT_RUNNER_PRICES overrides); null when unpriced. */
export function costOf(model, usage = {}, env = process.env) {
  if (isOpenAIModel(model) && openaiAuthMode(env) === 'chatgpt') return 0;
  const price = priceTable(env)[model];
  if (!price) return null;
  const cached = usage.cache_read_input_tokens || 0, written = usage.cache_creation_input_tokens || 0;
  const fresh = isOpenAIModel(model) ? Math.max(0, (usage.input_tokens || 0) - cached) : (usage.input_tokens || 0);
  const split = writeSplit(usage), w1h = split.cache_creation_1h_input_tokens || 0, w5m = split.cache_creation_5m_input_tokens || 0;
  const hasSplit = split.cache_creation_5m_input_tokens !== undefined || split.cache_creation_1h_input_tokens !== undefined;
  const writes = hasSplit && w1h + w5m === written ? w1h * price.input * 2 + w5m * (price.cache_write ?? price.input)
    : written * (cacheTtl(env) === '1h' ? price.input * 2 : (price.cache_write ?? price.input));
  const spend = fresh * price.input + cached * (price.cached_input ?? price.input) + writes + (usage.output_tokens || 0) * price.output;
  return Math.round(spend / 1e6 * 1e6) / 1e6;
}

/** The models to fall back to after `current`, keyed here: TOPHAT_RUNNER_FALLBACK_MODELS, else the models.json ladder. */
export function fallbackChain(current, env = process.env) {
  const listed = String(env.TOPHAT_RUNNER_FALLBACK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const keyed = providersAvailable(env), seen = new Set([current]);
  return (listed.length ? listed : [...MODELS.ladder.anthropic, ...MODELS.ladder.openai])
    .filter((m) => (seen.has(m) ? false : (seen.add(m), isOpenAI(m) ? keyed.openai : keyed.anthropic)));
}

export const cycleWait = (cycles = 0) => CAPS.cycleWaitMs[Math.min(Math.max(0, cycles), CAPS.cycleWaitMs.length - 1)];
export const isContentFilter = (detail = '') => /content.?filter|blocked by|safety|output blocked/i.test(detail);
export const isRequestShape = (reason, detail = '') => reason === 'invalid' && !isContentFilter(detail)
  && /not valid JSON|surrogate|tool_use|tool_result|content block|must be non-empty|roles must alternate|messages(\.\d|:)/i.test(detail);
export const needsCompaction = (detail = '') => /byte ceiling|prompt is too long|too many tokens|context.{0,24}(length|window)|maximum context/i.test(detail);
export const contextWindowOf = (model = '') => (isOpenAI(model) ? MODELS.contextWindow.openai : MODELS.contextWindow.anthropic);
export const largerWindowModel = (current, chain = []) => chain.find((m) => contextWindowOf(m) > contextWindowOf(current)) || null;
export function tokensIn(detail = '') { const m = /(\d[\d,]{2,})\s*tokens/i.exec(String(detail)); return m ? Number(m[1].replace(/,/g, '')) : null; }

export function nudgeText({ reason, detail, attempt, model, switching = null }) {
  const advice = isContentFilter(detail)
    ? 'The provider blocked the output itself, so repeating it verbatim will fail again: do the same work in different words, quote less of any source material, and keep going.'
    : ['auth', 'rate_limited', 'overloaded'].includes(reason) ? 'This was the provider rather than anything you wrote: continue exactly where you were.'
      : 'Continue from where you were; if one tool result or one long quotation looks like the cause, work around it rather than repeating it.';
  const where = switching ? ` This attempt runs on ${switching} instead of ${model}.` : ` Attempt ${attempt + 1} of ${ATTEMPTS_PER_MODEL} on ${model}.`;
  return `The previous completion did not come back: ${reason}: ${detail}. Nothing of it reached the owner, and the task is unchanged. ${advice}${where}`;
}

export function truncationNudge(pendingToolNames = []) {
  const head = 'Your last message was cut off at the output ceiling before you finished it. Continue from exactly where it stopped; do not restart the message or repeat what you already said.';
  const names = [...new Set(pendingToolNames)];
  if (!names.length) return head;
  return `${head} The cut landed in the middle of the arguments of your ${names.join(' and ')} call, so that call was NOT run and nothing it would have done has happened.`
    + ' Make it again in smaller pieces: a first call carrying the opening part, then further calls appending the rest. One tool call\'s arguments are bounded by the same output ceiling as the rest of the message.';
}
export const truncatedCallResult = (call) => ({ type: 'tool_result', tool_use_id: call.id, is_error: true,
  content: call.input_error || 'this tool call was cut off at the output ceiling before its arguments were complete, so it was not run; make it again in smaller pieces' });

/** An HTTP 4xx that no retry can heal: every client error except 408 (timeout), 409 (conflict) and 429 (rate limit). */
export function isClientError(error) {
  const status = Number(error?.status) || 0;
  return status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

/** The next move after a failed request: stop, compact, retry, switch to the next model, or start the ladder again. */
export function recoveryStep({ error, attempts = 0, model, chain = [], canCompact = false, cycles = 0, env = process.env, shapeFloored = false }) {
  const reason = error?.reason || 'failed', detail = error?.detail || error?.message || 'no detail';
  if (reason === 'aborted') return { action: 'stop', reason, detail, terminal: 'wanted' };
  const shape = isRequestShape(reason, detail);
  // A 4xx answer other than 408, 409 and 429 is the provider refusing the request as sent (a missing header, a bad
  // field, a key it will not take): the same request fails again on every attempt and every wait. A request refused
  // for its size or shape may be compacted once; anything else stops the turn and names the refusal.
  if (isClientError(error) && !(canCompact && (needsCompaction(detail) || shape))) return { action: 'stop', reason, detail, terminal: 'client_error' };
  if (canCompact && (needsCompaction(detail) || shape)) {
    return { action: 'compact', model, waitMs: 0, reason, detail, nudge: shape
      ? `The last request was refused for its shape, not its size (${detail}). The conversation was compacted and the task is unchanged; continue from where you were.`
      : `The last request was refused for its size (${detail}). The conversation was compacted and the task is unchanged; continue from where you were.` };
  }
  if (shape && !shapeFloored) {
    const step = recoveryStep({ error, attempts, model, chain, canCompact: false, cycles, env, shapeFloored: true });
    return step.action === 'stop' ? step : { ...step, waitMs: Math.max(step.waitMs || 0, cycleWait(cycles)) };
  }
  if (attempts + 1 < ATTEMPTS_PER_MODEL) return { action: 'retry', model, waitMs: Math.min(8000, 1000 * (attempts + 1)), nudge: nudgeText({ reason, detail, attempt: attempts + 1, model }), reason, detail };
  if (chain[0]) return { action: 'switch', model: chain[0], waitMs: 0, nudge: nudgeText({ reason, detail, attempt: attempts, model, switching: chain[0] }), reason, detail };
  const refill = fallbackChain(model, env), keyed = providersAvailable(env);
  if (reason === 'auth' && !refill.length && !keyed.anthropic && !keyed.openai) {
    return { action: 'stop', reason, detail: `${detail}; no model on this machine has a key file, so nothing can run until that is fixed`, terminal: 'needs_owner' };
  }
  const waitMs = cycleWait(cycles), to = refill[0] || model;
  return { action: 'cycle', model: to, chain: refill.slice(1), waitMs, reason, detail,
    nudge: `${nudgeText({ reason, detail, attempt: attempts, model, switching: to })} Every model in the chain has failed this turn, so this waits ${Math.round(waitMs / 1000)}s and starts the chain again; the task is unchanged and nothing is lost.` };
}

export function applyStep(state, step) {
  const { model, attempts = 0, chain = [], cycles = 0, compacted = false } = state;
  if (step.action === 'stop') return { ...state, stopped: true, terminal: step.terminal || 'stop' };
  if (step.action === 'compact') return { model, attempts, chain, cycles, compacted: true, stopped: false };
  if (step.action === 'cycle') return { model: step.model, attempts: 0, chain: step.chain || [], cycles: cycles + 1, compacted: false, stopped: false };
  if (step.action === 'switch') return { model: step.model, attempts: 0, chain: chain.filter((n) => n !== step.model), cycles, compacted, stopped: false };
  return { model, attempts: attempts + 1, chain, cycles, compacted, stopped: false };
}

const CONTINUE_PROMPT = 'Your previous message hit the output limit and stopped mid-answer. Continue it from exactly where it stopped: reply with the remaining text only, beginning at the very next character. Do not repeat any part of what you already wrote, do not restate it, do not apologise, do not add a preamble or a code fence. Your previous message and this one, concatenated with nothing in between, must read as the one answer that was asked for; if that answer is a JSON object, this reply must close that same object.';
const prefillRefusers = new Set(MODELS.prefillRefusers);
/** Ask for the rest of a cut answer: an assistant prefill, or a user turn on models that refuse prefill. */
export async function resume(request, text, model, options, stream = streamMessage) {
  const ask = (prefill) => stream({ ...request, messages: prefill ? [...request.messages, { role: 'assistant', content: text }]
    : [...request.messages, { role: 'assistant', content: text }, { role: 'user', content: CONTINUE_PROMPT }] }, options);
  if (prefillRefusers.has(model)) return ask(false);
  try { return await ask(true); } catch (error) {
    if (!(error instanceof ModelError) || error.status !== 400 || !/prefill|must end with a user message/i.test(error.detail || '')) throw error;
    prefillRefusers.add(model);
    return ask(false);
  }
}

function priced(model, env) { const p = priceTable(env)[model]; return Boolean(p) && Number.isFinite(p.input) && p.input >= 0 && Number.isFinite(p.output) && p.output >= 0; }
function reserveFor(model, bodyBytes, maxTokens, env, prefixBytes = 0) {
  if (!priced(model, env)) return null;
  const prefix = env.TOPHAT_RUNNER_CACHE === '0' ? 0 : Math.min(bodyBytes, prefixBytes);
  return costOf(model, { input_tokens: bodyBytes - prefix, cache_creation_input_tokens: prefix, cache_creation_1h_input_tokens: prefix, cache_creation_5m_input_tokens: 0, output_tokens: maxTokens }, env);
}
const textOfMessage = (m) => (m?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('');

/**
 * One answer for a prompt ({user} or {messages}, optional system, tools, schema), walking the ladder on failure and
 * refusing any request whose worst case would take the call past maxUsd. Never throws: {ok, text, model, usage,
 * cost_usd, attempts, switched, continuations, message} or {ok:false, reason, detail, tried, attempts}.
 */
export async function call(input = {}, options = {}) {
  const { env = process.env, maxUsd, maxCycles, onEvent = null, signal = null, streamImpl = streamMessage, resolved = null, eligible = null } = options;
  const allowed = (name) => !eligible || Boolean(eligible(name));
  const maxContinuations = Math.max(0, Number(options.maxContinuations ?? MAX_CONTINUATIONS) || 0);
  const emit = (event) => { try { onEvent?.(event); } catch { /* a logger never ends a call */ } };
  const tried = [];
  let attempts = 0;
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid', detail: 'input must be an object', tried, attempts };
  const hasMessages = Array.isArray(input.messages) && input.messages.length > 0;
  if (!hasMessages && !(typeof input.user === 'string' && input.user.trim())) return { ok: false, reason: 'invalid', detail: 'call needs either user text or a messages array', tried, attempts };
  const resolution = resolved || resolveCredentials(env);
  const useEnv = { ...resolution.env, TOPHAT_RUNNER_RETRIES: '0', TOPHAT_RUNNER_CACHE: env.TOPHAT_RUNNER_CACHE === '0' ? '0' : 'prefix' };
  if (!resolution.anthropic && !resolution.openai) return { ok: false, reason: 'auth', attempts, tried, detail: `no model on this machine has a usable credential, so nothing can run until that is fixed.\n${describe(resolution)}` };

  let model = chooseModel(input, useEnv, readConfig(env));
  let chain = fallbackChain(model, useEnv).filter((n) => priced(n, useEnv) && allowed(n));
  const keyedHere = (name) => (isOpenAI(name) ? resolution.openai : resolution.anthropic);
  if (!keyedHere(model) && chain.length) {
    emit({ type: 'switch', from: model, to: chain[0], reason: 'auth', detail: `no credential for ${model} on this machine` });
    tried.push({ model, reason: 'auth', detail: 'no credential for this provider on this machine' });
    model = chain.shift();
  }
  const cap = Number(maxUsd ?? env.TOPHAT_RUNNER_MAX_USD ?? DEFAULT_MAX_USD), cycleCap = Number(maxCycles ?? env.TOPHAT_RUNNER_MAX_CYCLES ?? Infinity);
  const maxTokens = input.max_tokens || 16_000, ceiling = MODELS.limits.maxTokensCeiling;
  if (!(Number.isFinite(cap) && cap > 0) || !(Number.isFinite(maxTokens) && maxTokens > 0)) return { ok: false, reason: 'cost', detail: 'maxUsd and max_tokens must be finite positive numbers', tried, attempts };
  const prefixBytes = Buffer.byteLength(JSON.stringify({ system: input.system || '', tools: input.tools || [], schema: input.schema || null }));
  const bodyBytes = Buffer.byteLength(JSON.stringify({ system: input.system || '', user: input.user || '', messages: input.messages || [], tools: input.tools || [], schema: input.schema || null })) + 2048;

  const switched = [], usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let spend = 0, modelAttempts = 0, cycles = 0;
  const charge = (u) => { for (const [k, v] of Object.entries({ ...(u || {}), ...writeSplit(u || {}) })) if (typeof v === 'number') usage[k] = (usage[k] || 0) + v; spend += costOf(model, u || {}, useEnv) || 0; };
  const affords = (i, o) => { const worst = costOf(model, { input_tokens: i, output_tokens: o }, useEnv); return worst !== null && spend + worst <= cap; };

  const attemptOnce = async () => {
    let text = '', continuations = 0;
    try {
      const request = { model, max_tokens: maxTokens, messages: hasMessages ? input.messages : [{ role: 'user', content: input.user }] };
      for (const f of ['system', 'tools', 'reasoning_effort', 'output_config', 'tool_choice']) if (input[f]) request[f] = input[f];
      request.caller = input.caller || useEnv.TOPHAT_RUNNER_CALLER || (input.purpose === 'push' ? 'push' : 'pipes');
      if (input.schema) { request.tools = [{ name: 'emit', description: 'Return the structured result.', input_schema: input.schema }]; request.tool_choice = { type: 'tool', name: 'emit' }; }
      const textOf = (m) => (input.schema ? (JSON.stringify(m.content.find((b) => b.type === 'tool_use')?.input) ?? '') : textOfMessage(m));
      let message = await streamImpl(request, { env: useEnv, signal });
      charge(message.usage);
      text = textOf(message);
      let answered = Number(message.usage?.output_tokens) || 0;
      const readIn = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((s, k) => s + (Number(message.usage?.[k]) || 0), 0) || bodyBytes;
      const cutShort = (detail) => ({ ok: false, reason: 'truncated', detail, continuations, stop_reason: 'max_tokens', ...(!input.schema && text ? { text } : {}) });
      if (message.stop_reason === 'max_tokens' && (input.schema || !text.trim()) && maxTokens < ceiling && continuations < maxContinuations) {
        if (!affords(readIn, ceiling)) return cutShort(`the answer was cut at ${maxTokens} output tokens with nothing to resume, and asking again at ${ceiling} would go over the ${cap} USD ceiling (${round(spend)} USD spent)`);
        continuations += 1;
        emit({ type: 'continue', from: model, to: model, reason: 'truncated', detail: `cut at ${maxTokens} output tokens with nothing to resume; asking again at ${ceiling}` });
        message = await streamImpl({ ...request, max_tokens: ceiling }, { env: useEnv, signal });
        charge(message.usage);
        answered += Number(message.usage?.output_tokens) || 0;
        text = textOf(message);
      }
      while (!input.schema && message.stop_reason === 'max_tokens' && text.trim() && continuations < maxContinuations) {
        if (!affords(readIn + answered + 256, maxTokens)) return cutShort(`the answer was cut after ${continuations} continuation${continuations === 1 ? '' : 's'}, and one more could cost over the ${cap} USD ceiling (${round(spend)} USD spent)`);
        continuations += 1;
        emit({ type: 'continue', from: model, to: model, reason: 'truncated', detail: `continuation ${continuations} of at most ${maxContinuations}` });
        try { message = await resume(request, text, model, { env: useEnv, signal }, streamImpl); } catch (error) {
          return cutShort(`the answer was cut and resumption ${continuations} failed: ${sanitize(error?.detail || error?.message || 'request failed')}`);
        }
        charge(message.usage);
        answered += Number(message.usage?.output_tokens) || 0;
        const more = textOfMessage(message);
        if (!more) break;
        text = more.startsWith(text) ? more : text + more;
      }
      if (message.stop_reason === 'max_tokens') return cutShort(continuations ? `still unfinished after ${continuations} continuation${continuations === 1 ? '' : 's'}` : 'completion reached its output ceiling; no complete answer');
      if (message.stop_reason === 'refusal') return { ok: false, reason: 'refused', detail: 'the model declined' };
      return { ok: true, text, message, stop_reason: message.stop_reason, continuations };
    } catch (error) {
      if (continuations && text && !input.schema) return { ok: false, reason: 'truncated', continuations, text, detail: `the answer was cut and its continuation failed: ${sanitize(error.detail || error.message || 'request failed')}` };
      return { ok: false, reason: error.reason || 'failed', detail: error.detail || error.message || 'request failed' };
    }
  };

  for (;;) {
    if (signal?.aborted) return { ok: false, reason: 'aborted', detail: 'interrupted', tried, attempts };
    if (!allowed(model)) {
      const detail = `${model} is not eligible for this call (the caller's own test, e.g. a context window that holds the prompt)`;
      tried.push({ model, reason: 'ineligible', detail });
      return { ok: false, reason: 'ineligible', detail, tried, attempts, cost_usd: round(spend) };
    }
    const reserve = reserveFor(model, bodyBytes, maxTokens, useEnv, prefixBytes);
    if (reserve === null) {
      const detail = `${model} has no entry in the price table (rev6/pull/models.json), so a call to it cannot be bounded by maxUsd`;
      tried.push({ model, reason: 'unpriced', detail });
      return { ok: false, reason: 'unpriced', detail, tried, attempts };
    }
    if (spend + reserve > cap) {
      const detail = `this request could cost up to ${round(reserve)} USD on ${model} and ${round(spend)} USD is already spent, over the ${cap} USD ceiling for this call`;
      tried.push({ model, reason: 'cost', detail });
      return { ok: false, reason: 'cost', detail, tried, attempts, cost_usd: round(spend) };
    }
    attempts += 1;
    const result = await attemptOnce();
    if (result.ok) {
      return { ok: true, text: result.text, model, usage: usageOf({ usage }), cost_usd: round(spend), attempts, switched, continuations: result.continuations || 0,
        ...(result.message ? { message: result.message } : {}), ...(result.stop_reason ? { stop_reason: result.stop_reason } : {}) };
    }
    tried.push({ model, reason: result.reason, detail: result.detail });
    if (result.reason === 'truncated') return { ok: false, reason: result.reason, detail: result.detail, tried, attempts, cost_usd: round(spend), model, switched,
      usage: usageOf({ usage }), continuations: result.continuations || 0, stop_reason: 'max_tokens', ...(result.text ? { text: result.text } : {}) };
    if (result.reason === 'aborted') return { ok: false, reason: 'aborted', detail: result.detail, tried, attempts, cost_usd: round(spend) };
    if (result.reason === 'refused') {
      if (!chain[0]) return { ok: false, reason: 'refused', detail: result.detail, tried, attempts, cost_usd: round(spend), model, usage: usageOf({ usage }) };
      emit({ type: 'switch', from: model, to: chain[0], reason: 'refused', detail: result.detail });
      switched.push({ from: model, to: chain[0], reason: 'refused' });
      model = chain.shift(); modelAttempts = 0;
      continue;
    }
    if (needsCompaction(result.detail)) {
      const bigger = largerWindowModel(model, chain);
      if (!bigger) return { ok: false, reason: 'too_long', tried, attempts, cost_usd: round(spend), tokens: tokensIn(result.detail),
        detail: `${result.detail}; no model left in the chain has a larger context window than ${model}, so this prompt has to be made smaller` };
      emit({ type: 'switch', from: model, to: bigger, reason: 'too_long', detail: result.detail });
      switched.push({ from: model, to: bigger, reason: 'too_long' });
      model = bigger; chain = chain.filter((n) => n !== bigger); modelAttempts = 0;
      continue;
    }
    const step = recoveryStep({ error: result, attempts: result.reason === 'auth' ? ATTEMPTS_PER_MODEL - 1 : modelAttempts, model, chain, canCompact: false, cycles, env: useEnv });
    if (step.action === 'stop') return { ok: false, reason: step.reason, detail: step.reason === 'auth' ? `${step.detail}\n${describe(resolution)}` : step.detail, tried, attempts, cost_usd: round(spend) };
    const from = model;
    ({ model, attempts: modelAttempts, chain, cycles } = applyStep({ model, attempts: modelAttempts, chain, cycles, compacted: false }, step));
    chain = chain.filter((n) => priced(n, useEnv) && allowed(n));
    while ((!priced(model, useEnv) || !allowed(model)) && chain.length) model = chain.shift();
    if (step.action === 'cycle' && cycles > cycleCap) return { ok: false, reason: step.reason, tried, attempts, cost_usd: round(spend), detail: `${step.detail}; every keyed model failed and the chain has been walked ${cycles} time${cycles === 1 ? '' : 's'}` };
    if (model !== from) switched.push({ from, to: model, reason: step.reason });
    emit({ type: model === from ? 'retry' : 'switch', from, to: model, reason: step.reason, detail: step.detail });
    if (step.waitMs) { emit({ type: 'wait', from, to: model, reason: step.reason, detail: `waiting ${step.waitMs}ms before the next attempt` }); await (options.sleepImpl || sleep)(step.waitMs); }
  }
}

/** call() for callers that want a message or a thrown ModelError (src/core/structured-call.mjs). */
export async function callMessage(request, options = {}) {
  const { model, max_tokens, system, messages, tools, reasoning_effort, purpose } = request || {};
  const result = await call({ model, max_tokens, system, messages, tools, reasoning_effort, purpose }, options);
  if (result.ok) return result.message;
  throw Object.assign(new ModelError(result.reason, result.detail), { tried: result.tried });
}
