// Subagent check-in progress digest: what a running child has actually been doing, read in code from its own ledger
// session (no model call), so the parent can tell on track from looping from stalled. Bounded to about 1.5 KB.
import { saidDuration } from './agents.mjs';

export const DIGEST_MAX = 1600, EXCERPT_CHARS = 350, ARG_CHARS = 80, LAST_CALLS = 6, REPEAT_WINDOW = 12, REPEAT_MIN = 3;

const parse = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = flat(s); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };
const ARG_KEYS = ['command', 'path', 'query', 'queries', 'url', 'urls', 'pattern', 'open', 'id', 'agent_id', 'description', 'text'];

/** The part of a tool input that says what the call was about: the command, path or query, else the JSON. */
export function argSummary(input) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'object') return clip(input, ARG_CHARS);
  for (const k of ARG_KEYS) if (input[k] !== undefined && input[k] !== '') {
    const v = typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k]);
    return clip(k === 'command' ? v.replace(/^\s*cd\s+\S+\s*&&\s*/, '') : v, ARG_CHARS);
  }
  return clip(JSON.stringify(input), ARG_CHARS);
}

/** A tool result counts as an error when the loop marked it so, or when it is a shell answer with a non-zero exit. */
export function resultFailed(block) {
  if (block?.is_error) return true;
  const c = typeof block?.content === 'string' ? block.content : '';
  const exit = /^\s*\{\s*"exit_code"\s*:\s*(-?\d+|null)/.exec(c);
  if (exit) return exit[1] !== '0';
  return /^\s*\{\s*"error"\s*:/.test(c);
}

const commitLines = (text) => [...String(text || '').matchAll(/^\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm)].map((m) => `${m[1].slice(0, 8)} ${m[2].trim()}`);

/**
 * Read a child's ledger rows (oldest first: {role, kind, content, created_at}) into the facts the digest prints.
 * `sinceMs` is the previous check-in (or the start), `startMs` the spawn, `atMs` now.
 */
export function digestFacts(rows, { atMs, startMs, sinceMs, totalCalls = null, expectedMs = null } = {}) {
  const calls = [], byId = new Map(), excerpts = [], commits = [];
  let lastStepMs = null, lastStepKind = null;
  for (const row of rows) {
    const at = Date.parse(row.created_at), blocks = parse(row.content);
    if (Number.isFinite(at) && (row.role === 'assistant' || row.kind === 'tool_result')) { lastStepMs = at; lastStepKind = row.kind; }
    if (row.role === 'assistant') {
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
      const thought = text ? '' : blocks.filter((b) => b?.type === 'thinking').map((b) => b.thinking).join('\n').trim();
      if (text || thought) excerpts.push({ at, text: text || thought, thinking: !text });
      for (const b of blocks) if (b?.type === 'tool_use') {
        const call = { id: b.id, name: b.name, arg: argSummary(b.input), at, endAt: null, ok: null, command: typeof b.input?.command === 'string' ? b.input.command : '' };
        calls.push(call); byId.set(b.id, call);
      }
    } else for (const b of blocks) if (b?.type === 'tool_result') {
      const call = byId.get(b.tool_use_id);
      if (!call) continue;
      call.endAt = at; call.ok = !resultFailed(b);
      if (/\bgit\b[^\n]*\bcommit\b/.test(call.command)) {
        const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        let text = body; try { const o = JSON.parse(body); if (typeof o === 'string') text = o; else if (o && typeof o.output === 'string') text = o.output; } catch { /* plain text */ }
        commits.push(...commitLines(text));
      }
    }
  }
  let consecutiveErrors = 0;
  for (let i = calls.length - 1; i >= 0; i--) { if (calls[i].ok === false) consecutiveErrors++; else if (calls[i].ok === true) break; }
  const counts = new Map();
  for (const c of calls.slice(-REPEAT_WINDOW)) { const key = `${c.name} ${c.arg}`; counts.set(key, (counts.get(key) || 0) + 1); }
  const repeats = [...counts].filter(([, n]) => n >= REPEAT_MIN).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n }));
  const pending = calls.filter((c) => c.ok === null);
  const total = totalCalls ?? calls.length;
  const recent = calls.filter((c) => Number.isFinite(c.at) && c.at > sinceMs).length;
  const minutes = (ms) => Math.max(ms, 1) / 60_000;
  return {
    excerpts: excerpts.slice(-2), last: calls.slice(-LAST_CALLS), consecutiveErrors, repeats, commits: commits.slice(-5),
    pending: pending.map((c) => ({ name: c.name, arg: c.arg, for_ms: Number.isFinite(c.at) ? atMs - c.at : null })),
    sinceLastStepMs: lastStepMs === null ? null : atMs - lastStepMs, lastStepKind,
    rateRecent: Number.isFinite(sinceMs) ? recent / minutes(atMs - sinceMs) : null, recentCalls: recent,
    rateOverall: Number.isFinite(startMs) ? total / minutes(atMs - startMs) : null,
    elapsedMs: Number.isFinite(startMs) ? atMs - startMs : null, expectedMs: expectedMs > 0 ? expectedMs : null,
  };
}

