// tophat setup: the instance file it writes is valid and loopback-only, the model key lands 0600 in the instance keyring
// and never in the output, a second run keeps the file, and a run without a key says which file to fill.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../src/setup.mjs';
import { loadInstance } from '../src/instance.mjs';

const KEY = 'sk-test-0123456789abcdef-not-a-real-key';

test('setup writes a loopback instance, places the key 0600, never prints it, and is idempotent', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key'); writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  const config = path.join(dir, 'conf/tophat.instance.json');
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });
  const logs = [];
  const r = await setup({ name: 'demo', owner: 'Sam', config, keyFile, install: false, start: false, branch: false, port: 47999 }, (s) => logs.push(s));
  assert.equal(r.ok, true);
  assert.equal(r.running, false);
  assert.ok(!JSON.stringify(r).includes(KEY) && !logs.join('\n').includes(KEY), 'the key never reaches the output');
  const c = loadInstance(config);
  assert.equal(c.hosts.bind, '127.0.0.1');
  assert.equal(c.ports.webchat, 47999);
  assert.deepEqual(c.models.chat.credential, { keyring: 'anthropic-api-key' });
  assert.equal(c.runner.env.TOPHAT_RUNNER_CONFINE, '1');
  const placed = path.join(c.paths.secrets, 'anthropic-api-key');
  assert.equal(readFileSync(placed, 'utf8').trim(), KEY);
  assert.equal(statSync(placed).mode & 0o777, 0o600);
  const before = readFileSync(config, 'utf8');
  const again = await setup({ name: 'demo', config, install: false, start: false }, () => {});
  assert.equal(readFileSync(config, 'utf8'), before, 'a second run keeps the instance file');
  assert.equal(again.ok, true, 'the key placed before still counts');
});

test('setup without a key writes the instance and names the file the user fills', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });
  const config = path.join(dir, 'conf/tophat.instance.json');
  const r = await setup({ name: 'demo', config, install: false, start: false }, () => {});
  assert.equal(r.ok, false);
  assert.match(r.next[0], /secrets\/anthropic-api-key/);
  assert.match(r.next[0], /never paste it into a chat/);
});

test('setup refuses a bad instance name', async () => {
  await assert.rejects(setup({ name: 'Bad Name', install: false, start: false }, () => {}), /lower case/);
});

test('a rerun applies the options it names to the existing file (a port moved after a clash), and reads the workspace id from ANTHROPIC_CUSTOM_HEADERS', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = { k: process.env.ANTHROPIC_API_KEY, h: process.env.ANTHROPIC_CUSTOM_HEADERS };
  t.after(() => { for (const [n, v] of [['ANTHROPIC_API_KEY', saved.k], ['ANTHROPIC_CUSTOM_HEADERS', saved.h]]) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } });
  process.env.ANTHROPIC_API_KEY = KEY;
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'anthropic-workspace-id: wrk_test_123';
  const config = path.join(dir, 'conf/tophat.instance.json');
  const first = await setup({ name: 'demo', config, install: false, start: false, branch: false, port: 47990 }, () => {});
  assert.ok(!JSON.stringify(first).includes('wrk_test_123') && !JSON.stringify(first).includes(KEY));
  let c = loadInstance(config);
  assert.equal(c.ports.webchat, 47990);
  assert.deepEqual(c.models.chat.workspace, { keyring: 'anthropic-workspace-id' });
  assert.equal(readFileSync(path.join(c.paths.secrets, 'anthropic-workspace-id'), 'utf8').trim(), 'wrk_test_123');
  await setup({ name: 'demo', config, install: false, start: false, branch: false, port: 47991 }, () => {});
  c = loadInstance(config);
  assert.equal(c.ports.webchat, 47991, 'the rerun moved the port');
});

import { spawnSync } from 'node:child_process';
import { ensureUserBranch } from '../src/setup.mjs';

test('ensureUserBranch: a fresh clone on main gets the user branch; a second run and a user branch are left alone', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-branch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'upstream');
  assert.match(ensureUserBranch(dir, 'me'), /created branch me from main/);
  assert.equal(g('symbolic-ref', '--short', 'HEAD').stdout.trim(), 'me');
  assert.match(ensureUserBranch(dir, 'me'), /on branch me/);
  g('switch', '-q', 'main');
  assert.match(ensureUserBranch(dir, 'me'), /switched to branch me/);
  g('switch', '-q', 'main');
  assert.match(ensureUserBranch(dir, 'me', { branch: 'mine' }), /created branch mine/);
  assert.equal(ensureUserBranch(path.join(os.tmpdir(), 'not-a-repo-xyz'), 'me'), null);
});
