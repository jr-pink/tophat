import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRegistry, accountsFor, canAccess } from '../src/scopes/registry.mjs';

const reg = () => parseRegistry({
  accounts: { alice: { emails: ['alice@example.org'] } },
  autoDomains: ['example.org'],
  scopes: { 'personal:alice': { kind: 'personal', owner: 'alice' }, all: { kind: 'group', everyone: true } }
});

test('an address on an autoDomain gets an account and its own personal scope', () => {
  const r = reg();
  const a = accountsFor('Bob@example.org', r);
  assert.equal(a.account, 'bob');
  assert.equal(a.personalScope, 'personal:bob');
  assert.ok(canAccess('bob', 'personal:bob', r) && canAccess('bob', 'all', r));
  assert.ok(!canAccess('bob', 'personal:alice', r));
});

test('other domains, subdomains and listed accounts are unchanged', () => {
  const r = reg();
  assert.equal(accountsFor('x@evil.com', r), null);
  assert.equal(accountsFor('a@sub.example.org', r), null);
  assert.equal(accountsFor('alice@example.org', r).account, 'alice');
});