const rate = (r) => (r === null || !Number.isFinite(r) ? '?' : r >= 10 ? r.toFixed(0) : r.toFixed(1));

/** The digest as plain lines, at most DIGEST_MAX characters (the excerpts shrink first). */
export function renderDigest(f) {
  const lines = [];
  const ratio = f.elapsedMs !== null && f.expectedMs ? f.elapsedMs / f.expectedMs : null;
  lines.push(`Time: elapsed ${f.elapsedMs === null ? '?' : saidDuration(f.elapsedMs)}${f.expectedMs ? `, expected ${saidDuration(f.expectedMs)}${ratio > 1 ? `, elapsed ${ratio.toFixed(1)}x expected` : ` (${Math.round(ratio * 100)}% used)`}` : ', no expected_minutes given'}`
    + `; last step ${f.sinceLastStepMs === null ? 'none yet' : `${saidDuration(f.sinceLastStepMs)} ago (${f.lastStepKind})`}.`);
  lines.push(`Pace: ${f.recentCalls} tool call${f.recentCalls === 1 ? '' : 's'} since the previous check-in (${rate(f.rateRecent)}/min) versus ${rate(f.rateOverall)}/min since start.`);
  if (f.pending.length) lines.push(`Waiting on: ${f.pending.slice(-3).map((p) => `${p.name} (${p.arg}) for ${p.for_ms === null ? '?' : saidDuration(p.for_ms)}`).join('; ')}.`);
  if (f.consecutiveErrors) lines.push(`Errors: the last ${f.consecutiveErrors} finished call${f.consecutiveErrors === 1 ? '' : 's'} in a row failed.`);
  if (f.repeats.length) lines.push(`Repeats: ${f.repeats.slice(0, 2).map((r) => `${clip(r.key, 90)} x${r.n}`).join('; ')} in its last ${REPEAT_WINDOW} calls.`);
  if (f.last.length) {
    lines.push(`Last ${f.last.length} call${f.last.length === 1 ? '' : 's'}:`);
    for (const c of f.last) lines.push(`- ${c.name}, ${c.arg || '(no args)'}, ${c.endAt !== null && Number.isFinite(c.at) ? saidDuration(c.endAt - c.at) : 'running'}, ${c.ok === null ? 'pending' : c.ok ? 'ok' : 'error'}`);
  } else lines.push('Calls: none yet.');
  if (f.commits.length) lines.push(`Commits: ${f.commits.join('; ')}`);
  const fixed = lines.join('\n');
  const room = Math.max(0, DIGEST_MAX - fixed.length - 40);
  const each = Math.min(EXCERPT_CHARS, f.excerpts.length ? Math.floor(room / f.excerpts.length) - 20 : 0);
  const said = each > 40 ? f.excerpts.map((e) => `${e.thinking ? 'It was thinking' : 'It said'}: "${clip(e.text, each)}"`) : [];
  return [...said, fixed].join('\n').slice(0, DIGEST_MAX);
}

/** Read the child's recent ledger rows and render its digest. */
export function progressDigest(db, row, { atMs, sinceMs, limitRows = 400 } = {}) {
  const rows = db.prepare('SELECT role, kind, content, created_at FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?').all(row.session_id, limitRows).reverse();
  const startMs = Date.parse(row.created_at);
  const facts = digestFacts(rows, { atMs, startMs, sinceMs: Number.isFinite(sinceMs) ? sinceMs : startMs, totalCalls: Number(row.calls) || null,
    expectedMs: Number(row.expected_minutes) > 0 ? Number(row.expected_minutes) * 60_000 : null });
  return { facts, text: renderDigest(facts) };
}

export const CHECK_IN_GUIDANCE = 'Read the digest above, then state in one line whether this subagent is on track, looping or stalled, citing the evidence (its calls, errors, repeats, pace or time).'
  + ' If it is stuck, looping or stalled, or elapsed is over about twice expected, act in this same turn: agent_send it a concrete steer, launch a parallel agent on an alternative approach, or agent_cancel it and re-brief; do not just say it is still running.'
  + ' Only when the digest shows clear forward progress may you answer in one short line that there is nothing to report and end the turn.';

/** The whole check-in text the parent receives for one due subagent (agents.checkIns() item). */
export function checkInText(a) {
  return `subagent ${a.agent_id} (${a.description}) has been running ${saidDuration(a.running_ms)} since ${a.started_at} and has not reported; last known status ${a.status}, ${a.calls} tool call${a.calls === 1 ? '' : 's'} so far`
    + `${a.last_activity ? `, its own last step ${a.last_activity}` : ', it has taken no step of its own yet'}${a.resumes ? `, relaunched ${a.resumes} time(s) after a restart` : ''}.`
    + ` Its report arrives on its own when it lands; this check-in repeats every ${saidDuration(a.every_ms)} until it does.`
    + `${a.digest ? `\nProgress digest (from its own ledger, computed in code):\n${a.digest}` : ''}\n${CHECK_IN_GUIDANCE}`;
}
