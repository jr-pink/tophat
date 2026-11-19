// tophat-pass write verbs over a throwaway vault in a temp HOME: the live vault is never touched. Every secret here
// is invented; the checks are that values round-trip, that nothing but get/totp/recovery --spend/generate prints one,
// and that a refused or failed operation leaves the vault and the export as they were.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/tophat-pass.mjs');
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../runner/test/import-fixtures');
const PASSWORD = 'canary-password-91ac', SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-write-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, 'vault'), keyFile = path.join(home, 'vault-master-key');
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, TOPHAT_VAULT_DIR: directory, TOPHAT_VAULT_KEY_FILE: keyFile };
  const run = (args, { input = '', extra = {} } = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...env, ...extra }, input });
  const ok = (args, opts) => { const r = run(args, opts); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`); return r; };
  return { home, directory, run, ok };
}

test('set stores a login from stdin, round-trips it, and prints only metadata', (t) => {
  const { run, ok, directory } = sandbox(t);
  const set = ok(['set', 'bay-books', '--kind', 'login', '--name', 'Bay Books', '--site', 'https://books.example.test',
    '--site', 'https://www.books.example.test', '--username', 'reader-42', '--email', 'Reader@Example.test', '--group', 'reading', '--notes', 'library card'], { input: `${PASSWORD}\n` });
  assert.ok(!set.stdout.includes(PASSWORD) && !set.stderr.includes(PASSWORD));
  const row = JSON.parse(set.stdout);
  assert.deepEqual([row.id, row.kind, row.origins, row.groups], ['bay-books', 'login', ['https://books.example.test', 'https://www.books.example.test'], ['reading']]);
  assert.equal(run(['get', 'bay-books', '--raw', '-n']).stdout, PASSWORD);
  assert.equal(run(['get', 'bay-books:username', '--raw', '-n']).stdout, 'reader-42');
  assert.equal(run(['get', 'bay-books:email', '--raw', '-n']).stdout, 'reader@example.test');
  for (const args of [['list'], ['find', 'books'], ['fields', 'bay-books'], ['history'], ['lookup', 'https://books.example.test/login']]) {
    assert.ok(!run(args).stdout.includes(PASSWORD), args.join(' '));
  }
  // At rest nothing is plaintext: neither the password nor the site appears in any vault file.
  for (const name of fs.readdirSync(directory)) {
    const bytes = fs.readFileSync(path.join(directory, name));
    assert.ok(!bytes.includes(PASSWORD) && !bytes.includes('books.example.test'), name);
  }
});

test('set refuses an existing id without --overwrite, a plain-http site and an empty value, without echoing the value', (t) => {
  const { run, ok } = sandbox(t);
  ok(['set', 'one', '--kind', 'secret'], { input: 'first-secret-value' });
  const again = run(['set', 'one', '--kind', 'secret'], { input: PASSWORD });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /explicit replacement required/);
  assert.equal(run(['get', 'one', '--raw', '-n']).stdout, 'first-secret-value');
  ok(['set', 'one', '--kind', 'secret', '--overwrite'], { input: PASSWORD });
  assert.equal(run(['get', 'one', '--raw', '-n']).stdout, PASSWORD);
  const http = run(['set', 'two', '--kind', 'login', '--site', 'http://plain.example.test'], { input: PASSWORD });
  assert.equal(http.status, 1);
  assert.ok(!http.stderr.includes(PASSWORD));
  assert.equal(run(['set', 'three', '--kind', 'secret'], { input: '\n' }).status, 2);
  assert.equal(run(['set', 'four', '--kind', 'nonsense'], { input: 'x' }).status, 2);
  assert.equal(run(['set', 'Bad Id!', '--kind', 'secret'], { input: PASSWORD }).status, 1);
});

test('setpass and settotp change one field of a login and keep the rest; totp prints a code', (t) => {
  const { run, ok } = sandbox(t);
  ok(['set', 'site', '--kind', 'login', '--site', 'https://site.example.test', '--username', 'me', '--group', 'g1'], { input: 'old-password-value' });
  ok(['setpass', 'site'], { input: PASSWORD });
  ok(['settotp', 'site'], { input: SEED });
  assert.equal(run(['get', 'site', '--raw', '-n']).stdout, PASSWORD);
  assert.equal(run(['get', 'site:username', '--raw', '-n']).stdout, 'me');
  assert.equal(run(['get', 'site:totp', '--raw', '-n']).stdout, SEED);
  assert.match(run(['totp', 'site']).stdout, /^\d{6}\n$/);
  assert.deepEqual(JSON.parse(run(['list', '--json']).stdout)[0].groups, ['g1']);
  ok(['set', 'a-secret', '--kind', 'secret'], { input: 'x-value' });
  assert.equal(run(['setpass', 'a-secret'], { input: 'y' }).status, 2, 'only a login has a password to rotate');
  assert.equal(run(['settotp', 'site'], { input: 'not base32 !!' }).status, 1);
  assert.equal(run(['get', 'site:totp', '--raw', '-n']).stdout, SEED, 'a refused seed leaves the old one');
});

test('totp, recovery codes and passkey references are stored with their own shapes', (t) => {
  const { run, ok } = sandbox(t);
  ok(['set', 'bank-otp', '--kind', 'totp', '--site', 'https://bank.example.test'], { input: `otpauth://totp/Bank:me?secret=${SEED}&digits=8&period=60&algorithm=SHA256\n` });
  assert.match(run(['totp', 'bank-otp']).stdout, /^\d{8}\n$/);
  ok(['set', 'bank-codes', '--kind', 'recovery-codes'], { input: 'aaaa-1111\nbbbb-2222\ncccc-3333\n' });
  assert.deepEqual(JSON.parse(run(['recovery', 'bank-codes']).stdout).remaining, 3);
  assert.ok(!run(['recovery', 'bank-codes']).stdout.includes('aaaa-1111'), 'counting never prints a code');
  assert.equal(run(['recovery', 'bank-codes', '--spend']).stdout, 'aaaa-1111\n');
  assert.equal(run(['recovery', 'bank-codes', '--spend']).stdout, 'bbbb-2222\n');
  assert.equal(JSON.parse(run(['recovery', 'bank-codes']).stdout).remaining, 1);
  assert.equal(run(['get', 'bank-codes', '--raw', '-n']).stdout, 'cccc-3333', 'spent codes are gone for good');
  assert.equal(run(['recovery', 'bank-otp']).status, 3);
  const dup = run(['set', 'dupes', '--kind', 'recovery-codes'], { input: 'same\nsame\n' });
  assert.equal(dup.status, 1);
  const passkey = ok(['set', 'bank-passkey', '--kind', 'passkey-reference', '--rp-id', 'bank.example.test', '--provider', 'platform-authenticator', '--credential-id', 'cred-ref-1']);
  assert.equal(JSON.parse(passkey.stdout).kind, 'passkey-reference');
  assert.equal(run(['get', 'bank-passkey', '--raw', '-n']).stdout, 'platform-authenticator');
  const stored = JSON.parse(run(['get', 'bank-passkey']).stdout)[0].value;
  assert.deepEqual(stored, { rpId: 'bank.example.test', provider: 'platform-authenticator', credentialId: 'cred-ref-1' });
  assert.equal(run(['set', 'bad-passkey', '--kind', 'passkey-reference', '--rp-id', 'not a host', '--provider', 'x']).status, 1);
});

