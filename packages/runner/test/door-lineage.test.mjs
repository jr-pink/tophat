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

const NOTICE = (g) => `[Automated event from home-mac: this turn has a door into home-mac, as his user. Tool: /Users/p/.tophat-doors/c1/${g}/door (\`/Users/p/.tophat-doors/c1/${g}/door help\`). Commands start in /r.]`;
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

/** Asserts a subagent row ran under `grant`: tagged with it, and its brief carries that grant's door line and no other door. */
function underGrant(row, grant, label) {
  assert.ok(row, `${label}: no such subagent`);
  assert.equal(row.door, grant, `${label}: tagged ${row.door || '(none)'}, not ${grant}`);
  if (grant) assert.ok(row.prompt?.includes(NOTICE(grant)), `${label}: the brief carries the ${grant} door line`);
  for (const other of ['g1', 'g2', 'g3'].filter((g) => g !== grant)) assert.ok(!String(row.prompt ?? '').includes(`/${other}/door`), `${label}: the brief names no ${other} door`);
}

test('a subagent report that wakes the idle runner runs under the reporting subagent\'s grant, not the grant of the owner\'s later message', async (t) => {
  const h = harness(t, (req, u) => {
    if (u.answered) return reply('ok');
    if (u.text.includes('Subagent report context')) return call('Agent', { description: 'after-report', prompt: 'follow up on the report' });
    if (u.text.includes('spawn first')) return call('Agent', { description: 'first', prompt: 'do the first thing' });
    return reply('ok');
  });
  h.holds.first = gate();
  await h.owner(`spawn first\n\n${NOTICE('g1')}`);
  underGrant(h.agent('first'), 'g1', 'spawned by the owner\'s g1 message');
  await h.owner(`just chatting\n\n${NOTICE('g2')}`);
  h.holds.first.open();
  await h.until(() => h.agent('after-report'), 'the report wake to spawn');
  underGrant(h.agent('after-report'), 'g1', 'spawned by the turn the g1 subagent\'s report woke');
  await h.r.settled();
  // recursive: the g1 child's report wakes again under g1, two levels down
  await h.until(() => h.agent('after-report').status !== 'running', 'the grandchild to end');
});

test('a check-in of a running g1 subagent wakes the idle runner under g1', async (t) => {
  let spawned = false;
  const h = harness(t, (req, u) => {
    if (u.answered) return reply('ok');
    if (u.text.includes('Subagent check-in context') && !spawned) { spawned = true; return call('Agent', { description: 'after-checkin', prompt: 'look into the slow one' }); }
    if (u.text.includes('spawn slow')) return call('Agent', { description: 'slow', prompt: 'take a while', check_in_seconds: 0.4 });
    return reply('ok');
  });
  h.holds.slow = gate(); h.holds['after-checkin'] = gate();
  t.after(() => { h.holds.slow.open(); h.holds['after-checkin'].open(); });
  await h.owner(`spawn slow\n\n${NOTICE('g1')}`);
  underGrant(h.agent('slow'), 'g1', 'spawned by the owner\'s g1 message');
  await h.owner(`just chatting\n\n${NOTICE('g2')}`);
  await h.until(() => h.agent('after-checkin'), 'the check-in wake to spawn');
  underGrant(h.agent('after-checkin'), 'g1', 'spawned by the turn the g1 subagent\'s check-in woke');
});

test('background job results riding a wake: the job\'s grant governs when the waking subagent ran under none', async (t) => {
  const h = harness(t, (req, u) => {
    if (u.answered) return reply('ok');
    if (u.text.includes('Subagent report context')) return call('Agent', { description: 'after-job', prompt: 'act on the job output' });
    if (u.text.includes('start job')) return call('shell', { command: 'sleep 0.3; echo JOB-OUT', background: true });
    if (u.text.includes('spawn doorless')) return call('Agent', { description: 'doorless', prompt: 'no door here' });
    return reply('ok');
  });
  await h.owner(`start job\n\n${NOTICE('g1')}`);
  const job = h.ledger.db.prepare('SELECT * FROM jobs').get();
  assert.equal(job.door, 'g1');
  h.holds.doorless = gate();
  await h.owner('spawn doorless'); // a message of the owner's with no door: work under none
  underGrant(h.agent('doorless'), '', 'spawned by the owner\'s doorless message');
  await h.until(() => h.ledger.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status !== 'running', 'the job to end');
  h.holds.doorless.open();
  await h.until(() => h.agent('after-job'), 'the wake to spawn');
  const woke = h.ledger.db.prepare("SELECT content FROM messages WHERE session_id = 'root' AND kind = 'injected' AND content LIKE '%Background job context%'").get();
  assert.ok(woke?.content.includes(job.id), 'the job result was delivered by that wake');
  underGrant(h.agent('after-job'), 'g1', 'spawned by the wake that delivered the g1 job');
});

