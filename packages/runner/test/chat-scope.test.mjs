// Which chats may write into the instance's memory store (rev6/pull/chat-scope.mjs, one rule with the intake's transcript claim).
// A team instance (scopes on, write scope `team`) must not store the words of a personal-scope chat: the store files every
// row under the instance's own group, which syncs to every member. With scopes off the runner writes every chat, as it always did.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatScopeVerdict, runnerChatVerdict } from '../rev6/pull/chat-scope.mjs';
import { drainPushes } from '../rev6/pull/pushq.mjs';
import { openLedger } from '../rev6/pull/ledger.mjs';
import { createRunner } from '../rev6/pull/pull.mjs';

const NOW = '2026-11-08T21:00:00Z';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function instance(t, { scopesOn = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tophat-chat-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, 'events.sqlite'));
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, session_id TEXT, scope TEXT)');
  const add = db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)');
  for (const [id, scope] of [['c-plain', ''], ['c-legacy', 'legacy'], ['c-team', 'team'], ['c-open', 'commons'], ['c-personal', 'personal:sam'], ['c-founders', 'founders'], ['c-unknown', 'nowhere']]) add.run(id, id, `s-${id}`, scope);
  db.close();
  writeFileSync(path.join(dir, 'scopes.json'), JSON.stringify({ version: 1, accounts: {}, scopes: { 'personal:sam': { kind: 'personal' }, commons: { kind: 'group', everyone: true }, founders: { kind: 'group', members: ['sam'] } } }));
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(scopesOn ? { scopes: { enabled: true, registryFile: path.join(dir, 'scopes.json') } } : { version: 1 }));
  return { dir, env: { HOME: dir, TOPHAT_CONFIG: path.join(dir, 'config.json'), WEBCHAT_DB: path.join(dir, 'events.sqlite'), TOPHAT_SCOPE: 'team' } };
}

test('scopes on: unscoped, legacy, the write scope and an everyone group are admitted; personal, member-limited and unknown scopes are refused for good', (t) => {
  const { env } = instance(t);
  for (const id of ['c-plain', 'c-legacy', 'c-team', 'c-open']) assert.equal(chatScopeVerdict([id], env), null, id);
  for (const id of ['c-personal', 'c-founders', 'c-unknown']) {
    const v = chatScopeVerdict([`s-${id}`], env);
    assert.equal(v.retry, false, id);
    assert.match(v.why, /is not open to everyone/);
  }
  assert.equal(runnerChatVerdict('other-session', { ...env, TOPHAT_CONVERSATION_ID: 'c-team' }), null);
  assert.equal(chatScopeVerdict(['not-a-chat'], env).retry, true, 'a chat the store cannot place is refused for now, never admitted');
});

test('scopes off: every chat is admitted without opening the webchat store', (t) => {
  const { env, dir } = instance(t, { scopesOn: false });
  for (const id of ['c-plain', 'c-personal', 'c-unknown', 'not-a-chat']) assert.equal(chatScopeVerdict([id], { ...env, WEBCHAT_DB: path.join(dir, 'missing.sqlite') }), null, id);
});

function drained(t, sessionId, env) {
  const ledger = openLedger(path.join(env.HOME, `ledger-${sessionId}.sqlite`));
  t.after(() => ledger.close());
  ledger.append(sessionId, 'user', 'owner', [{ type: 'text', text: 'a private plan' }], NOW);
  ledger.append(sessionId, 'assistant', 'assistant', [{ type: 'text', text: 'noted' }], NOW);
  ledger.queuePush(sessionId, 0, ledger.lastSeq(sessionId), NOW);
  const calls = [], stored = new Map();
  const cli = async (command, payload) => {
    calls.push(command);
    if (command === 'read') return { ok: true, raw: stored.has(payload.id) ? { processed: false } : undefined };
    if (command === 'ingest') { for (const r of payload.records) stored.set(r.id, r); return { ok: true, stored: payload.records.map((r) => r.id), duplicates: [], rejected: [] }; }
    return { ok: false, reason: 'unexpected' };
  };
  return { ledger, calls, stored, run: () => drainPushes({ ledger, sessionId, env, now: () => NOW, cli }) };
}

