// A 4xx client error from the model API (other than 408, 409 and 429) is never retried: the same request fails the same
// way every time, so the runner stops the turn and names the refusal instead of walking the model ladder for minutes.
// Offline: the only model is rev5/fake-provider.mjs on loopback, answering HTTP 400 the way a key scoped to an
// organisation is refused without its workspace id header.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isClientError, recoveryStep } from '../rev6/pull/call.mjs';
import { ModelError, streamMessage } from '../rev6/pull/wire.mjs';
import { startFakeProvider } from '../rev5/fake-provider.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUNNER = path.join(HERE, '..'), WORKSPACE = path.join(RUNNER, '../..');
const REFUSAL = { type: 'invalid_request_error', message: 'this request is missing a required header: workspace id' };
const has = (dir, dep) => existsSync(path.join(dir, dep, 'package.json'));
const runnerModules = [process.env.TOPHAT_RUNNER_NODE_MODULES, path.join(RUNNER, 'node_modules'), path.join(WORKSPACE, 'node_modules')]
  .find((d) => d && ['linkedom', '@mozilla/readability'].every((x) => has(d, x))) ?? null;

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tophat-4xx-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fakeEnv(dir, url) {
  writeFileSync(path.join(dir, 'model-key'), 'fake-key-400\n', { mode: 0o600 });
  return { HOME: dir, TOPHAT_RUNNER_API_BASE: url, TOPHAT_RUNNER_API_KEY_FILE: path.join(dir, 'model-key'), TOPHAT_RUNNER_MODEL: 'fake-model',
    TOPHAT_RUNNER_FALLBACK_MODELS: 'fake-model-b,fake-model-c', TOPHAT_STATE_DIR: path.join(dir, 'state'), TOPHAT_CONFIG_DIR: path.join(dir, 'config') };
}

test('recoveryStep: a 4xx other than 408/409/429 stops; 408, 409, 429 and 5xx still recover', () => {
  const at = (status, reason = 'invalid', detail = `HTTP ${status} refused`) => recoveryStep({ error: new ModelError(reason, detail, { status }), attempts: 0, model: 'm', chain: ['n'], canCompact: true });
  for (const s of [400, 401, 403, 404, 422]) {
    const step = at(s, s === 401 || s === 403 ? 'auth' : 'invalid');
    assert.equal(step.action, 'stop', `HTTP ${s}`);
    assert.equal(step.terminal, 'client_error');
    assert.ok(isClientError({ status: s }));
  }
  for (const s of [408, 409, 429, 500, 529]) { assert.notEqual(at(s, s === 429 ? 'rate_limited' : 'overloaded').action, 'stop', `HTTP ${s}`); assert.ok(!isClientError({ status: s })); }
  // too large is repaired by compaction once, not refused outright; with compaction spent it stops
  assert.equal(at(400, 'invalid', 'HTTP 400 prompt is too long: 300000 tokens').action, 'compact');
  assert.equal(recoveryStep({ error: new ModelError('invalid', 'HTTP 400 prompt is too long', { status: 400 }), model: 'm', chain: ['n'], canCompact: false }).action, 'stop');
  // a transport failure with no status is unchanged: retried
  assert.equal(recoveryStep({ error: new ModelError('failed', 'ECONNRESET', { retryable: true }), model: 'm', chain: [] }).action, 'retry');
});

test('streamMessage: an HTTP 400 from the provider is one request, not a retry loop', async () => {
  const fake = await startFakeProvider({ reply: () => ({ status: 400, error: REFUSAL }), key: 'fake-key-400' });
  try {
    const env = fakeEnv(tmp(), fake.url);
    await assert.rejects(streamMessage({ model: 'fake-model', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }, { env }),
      (e) => e instanceof ModelError && e.status === 400 && !e.retryable);
    assert.equal(fake.requests.length, 1);
  } finally { await fake.close(); }
});

test('runAgent: a turn answered with HTTP 400 stops after one request and reports the refusal', { skip: !runnerModules && 'runner dependencies not installed (TOPHAT_RUNNER_NODE_MODULES)', timeout: 60_000 }, async () => {
  // the agent loop imports the tool set, whose dependencies live in the runner's node_modules: run a scratch copy
  const dir = tmp(), copy = path.join(dir, 'runner');
  cpSync(RUNNER, copy, { recursive: true, filter: (s) => !/\/(node_modules|test)(\/|$)/.test(s) });
  mkdirSync(path.join(copy, 'node_modules/@tophat-md'), { recursive: true });
  for (const e of readdirSync(runnerModules)) if (!e.startsWith('.') && e !== '@tophat-md') { try { symlinkSync(path.join(runnerModules, e), path.join(copy, 'node_modules', e)); } catch { /* exists */ } }
  symlinkSync(path.join(WORKSPACE, 'packages/linknotes'), path.join(copy, 'node_modules/@tophat-md/linknotes'));
  const { runAgent } = await import(path.join(copy, 'rev6/pull/loop.mjs'));
  const fake = await startFakeProvider({ reply: () => ({ status: 400, error: REFUSAL }), key: 'fake-key-400' });
  try {
    const env = fakeEnv(dir, fake.url);
    let model = 'fake-model', stopped = 0;
    const events = [], nudges = [];
    const r = await runAgent({ role: 'root', env, now: () => new Date().toISOString(), sessionId: 's-400', parent: null,
      ledger: { append() {} }, tools: { specs: [] }, getModel: () => model, setModel: (m) => { model = m; }, canCompact: true, compact: async () => {},
      request: (m) => ({ model: m, system: 'test', max_tokens: 64 }), messages: () => [{ role: 'user', content: 'order the tank' }],
      signal: () => undefined, onAborted: async () => 'stop', nudge: (t) => nudges.push(t), emit: (e) => events.push(e), onEvent() {},
      onStop: () => { stopped += 1; }, onAssistant() {}, onFinal: async () => ({}) });
    assert.equal(fake.requests.length, 1, `requests: ${fake.requests.length}; recoveries: ${JSON.stringify(events.filter((e) => e.status === 'recovering').slice(0, 3))}`);
    assert.equal(r.recoveries, 0);
    assert.equal(stopped, 1);
    assert.match(r.failure, /HTTP 400/);
    assert.match(r.failure, /workspace id/);
  } finally { await fake.close(); }
});
