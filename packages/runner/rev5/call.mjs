// The one model call path for everything in this repo that is not the streaming conversation turn.
//
// usage limits).
//
// The auto-switching ladder already existed and was walked by exactly one caller, rev5/pull.mjs.
// Every other caller invented its own failure handling or had none, so a nightly job could lose
// two nights of thinking to one unset variable and report a benign GAP. This file is that ladder
// for a one-shot completion: credentials resolved through rev5/model-credentials.mjs so no caller
// depends on a variable being set, the policy decisions taken by rev5/resilience.mjs so the rungs
// are the ones pull.mjs climbs, and a cost bound in front of every request.
//
//   import { call } from './call.mjs';
//   const r = await call({ system, user, messages, model, max_tokens, purpose }, { env, maxUsd, onEvent });
//   // ok:    { ok: true, text, model, usage, cost_usd, attempts, switched: [...], continuations }
//   // not:   { ok: false, reason, detail, tried: [{ model, reason, detail }], attempts }
//   // cut:   { ok: false, reason: 'truncated', text, continuations, model, usage, cost_usd, ... }
//
// A completion cut at its output ceiling is continued the way rev5/model.mjs complete() does it
// (up to MAX_CONTINUATIONS resumptions, or one re-ask at the ceiling when nothing resumable arrived),
// and every one of those requests is priced against maxUsd before it goes out. What still does not
// finish comes back as `truncated` WITH the text that was paid for, never as nothing.
//
// A failure is a value, never a throw, and nothing fails silently: onEvent sees every switch,
// retry and wait as it happens.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, MAX_CONTINUATIONS, MAX_TOKENS_CEILING, PRICES, ModelError, costOf, resume, sanitize, streamMessage, usageOf } from './model.mjs';
import {
  ATTEMPTS_PER_MODEL, applyStep, fallbackChain, largerWindowModel, needsCompaction, recoveryStep, tokensIn
} from './resilience.mjs';
import { describe, resolveCredentials } from './model-credentials.mjs';

export { describe, resolveCredentials } from './model-credentials.mjs';

/**
 * The default spend ceiling for ONE call, in USD. Deliberately small: a batch job that wants to
 * spend more says so in its own maxUsd, which is a decision someone made rather than a default
 * nobody read. TOPHAT_RUNNER_MAX_USD moves it for a whole process.
 */
export const DEFAULT_MAX_USD = 2;

// The live ladder cycles until interrupted. Tests or bounded batch callers may explicitly cap it.
export const DEFAULT_MAX_CYCLES = Infinity;
// One token per UTF-8 byte overestimates text tokenization; caching is disabled for a bounded call.
const RESERVE_BYTES_PER_TOKEN = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (usd) => Math.round(usd * 1e6) / 1e6;

