// The demo's required instance settings come from seed/instance-policy.json: applying them is idempotent, keeps machine-specific
// values and the file mode, and a hand edit that drops one is reported by the check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyInstancePolicy, checkInstance, differences, readPolicy } from '../src/instance-config.mjs';

const dir = () => mkdtempSync(path.join(tmpdir(), 'demo-instance-'));

test('the policy carries public prompt mode and no transcript writes', () => {
  const env = readPolicy().runner.env;
  assert.equal(env.TOPHAT_RUNNER_PROMPT_MODE, 'public');
  assert.equal(env.TOPHAT_RUNNER_TRANSCRIPTS, '0');
  assert.equal(env.TOPHAT_RUNNER_TOOLS_ALLOW, 'memory_search,memory_read');
});

test('apply fills what is missing, keeps the rest and the mode, and a second run writes nothing', () => {
  const d = dir();
  try {
    const f = path.join(d, 'instance.json');
    writeFileSync(f, JSON.stringify({ name: 'x', ports: { webchat: 4471 }, runner: { env: { PATH: '/bin', TOPHAT_RUNNER_MAX_TOKENS: '900', TOPHAT_RUNNER_PROMPT_MODE: 'owner' } } }), { mode: 0o600 });
    const first = applyInstancePolicy(f);
    assert.ok(first.changed.includes('runner.env.TOPHAT_RUNNER_PROMPT_MODE') && first.changed.includes('runner.env.TOPHAT_RUNNER_TRANSCRIPTS'));
    const got = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(got.runner.env.TOPHAT_RUNNER_PROMPT_MODE, 'public');
    assert.equal(got.runner.env.PATH, '/bin');
    assert.equal(got.runner.env.TOPHAT_RUNNER_MAX_TOKENS, '900');
    assert.equal(got.ports.webchat, 4471);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(applyInstancePolicy(f), { changed: [] });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('check reports a dropped setting and any webchat row in the memory database', async () => {
  const d = dir();
  try {
    const f = path.join(d, 'instance.json'), db = path.join(d, 'memory.sqlite');
    writeFileSync(f, JSON.stringify({ runner: { env: {} } }));
    const h = new DatabaseSync(db);
    h.exec("CREATE TABLE raw_data (id TEXT, source TEXT); INSERT INTO raw_data VALUES ('a', 'tophat-docs')");
    let r = await checkInstance(f, db);
    assert.equal(r.ok, false);
    assert.ok(r.policy.some((x) => x.path === 'runner.env.TOPHAT_RUNNER_TRANSCRIPTS'));
    assert.equal(r.webchatRows, 0);
    applyInstancePolicy(f);
    assert.equal((await checkInstance(f, db)).ok, true);
    h.exec("INSERT INTO raw_data VALUES ('webchat/x/1', 'webchat')"); h.close();
    r = await checkInstance(f, db);
    assert.equal(r.ok, false);
    assert.equal(r.webchatRows, 1);
    assert.deepEqual(differences({ a: { b: 1 } }, { a: { b: 1 } }), []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
