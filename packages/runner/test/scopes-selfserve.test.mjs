import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRegistry, accountsFor, canAccess } from '../src/scopes/registry.mjs';

const reg = () => parseRegistry({
  accounts: { albert: { emails: ['albert@pinkmatter.io'] } },
  autoDomains: ['pinkmatter.io'],
  scopes: { 'personal:albert': { kind: 'personal', owner: 'albert' }, all: { kind: 'group', everyone: true } }
});

test('an address on an autoDomain gets an account and its own personal scope', () => {
  const r = reg();
  const a = accountsFor('JrPink@pinkmatter.io', r);
  assert.equal(a.account, 'jrpink');
  assert.equal(a.personalScope, 'personal:jrpink');
  assert.ok(canAccess('jrpink', 'personal:jrpink', r) && canAccess('jrpink', 'all', r));
  assert.ok(!canAccess('jrpink', 'personal:albert', r));
});

test('other domains, subdomains and listed accounts are unchanged', () => {
  const r = reg();
  assert.equal(accountsFor('x@evil.com', r), null);
  assert.equal(accountsFor('a@sub.pinkmatter.io', r), null);
  assert.equal(accountsFor('albert@pinkmatter.io', r).account, 'albert');
});
