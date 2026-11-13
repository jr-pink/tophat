// The change log of the vault is the one part meant to be printed, so a test that only checked the entries
// would not notice a password, token or recovery code leaking into an event. These cases check each kind.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PasswordManager, HISTORY_LIMIT} from '../src/vault/manager.mjs';

const PASSWORD = 'HISTORY-CANARY-PASSWORD-91fe';
const TOKEN = 'HISTORY-CANARY-ACCESS-TOKEN-4b7c';
const REFRESH = 'HISTORY-CANARY-REFRESH-TOKEN-d20a';
const SITE = 'https://history.example.test';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tophat-vault-history-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return new PasswordManager({directory: path.join(root, 'vault'), keyFile: path.join(root, 'key')});
}

const login = (password = PASSWORD) => ({
  id: 'tracked', name: 'Tracked account', kind: 'login',
  origins: [SITE], value: {username: 'someone', password},
});

const grant = (over = {}) => ({
  id: 'service', name: 'Service', kind: 'oauth',
  value: {issuer: 'service.com', account: 'owner@example.test',
    scopes: ['transactions:read', 'accounts:read'], accessToken: TOKEN,
    refreshToken: REFRESH, expiresAt: '2026-11-01T00:00:00.000Z', ...over},
});

test('every change to a credential is recorded, newest first, per entry', t => {
  const m = fixture(t);
  m.save(login());
  m.save(login('ROTATED-6a1b'), {overwrite: true});
  m.groups('tracked', ['work', 'banking']);
  m.archive('tracked');
  m.archive('tracked', false);
  m.save({...login(), id: 'other', name: 'Other account'});

  const all = m.history();
  assert.deepEqual(all.map(event => event.action),
    ['created', 'unarchived', 'archived', 'grouped', 'replaced', 'created']);

  const mine = m.history({id: 'tracked'});
  assert.equal(mine.length, 5, 'the per-entry log is filtered to that entry');
  assert.ok(mine.every(event => event.id === 'tracked'));

  const grouped = mine.find(event => event.action === 'grouped');
  assert.deepEqual(grouped.from, [], 'the log says what the groups were');
  assert.deepEqual(grouped.to, ['work', 'banking'], 'and what they became');
  assert.ok(Date.parse(all[0].at) > 0, 'every event carries a timestamp');
  assert.ok(all.every(event => Number.isSafeInteger(event.revision)),
    'and the catalog revision it landed in');
});

test('a forgotten credential leaves its history behind', t => {
  const m = fixture(t);
  m.save(login());
  m.forget('tracked');
  assert.deepEqual(m.list(), [], 'the entry is gone');
  const events = m.history({id: 'tracked'});
  assert.deepEqual(events.map(event => event.action), ['forgotten', 'created']);
  assert.equal(events[0].name, 'Tracked account',
    'the log still says which credential it was, which is the point of asking later');
});

test('no secret value ever reaches the log', t => {
  const m = fixture(t);
  m.save(login());
  m.save(login('ROTATED-6a1b'), {overwrite: true});
  m.save(grant());
  m.save({id: 'codes', name: 'Backup codes', kind: 'recovery-codes',
    value: ['CODE-CANARY-ONE', 'CODE-CANARY-TWO']});
  m.takeRecoveryCode('codes');

  const dump = JSON.stringify(m.history({limit: HISTORY_LIMIT}));
  for (const secret of [PASSWORD, 'ROTATED-6a1b', TOKEN, REFRESH, 'CODE-CANARY-ONE'])
    assert.equal(dump.includes(secret), false, `the log leaked ${secret.slice(0, 12)}`);
});

test('the log is bounded and keeps the newest events', t => {
  const m = fixture(t);
  const catalog = {version: 2, revision: 0, entries: {},
    history: Array.from({length: HISTORY_LIMIT + 10}, (unused, index) =>
      ({at: new Date(index).toISOString(), revision: index, id: 'filler', action: 'created'}))};
  m.initialize();
  m.write('catalog', JSON.stringify(catalog));
  m.save(login());
  const stored = m.catalog().history;
  assert.equal(stored.length, HISTORY_LIMIT, 'the log grew without bound');
  assert.equal(stored.at(-1).id, 'tracked', 'the newest event was dropped instead of the oldest');
});

test('an OAuth grant is stored with its issuer, account, scopes and expiry', t => {
  const m = fixture(t);
  const saved = m.save(grant());
  assert.equal(saved.issuer, 'service.com');
  assert.equal(saved.account, 'owner@example.test');
  assert.deepEqual(saved.scopes, ['accounts:read', 'transactions:read'], 'scopes are deduplicated and sorted');
  assert.equal(saved.expiresAt, '2026-11-01T00:00:00.000Z');
  assert.equal(saved.hasRefreshToken, true);
  assert.equal(saved.value, undefined, 'metadata never carries the token');

  const value = m.value(m.entry(m.catalog(), 'service'));
  assert.equal(value.accessToken, TOKEN);
  assert.equal(value.refreshToken, REFRESH);
  assert.equal(value.tokenType, 'Bearer', 'the default token type is filled in');
  assert.equal(value.clientId, null);
});

test('an OAuth grant without any token, issuer or account is refused', t => {
  const m = fixture(t);
  assert.throws(() => m.save(grant({accessToken: null, refreshToken: null})), /access or refresh token/);
  assert.throws(() => m.save(grant({issuer: ''})), /issuer/);
  assert.throws(() => m.save(grant({account: '  '})), /account/);
  assert.throws(() => m.save(grant({expiresAt: 'whenever'})), /expiry/);
  assert.throws(() => m.save(grant({scopes: ['ok', 42]})), /scopes/);
  assert.deepEqual(m.list(), [], 'a refused grant left nothing behind');
});

test('a refresh-only grant is valid, because that is the one worth storing', t => {
  const m = fixture(t);
  // An access token is minutes old by the time anyone looks; the refresh token
  // is the durable half, and a store that demanded both would reject exactly
  // the record that is still useful tomorrow.
  const saved = m.save(grant({accessToken: null, expiresAt: null}));
  assert.equal(saved.expiresAt, null);
  assert.equal(saved.hasRefreshToken, true);
  assert.equal(m.value(m.entry(m.catalog(), 'service')).accessToken, null);
});
