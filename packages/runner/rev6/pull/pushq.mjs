// The push hand-off: each turn's ledger slice goes on push_queue, is ingested into memory.sqlite as webchat
// records (owner words, replies, tool calls with their outcomes), and is settled only on the store's own receipt.
import { redactSecrets } from '../tools/runner/redact.mjs';
import { cut } from '../base/text.mjs';
import { readConfig } from './call.mjs';
import { textOf } from './loop.mjs';
import { runnerChatVerdict } from './chat-scope.mjs';
import { memoryCli, receiptComplete } from './tools.mjs';

const asText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p?.type === 'text' ? p.text : JSON.stringify(p))).join('\n') : JSON.stringify(c ?? ''));

/** Ledger rows (fromSeq, toSeq] as raw records for the store; a tool call carries its result or says it has none. */
export function transcriptRecords(ledger, sessionId, fromSeq, toSeq) {
  const rows = ledger.rows(sessionId, fromSeq, toSeq);
  const record = (r, native, role, author, text, locator) => ({ id: `webchat/${native}`, source: 'webchat', account: '', native_id: native, revision: '1', role, author,
    participants: ['owner', 'tophat'], thread: sessionId, text, occurred_at: r.created_at, available_at: r.created_at, policy: { model: 'allow', publish: 'none' }, ...(locator ? { locator } : {}) });
  const results = new Map();
  for (const r of rows) if (r.kind === 'tool_result') for (const p of r.content) if (p.type === 'tool_result') results.set(p.tool_use_id, { ...p, at: r.created_at, seq: r.seq });
  const out = [];
  for (const r of rows) {
    if (['owner', 'assistant', 'interrupted'].includes(r.kind) && textOf(r.content)) {
      const owner = r.kind === 'owner';
      out.push(record(r, `${sessionId}/${r.seq}`, owner ? 'owner' : 'assistant', owner ? 'owner' : 'tophat', textOf(r.content)));
    }
    if (r.kind !== 'assistant' && r.kind !== 'interrupted') continue;
    for (const p of r.content) {
      if (p.type !== 'tool_use') continue;
      const result = results.get(p.id), native = `${sessionId}/${r.seq}/${p.id}`;
      const outcome = result ? `[${result.is_error ? 'failed' : 'result'}] ${cut(redactSecrets(asText(result.content)).text, 1500)}`
        : '[no result recorded: the call was interrupted or the runner restarted before it finished; its effect is unknown]';
      out.push(record(r, native, 'tool', `tool:${p.name}`, `[tool call ${p.id}] ${p.name} ${cut(redactSecrets(JSON.stringify(p.input ?? {})).text, 1500)}\n${outcome}`,
        { source: 'webchat', account: '', native_id: native, revision: '1', thread: sessionId, field: 'text', tool_use_id: p.id, tool: p.name, call_seq: r.seq,
          result_seq: result?.seq ?? null, result_at: result?.at ?? null, outcome: result ? (result.is_error ? 'failed' : 'ok') : 'unknown' }));
    }
  }
  return out;
}

const pushModel = (env) => env.TOPHAT_RUNNER_PUSH_MODEL || readConfig(env)?.rev5?.purposeModels?.push || null;
async function ackState(records, env, cli = memoryCli) {
  const acked = [], unacked = [], unknown = [];
  for (const record of records) {
    const read = await cli('read', { kind: 'raw', id: record.id }, { env });
    (!read.ok ? unknown : read.raw?.processed ? acked : unacked).push(record.id);
  }
  return { acked, unacked, unknown };
}

