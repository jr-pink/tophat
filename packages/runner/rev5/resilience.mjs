// What a failed completion costs: one more request, not the task.
//
// So the only wanted terminal is the owner's own interrupt. Everything else -- a 400 whose body says
// the output was blocked by a content filter, a rate limit, an overloaded provider, a stream that died
// before message_stop, a key file that went missing -- is a step on a ladder: tell the model what
// happened and ask again, three times on this model, then move to the next model that has a key, and
// only give up when the chain is exhausted. The decision is pure and lives here so both the parent
// turn (pull.mjs) and every subagent turn (agents.mjs) climb the identical ladder.

import { providersAvailable } from './model.mjs';
import { OPENAI_LIMITS } from './openai.mjs';

/** Attempts on one model before the ladder moves to the next. */
export const ATTEMPTS_PER_MODEL = 3;

/** The one failure we do want to be terminal: the owner stopped it on purpose. */
export const WANTED_TERMINAL = Object.freeze(['aborted']);

/** Running out of models is not running out of options. So an exhausted chain starts again at the
 * top with a wait in front of it, growing 5s, 10s, 20s, 40s, 60s and staying there: a provider that
 * is down comes back, a key that is missing gets fixed, and the turn is still alive and still says
 * what it is waiting on. Only the owner's own stop ends a turn.
 */
export const CYCLE_WAIT_MS = Object.freeze([5_000, 10_000, 20_000, 40_000, 60_000]);
export const cycleWait = (cycles = 0) => CYCLE_WAIT_MS[Math.min(Math.max(0, cycles), CYCLE_WAIT_MS.length - 1)];

/**
 * A 400 the request's own shape caused: the same bytes fail on every model and at every attempt,
 * so the ladder shrinks the history (which drops the malformed part with it) instead of repeating.
 * rev5/request-repair.mjs mends the shapes we know before a request ever goes out; this catches
 * what it does not know yet.
 */
export const isRequestShape = (reason, detail = '') => reason === 'invalid' && !isContentFilter(detail)
  && /not valid JSON|surrogate|tool_use|tool_result|content block|must be non-empty|roles must alternate|messages(\.\d|:)/i.test(detail);

const ANTHROPIC_DEFAULTS = ['claude-opus-5', 'claude-fable-5', 'claude-mythos-5'];
const OPENAI_DEFAULTS = ['gpt-6-astra'];

/** Is this model id served by the OpenAI path rather than the Anthropic one? */
export const isOpenAI = (model = '') => /^(gpt|o\d)/.test(model);

/**
 * The models to fall back to, in order, after `current` has spent its attempts: the explicit
 * TOPHAT_RUNNER_FALLBACK_MODELS list if set, else the built-in order, in both cases keeping only the ones
 * whose provider actually has a key file on this machine. A model with no key is not a fallback.
 */
