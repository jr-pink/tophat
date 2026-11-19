// A finished subagent that is resumed (agent_send) reports again, and that report wakes the parent (2026-11-15: agent_887d19e8 finished at
// 08:34Z, the parent resumed it, the second run ended at 08:45Z and the parent was not woken until the owner asked "status?" at 19:49Z: the
// launch kept the first run's delivered_at, so the second report counted as delivered). Also: a turn that ends with goal items open only
// because a subagent is running gets a turn back when that subagent ends, even if its report was already taken; and reports taken for a
// wake that then failed are handed back. Run with npm test (hermetic env).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../rev6/pull/ledger.mjs';
import { createAgents } from '../rev6/pull/agents.mjs';
import { createRunner } from '../rev6/pull/pull.mjs';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const reply = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
let callN = 0;
const call = (name, input) => ({ content: [{ type: 'tool_use', id: `toolu_${++callN}`, name, input }], stop_reason: 'tool_use' });
function lastUser(request) {
  const m = [...request.messages].reverse().find((x) => x.role === 'user');
  const parts = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }];
  return { text: parts.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? JSON.stringify(p.content) : '')).join('\n'), answered: parts.some((p) => p.type === 'tool_result') };
}

function harness(t, root, { goals = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rev6-resume-wake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'work'), { recursive: true });
  writeFileSync(join(dir, 'key'), 'sk-ant-api03-synthetic0123456789', { mode: 0o600 });
  const ledger = openLedger(join(dir, 'runner.sqlite'));
  const runs = {}, gates = {}, rootSeen = [];
  const stream = async (request, { signal } = {}) => {
    const child = /^Task description: (.*)\.$/u.exec(request.system_tail || '');
    let out;
    if (child) {
      const d = child[1], n = (runs[d] = (runs[d] || 0) + 1);
      await Promise.race([gates[`${d}#${n}`]?.p, new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))]);
      out = reply(`child ${d} report run ${n}`);
    } else { const u = lastUser(request); rootSeen.push(u.text); out = await root(request, u); }
    return { id: `m${++callN}`, model: request.model, role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 }, ...out };
  };
  const tools = (o) => ({ ready: async () => {}, computerPrompt: () => null, specs: [], jobs: { running: () => [], undelivered: () => [], stopAll() {}, redeliver() {} }, mail: null, roots: ['/'], confined: false,
    closeBrowser: async () => {}, setPermissionMode() {}, abortForeground() {},
    async run(name, input, c) {
      if (name === 'Agent') return { content: JSON.stringify(await o.agents.spawn(input, c?.id)), isError: false };
      if (name === 'agent_send') return { content: JSON.stringify(await o.agents.send(input)), isError: false };
      return { content: `no ${name}`, isError: true };
    } });
  const env = { HOME: dir, TOPHAT_CONVERSATION_ID: 'c-resume', TOPHAT_TIMEZONE: 'America/Los_Angeles', TOPHAT_RUNNER_API_KEY_FILE: join(dir, 'key'), TOPHAT_STATE_DIR: join(dir, 'state'),
    TOPHAT_RUNNER_RUNNER_DB: join(dir, 'runner.sqlite'), TOPHAT_RUNNER_DB: join(dir, 'memory.sqlite'), TOPHAT_RUNNER_GOALS_DIR: join(dir, 'goals'), TOPHAT_RUNNER_PUSH: '0', TOPHAT_RUNNER_VISION: '0',
    TOPHAT_RUNNER_GOAL_HOOK: goals ? '1' : '0', TOPHAT_RUNNER_CHAT_TOOLS: '0', TOPHAT_RUNNER_NO_RETRIEVAL: '1', TOPHAT_REV6_PREFETCH_WAIT_MS: '0', TOPHAT_RUNNER_TRANSCRIPTS: '0', TOPHAT_RUNNER_AGENT_CHECKIN_MS: 'off', TOPHAT_CONFIG: join(dir, 'no-config.json') };
  const r = createRunner({ args: { sessionId: 'root', model: 'fake-model', cwd: join(dir, 'work'), addDirs: [] }, ledger, env, write: () => {},
    factories: { tools, streamMessage: stream, memoryCli: async () => ({ ok: false, reason: 'test' }), prefetchPasses: () => [], ...(goals ? { goals: () => goals } : {}) } });
  t.after(async () => { try { r.stopKeepLedger(); await sleep(30); ledger.close(); } catch { /* closed */ } });
  r.start();
  const owner = async (text) => { r.handle({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }); await sleep(5); await r.settled(); };
  const agent = (d) => ledger.db.prepare('SELECT * FROM agents WHERE description = ?').get(d);
  const until = async (pred, label, ms = 8000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(10); } };
  return { r, ledger, gates, rootSeen, agent, owner, until };
}