/** Settle this session's pending slices. Ingest only by default; TOPHAT_RUNNER_TURN_PUSH=1 also runs a push cycle and checks acknowledgement. */
export async function drainPushes({ ledger, sessionId, env, now, cli = memoryCli }) {
  for (const item of ledger.pendingPushes(sessionId)) {
    // A chat whose scope the instance does not serve writes nothing: the store files every row under the instance's own group.
    const held = runnerChatVerdict(sessionId, env), records = held ? [] : transcriptRecords(ledger, sessionId, item.from_seq, item.to_seq), receipt = { sent: records.length, ...(held ? { held_by_scope: held.why } : {}) };
    let outcome = held?.retry ? { ok: false, reason: 'chat scope not confirmed', detail: held.why } : { ok: true };
    if (records.length) {
      const before = await ackState(records, env, cli);
      if (before.acked.length === records.length) Object.assign(receipt, { acknowledged: `${records.length}/${records.length}`, verified_by: 'read raw', cycle: 'not run: every record of this turn was already acknowledged' });
      else {
        const ingested = await cli('ingest', { records }, { env });
        Object.assign(receipt, { stored: ingested.stored?.length ?? null, duplicates: ingested.duplicates?.length ?? null, rejected: ingested.rejected || [] });
        const check = receiptComplete(records, ingested);
        if (!check.complete) outcome = { ok: false, reason: 'ingest incomplete', detail: `${check.reason}; ${JSON.stringify(check.rejected).slice(0, 300)}` };
        if (outcome.ok && env.TOPHAT_RUNNER_TURN_PUSH !== '1') Object.assign(receipt, { cycle: 'left to the heartbeat push' });
        else if (outcome.ok) {
          const days = Number(env.TOPHAT_RUNNER_PUSH_WINDOW_DAYS) || 7;
          const request = { max_output_tokens: Number(env.TOPHAT_RUNNER_MAX_TOKENS) || 32_000, now: now(), since: new Date(Date.parse(now()) - days * 86_400_000).toISOString(), ...(pushModel(env) ? { model: pushModel(env) } : {}) };
          const pushed = await cli('push', request, { env });
          Object.assign(receipt, { interpret: pushed.interpret?.status ?? null, interpret_reason: pushed.interpret?.reason ?? null, max_tokens_requested: request.max_output_tokens,
            max_tokens_reported: pushed.interpret?.max_tokens ?? null, now: request.now, pages: (pushed.pages || []).map((p) => `${p.entity_id}:${p.status}`), pages_dirty_after: pushed.pages_dirty_after ?? null,
            calls: pushed.calls ?? null, backlog_after: pushed.backlog_after ?? null, claimed_elsewhere: pushed.claimed_elsewhere ?? null, excluded_future: pushed.excluded_future ?? null, problems: pushed.problems || [] });
          const after = await ackState(records, env, cli);
          Object.assign(receipt, { acknowledged: `${after.acked.length}/${records.length}`, verified_by: 'read raw', ...(after.unknown.length ? { ack_unknown: after.unknown.length } : {}) });
          if (!pushed.ok && pushed.reason !== undefined) outcome = { ok: false, reason: pushed.reason, detail: (pushed.problems || [pushed.detail || pushed.error]).join('; ') };
          else if (after.acked.length !== records.length) outcome = { ok: false, reason: 'interpretation pending', detail: `durable input stored (${records.length} records); ${after.unacked.length + after.unknown.length} of ${records.length} not yet acknowledged by the store`
            + `${pushed.claimed_elsewhere ? `; ${pushed.claimed_elsewhere} pending rows held by another cycle` : ''}${pushed.interpret?.status ? `; this cycle's interpretation ${pushed.interpret.status}` : '; this cycle interpreted nothing of this turn'}` };
        }
      }
    }
    ledger.settlePush(item.id, outcome.ok, outcome.ok ? null : cut(`${outcome.reason}: ${outcome.detail || ''}`, 500), now(), receipt);
    process.stderr.write(`[rev6 pull] push for ${sessionId} ${outcome.ok ? 'landed' : `deferred (${outcome.reason}); the raw input stays pending and is retried at the next turn end`}: ${JSON.stringify(receipt).slice(0, 400)}\n`);
  }
}

/** A receipt that by itself proves the slice landed (ingest accounted, interpretation applied, only page problems left). */
export function acceptedReceipt(item) {
  let receipt;
  try { receipt = JSON.parse(item.receipt || 'null'); } catch { return null; }
  if (!receipt || typeof receipt !== 'object') return null;
  const accounted = (receipt.stored ?? 0) + (receipt.duplicates ?? 0);
  if (!(receipt.sent >= 0) || accounted !== receipt.sent || (receipt.rejected || []).length) return null;
  if (!(receipt.interpret === 'applied' || (receipt.interpret == null && receipt.backlog_after === 0))) return null;
  const problems = receipt.problems || [];
  if (!problems.every((p) => /^page /.test(String(p)))) return null;
  return { receipt, why: `ingest accounted ${accounted}/${receipt.sent}, interpret ${receipt.interpret ?? 'nothing pending'}, ${problems.length ? `${problems.length} stale page problem(s) left to the store's page queue` : 'no problems'}` };
}

export function reconcilePending({ ledger, apply = false, now = () => new Date().toISOString() }) {
  const report = { applied: apply, settled: [], left_pending: [] };
  for (const item of ledger.allPending()) {
    const accepted = acceptedReceipt(item);
    if (!accepted) { report.left_pending.push({ id: item.id, session: item.session_id, attempts: item.attempts, reason: item.receipt ? 'receipt does not prove the slice landed' : 'no receipt yet' }); continue; }
    if (apply) ledger.reconcilePush(item.id, now(), accepted.why, accepted.receipt);
    report.settled.push({ id: item.id, session: item.session_id, attempts: item.attempts, why: accepted.why });
  }
  return report;
}
