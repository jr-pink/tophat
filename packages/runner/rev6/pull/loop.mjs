// The agent loop, one copy for the root turn and for subagents: request, stream, record, recover,
// run tools, repeat until the model stops and the role's end hook agrees. Role differences (the root's
// prefetch, owner cut, compaction and goal hook; a child's cancel and failure rules) come in as hooks.
import { ModelError, abortableSleep, createAssembler, streamMessage, usageOf } from './wire.mjs';
import { applyStep, fallbackChain, recoveryStep, TRUNCATION_CAP, truncatedCallResult, truncationNudge } from './call.mjs';
import { PARALLEL, PARALLEL_EXTRA } from './tools.mjs';

export const textOf = (content) => (content || []).filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
const USAGE_KEYS = ['requests', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'reasoning_output_tokens'];
export const emptyUsage = (from = {}) => Object.fromEntries(USAGE_KEYS.map((k) => [k, from[k] || 0]));
export const addUsage = (usage, u = {}) => { usage.requests += 1; for (const k of USAGE_KEYS) if (k !== 'requests') usage[k] += u?.[k] || 0; };

/**
 * Run tool calls: the PARALLEL set at once, the rest in order. When `preempt` fires (the owner spoke), every call
 * still running is moved to a background job and answered "backgrounded"; nothing is cancelled.
 */
// The display text of a tool result: a block list (read_document on an image) shows its text blocks.
const resultText = (c) => (Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : c);

export async function runCalls(calls, { tools, cancelled = () => null, preempt = null }) {
  const settled = new Array(calls.length), moved = new Set(), inflight = new Map();
  let ran = 0;
  const runOne = async (call) => {
    const stop = cancelled();
    if (stop) return { content: stop, isError: true };
    ran += 1;
    return call.input_error ? { content: call.input_error, isError: true } : tools.run(call.name, call.input, call);
  };
  const OWNER = Symbol('owner');
  let nudged = Boolean(preempt?.already), wake = () => {};
  const spoke = new Promise((r) => { wake = () => r(OWNER); });
  const release = preempt ? preempt.subscribe(wake) : () => {};
  const detach = (i, promise) => { moved.add(i); settled[i] = { content: `backgrounded as ${tools.jobs.adopt(calls[i].name, calls[i].input, promise).job_id}; still running, result arrives later` }; };
  const keep = (i, promise) => {
    inflight.set(i, promise);
    return promise.then((r) => { inflight.delete(i); if (!moved.has(i)) settled[i] = r; },
      (e) => { inflight.delete(i); if (!moved.has(i)) settled[i] = { content: `this tool call failed: ${e?.message || e}`, isError: true }; });
  };
  const detachAll = () => { for (const [i, p] of inflight) detach(i, p); inflight.clear(); };
  try {
    const parallel = [];
    for (let i = 0; i < calls.length; i++) if (PARALLEL.has(calls[i].name) || PARALLEL_EXTRA.has(calls[i].name)) parallel.push(keep(i, runOne(calls[i])));
    if (parallel.length && !nudged && await Promise.race([Promise.all(parallel), spoke]) === OWNER) nudged = true;
    if (nudged) detachAll();
    let chain = Promise.resolve();
    for (let i = 0; i < calls.length; i++) {
      if (settled[i]) continue;
      chain = chain.then(() => runOne(calls[i]));
      if (nudged) { detach(i, chain); continue; }
      if (await Promise.race([keep(i, chain), spoke]) === OWNER) { nudged = true; detachAll(); }
    }
  } finally { release(); }
  return { results: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: settled[i].content, ...(settled[i].isError ? { is_error: true } : {}) })), ran };
}

/**
 * o: { role: 'root'|'child', ledger, sessionId, env, emit, parent, tools, getModel(), setModel(m), request(model),
 *      messages(), signal(), beforeStep() -> 'stop'|void, onAborted(partial) -> 'continue'|'stop', nudge(block-text),
 *      compact(trigger), canCompact, cancelled(), preempt, onEvent(event), onFinal({message, calls, text}) -> {continue}|{stop, status, note},
 *      beforeCalls(calls), onStep(), usage, calls }
 */