test('a report delivered inside a running turn, at a step boundary or as an automated event, leaves that turn\'s grant alone', async (t) => {
  let step = 0;
  const h = harness(t, (req, u) => {
    if (u.text.includes('spawn first') && !u.answered) return call('Agent', { description: 'first', prompt: 'do the first thing' });
    if (step > 0 || u.text.includes('hold then spawn')) { step += 1; return step === 1 ? call('hold', {}) : step === 2 ? call('Agent', { description: 'mid-turn', prompt: 'spawned after the report' }) : reply('ok'); }
    return reply('ok');
  });
  h.holds.first = gate(); h.holds.tool = gate();
  await h.owner(`spawn first\n\n${NOTICE('g1')}`);
  const first = h.agent('first');
  h.say(`hold then spawn\n\n${NOTICE('g2')}`);
  await h.until(() => step === 1, 'the hold call');
  h.holds.first.open();
  await h.until(() => h.agent('first').status !== 'running', 'the g1 subagent to end');
  // the webchat's inbound path delivers an automated event naming the g1 subagent while the g2 turn runs
  h.say(`[Subagent report context for the assistant, not owner-visible]\nsubagent ${first.id} (first) is done.\n\n${INBOX_RULE}`);
  await sleep(150); // past the settle wake, which must not fire while the turn runs
  h.holds.tool.open();
  await h.until(() => h.agent('mid-turn'), 'the spawn after the report');
  await h.r.settled();
  underGrant(h.agent('mid-turn'), 'g2', 'spawned by the g2 turn after a g1 report arrived inside it');
});

test('an automated event naming a g1 subagent that arrives at an idle runner starts its turn under g1', async (t) => {
  const h = harness(t, (req, u) => {
    if (u.answered) return reply('ok');
    if (u.text.includes('relayed report')) return call('Agent', { description: 'after-relay', prompt: 'act on the relayed report' });
    if (u.text.includes('spawn first')) return call('Agent', { description: 'first', prompt: 'do the first thing', wait: true });
    return reply('ok');
  });
  await h.owner(`spawn first\n\n${NOTICE('g1')}`);
  const first = h.agent('first');
  await h.owner(`just chatting\n\n${NOTICE('g2')}`);
  await h.owner(`[Subagent report context for the assistant, not owner-visible]\nrelayed report: subagent ${first.id} (first) is done.\n\n${INBOX_RULE}`);
  underGrant(h.agent('after-relay'), 'g1', 'spawned by the turn the relayed g1 report started');
});

test('a turn moved to the background keeps its own grant: the Agent call it was streaming when the owner typed is tagged g1, and its report wakes under g1', async (t) => {
  const streaming = gate(), release = gate();
  const h = harness(t, async (req, u, { onEvent }) => {
    if (u.text.includes('Background turn report context') && !u.answered) return call('Agent', { description: 'after-bg', prompt: 'act on the background turn' });
    if (u.answered) return reply('ok');
    if (u.text.includes('long work')) {
      onEvent?.({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'starting the subagent' } });
      streaming.open();
      await release.p;
      onEvent?.({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '.' } });
      return call('Agent', { description: 'from-bg', prompt: 'launched while he typed' });
    }
    return reply('ok');
  }, { minGeneratingMs: 0 });
  h.say(`long work\n\n${NOTICE('g1')}`);
  await streaming.p; await sleep(20);
  h.say(`something else\n\n${NOTICE('g2')}`);
  await h.until(() => h.ledger.db.prepare("SELECT 1 FROM agents WHERE id LIKE 'bgturn_%'").get(), 'the turn to move to the background');
  const bg = h.ledger.db.prepare("SELECT * FROM agents WHERE id LIKE 'bgturn_%'").get();
  assert.equal(bg.door, 'g1', 'the background turn row keeps g1');
  release.open();
  await h.until(() => h.agent('from-bg'), 'the background turn\'s Agent call');
  underGrant(h.agent('from-bg'), 'g1', 'spawned by the g1 turn after it moved to the background under the owner\'s g2 message');
  await h.until(() => h.agent('after-bg'), 'the background turn report wake');
  underGrant(h.agent('after-bg'), 'g1', 'spawned by the turn the g1 background turn\'s report woke');
});

test('a wake whose cause ran under no door runs under none, not under the grant of the owner\'s last message; so does an automated event naming no cause', async (t) => {
  const h = harness(t, (req, u) => {
    if (u.answered) return reply('ok');
    if (u.text.includes('Subagent report context')) return call('Agent', { description: 'after-doorless', prompt: 'act on the doorless report' });
    if (u.text.includes('push wake')) return call('Agent', { description: 'after-push', prompt: 'act on the push wake' });
    if (u.text.includes('spawn doorless')) return call('Agent', { description: 'doorless', prompt: 'no door here' });
    return reply('ok');
  });
  h.holds.doorless = gate();
  await h.owner('spawn doorless');
  underGrant(h.agent('doorless'), '', 'spawned by the owner\'s doorless message');
  await h.owner(`just chatting\n\n${NOTICE('g2')}`);
  h.holds.doorless.open();
  await h.until(() => h.agent('after-doorless'), 'the report wake to spawn');
  underGrant(h.agent('after-doorless'), '', 'spawned by the wake of a subagent that ran under no door');
  await h.r.settled();
  await h.owner(`just chatting again\n\n${NOTICE('g2')}`);
  await h.owner(`[Automated event: push wake, a new email arrived]\n\n${INBOX_RULE}`);
  underGrant(h.agent('after-push'), '', 'spawned by a push wake, which has no lineage to the owner\'s g2 message');
});
