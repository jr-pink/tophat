// Door lineage end to end, through the real runner (createRunner) and the real subagent registry (agents.mjs), with a fake model.
// The owner, 2026-11-14 20:57 PST: "we should just track that the thing started by something with a grant also gets a grant", "its like
// recursive children"; 22:56: "fix it and make it correct". A turn no owner message started (a subagent report or check-in, a background
// turn report, background job results riding a wake) runs under the grant of what woke it, never the stale grant of the owner's last message;
// a report delivered inside a running turn leaves that turn's grant alone; a turn moved to the background keeps its own grant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../rev6/pull/ledger.mjs';
import { createJobs } from '../rev6/pull/tools.mjs';
import { createRunner } from '../rev6/pull/pull.mjs';
import { INBOX_RULE } from '../rev6/base/inbox-rule.mjs';

const NOTICE = (g) => `[Automated event from home-mac: this turn has a door into home-mac, as his user. Tool: /Users/p/.tophat-doors/c1/door (\`/Users/p/.tophat-doors/c1/door help\`). Commands start in /r. (door grant ${g}).]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const reply = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
let callN = 0;
const call = (name, input) => ({ content: [{ type: 'tool_use', id: `toolu_${++callN}`, name, input }], stop_reason: 'tool_use' });

/** The text of the request's last user message and whether it answers a tool call. */
function lastUser(request) {
  const m = [...request.messages].reverse().find((x) => x.role === 'user');
  const parts = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }];
  return { text: parts.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? JSON.stringify(p.content) : '')).join('\n'), answered: parts.some((p) => p.type === 'tool_result') };
}

/**
 * A runner over a temp ledger. `root(request, u)` scripts the root model (u = lastUser); a child's model waits for `holds[description]`
 * (when set) and then reports "child done". Tools: Agent (the real registry), shell with background (real jobs), hold (waits holds.tool).
 */
function harness(t, root, { minGeneratingMs = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rev6-door-lineage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'work'), { recursive: true });
  writeFileSync(join(dir, 'key'), 'sk-ant-api03-synthetic0123456789', { mode: 0o600 });
  const ledger = openLedger(join(dir, 'runner.sqlite'));
  const holds = {};
  const stream = async (request, { onEvent, signal } = {}) => {
    const child = /^Task description: (.*)\.$/u.exec(request.system_tail || '');
    const aborted = new Promise((_, reject) => { if (signal?.aborted) reject(new Error('aborted')); signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); });
    aborted.catch(() => {});
    const out = child ? (await Promise.race([holds[child[1]]?.p, aborted]), reply(`child ${child[1]} done`)) : await root(request, lastUser(request), { onEvent });
    return { id: `m${++callN}`, model: request.model, role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 }, ...out };
  };
  const tools = (o) => {
    const jobs = createJobs(o.db, { sessionId: o.sessionId, cwd: join(dir, 'work'), env: { PATH: process.env.PATH }, door: o.door });
    return { ready: async () => {}, computerPrompt: () => null, specs: [], jobs, mail: null, roots: ['/'], confined: false, closeBrowser: async () => {}, setPermissionMode() {}, abortForeground() {},
      async run(name, input, c) {
        if (name === 'Agent') return { content: JSON.stringify(await o.agents.spawn(input, c?.id)), isError: false };
        if (name === 'shell') return { content: JSON.stringify(jobs.start('shell', input, input.command)), isError: false };
        if (name === 'hold') { await holds.tool?.p; return { content: 'held', isError: false }; }
        return { content: `no ${name}`, isError: true };
      } };
  };
  const env = { HOME: dir, TOPHAT_CONVERSATION_ID: 'c-door', TOPHAT_TIMEZONE: 'America/Los_Angeles', TOPHAT_RUNNER_API_KEY_FILE: join(dir, 'key'), TOPHAT_STATE_DIR: join(dir, 'state'),
    TOPHAT_RUNNER_RUNNER_DB: join(dir, 'runner.sqlite'), TOPHAT_RUNNER_DB: join(dir, 'memory.sqlite'), TOPHAT_RUNNER_GOALS_DIR: join(dir, 'goals'), TOPHAT_RUNNER_PUSH: '0', TOPHAT_RUNNER_VISION: '0',
    TOPHAT_RUNNER_GOAL_HOOK: '0', TOPHAT_RUNNER_CHAT_TOOLS: '0', TOPHAT_RUNNER_NO_RETRIEVAL: '1', TOPHAT_REV6_PREFETCH_WAIT_MS: '0', TOPHAT_RUNNER_TRANSCRIPTS: '0', TOPHAT_CONFIG: join(dir, 'no-config.json') };
  const r = createRunner({ args: { sessionId: 'root', model: 'fake-model', cwd: join(dir, 'work'), addDirs: [] }, ledger, env, write: () => {},
    factories: { tools, streamMessage: stream, memoryCli: async () => ({ ok: false, reason: 'test' }), prefetchPasses: () => [], ...(minGeneratingMs === null ? {} : { backgroundMinGeneratingMs: () => minGeneratingMs }) } });
  t.after(async () => { try { r.stopKeepLedger(); await sleep(30); ledger.close(); } catch { /* closed */ } });
  r.start();
  const say = (text) => r.handle({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  const owner = async (text) => { say(text); await sleep(5); await r.settled(); };
  const agent = (description) => ledger.db.prepare('SELECT * FROM agents WHERE description = ?').get(description);
  const until = async (pred, label, ms = 8000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(10); } };
  return { r, ledger, holds, say, owner, agent, until };
}

test('a model switch mid-turn applies to the next message; the running turn finishes on the model it started with', async (t) => {
  const seen = [];
  const g = gate();
  let n = 0;
  const h = harness(t, async (request) => {
    seen.push(request.model);
    n += 1;
    if (n === 1) { await g.p; return call('hold', {}); }
    return reply('done');
  });
  h.say('first');
  await h.until(() => seen.length === 1, 'first request');
  h.r.handle({ type: 'control_request', request_id: 'r1', request: { subtype: 'set_model', model: 'claude-sonnet-4-6' } });
  g.open();
  await h.until(() => seen.length >= 2, 'second request of the same turn');
  assert.equal(seen[1], seen[0], 'the running turn keeps its model');
  h.holds.tool?.open?.();
  await h.r.settled();
  const before = seen.length;
  await h.owner('second');
  assert.notEqual(seen[before], seen[0], 'the next message runs on the new model');
});