test('turn drain: scopes off ingests as before; scopes on a personal chat writes nothing, a team chat is written, an unplaced chat stays pending', async (t) => {
  const off = instance(t, { scopesOn: false }), a = drained(t, 's-c-personal', off.env);
  await a.run();
  assert.equal(a.stored.size, 2);
  assert.equal(a.ledger.allPending().length, 0);
  const on = instance(t), personal = drained(t, 's-c-personal', on.env);
  await personal.run();
  assert.deepEqual(personal.calls, []);
  assert.equal(personal.ledger.allPending().length, 0, 'settled: a refusal for good is not retried');
  const team = drained(t, 's-c-team', on.env);
  await team.run();
  assert.equal(team.stored.size, 2);
  const unplaced = drained(t, 's-unplaced', on.env);
  await unplaced.run();
  assert.deepEqual(unplaced.calls, []);
  assert.equal(unplaced.ledger.allPending().length, 1);
});

// ---- the runner: the owner's words ahead of the turn and the chat work item.
function runner(t, env0, sessionId, conversation, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-scope-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'key'), 'sk-ant-api03-synthetic0123456789', { mode: 0o600 });
  const ledger = openLedger(path.join(dir, 'runner.sqlite'));
  const jobs = { adopt: () => ({ job_id: 'j' }), undelivered: () => [], running: () => [], stopAll() {} };
  const toolsStub = () => ({ ready: async () => {}, computerPrompt: () => null, specs: [], jobs, mail: null, roots: ['/'], confined: false, closeBrowser: async () => {}, setPermissionMode() {}, abortForeground() {}, async run() { return { content: '', isError: false }; } });
  const streamStub = async (request) => ({ id: 'm1', model: request.model, role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  const calls = [];
  const memoryCli = async (command, payload) => { calls.push({ command, op: payload?.op, thread: payload?.records?.[0]?.thread }); return { ok: true, stored: (payload?.records || []).map((r) => r.id), duplicates: [], rejected: [] }; };
  const env = { ...env0, TOPHAT_CONVERSATION_ID: conversation, TOPHAT_TIMEZONE: 'America/Los_Angeles', TOPHAT_RUNNER_API_KEY_FILE: path.join(dir, 'key'), TOPHAT_STATE_DIR: path.join(dir, 'state'), TOPHAT_RUNNER_RUNNER_DB: path.join(dir, 'runner.sqlite'),
    TOPHAT_RUNNER_DB: path.join(dir, 'memory.sqlite'), TOPHAT_RUNNER_GOALS_DIR: path.join(dir, 'goals'), TOPHAT_RUNNER_PUSH: '0', TOPHAT_RUNNER_AGENTS: '0', TOPHAT_RUNNER_VISION: '0', TOPHAT_RUNNER_GOAL_HOOK: '0', TOPHAT_RUNNER_CHAT_TOOLS: '0',
    TOPHAT_RUNNER_NO_RETRIEVAL: '1', TOPHAT_REV6_PREFETCH_WAIT_MS: '0', ...extra };
  const r = createRunner({ args: { sessionId, model: 'fake-model', cwd: path.join(dir, 'work'), addDirs: [] }, ledger, env, write: () => {}, factories: { tools: toolsStub, streamMessage: streamStub, memoryCli, prefetchPasses: () => [] } });
  t.after(() => { try { r.stopKeepLedger(); ledger.close(); } catch { /* closed */ } });
  return { r, calls };
}
async function ownerTurn(h) {
  h.r.start();
  h.r.handle({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a private plan' }] } });
  await sleep(5); await h.r.settled();
}

const writes = (h) => h.calls.filter((c) => ['ingest', 'tasks', 'push', 'apply'].includes(c.command));

test('runner, TOPHAT_RUNNER_TRANSCRIPTS=0: nothing of a chat reaches the store, in any scope (the words ahead of the turn, the work item, the turn drain)', async (t) => {
  const open = { TOPHAT_RUNNER_PUSH: undefined, TOPHAT_RUNNER_GOAL_HOOK: undefined };
  // control: scopes off and the switch unset, the chat's words are ingested ahead of the turn and again by the drain
  const control = runner(t, instance(t, { scopesOn: false }).env, 's-c-plain', 'c-plain', open);
  await ownerTurn(control); await sleep(60);
  assert.ok(writes(control).some((c) => c.command === 'ingest'), 'the control writes');
  for (const [scopesOn, id] of [[false, 'c-plain'], [true, 'c-team'], [true, 'c-plain']]) {
    const h = runner(t, instance(t, { scopesOn }).env, `s-${id}`, id, { ...open, TOPHAT_RUNNER_TRANSCRIPTS: '0' });
    await ownerTurn(h); await sleep(60);
    assert.deepEqual(h.calls.filter((c) => c.command !== 'search' && c.command !== 'read' && c.command !== 'status'), [], `${id}, scopes ${scopesOn ? 'on' : 'off'}: no store write and no drain`);
  }
});