test('archive hides an entry from lists and lookups without deleting it; groups replace; forget needs --yes', (t) => {
  const { run, ok } = sandbox(t);
  ok(['set', 'old-site', '--kind', 'login', '--site', 'https://old.example.test', '--username', 'u'], { input: PASSWORD });
  ok(['archive', 'old-site']);
  assert.equal(run(['list']).stdout.trim(), '');
  assert.match(run(['list', '--archived']).stdout, /old-site.*\(archived\)/);
  assert.equal(run(['lookup', 'https://old.example.test']).status, 3);
  ok(['archive', 'old-site', '--restore']);
  assert.match(run(['list']).stdout, /old-site/);
  ok(['groups', 'old-site', '--set', 'travel, family']);
  assert.deepEqual(JSON.parse(run(['list', '--json', '--group', 'family']).stdout).map((r) => r.id), ['old-site']);
  ok(['groups', 'old-site', '--set', '']);
  assert.deepEqual(JSON.parse(run(['list', '--json']).stdout)[0].groups, []);
  assert.equal(run(['forget', 'old-site']).status, 2);
  assert.match(run(['list']).stdout, /old-site/);
  ok(['forget', 'old-site', '--yes']);
  assert.equal(run(['list']).stdout.trim(), '');
  assert.match(run(['history', 'old-site']).stdout, /forgotten/);
  assert.ok(!run(['history', 'old-site']).stdout.includes(PASSWORD));
});

