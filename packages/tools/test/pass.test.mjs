// tophat-pass over a throwaway vault: read verbs, raw extraction, exit codes, and that nothing is written.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PasswordManager } from '../../runner/src/vault/manager.mjs';
import { pick, parseArgs } from '../pass/tophat-pass.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/tophat-pass.mjs');
const FAKE = 'hunter2-test-value';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-test-'));
const directory = path.join(dir, 'vault'), keyFile = path.join(dir, 'vault-master-key');
const m = new PasswordManager({ directory, keyFile });
m.save({ id: 'site-login', name: 'site', kind: 'login', origins: ['https://site.example'], value: { usernames: ['me@site'], password: FAKE } });
m.save({ id: 'api-key', name: 'api key', kind: 'secret', origins: [], value: JSON.stringify({ number: '4242', exp: '12/30' }) });
m.lock?.();
const env = { PATH: process.env.PATH, HOME: dir, TOPHAT_VAULT_DIR: directory, TOPHAT_VAULT_KEY_FILE: keyFile };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
const snapshot = () => fs.readdirSync(directory).sort().map((f) => `${f}:${fs.statSync(path.join(directory, f)).mtimeMs}`).join('|');

test('list and find print metadata and never a value', () => {
  const before = snapshot();
  for (const args of [['list'], ['find', 'site'], ['list', '--json'], ['fields', 'site-login'], ['status'], ['history']]) {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.ok(!r.stdout.includes(FAKE), args.join(' '));
  }
  assert.match(run('list').stdout, /site-login\s+login\s+site/);
  assert.equal(snapshot(), before, 'read verbs write nothing');
});
test('get --raw extracts one value; fields; ambiguity and unknown ids have their own exit codes', () => {
  assert.equal(run('get', 'site-login', '--raw', '-n').stdout, FAKE);
  assert.equal(run('get', 'site-login:username', '--raw').stdout, 'me@site\n');
  assert.equal(run('get', 'api-key:number', '--raw', '-n').stdout, '4242');
  const unknown = run('get', 'nope', '--raw');
  assert.equal(unknown.status, 3);
  assert.ok(!unknown.stderr.includes(FAKE));
  assert.equal(run('get', 'site-login', '--field', 'nosuch', '--raw').status, 3);
  assert.equal(run('bogus').status, 2);
  assert.equal(run('lookup', 'https://site.example/login').status, 0);
  assert.ok(!run('lookup', 'https://site.example/login').stdout.includes(FAKE));
  assert.ok(run('lookup', 'https://site.example/login', '--reveal').stdout.includes(FAKE));
});
test('a wrong argument is echoed only when it looks like an id', () => {
  const r = run('get', `Pass word ${FAKE}!`, '--raw');
  assert.equal(r.status, 3);
  assert.ok(!r.stderr.includes(FAKE), r.stderr);
});
test('pick and parseArgs', () => {
  assert.equal(pick('login', { usernames: ['a', 'b'], password: 'p' }, 'username'), 'a\nb');
  assert.equal(pick('login', { password: 'p' }, null), 'p');
  assert.equal(pick('totp', { secret: 's' }, null), null);
  assert.deepEqual(parseArgs(['get', 'x', '--raw', '-n', '--field=f']).flags, { raw: true, 'no-newline': true, field: 'f' });
});
test('cdp --secret-from reads through tophat-pass', async () => {
  const { fetchVaultSecret } = await import('../cdp/browser/secrets.mjs');
  assert.equal(fetchVaultSecret('site-login', env), FAKE);
  assert.equal(fetchVaultSecret('site-login:username', env), 'me@site');
  assert.throws(() => fetchVaultSecret('nope', env), (e) => e.code === 1 && !e.message.includes(FAKE));
});