export function fallbackChain(current, env = process.env) {
  const listed = String(env.TOPHAT_RUNNER_FALLBACK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const providers = providersAvailable(env);
  const wanted = listed.length ? listed : [...ANTHROPIC_DEFAULTS, ...OPENAI_DEFAULTS];
  const seen = new Set([current]);
  return wanted.filter((model) => {
    if (seen.has(model)) return false;
    seen.add(model);
    return isOpenAI(model) ? providers.openai : providers.anthropic;
  });
}

/**
 * A failure that says the request itself is too big. Asking again cannot help and neither can another
 * model: the context has to shrink first, so the ladder compacts and then retries the same model.
 */
export const needsCompaction = (detail = '') => /byte ceiling|prompt is too long|too many tokens|context.{0,24}(length|window)|maximum context/i.test(detail);

/** The context windows the two providers document, so a prompt that does not fit one can be tried on the
 * other instead of simply failing. the gpt figure is the repo's own OPENAI_LIMITS.contextWindow. Both are
 * per-provider rather than per-model: a model id we have never seen gets its provider's number rather than
 * an invented one. The gpt figure is read when asked, not at module evaluation: openai.mjs and model.mjs
 * import each other and model.mjs imports this file, so a process whose first import is openai.mjs
 * (rev5/cua.test.mjs) reaches this line while OPENAI_LIMITS is still uninitialised, and the whole module
 * graph died with a TDZ ReferenceError before any test ran.
 */
export const CONTEXT_WINDOWS = Object.freeze({ anthropic: 1_000_000, get openai() { return OPENAI_LIMITS.contextWindow; } });
export const contextWindowOf = (model = '') => (isOpenAI(model) ? CONTEXT_WINDOWS.openai : CONTEXT_WINDOWS.anthropic);

/**
 * The first model in the chain with a strictly larger window than the one that just refused the
 * prompt for its size. Null when the chain has none, which is the honest end of the road: the
 * caller reports too_long with the count the provider measured instead of retrying what cannot fit.
 * A conversation runner compacts instead (recoveryStep's canCompact branch); a one-shot call has no
 * history to shrink, so moving is the only move it has.
 */
export function largerWindowModel(current, chain = []) {
  const here = contextWindowOf(current);
  return chain.find((model) => contextWindowOf(model) > here) || null;
}

/** The token count a provider named in its own refusal, so too_long carries a measurement, not a guess. */
export function tokensIn(detail = '') {
  const match = /(\d[\d,]{2,})\s*tokens/i.exec(String(detail));
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

/** A content filter refusing the output is the one failure where saying the same thing again cannot work. */
export const isContentFilter = (detail = '') => /content.?filter|blocked by|safety|output blocked/i.test(detail);

/** What the model is told about the failure it never saw. */
export function nudgeText({ reason, detail, attempt, model, switching = null }) {
  const head = `The previous completion did not come back: ${reason}: ${detail}. Nothing of it reached the owner, and the task is unchanged.`;
  const advice = isContentFilter(detail)
    ? 'The provider blocked the output itself, so repeating it verbatim will fail again: do the same work in different words, quote less of any source material, and keep going.'
    : reason === 'auth' || reason === 'rate_limited' || reason === 'overloaded'
      ? 'This was the provider rather than anything you wrote: continue exactly where you were.'
      : 'Continue from where you were; if one tool result or one long quotation looks like the cause, work around it rather than repeating it.';
  const where = switching ? ` This attempt runs on ${switching} instead of ${model}.` : ` Attempt ${attempt + 1} of ${ATTEMPTS_PER_MODEL} on ${model}.`;
  return `${head} ${advice}${where}`;
}

/** A completion the provider cut at the output ceiling is the one failure the ladder above never sees: the request
 * succeeded, the bytes arrived, they simply stop mid-sentence or mid tool call. It is still not a finished turn,
 * and reading it as one is expensive. So a cut is continued, a bounded number of times, and a run that cannot get
 * past the ceiling ends visibly unfinished. Both run loops use these: rev5/pull.mjs for the owner's turn,
 * rev5/agents.mjs for every subagent.
 */
export const TRUNCATION_CAP = 3;

/** What the model is told about its own cut-off message, and about the tool call that went down with it. */
export function truncationNudge(pendingToolNames = []) {
  const head = 'Your last message was cut off at the output ceiling before you finished it. Continue from exactly where it stopped; do not restart the message or repeat what you already said.';
  const names = [...new Set(pendingToolNames)];
  if (!names.length) return head;
  return `${head} The cut landed in the middle of the arguments of your ${names.join(' and ')} call, so that call was NOT run and nothing it would have done has happened.`
    + ' Make it again in smaller pieces: a first call carrying the opening part, then further calls appending the rest. One tool call\'s arguments are bounded by the same output ceiling as the rest of the message.';
}

/** The tool_result that stands in for a call the ceiling cut: the model must see that it did not run. */
export const truncatedCallResult = (call) => ({ type: 'tool_result', tool_use_id: call.id, is_error: true,
  content: call.input_error || 'this tool call was cut off at the output ceiling before its arguments were complete, so it was not run; make it again in smaller pieces' });

/**
 * The turn's own state after one rung, so the loop in pull.mjs and the walk in
 * ladder.model.test.mjs move the same way. `state` is what the turn carries: which model it is on,
 * how many times that model has failed, what is left of the chain, how many times the chain has
 * been cycled, and whether this turn has already compacted for size. Pure; the caller does the
 * waiting, the emitting and the compaction itself.
 */
export function applyStep(state, step) {
  const { model, attempts = 0, chain = [], cycles = 0, compacted = false } = state;
  if (step.action === 'stop') return { ...state, stopped: true, terminal: step.terminal || 'stop' };
  if (step.action === 'compact') return { model, attempts, chain, cycles, compacted: true, stopped: false };
  if (step.action === 'cycle') {
    return { model: step.model, attempts: 0, chain: step.chain || [], cycles: cycles + 1, compacted: false, stopped: false };
  }
  if (step.action === 'switch') {
    return { model: step.model, attempts: 0, chain: chain.filter((name) => name !== step.model), cycles, compacted, stopped: false };
  }
  return { model, attempts: attempts + 1, chain, cycles, compacted, stopped: false };
}

/**
 * One rung of the ladder.
 *
 * `attempts` is how many times this model has already failed in this turn. Returns an action:
 *   retry  - ask the same model again, after waitMs, with `nudge` appended to the context
 *   switch - `model` is the next model to use; attempts reset, `nudge` says so
 *   stop   - genuinely terminal: the owner's interrupt, or nothing left to try
 */
export function recoveryStep({ error, attempts = 0, model, chain = [], canCompact = false, cycles = 0, env = process.env, shapeFloored = false }) {
  const reason = error?.reason || 'failed';
  const detail = error?.detail || error?.message || 'no detail';
  if (WANTED_TERMINAL.includes(reason)) return { action: 'stop', reason, detail, terminal: 'wanted' };
  // A 4xx answer other than 408, 409 and 429 is the provider refusing the request as sent: no retry heals it. A request
  // refused for its size or shape may be compacted once; anything else stops and names the refusal.
  const clientStatus = Number(error?.status) || 0;
  if (clientStatus >= 400 && clientStatus < 500 && ![408, 409, 429].includes(clientStatus)
    && !(canCompact && (needsCompaction(detail) || isRequestShape(reason, detail)))) return { action: 'stop', reason, detail, terminal: 'client_error' };
  // Too big is not "try again": it is "carry less", and it is the same on every model.
  if (canCompact && (needsCompaction(detail) || isRequestShape(reason, detail))) {
    return {
      action: 'compact',
      model,
      waitMs: 0,
      nudge: isRequestShape(reason, detail)
        ? `The last request was refused for its shape, not its size (${detail}). The conversation was compacted and the task is unchanged; continue from where you were.`
        : `The last request was refused for its size (${detail}). The conversation was compacted and the task is unchanged; continue from where you were.`,
      reason, detail
    };
  }
  // A shape refusal that outlived the compaction is a request-repair defect: the same bytes go out on
  // every attempt and every model, and the provider answers a 400 in milliseconds. With the ordinary
  // 1s/2s/0s waits that was a storm. The ladder still never stops, but each rung of a shape failure
  // waits at least the cycle wait, so it costs a request every few seconds, not many.
  if (isRequestShape(reason, detail) && !shapeFloored) {
    const step = recoveryStep({ error, attempts, model, chain, canCompact: false, cycles, env, shapeFloored: true });
    return step.action === 'stop' ? step : { ...step, waitMs: Math.max(step.waitMs || 0, cycleWait(cycles)) };
  }
  if (attempts + 1 < ATTEMPTS_PER_MODEL) {
    return {
      action: 'retry',
      model,
      waitMs: Math.min(8000, 1000 * (attempts + 1)),
      nudge: nudgeText({ reason, detail, attempt: attempts + 1, model }),
      reason, detail
    };
  }
  const next = chain[0];
  if (!next) {
    // The one failure a wait cannot mend: no provider on this machine has a usable key. Cycling on
    // that would spin in the dark for ever, so it stops and names the file the owner has to fix. Every
    // other failure, provider or network or shape, keeps going.
    const refill = fallbackChain(model, env);
    // The test is whether this machine has any usable key at all, not whether the chain has another
    // model in it: on a machine keyed for one provider only, fallbackChain(current) is empty because
    // it excludes the model we are already on, and reading that as "nothing can run" ended a turn
    // that had a perfectly good key. With a key present, an auth failure is a provider problem like
    // any other: wait and go round again.
    const keyed = providersAvailable(env);
    if (reason === 'auth' && !refill.length && !keyed.anthropic && !keyed.openai) {
      return { action: 'stop', reason, detail: `${detail}; no model on this machine has a key file, so nothing can run until that is fixed`, terminal: 'needs_owner' };
    }
    // The chain is spent; it is refilled and tried again after a wait, for as long as the owner lets it run.
    const full = refill;
    const waitMs = cycleWait(cycles);
    return {
      action: 'cycle',
      model: full[0] || model,
      chain: full.slice(1),
      waitMs,
      nudge: `${nudgeText({ reason, detail, attempt: attempts, model, switching: full[0] || model })} Every model in the chain has failed this turn, so this waits ${Math.round(waitMs / 1000)}s and starts the chain again; the task is unchanged and nothing is lost.`,
      reason, detail
    };
  }
  return {
    action: 'switch',
    model: next,
    waitMs: 0,
    nudge: nudgeText({ reason, detail, attempt: attempts, model, switching: next }),
    reason, detail
  };
}