test('import reads Chrome, Apple, Bitwarden and 1Password exports, deletes the export, and prints no value', (t) => {
  const { run, ok, home } = sandbox(t);
  const stage = (name) => { const copy = path.join(home, `export-${name}`); fs.copyFileSync(path.join(FIXTURES, name), copy); return copy; };
  const chrome = stage('chrome-passwords.csv');
  const first = ok(['import', chrome, '--format', 'chrome']);
  const counts = JSON.parse(first.stdout);
  assert.deepEqual([counts.imported, counts.exportDeleted], [3, true]);
  assert.ok(!fs.existsSync(chrome), 'the cleartext export is deleted after a good import');
  assert.ok(!first.stdout.includes('quiet,anchor,walnut'));
  assert.equal(JSON.parse(run(['list', '--json']).stdout).length, 3);
  const bay = JSON.parse(run(['find', 'Bay Books', '--json']).stdout)[0];
  assert.equal(run(['get', bay.id, '--raw', '-n']).stdout, 'quiet,anchor,walnut');
  // Re-importing the same rows skips them; --keep retains the file.
  const again = stage('chrome-passwords.csv');
  const repeat = JSON.parse(ok(['import', again, '--format', 'chrome', '--keep']).stdout);
  assert.deepEqual([repeat.imported, repeat.skipped, repeat.exportDeleted], [0, 3, false]);
  assert.ok(fs.existsSync(again));
  const apple = JSON.parse(ok(['import', stage('safari-passwords.csv'), '--format', 'apple']).stdout);
  assert.equal(apple.imported, 3, 'two logins and the verification code the OTPAuth column carried');
  assert.ok(run(['list']).stdout.split('\n').some((l) => /\btotp\b.*Harbor Mail verification code/.test(l)));
  const bitwarden = JSON.parse(ok(['import', stage('bitwarden-export.json'), '--format', 'bitwarden']).stdout);
  assert.ok(bitwarden.imported > 0);
  assert.ok(JSON.parse(run(['list', '--json', '--archived']).stdout).some((e) => e.archived), 'a soft-deleted Bitwarden item arrives archived');
  assert.ok(JSON.parse(run(['list', '--json']).stdout).some((e) => e.groups.includes('Shared')), 'folders become groups');
  const onepassword = JSON.parse(ok(['import', stage('1password-export.csv'), '--format', '1password']).stdout);
  assert.ok(onepassword.imported > 0);
  const csvBitwarden = JSON.parse(ok(['import', stage('bitwarden-export.csv'), '--format', 'bitwarden']).stdout);
  assert.equal(csvBitwarden.imported + csvBitwarden.skipped > 0, true);
});