test('a resumed subagent reports again and its second report wakes the idle parent', async (t) => {
  let resumed = false;
  const h = harness(t, (req, u) => {
    if (u.answered) return reply('ok');
    if (u.text.includes('child first report run 2')) return reply('second report seen');
    if (u.text.includes('child first report run 1') && !resumed) { resumed = true; return call('agent_send', { agent_id: h.agent('first').id, text: 'carry on' }); }
    if (u.text.includes('spawn first')) return call('Agent', { description: 'first', prompt: 'do the first thing' });
    return reply('ok');
  });
  h.gates['first#1'] = gate(); h.gates['first#2'] = gate();
  t.after(() => { h.gates['first#1'].open(); h.gates['first#2'].open(); });
  await h.owner('spawn first');
  h.gates['first#1'].open();
  await h.until(() => h.rootSeen.some((x) => x.includes('child first report run 1')), 'the first report wake');
  await h.until(() => h.agent('first').status === 'running', 'the resume');
  assert.equal(h.agent('first').delivered_at, null, 'a relaunch clears the stamp of the run before');
  await h.r.settled();
  h.gates['first#2'].open();
  await h.until(() => h.rootSeen.some((x) => x.includes('child first report run 2')), 'the second report to wake the parent');
});

test('open goals deferred to a running subagent get a turn when it ends, even when its report was already taken', async (t) => {
  const goals = { read: () => ({ hook: 'on', has_goals: true, items: [{ id: 'g1', text: 'finish the thing', status: 'todo' }] }) };
  const h = harness(t, (req, u) => (u.answered ? reply('ok') : u.text.includes('spawn first') ? call('Agent', { description: 'first', prompt: 'work' }) : reply('ok')), { goals });
  h.gates['first#1'] = gate();
  t.after(() => h.gates['first#1'].open());
  await h.owner('spawn first');
  await sleep(50);
  const before = h.rootSeen.length;
  h.gates['first#1'].open();
  // the report is taken (as agent_wait does) before the settle wake looks at it
  await h.until(() => h.agent('first').status === 'done', 'the child to end');
  h.ledger.db.prepare("UPDATE agents SET delivered_at = '9999-01-01T00:00:00.000Z' WHERE id = ?").run(h.agent('first').id);
  await h.until(() => h.rootSeen.length > before, 'the parent to get a turn after the child ended');
  assert.ok(h.rootSeen.slice(before).some((x) => x.includes('still has open items')), h.rootSeen.slice(before).join('\n---\n'));
});

test('reports taken for a wake that failed are handed back; a stale stamp from an earlier run never hides a later end', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rev6-resume-wake-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = openLedger(join(dir, 'runner.sqlite'));
  t.after(() => ledger.close());
  const reg = createAgents({ ledger, parentSessionId: 'p', cwd: dir, env: {}, now: () => '2026-11-15T08:45:07.000Z' });
  const ins = ledger.db.prepare("INSERT INTO agents (id, parent_session, session_id, description, prompt, model, status, created_at, ended_at, delivered_at, result) VALUES (?, 'p', ?, 'd', 'x', 'm', 'done', '2026-11-15T08:00:00.000Z', ?, ?, 'r')");
  ins.run('a_stale', 'p/agent/a_stale', '2026-11-15T08:45:07.000Z', '2026-11-15T08:34:35.000Z');   // second run ended after the first delivery
  ins.run('a_taken', 'p/agent/a_taken', '2026-11-15T08:34:35.000Z', '2026-11-15T08:34:36.000Z');   // delivered after it ended
  assert.equal(reg.pendingReports(), 1);
  assert.deepEqual(reg.undelivered().map((a) => a.agent_id), ['a_stale']);
  assert.equal(reg.pendingReports(), 0);
  reg.redeliver(['a_stale']);
  assert.equal(reg.pendingReports(), 1, 'a failed wake gives the report back');
});
