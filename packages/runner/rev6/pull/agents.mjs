// Subagents: the Agent tool family over the `agents` table, each child a runAgent in its own ledger session
// (`<parent>/agent/<id>`). Depth 1 by default, 6 at once, 40 per conversation, a check-in to the parent every
// 180 s while one runs, and relaunch after a restart (up to 3 times) with a note that it is the same task.
import { randomUUID } from 'node:crypto';
import { costOf } from './call.mjs';
import { buildMessages, ensureTables } from './ledger.mjs';
import { baselinePrompt, childSystem, createInstructions } from './context.mjs';
import { resolveCredentials } from './credentials.mjs';
import { agentEnv, createTools } from './tools.mjs';
import { emptyUsage, runAgent, textOf } from './loop.mjs';
import { progressDigest } from './progress.mjs';
import { isBackgroundTurn } from './background.mjs';
import { doorOf, withDoorNotice } from '../base/door-tag.mjs';

export function checkInInterval(env = process.env) {
  const given = env.TOPHAT_RUNNER_AGENT_CHECKIN_MS;
  if (given === undefined || String(given).trim() === '') return 180_000;
  if (/^(?:off|no|false)$/i.test(String(given).trim())) return 0;
  const ms = Number(given);
  return Number.isFinite(ms) && ms >= 0 ? ms : 180_000;
}
export function agentLimits(env = process.env) {
  const n = (name, fallback) => { const v = Number(env[name]); return v > 0 ? v : fallback; };
  return { concurrent: n('TOPHAT_RUNNER_AGENT_MAX_CONCURRENT', 6), perConversation: n('TOPHAT_RUNNER_AGENT_MAX_PER_CONVERSATION', 40), waitMs: n('TOPHAT_RUNNER_AGENT_WAIT_MS', 30 * 60_000),
    depth: n('TOPHAT_RUNNER_AGENT_DEPTH', 1), resultChars: n('TOPHAT_RUNNER_AGENT_RESULT_CHARS', 12_000), maxTokens: n('TOPHAT_RUNNER_AGENT_MAX_TOKENS', 32_000), checkInMs: checkInInterval(env) };
}
export const saidDuration = (ms) => { const s = Math.max(0, Math.round(Number(ms) / 1000)); return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
export function checkInDue(row, atMs, defaultMs = 180_000) {
  if (!row || row.status !== 'running') return null;
  const every = row.checkin_ms === null || row.checkin_ms === undefined ? defaultMs : Number(row.checkin_ms);
  if (!(every > 0) || !Number.isFinite(atMs)) return null;
  const since = Date.parse(row.checked_at || row.created_at), started = Date.parse(row.created_at);
  if (!Number.isFinite(since) || atMs - since < every) return null;
  return { agent_id: row.id, description: row.description, status: row.status, started_at: row.created_at, running_ms: Number.isFinite(started) ? atMs - started : null, every_ms: every };
}
export function priorUsage(row) { try { const u = JSON.parse(row?.usage || '{}'); return u && typeof u === 'object' ? u : {}; } catch { return {}; } }
export function restartNote(row) {
  const calls = Number(row?.calls) || 0, runs = (Number(row?.resumes) || 0) + 1;
  return '[The runner restarted while you were working. This is the same task, not a new one: everything above is your own work so far'
    + `, ${calls} tool call${calls === 1 ? '' : 's'} over ${runs} run${runs === 1 ? '' : 's'} of this task. Continue from where you stopped and finish it; do not start over.`
    + ' Before you repeat any step that has a side effect (a file edit, a commit, a message, a purchase), check on disk or in the record whether it already landed, and skip it if it did.]';
}

export function createAgents({ ledger, parentSessionId, cwd, roots = [], env = process.env, permissionMode = 'bypassPermissions', model, now = () => new Date().toISOString(),
  emit = () => {}, systemContext = () => '', depth = 0, onOwnerWord = null, onSettled = null, toolFactories = {}, stream = null, door = () => null }) {
  // `door()`: the home host's door grant of the turn starting work now ({ grant, notice } or null; base/door-tag.mjs). Every row this
  // writes carries it, and a child's own subagents and jobs inherit its row's grant, so the home host can keep that turn's door open.
  env = { ...resolveCredentials(env).env };
  env.TOPHAT_RUNNER_CACHE_TTL = env.TOPHAT_RUNNER_AGENT_CACHE_TTL || '5m';
  const db = ledger.db, limits = agentLimits(env), q = (sql) => db.prepare(sql);
  ensureTables(db);
  const get = q('SELECT * FROM agents WHERE id = ? AND parent_session = ?');
  const finish = q('UPDATE agents SET status = ?, result = ?, usage = ?, cost_usd = ?, calls = ?, ended_at = ?, stop_reason = ? WHERE id = ?');
  const progress = q('UPDATE agents SET usage = ?, cost_usd = ?, calls = ? WHERE id = ?');
  const markUncertain = q("UPDATE agents SET status = 'uncertain', ended_at = COALESCE(ended_at, ?), stop_reason = COALESCE(stop_reason, ?) WHERE id = ? AND status = 'running'");
  const ownerAlive = (pid) => { if (!pid || pid === process.pid) return false; try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
  // Children this conversation's previous runner was running: still marked running with a dead owner, or already marked
  // uncertain for exactly that reason by the sweep below within RECENT_DEATH_MS. Death by sweep says nothing about the
  // work, only that nobody had picked it up yet.
  const RECENT_DEATH_MS = Number(env.TOPHAT_RUNNER_AGENT_RECENT_DEATH_MS) || 60 * 60_000;
  const died = /^(?:runner|owner) pid \d+ is gone/;
  const nowMs = Date.parse(now());
  const interrupted = [
    ...q("SELECT id, session_id, resumes, owner_pid, calls, usage, cost_usd FROM agents WHERE parent_session = ? AND status = 'running' ORDER BY created_at").all(parentSessionId).filter((r) => !ownerAlive(r.owner_pid)),
    ...q("SELECT id, session_id, resumes, owner_pid, calls, usage, cost_usd, stop_reason, ended_at FROM agents WHERE parent_session = ? AND status = 'uncertain' AND stop_reason LIKE '%pid % is gone%' ORDER BY created_at").all(parentSessionId)
      .filter((r) => died.test(String(r.stop_reason || '')) && nowMs - Date.parse(r.ended_at) >= 0 && nowMs - Date.parse(r.ended_at) < RECENT_DEATH_MS),
  ];
  for (const row of q("SELECT id, owner_pid FROM agents WHERE status = 'running' AND owner_pid IS NOT NULL AND parent_session != ?").all(parentSessionId)) {
    if (row.owner_pid !== process.pid && !ownerAlive(row.owner_pid)) markUncertain.run(now(), `runner pid ${row.owner_pid} is gone and this conversation did not reopen to resume it`, row.id);
  }
  const live = new Map();
  // A background turn (an owner-interrupted root turn, adopt() below) has no spawn card to stream under, so a relaunched
  // one runs quietly and reaches the transcript only through its report.
  const loudEmit = emit;
  const emitFor = (id) => (isBackgroundTurn(id) ? () => {} : loudEmit);
  const runningCount = () => [...live.values()].filter((e) => e.running).length;
  const reap = (row) => {
    if (!(row && row.status === 'running' && !live.get(row.id)?.running && row.owner_pid && row.owner_pid !== process.pid && !ownerAlive(row.owner_pid))) return row;
    markUncertain.run(now(), `owner pid ${row.owner_pid} is gone; nothing was running this child`, row.id);
    return q('SELECT * FROM agents WHERE id = ?').get(row.id) || row;
  };
  const settledNow = (id) => { try { onSettled?.(id); } catch (error) { process.stderr.write(`[rev6 agents] settle wake failed: ${error.message}\n`); } };
  const stampCheck = q('UPDATE agents SET checked_at = ? WHERE id = ?');
  const lastActivity = q('SELECT created_at, kind FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1');
  const partialReport = (sessionId) => {
    for (const r of q("SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 20").all(sessionId)) {
      let text = '';
      try { text = textOf(JSON.parse(r.content)).trim(); } catch { text = ''; }
      if (text) return text;
    }
    return '';
  };
  const runningRows = () => q("SELECT * FROM agents WHERE parent_session = ? AND status = 'running' ORDER BY created_at").all(parentSessionId);
  const describe = (row) => ({ agent_id: row.id, description: row.description, status: row.status, model: row.model, started_at: row.created_at, ended_at: row.ended_at,
    calls: row.calls, usage: row.usage ? JSON.parse(row.usage) : null, cost_usd: row.cost_usd, ...(row.stop_reason ? { stop_reason: row.stop_reason } : {}), result: row.result });

  async function run(id) {
    const emit = emitFor(id);
    const row = get.get(id, parentSessionId), entry = live.get(id);
    const instructions = createInstructions({ cwd, roots, env }), childEnv = agentEnv(id, env);
    const rowDoor = () => (row.door ? { grant: row.door, notice: doorOf(row.prompt)?.notice || null } : null);
    const tools = createTools({ db, sessionId: row.session_id, cwd, roots, env: childEnv, permissionMode, now, onPath: (p) => instructions.touch(p), factories: toolFactories, door: rowDoor,
      agents: depth + 1 < limits.depth ? createAgents({ ledger, parentSessionId: row.session_id, cwd, roots, env: childEnv, permissionMode, model: row.model, now, emit, systemContext, depth: depth + 1, toolFactories, stream, door: rowDoor }) : null });
    // Held on the entry so a cancel can kill its foreground tool calls (a `sleep 90` kept a cancelled child alive past the stop).
    if (entry) entry.tools = tools;
    const usage = emptyUsage(priorUsage(row));
    const spent = () => costOf(row.model, usage, env) ?? (row.cost_usd ?? null);
    let childModel = row.model, system = null, systemKey = null, r = { status: 'done', finalText: '', note: '', lastStop: null, pendingNames: [], calls: Number(row.calls) || 0 };
    const systemNow = () => {
      const key = instructions.prompt();
      if (system === null || key !== systemKey) { systemKey = key; system = childSystem({ systemContext: systemContext(), baseline: baselinePrompt({ env, now }), instructions: instructions.prompt() }); }
      return system;
    };
    const parent = row.spawn_call;
    try {
      r = await runAgent({ role: 'child', stream, ledger, sessionId: row.session_id, env, now, emit, parent, tools, usage, calls: Number(row.calls) || 0,
        getModel: () => childModel, setModel: (m) => { childModel = m; },
        request: (m) => ({ model: m, system: systemNow(), tools: tools.specs, max_tokens: limits.maxTokens, caller: row.caller || 'subagent-build', system_tail: `Task description: ${row.description}.` }),
        messages: () => buildMessages(ledger.active(row.session_id)).messages,
        signal: () => entry.controller.signal,
        beforeStep: (res) => {
          if (entry.controller.signal.aborted) { res.status = 'cancelled'; return 'stop'; }
          if (entry.queue.length) ledger.append(row.session_id, 'user', 'owner', entry.queue.splice(0).map((text) => ({ type: 'text', text })), now());
          return undefined;
        },
        onEvent: (event) => { if (event.type !== 'ping') emit({ type: 'stream_event', event, parent_tool_use_id: parent }); },
        onAborted: (partial, res) => { res.status = 'cancelled'; res.finalText = textOf(partial.message.content) || res.finalText; return 'stop'; },
        onAssistant: (m) => emit({ type: 'assistant', message: { id: m.id, role: 'assistant', model: m.model || row.model, content: m.content, stop_reason: m.stop_reason, usage: m.usage }, parent_tool_use_id: parent }),
        nudge: (text) => ledger.append(row.session_id, 'user', 'injected', [{ type: 'text', text: `[Recovery context for the assistant, not owner-visible]\n${text}` }], now()),
        cancelled: () => (entry.controller.signal.aborted ? 'cancelled before this ran' : null),
        onStep: (res) => progress.run(JSON.stringify(usage), spent(), res.calls, id),
        onFinal: ({ message, calls }) => {
          if (entry.queue.length) return { continue: true };
          if (!calls.length) return { continue: false };
          const names = calls.map((c) => c.name);
          return { continue: false, status: 'failed', pendingNames: names, note: `the model stopped with stop_reason ${message.stop_reason || 'unknown'} while a ${[...new Set(names)].join(' and ')} call was still pending, so that call was never run` };
        } });
    } finally {
      tools.jobs.stopAll();
      await tools.closeBrowser?.();
      const names = [...new Set(r.pendingNames || [])], said = r.finalText ? `\n[it had said before that:]\n${r.finalText}` : '';
      const result = r.status === 'done' ? (r.finalText || '[the subagent finished without a report]')
        : r.status === 'cancelled' ? `[cancelled before finishing; it had said so far:]\n${r.finalText}`
          : `[failed: ${r.note}${r.lastStop ? ` (last stop_reason ${r.lastStop})` : ''}]${names.length ? `\n[not run: ${names.join(', ')}; the arguments never finished arriving]` : ''}${said}`;
      finish.run(r.status, result.slice(0, limits.resultChars), JSON.stringify(usage), spent(), r.calls, now(), r.lastStop, id);
      entry.running = false;
      live.delete(id);
      for (const w of entry.waiters) w();
      settledNow(id);
    }
  }

  function start(id) {
    const entry = live.get(id);
    entry.running = true;
    q("UPDATE agents SET status = 'running', ended_at = NULL, owner_pid = ? WHERE id = ?").run(process.pid, id);
    entry.promise = run(id).catch((error) => { finish.run('failed', `[runner error: ${error.message}]`, null, null, 0, now(), null, id); live.delete(id); for (const w of entry.waiters) w(); settledNow(id); });
  }
  const launch = (id) => { live.set(id, { controller: new AbortController(), waiters: [], queue: [], running: false }); start(id); };

  async function waitFor(ids, timeoutMs) {
    const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 120_000, 0), 600_000);
    let preempted = false;
    for (const id of ids) {
      const entry = live.get(id);
      if (!entry?.running) continue;
      const left = deadline - Date.now();
      if (left <= 0) break;
      let release = null;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, left); timer.unref?.();
        const done = () => { clearTimeout(timer); resolve(); };
        entry.waiters.push(done);
        if (onOwnerWord) release = onOwnerWord(() => { preempted = true; done(); });
      });
      release?.();
      if (preempted) break;
    }
    const rows = ids.map((id) => { const row = get.get(id, parentSessionId); return row ? describe(row) : { agent_id: id, error: 'no such subagent in this conversation' }; });
    return preempted ? rows.map((r) => (r.status === 'running' ? { ...r, note: 'the owner spoke, so this wait returned early; the subagent is still running and its report arrives at the next boundary' } : r)) : rows;
  }

  const RESUME_CAP = Number(env.TOPHAT_RUNNER_AGENT_RESUME_CAP) || 3;
  function resumeInterrupted() {
    if (!env.TOPHAT_RUNNER_API_KEY_FILE) {
      if (interrupted.length) process.stderr.write(`[rev6 agents] no TOPHAT_RUNNER_API_KEY_FILE here; leaving ${interrupted.length} running subagent(s) to their owner\n`);
      interrupted.length = 0;
      return;
    }
    for (const row of interrupted) {
      const tooMany = runningCount() >= limits.concurrent;
      if (tooMany || row.resumes >= RESUME_CAP) {
        const said = partialReport(row.session_id);
        const head = tooMany ? '[the runner restarted while this subagent was running and the concurrency limit was already taken by others; its ledger session holds what it had done]'
          : `[the runner restarted while this subagent was running, ${row.resumes} times now, which is the relaunch cap (TOPHAT_RUNNER_AGENT_RESUME_CAP=${RESUME_CAP}); it was not relaunched again. Nothing it may have half-finished has been undone: check the state on disk before redoing any of it. agent_send restarts it with its whole transcript if you want it carried on.]`;
        finish.run(tooMany ? 'uncertain' : 'failed', `${head}${said ? `\n[it had said so far:]\n${said}` : ''}`.slice(0, limits.resultChars), row.usage ?? null, row.cost_usd ?? null, Number(row.calls) || 0, now(), null, row.id);
        settledNow(row.id);
        continue;
      }
      q('UPDATE agents SET resumes = resumes + 1 WHERE id = ?').run(row.id);
      ledger.append(row.session_id, 'user', 'owner', [{ type: 'text', text: restartNote(row) }], now());
      launch(row.id);
    }
    interrupted.length = 0;
  }

  return {
    resumeInterrupted,
    interruptedCount: () => interrupted.length,
    async spawn({ description, prompt, model: wanted, wait = false, check_in_seconds: checkIn, kind, expected_minutes: expected }, callId) {
      if (runningCount() >= limits.concurrent) return { error: `${runningCount()} subagents are already running (limit ${limits.concurrent}); wait for one with agent_wait or cancel one` };
      if (!prompt || !description) return { error: 'description and prompt are required' };
      const id = `agent_${randomUUID().slice(0, 8)}`, session = `${parentSessionId}/agent/${id}`;
      const checkinMs = Number.isFinite(Number(checkIn)) && Number(checkIn) >= 0 ? Math.round(Number(checkIn) * 1000) : null;
      const expectedMinutes = Number(expected) > 0 && Number.isFinite(Number(expected)) ? Number(expected) : null;
      const turnDoor = door();
      const brief = withDoorNotice(prompt, turnDoor); // the turn's door line goes along, so the subagent can reach his host too
      q('INSERT INTO agents (id, parent_session, session_id, spawn_call, description, prompt, model, status, created_at, checkin_ms, owner_pid, caller, expected_minutes, door) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, parentSessionId, session, callId || null, String(description).slice(0, 200), brief, wanted || model, 'running', now(), checkinMs, process.pid, kind === 'search' ? 'subagent-search' : 'subagent-build', expectedMinutes, turnDoor?.grant || '');
      ledger.ensureSession(session, { model: wanted || model, cwd, forkedFrom: parentSessionId, at: now() });
      ledger.append(session, 'user', 'owner', [{ type: 'text', text: brief }], now());
      launch(id);
      if (!wait) return { agent_id: id, status: 'running', note: 'running in the background; its report arrives on its own when it ends, waking this conversation if nothing else is happening, or ask with agent_wait' };
      const [done] = await waitFor([id], limits.waitMs);
      if (done.status && done.status !== 'running') q('UPDATE agents SET delivered_at = ? WHERE id = ?').run(now(), id);
      return done;
    },
    async send({ agent_id: id, text }) {
      const row = get.get(id, parentSessionId);
      if (!row) return { error: `no subagent ${id} in this conversation` };
      if (!text) return { error: 'text is required' };
      const entry = live.get(id);
      if (entry?.running) { entry.queue.push(String(text)); return { agent_id: id, status: 'running', queued: true }; }
      if (['uncertain', 'cancelled', 'failed', 'done'].includes(row.status)) {
        if (runningCount() >= limits.concurrent) return { error: `${runningCount()} subagents are already running (limit ${limits.concurrent})` };
        ledger.append(row.session_id, 'user', 'owner', [{ type: 'text', text: String(text) }], now());
        launch(id);
        return { agent_id: id, status: 'running', resumed: true };
      }
      return { error: `subagent ${id} is ${row.status}` };
    },
    list() { return q('SELECT * FROM agents WHERE parent_session = ? ORDER BY created_at').all(parentSessionId).map((row) => ({ ...describe(row), result: row.result ? `${row.result.slice(0, 300)}${row.result.length > 300 ? '…' : ''}` : null })); },
    async wait({ agent_ids, agent_id, timeout_ms }) {
      const ids = [...(Array.isArray(agent_ids) ? agent_ids : []), ...(agent_id ? [agent_id] : [])];
      if (!ids.length) return { error: 'give agent_id or agent_ids' };
      const rows = await waitFor(ids, timeout_ms);
      for (const r of rows) if (r.status && r.status !== 'running') q('UPDATE agents SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?').run(now(), r.agent_id);
      return { agents: rows };
    },
    cancel({ agent_id: id }) {
      const row = reap(get.get(id, parentSessionId));
      if (!row) return { error: `no subagent ${id} in this conversation` };
      const entry = live.get(id);
      if (!entry?.running) return describe(row);
      entry.controller.abort();
      try { entry.tools?.abortForeground?.(); } catch { /* best effort */ }
      return { agent_id: id, status: 'cancelling' };
    },
    /**
     * Take over a run that is already going: the root's own turn, interrupted by the owner and moved onto the forked
     * session `sessionId` (pull.mjs backgroundTurn()). Nothing is started here; `done` resolves to { status, result,
     * usage, cost, calls, stopReason }. The row is a child's in every other respect: listed, agent_cancel aborts `signal`,
     * agent_send text lands in `queue`, its end wakes the parent through onSettled and its report is delivered by
     * undelivered(). No check-in clock. Refused, before anything is written, at the concurrency limit.
     */
    adopt({ id, sessionId, description, model: turnModel, done }) {
      if (runningCount() >= limits.concurrent) return { error: `${runningCount()} subagents are already running (limit ${limits.concurrent})` };
      q('INSERT INTO agents (id, parent_session, session_id, spawn_call, description, prompt, model, status, created_at, checkin_ms, owner_pid, caller, door) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, 0, ?, ?, ?)')
        .run(id, parentSessionId, sessionId, String(description || 'background turn').slice(0, 200), turnModel || model, 'running', now(), process.pid, 'subagent-build', door()?.grant || '');
      const entry = { controller: new AbortController(), waiters: [], queue: [], running: true };
      live.set(id, entry);
      entry.promise = Promise.resolve(done).then((r = {}) => {
        finish.run(r.status || 'done', String(r.result ?? '').slice(0, limits.resultChars), JSON.stringify(r.usage || {}), r.cost ?? null, Number(r.calls) || 0, now(), r.stopReason ?? null, id);
      }, (error) => { finish.run('failed', `[runner error: ${error?.message || error}]`, null, null, 0, now(), null, id); })
        .finally(() => { entry.running = false; live.delete(id); for (const w of entry.waiters) w(); settledNow(id); });
      return { agent_id: id, signal: entry.controller.signal, queue: entry.queue };
    },
    pendingReports() { return q("SELECT COUNT(*) AS n FROM agents WHERE parent_session = ? AND status != 'running' AND delivered_at IS NULL").get(parentSessionId).n; },
    undelivered() {
      const rows = q("SELECT * FROM agents WHERE parent_session = ? AND status != 'running' AND delivered_at IS NULL ORDER BY ended_at").all(parentSessionId);
      const stamp = q('UPDATE agents SET delivered_at = ? WHERE id = ?');
      for (const row of rows) stamp.run(now(), row.id);
      return rows.map(describe);
    },
    running() { return q("SELECT id, description, created_at FROM agents WHERE parent_session = ? AND status = 'running'").all(parentSessionId); },
    checkIns() {
      const at = now(), atMs = Date.parse(at), due = [];
      for (const row of runningRows()) {
        const item = checkInDue(row, atMs, limits.checkInMs);
        if (!item) continue;
        stampCheck.run(at, row.id);
        const last = lastActivity.get(row.session_id);
        let digest = null;
        try { digest = progressDigest(db, row, { atMs, sinceMs: Date.parse(row.checked_at || row.created_at) }).text; }
        catch (error) { process.stderr.write(`[rev6 agents] progress digest for ${row.id} failed: ${error.message}\n`); }
        due.push({ ...item, calls: row.calls, resumes: row.resumes, last_activity: last ? `${last.kind} at ${last.created_at}` : null, expected_minutes: row.expected_minutes ?? null, digest });
      }
      return due;
    },
    nextCheckInAt() {
      if (!(limits.checkInMs > 0)) return null;
      let soonest = null;
      for (const row of runningRows()) {
        const every = row.checkin_ms === null || row.checkin_ms === undefined ? limits.checkInMs : Number(row.checkin_ms);
        const since = Date.parse(row.checked_at || row.created_at);
        if (!(every > 0) || !Number.isFinite(since)) continue;
        if (soonest === null || since + every < soonest) soonest = since + every;
      }
      return soonest;
    },
    cancelAll() { for (const [, entry] of live) if (entry.running) { entry.controller.abort(); try { entry.tools?.abortForeground?.(); } catch { /* best effort */ } } },
    async settled() { await Promise.all([...live.values()].map((e) => e.promise).filter(Boolean)); },
  };
}
