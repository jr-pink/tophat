// A chat from another host goes whole into a group scope here, checked by digest (server/chat-import.js, /api/agent op import-conversation).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLegacyStore } from '../src/lib/server/store.js';
import { createScopeService, registryApi } from '../src/lib/server/scopes.js';
import { importChat, digestOf } from '../src/lib/server/chat-import.js';
import { parseRegistry } from '../../runner/src/scopes/registry.mjs';

const ID = '11111111-2222-3333-4444-555555555555';
const registry = parseRegistry({
  accounts: { a: { emails: ['a@x.test'] } },
  scopes: { 'personal:a': { kind: 'personal', owner: 'a' }, 'team-a': { kind: 'group', everyone: true } }
});
const events = () => [
  { kind: 'conversation.created', content: { title: 'T', settings: {}, cwd: '/foreign/path' }, at: '2026-11-01T00:00:00.000Z', run_id: null },
  { kind: 'message.user', content: { itemId: 'u1', text: 'hello vessels' }, at: '2026-11-01T00:00:01.000Z', run_id: 'r1' },
  { kind: 'assistant.message', content: { itemId: 'a1', text: 'about 2.5 percent', agentId: null }, at: '2026-11-01T00:00:02.000Z', run_id: 'r1' }
];
function setup(t, { enabled = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chat-import-')));
  const store = openLegacyStore(join(dir, 'events.sqlite'));
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  const scopes = createScopeService({ store, registry: registryApi(registry), config: { enabled, defaultScope: 'legacy', router: { enabled: false } } });
  const body = (extra = {}) => {
    const ev = events();
    return { conversation: { id: ID, title: 'Vessel viewers', settings: { provider: 'direct' }, session_id: 'foreign-session', created_at: ev[0].at, updated_at: ev[2].at }, events: ev, scope: 'team-a', digest: digestOf(ev), origin: 'host-a', ...extra };
  };
  return { store, scopes, body };
}

test('imports into a group scope, fresh row, digest equal to the sender\'s, marker left out of the digest', (t) => {
  const { store, scopes, body } = setup(t);
  const out = importChat({ store, scopes, body: body(), defaultCwd: '/srv/work' });
  assert.equal(out.ok, true); assert.equal(out.scope, 'team-a'); assert.equal(out.count, 3);
  assert.deepEqual(store.conversationDigest(ID), digestOf(events()));
  const row = store.conversation(ID);
  assert.equal(row.scope, 'team-a'); assert.equal(row.cwd, '/srv/work'); assert.equal(row.archived, false);
  assert.equal(row.source, 'import'); assert.ok(!row.sessionId, 'no foreign runner session');
  assert.ok(store.allConversationEvents(ID).some((e) => e.kind === 'conversation.meta' && e.content.scopeMove?.from === 'host-a'));
});

test('a repeat is a duplicate, not a second write; different history under the same id is refused and nothing is replaced', (t) => {
  const { store, scopes, body } = setup(t);
  importChat({ store, scopes, body: body() });
  const again = importChat({ store, scopes, body: body() });
  assert.equal(again.duplicate, true);
  const other = body(); other.events[1].content.text = 'changed'; other.digest = digestOf(other.events);
  assert.throws(() => importChat({ store, scopes, body: other }), { code: 'exists', status: 409 });
  assert.equal(store.allConversationEvents(ID).find((e) => e.kind === 'message.user').content.text, 'hello vessels');
});

test('refuses a personal scope, an unknown scope, scopes off, a tampered digest and an unknown event kind; writes nothing', (t) => {
  const { store, scopes, body } = setup(t);
  assert.throws(() => importChat({ store, scopes, body: body({ scope: 'personal:a' }) }), { code: 'not-a-group', status: 403 });
  assert.throws(() => importChat({ store, scopes, body: body({ scope: 'nope' }) }), { code: 'unknown-scope', status: 404 });
  const bad = body(); bad.digest = { count: 3, hash: 'x' };
  assert.throws(() => importChat({ store, scopes, body: bad }), { code: 'digest-mismatch' });
  const kind = body(); kind.events[1].kind = 'owner.secret';
  assert.throws(() => importChat({ store, scopes, body: kind }), { code: 'bad-bundle' });
  assert.equal(store.conversation(ID), null);
  const off = setup(t, { enabled: false });
  assert.throws(() => importChat({ store: off.store, scopes: off.scopes, body: off.body() }), { code: 'scopes-disabled' });
});
