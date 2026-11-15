import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScopeGate, sessionToken, EDGE_COOKIE } from '../src/scopes/edge-gate.mjs';
import { parseRegistry } from '../src/scopes/registry.mjs';

const registry = () => parseRegistry(JSON.stringify({
  version: 1,
  accounts: { ann: { name: 'Ann', emails: ['ann@example.org'] } },
  scopes: { 'personal:ann': { kind: 'personal', label: 'Ann', owner: 'ann' } }
}));
const base = { authBase: 'https://auth.example.org', orgDomain: 'example.org', registry };
const req = (headers = {}, accept = 'text/html') => new Request('https://host.example.org/x', { headers: { accept, ...headers } });

test('cookie name is configurable and defaults to the edge cookie', () => {
  assert.equal(sessionToken(`a=b; ${EDGE_COOKIE}=t1`), 't1');
  assert.equal(sessionToken('a=b; mine=t2', 'mine'), 't2');
  assert.equal(sessionToken(`${EDGE_COOKIE}=t1`, 'mine'), null);
});

test('a configured cookie name is the one asked about and sent to the sign-in service', async () => {
  let sent;
  const gate = makeScopeGate({ ...base, cookieName: 'mine', fetchSession: async (c) => { sent = c; return { email: 'ann@example.org', org: true }; } });
  const r = await gate(req({ cookie: 'mine=tok123' }));
  assert.equal(r.ok, true);
  assert.equal(sent, 'mine=tok123');
});

test('a signed-out page request is redirected to sign-in', async () => {
  const gate = makeScopeGate({ ...base, publicBase: 'https://host.example.org', fetchSession: async () => null });
  const r = await gate(req());
  assert.equal(r.response.status, 302);
  assert.match(r.response.headers.get('location'), /^https:\/\/auth\.example\.org\/\?next=/);
});