test('a 1Password .1pux archive imports through unzip; a failed import keeps the export and changes nothing', { skip: !fs.existsSync('/usr/bin/zip') }, (t) => {
  const { run, ok, home } = sandbox(t);
  fs.copyFileSync(path.join(FIXTURES, '1password-export.data'), path.join(home, 'export.data'));
  execFileSync('/usr/bin/zip', ['-q', 'export.1pux', 'export.data'], { cwd: home });
  const archive = path.join(home, 'export.1pux');
  const result = JSON.parse(ok(['import', archive, '--format', '1password', '--keep']).stdout);
  assert.ok(result.imported > 0 && !result.exportDeleted);
  const second = JSON.parse(ok(['import', archive, '--format', '1pux']).stdout);
  assert.deepEqual([second.imported, second.exportDeleted], [0, true]);
  assert.ok(!fs.existsSync(archive));
  const before = run(['list', '--json', '--archived']).stdout;
  const junk = path.join(home, 'junk.csv');
  fs.writeFileSync(junk, 'this is not,a valid\n"unterminated');
  const bad = run(['import', junk, '--format', 'chrome']);
  assert.equal(bad.status, 1);
  assert.ok(fs.existsSync(junk), 'a failed import deletes nothing');
  assert.equal(run(['list', '--json', '--archived']).stdout, before);
  assert.equal(run(['import', junk, '--format', 'lastpass']).status, 2);
  assert.equal(run(['import', path.join(home, 'missing.csv'), '--format', 'chrome']).status, 1);
});

test('protect wraps the key: a locked vault exits 4, the passphrase unlocks it, and a wrong one fails', (t) => {
  const { run, ok } = sandbox(t);
  ok(['set', 'kept', '--kind', 'secret'], { input: PASSWORD });
  const phrase = 'correct horse battery staple';
  const protectedRun = ok(['protect'], { extra: { TOPHAT_PASS_NEW_PASSPHRASE: phrase } });
  assert.equal(JSON.parse(protectedRun.stdout).keyStorage, 'passphrase-wrapped');
  assert.equal(run(['list']).status, 4);
  assert.equal(run(['list'], { extra: { TOPHAT_PASS_PASSPHRASE: 'wrong passphrase value' } }).status, 1);
  assert.equal(run(['get', 'kept', '--raw', '-n'], { extra: { TOPHAT_PASS_PASSPHRASE: phrase } }).stdout, PASSWORD);
  ok(['set', 'later', '--kind', 'secret'], { input: 'v2-value', extra: { TOPHAT_PASS_PASSPHRASE: phrase } });
  assert.equal(run(['protect'], { extra: { TOPHAT_PASS_NEW_PASSPHRASE: 'short' } }).status, 1);
});

test('init creates an owner-only vault; generate prints a fresh password and stores nothing', (t) => {
  const { run, ok, directory, home } = sandbox(t);
  assert.equal(run(['list']).status, 1, 'reading a missing vault is an error, not an empty list');
  const init = JSON.parse(ok(['init']).stdout);
  assert.equal(init.initialized, true);
  assert.equal(fs.statSync(directory).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(home, 'vault-master-key')).mode & 0o077, 0);
  const a = ok(['generate']).stdout.trim(), b = ok(['generate']).stdout.trim();
  for (const p of [a, b]) assert.match(p, /^[A-Za-z0-9]{6}-[A-Za-z0-9]{6}-[A-Za-z0-9]{6}$/);
  assert.notEqual(a, b);
  // --length no longer silently switches shape (2026-11-17); the dense form is the named --dense opt-in
  assert.notEqual(run(['generate', '--length', '24']).status, 0);
  assert.equal(ok(['generate', '--dense', '32']).stdout.trim().length, 32);
  assert.equal(run(['generate', '--dense', '4']).status, 1);
  assert.equal(run(['list']).stdout.trim(), '');
});

test('the default vault is under the temp HOME, never the real one', (t) => {
  const { home } = sandbox(t);
  const r = spawnSync(process.execPath, [BIN, 'set', 'home-default', '--kind', 'secret'], { encoding: 'utf8', input: 'v', env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, '.config/tophat/vault')));
});
