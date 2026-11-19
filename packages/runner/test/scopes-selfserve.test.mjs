import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRegistry, accountsFor, canAccess } from '../src/scopes/registry.mjs';

const reg = () => parseRegistry({
  accounts: { alice: { emails: ['alice@example.test'] } },
  autoDomains: ['example.test'],
  scopes: { 'personal:alice': { kind: 'personal', owner: 'alice' }, all: { kind: 'group', everyone: true } }
});

test('an address on an autoDomain gets an account and its own personal scope', () => {
  const r = reg();
  const a = accountsFor('Casey@example.test', r);
  assert.equal(a.account, 'casey');
  assert.equal(a.personalScope, 'personal:casey');
  assert.ok(canAccess('casey', 'personal:casey', r) && canAccess('casey', 'all', r));
  assert.ok(!canAccess('casey', 'personal:alice', r));
});

test('other domains, subdomains and listed accounts are unchanged', () => {
  const r = reg();
  assert.equal(accountsFor('x@evil.com', r), null);
  assert.equal(accountsFor('a@sub.example.test', r), null);
  assert.equal(accountsFor('alice@example.test', r).account, 'alice');
});