export function readConfig(env = process.env) {
  const file = env.TOPHAT_CONFIG || join(env.HOME || homedir(), '.config', 'tophat', 'config.json');
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Which model this call runs on.
 *
 * explicit argument > TOPHAT_RUNNER_MODEL > rev5.purposeModels[purpose] in config.json > DEFAULT_MODEL.
 *
 * `rev5.model` in config.json is NOT read here, on purpose. That key is the WEBCHAT CHAT default and
 * nothing else. A batch caller that genuinely wants to follow the chat default sets TOPHAT_RUNNER_MODEL
 * or passes the model in, both of which are visible at the call site. Per-purpose overrides live under
 * rev5.purposeModels, e.g. {"rev5":{"purposeModels":{"nightly-understanding":"gpt-6-astra"}}}.
 */
export function modelFor({ model, purpose } = {}, env = process.env, config = null) {
  if (model) return model;
  if (env.TOPHAT_RUNNER_MODEL) return env.TOPHAT_RUNNER_MODEL;
  const table = (config || readConfig(env))?.rev5?.purposeModels;
  if (purpose && table && typeof table[purpose] === 'string' && table[purpose]) return table[purpose];
  return DEFAULT_MODEL;
}

/** What this request could cost at worst on this model, or null when the model has no price at all. */
function priced(model, env) {
  let table = PRICES;
  try { table = { ...table, ...JSON.parse(env.TOPHAT_RUNNER_PRICES || '{}') }; } catch { /* defaults */ }
  const p = table[model];
  return p && Number.isFinite(p.input) && p.input >= 0 && Number.isFinite(p.output) && p.output >= 0;
}
function reserveFor(model, bodyBytes, maxTokens, env) {
  if (!priced(model, env)) return null;
  return costOf(model, {
    input_tokens: Math.ceil(bodyBytes / RESERVE_BYTES_PER_TOKEN),
    output_tokens: maxTokens
  }, env);
}

const textOfMessage = (message) => (message?.content || [])
  .filter((block) => block?.type === 'text').map((block) => block.text).join('');

/**
 * One completion with the ladder in front of it.
 *
 * `input`: { system, user, messages, model, max_tokens, purpose, schema, reasoning_effort, tools }.
 * Give `user` for a plain prompt or `messages` for a built conversation. A cut output is continued
 * within maxUsd (see the top of this file); `maxContinuations: 0` turns that off for one call.
 *
 * `options`: { env, maxUsd, maxCycles, maxContinuations, eligible, onEvent, signal, streamImpl, resolved }.
 * `eligible(model)` narrows which models this call may run on beyond "keyed and priced": a caller
 * that sized its prompt for one context window passes the models whose window holds it, and an
 * ineligible model is skipped in the chain or, as the asked-for model, refused by name.
 */
export async function call(input = {}, options = {}) {
  const {
    env = process.env, maxUsd, maxCycles, onEvent = null, signal = null,
    streamImpl = streamMessage, resolved = null, eligible = null
  } = options;
  const allowed = (name) => !eligible || Boolean(eligible(name));
  const maxContinuations = Math.max(0, Number(options.maxContinuations ?? MAX_CONTINUATIONS) || 0);

  const emit = (event) => { if (onEvent) { try { onEvent(event); } catch { /* a logger must never end a call */ } } };
  const tried = [];
  let attempts = 0;

  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid', detail: 'input must be an object', tried, attempts };
  const hasMessages = Array.isArray(input.messages) && input.messages.length > 0;
  if (!hasMessages && !(typeof input.user === 'string' && input.user.trim())) {
    return { ok: false, reason: 'invalid', detail: 'call needs either user text or a messages array', tried, attempts };
  }

  // Credentials first, and from one place, so a process that inherited no variables still runs.
  const resolution = resolved || await resolveCredentials(env);
  const useEnv = { ...resolution.env, TOPHAT_RUNNER_RETRIES: '0', TOPHAT_RUNNER_CACHE: '0' };
  if (!resolution.anthropic && !resolution.openai) {
    // The one genuinely terminal failure, and it is loud: no model on this machine has a credential.
    return {
      ok: false, reason: 'auth', attempts, tried,
      detail: `no model on this machine has a usable credential, so nothing can run until that is fixed.\n${describe(resolution)}`
    };
  }

  const config = readConfig(env);
  let model = modelFor(input, useEnv, config);
  let chain = fallbackChain(model, useEnv).filter(name => priced(name, useEnv) && allowed(name));
  // The model asked for may itself be one the machine has no credential for; fallbackChain only
  // lists keyed models, so start on the first keyed one rather than burning three attempts on a
  // provider that is not here at all.
  const keyedHere = (name) => (/^(gpt|o\d)/.test(name) ? resolution.openai : resolution.anthropic);
  if (!keyedHere(model) && chain.length) {
    emit({ type: 'switch', from: model, to: chain[0], reason: 'auth', detail: `no credential for ${model} on this machine` });
    tried.push({ model, reason: 'auth', detail: 'no credential for this provider on this machine' });
    model = chain[0];
    chain = chain.slice(1);
  }

  const cap = Number(maxUsd ?? env.TOPHAT_RUNNER_MAX_USD ?? DEFAULT_MAX_USD);
  const cycleCap = Number(maxCycles ?? env.TOPHAT_RUNNER_MAX_CYCLES ?? DEFAULT_MAX_CYCLES);
  const maxTokens = input.max_tokens || 16_000;
  if (!(Number.isFinite(cap) && cap > 0) || !(Number.isFinite(maxTokens) && maxTokens > 0)) return { ok: false, reason: 'cost', detail: 'maxUsd and max_tokens must be finite positive numbers', tried, attempts };
  const bodyBytes = Buffer.byteLength(JSON.stringify({
    system: input.system || '', user: input.user || '', messages: input.messages || [], tools: input.tools || [], schema: input.schema || null
  })) + 2048;

  const switched = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const addUsage = (u = {}) => { for (const key of Object.keys(usage)) usage[key] += Number(u?.[key]) || 0; };
  let spend = 0, modelAttempts = 0, cycles = 0;
  // Tokens are charged as each response lands, so a call that fails part way still bills what it read.
  const charge = (u) => { addUsage(u); spend += costOf(model, u || {}, useEnv) || 0; };
  // Whether one more request on this model fits the ceiling, priced at its worst.
  const affords = (inputTokens, outputTokens) => {
    const worst = costOf(model, { input_tokens: inputTokens, output_tokens: outputTokens }, useEnv);
    return worst !== null && spend + worst <= cap;
  };

  const moveTo = (next, reason, detail) => {
    emit({ type: 'switch', from: model, to: next, reason, detail });
    switched.push({ from: model, to: next, reason });
    model = next;
    chain = chain.filter((name) => name !== next);
    modelAttempts = 0;
  };

  const attemptOnce = async () => {
    let text = '', continuations = 0;
    try {
      const request = { model, max_tokens: maxTokens,
        messages: hasMessages ? input.messages : [{ role: 'user', content: input.user }] };
      for (const field of ['system', 'tools', 'reasoning_effort', 'output_config', 'tool_choice']) if (input[field]) request[field] = input[field];
      if (input.schema) {
        request.tools = [{ name: 'emit', description: 'Return the structured result.', input_schema: input.schema }];
        request.tool_choice = { type: 'tool', name: 'emit' };
      }
      const textOf = (m) => (input.schema ? (JSON.stringify(m.content.find(b => b.type === 'tool_use')?.input) ?? '') : textOfMessage(m));
      let message = await streamImpl(request, { env: useEnv, signal });
      charge(message.usage);
      text = textOf(message);
      let answered = Number(message.usage?.output_tokens) || 0;
      // What a follow-up request re-reads: the provider's own count of the first one where it gave one.
      const reported = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
        .reduce((sum, key) => sum + (Number(message.usage?.[key]) || 0), 0);
      const readIn = reported || Math.ceil(bodyBytes / RESERVE_BYTES_PER_TOKEN);
      const cut = (detail) => ({ ok: false, reason: 'truncated', detail, continuations, stop_reason: 'max_tokens',
        ...(!input.schema && text ? { text } : {}) });

      // Nothing resumable arrived (a structured answer whose tool input never closed, or the whole budget
      // spent before the first text block): the one thing that can help is asking again at the ceiling.
      if (message.stop_reason === 'max_tokens' && (input.schema || !text.trim()) && maxTokens < MAX_TOKENS_CEILING && continuations < maxContinuations) {
        if (!affords(readIn, MAX_TOKENS_CEILING)) return cut(`the answer was cut at ${maxTokens} output tokens with nothing to resume, and asking again at ${MAX_TOKENS_CEILING} would go over the ${cap} USD ceiling (${round(spend)} USD spent)`);
        continuations += 1;
        emit({ type: 'continue', from: model, to: model, reason: 'truncated', detail: `cut at ${maxTokens} output tokens with nothing to resume; asking again at ${MAX_TOKENS_CEILING}` });
        message = await streamImpl({ ...request, max_tokens: MAX_TOKENS_CEILING }, { env: useEnv, signal });
        charge(message.usage);
        answered += Number(message.usage?.output_tokens) || 0;
        text = textOf(message);
      }
      // Prose that did arrive is resumed from exactly where it stopped, each resumption priced first.
      while (!input.schema && message.stop_reason === 'max_tokens' && text.trim() && continuations < maxContinuations) {
        const carried = readIn + answered + 256;
        if (!affords(carried, maxTokens)) return cut(`the answer was cut after ${continuations} continuation${continuations === 1 ? '' : 's'}, and one more could cost over the ${cap} USD ceiling (${round(spend)} USD spent)`);
        continuations += 1;
        emit({ type: 'continue', from: model, to: model, reason: 'truncated', detail: `continuation ${continuations} of at most ${maxContinuations}` });
        try {
          message = await resume(request, text, model, { env: useEnv, signal }, streamImpl);
        } catch (error) {
          return cut(`the answer was cut and resumption ${continuations} failed: ${sanitize(error?.detail || error?.message || 'request failed')}`);
        }
        charge(message.usage);
        answered += Number(message.usage?.output_tokens) || 0;
        const more = textOfMessage(message);
        if (!more) break;
        // A model told to carry on may start the whole answer again; that replaces, it is never appended.
        text = more.startsWith(text) ? more : text + more;
      }
      if (message.stop_reason === 'max_tokens') {
        return cut(continuations
          ? `still unfinished after ${continuations} continuation${continuations === 1 ? '' : 's'}`
          : 'completion reached its output ceiling; no complete answer');
      }
      return { ok: true, text, message, stop_reason: message.stop_reason, continuations };
    } catch (error) {
      // A failure after part of the answer was paid for keeps that part.
      if (continuations && text && !input.schema) return { ok: false, reason: 'truncated', continuations, text,
        detail: `the answer was cut and its continuation failed: ${sanitize(error.detail || error.message || 'request failed')}` };
      return { ok: false, reason: error.reason || 'failed', detail: error.detail || error.message || 'request failed' };
    }
  };

  for (;;) {
    if (signal?.aborted) return { ok: false, reason: 'aborted', detail: 'interrupted', tried, attempts };
    // Prices are not invented here, so the model is skipped and named; if nothing priced is left,
    // the call refuses.
    if (!allowed(model)) {
      const detail = `${model} is not eligible for this call (the caller's own test, e.g. a context window that holds the prompt)`;
      tried.push({ model, reason: 'ineligible', detail });
      return { ok: false, reason: 'ineligible', detail, tried, attempts, cost_usd: round(spend) };
    }
    const reserve = reserveFor(model, bodyBytes, maxTokens, useEnv);
    if (reserve === null) {
      const detail = `${model} has no entry in PRICES (rev5/model.mjs), so a call to it cannot be bounded by maxUsd`;
      tried.push({ model, reason: 'unpriced', detail });
      return { ok: false, reason: 'unpriced', detail, tried, attempts };
    }
    if (spend + reserve > cap) {
      const detail = `this request could cost up to ${round(reserve)} USD on ${model} and ${round(spend)} USD is already spent, over the ${cap} USD ceiling for this call`;
      tried.push({ model, reason: 'cost', detail });
      return { ok: false, reason: 'cost', detail, tried, attempts, cost_usd: round(spend) };
    }

    attempts += 1;
    // Only tokens the provider actually reported are charged (attemptOnce, as each response lands).
    // A 429, a 401 or a 400 processed no tokens and is billed as nothing; charging the worst-case
    // reserve for them (as this did until it was measured) spends the whole ceiling on failures.
    const result = await attemptOnce();

    if (result.ok) {
      return { ok: true, text: result.text, model, usage: usageOf({ usage }), cost_usd: round(spend), attempts, switched,
        continuations: result.continuations || 0,
        ...(result.message ? { message: result.message } : {}), ...(result.stop_reason ? { stop_reason: result.stop_reason } : {}) };
    }

    tried.push({ model, reason: result.reason, detail: result.detail });
    // A cut answer is terminal and keeps what was paid for; another model would start from nothing.
    if (result.reason === 'truncated') {
      return { ok: false, reason: result.reason, detail: result.detail, tried, attempts, cost_usd: round(spend), model, switched,
        usage: usageOf({ usage }), continuations: result.continuations || 0, stop_reason: 'max_tokens',
        ...(result.text ? { text: result.text } : {}) };
    }
    // The owner's own interrupt is the only wanted terminal, here as in the live turn.
    if (result.reason === 'aborted') return { ok: false, reason: 'aborted', detail: result.detail, tried, attempts, cost_usd: round(spend) };

    // Too big for this window. A one-shot call has no history to compact, so the move is to a model
    // with a larger window; when the chain has none, that is reported as a measurement, not a retry.
    if (needsCompaction(result.detail)) {
      const bigger = largerWindowModel(model, chain);
      if (!bigger) {
        return { ok: false, reason: 'too_long', tried, attempts, cost_usd: round(spend), tokens: tokensIn(result.detail),
          detail: `${result.detail}; no model left in the chain has a larger context window than ${model}, so this prompt has to be made smaller` };
      }
      moveTo(bigger, 'too_long', result.detail);
      continue;
    }

    // An auth failure with another keyed provider on the machine is a SWITCH, not a stop, and not
    // three more attempts either: a credential does not appear between two requests a second apart.
    // Spending this model's remaining attempts is what recoveryStep does for a live turn, where a
    // human may be fixing the file; a batch call moves on at once by reporting the attempts spent.
    const step = recoveryStep({
      error: { reason: result.reason, detail: result.detail },
      attempts: result.reason === 'auth' ? ATTEMPTS_PER_MODEL - 1 : modelAttempts,
      model, chain, canCompact: false, cycles, env: useEnv
    });

    if (step.action === 'stop') {
      const detail = step.reason === 'auth' ? `${step.detail}\n${describe(resolution)}` : step.detail;
      return { ok: false, reason: step.reason, detail, tried, attempts, cost_usd: round(spend) };
    }

    const from = model;
    ({ model, attempts: modelAttempts, chain, cycles } =
      applyStep({ model, attempts: modelAttempts, chain, cycles, compacted: false }, step));
    chain = chain.filter(name => priced(name, useEnv) && allowed(name));
    // A refilled cycle starts on the head of the raw ladder, which may be a model this call cannot run.
    while ((!priced(model, useEnv) || !allowed(model)) && chain.length) model = chain.shift();

    if (step.action === 'cycle' && cycles > cycleCap) {
      return { ok: false, reason: step.reason, tried, attempts, cost_usd: round(spend),
        detail: `${step.detail}; every keyed model failed and the chain has been walked ${cycles} time${cycles === 1 ? '' : 's'}` };
    }
    if (model !== from) switched.push({ from, to: model, reason: step.reason });
    emit({ type: model === from ? 'retry' : 'switch', from, to: model, reason: step.reason, detail: step.detail });
    if (step.waitMs) {
      emit({ type: 'wait', from, to: model, reason: step.reason, detail: `waiting ${step.waitMs}ms before the next attempt` });
      await (options.sleepImpl || sleep)(step.waitMs);
    }
  }
}

/**
 * The same ladder for a caller that needs the assembled MESSAGE rather than its text: a tool-using
 * bench round, where dropping tool_use blocks would drop the point of the call. Throws on failure so
 * it can stand in for streamMessage; `call` itself never throws.
 */
export async function callMessage(request, options = {}) {
  const { model, max_tokens: maxTokens, system, messages, tools, reasoning_effort: effort, purpose } = request || {};
  const result = await call({ model, max_tokens: maxTokens, system, messages, tools, reasoning_effort: effort, purpose }, options);
  if (result.ok) return result.message;
  const error = new ModelError(result.reason, result.detail);
  error.tried = result.tried;
  throw error;
}