export async function runAgent(o) {
  const root = o.role === 'root', env = o.env, now = o.now;
  const usage = o.usage || emptyUsage();
  const r = { finalText: '', failure: null, numTurns: 0, recoveries: 0, truncations: 0, status: 'done', note: '', lastStop: null, pendingNames: [], calls: o.calls || 0, usage };
  let attempts = 0, chain = fallbackChain(o.getModel(), env), cycles = 0, compacted = false;
  for (;;) {
    if ((await o.beforeStep?.(r)) === 'stop') break;
    const partial = createAssembler(), model = o.getModel();
    let message;
    try {
      message = await (o.stream || streamMessage)({ ...o.request(model), messages: o.messages() }, { env, signal: o.signal(), onEvent: (event) => { partial.take(event); o.onEvent(event); } });
    } catch (error) {
      if (error instanceof ModelError && error.reason === 'aborted') {
        if ((await o.onAborted(partial, r)) === 'continue') continue;
        break;
      }
      const known = error instanceof ModelError ? error : { reason: 'failed', detail: error?.message || 'request failed' };
      const step = recoveryStep({ error: known, attempts, model, chain, canCompact: Boolean(o.canCompact) && !compacted, cycles, env });
      if (step.action === 'stop') {
        if (root) { r.failure = `${step.reason}: ${step.detail}`; o.onStop?.(); } else { r.status = 'failed'; r.note = `${step.reason}: ${step.detail}`; }
        break;
      }
      let next;
      ({ model: next, attempts, chain, cycles, compacted } = applyStep({ model, attempts, chain, cycles, compacted }, step));
      o.setModel(next);
      r.recoveries += 1;
      if (step.action === 'compact') {
        o.emit({ type: 'system', subtype: 'status', status: 'recovering', action: 'compact', reason: step.reason, detail: step.detail, model: next, recoveries: r.recoveries });
        await o.compact('recovery');
        o.nudge(step.nudge);
        continue;
      }
      if (root) o.emit({ type: 'system', subtype: 'status', status: 'recovering', action: step.action, reason: step.reason, detail: step.detail, model: next, attempt: attempts, recoveries: r.recoveries, cycles, wait_ms: step.waitMs || 0 });
      else { o.nudge(step.nudge); o.emit({ type: 'system', subtype: 'status', status: 'recovering', action: step.action, reason: step.reason, detail: step.detail, model: next, attempt: attempts, recoveries: r.recoveries, parent_tool_use_id: o.parent }); }
      if (root) o.nudge(step.nudge);
      // The wait ends early on the step's abort (his message, the stop, a cancel): beforeStep then reads why.
      if (step.waitMs) await abortableSleep(step.waitMs, o.signal?.());
      continue;
    }
    r.numTurns += 1;
    attempts = 0;
    if (root) addUsage(usage, message.usage);
    else { usage.requests += 1; for (const [k, v] of Object.entries(usageOf(message))) if (k in usage && v) usage[k] += v; }
    o.ledger.append(o.sessionId, 'assistant', 'assistant', message.content, now());
    o.onAssistant(message);
    r.finalText = textOf(message.content) || r.finalText;
    r.lastStop = message.stop_reason || null;
    const calls = message.content.filter((p) => p.type === 'tool_use');
    const fill = () => {
      const fills = calls.map(truncatedCallResult);
      if (root) { for (const b of fills) o.emit({ type: 'user', message: { role: 'user', content: [b] }, tool_use_result: b.content, parent_tool_use_id: null }); o.ledger.append(o.sessionId, 'user', 'tool_result', fills, now()); }
      else { o.ledger.append(o.sessionId, 'user', 'tool_result', fills, now()); for (const b of fills) o.emit({ type: 'user', message: { role: 'user', content: [b] }, tool_use_result: b.content, parent_tool_use_id: o.parent }); }
    };
    if (message.stop_reason === 'max_tokens') {
      if (root) {
        if (calls.length) fill();
        if (r.truncations < TRUNCATION_CAP) {
          r.truncations += 1;
          o.emit({ type: 'system', subtype: 'status', status: 'recovering', action: 'continue', reason: 'max_tokens', detail: 'the completion hit the output token ceiling', model: o.getModel(), recoveries: r.recoveries + r.truncations });
          o.nudge(truncationNudge(calls.map((c) => c.name)));
          continue;
        }
      } else {
        r.truncations += 1;
        r.pendingNames = calls.map((c) => c.name);
        if (calls.length) fill();
        if (r.truncations > TRUNCATION_CAP) {
          const names = [...new Set(r.pendingNames)];
          r.status = 'failed';
          r.note = `the model was cut off at the output ceiling (stop_reason max_tokens) ${r.truncations} times in a row, past the cap of ${TRUNCATION_CAP}`
            + `${names.length ? `, the last of them in the middle of a ${names.join(' and ')} call that was never run` : ''}`
            + `. ${r.calls} tool call${r.calls === 1 ? '' : 's'} ran before that; nothing half-written has been undone, so check the state on disk.`
            + ' To carry it on, agent_send it with the remaining output split across several smaller writes.';
          break;
        }
        o.emit({ type: 'system', subtype: 'status', status: 'recovering', action: 'continue', reason: 'max_tokens', detail: 'the completion hit the output token ceiling', model: o.getModel(), attempt: r.truncations, recoveries: r.recoveries + r.truncations, parent_tool_use_id: o.parent });
        o.nudge(truncationNudge(r.pendingNames));
        o.onStep?.(r);
        continue;
      }
    } else if (!root) { r.truncations = 0; r.pendingNames = []; }
    o.countCalls?.(calls.length);
    if (message.stop_reason !== 'tool_use' || !calls.length) {
      const end = await o.onFinal({ message, calls, text: textOf(message.content), result: r });
      if (end.continue) continue;
      if (end.status) { r.status = end.status; r.note = end.note || ''; r.pendingNames = end.pendingNames || r.pendingNames; }
      break;
    }
    o.beforeCalls?.(calls);
    const { results, ran } = await runCalls(calls, { tools: o.tools, cancelled: o.cancelled, preempt: o.preempt?.() });
    r.calls += ran;
    for (const b of results) o.emit({ type: 'user', message: { role: 'user', content: [b] }, tool_use_result: resultText(b.content), parent_tool_use_id: root ? null : o.parent });
    o.ledger.append(o.sessionId, 'user', 'tool_result', results, now());
    o.onStep?.(r);
  }
  return r;
}
