// memory_apply from a chat outside the instance's write scope, through the real store (store/cli.mjs on linknotes): filed only under the
// chat's own scope group or refused, never under the instance's default group (`team` here, which syncs to every member); an explicit
// `groups` cannot widen past the chat's scope. With scopes off the runner writes every chat as it always did (the control).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTools } from '../rev6/pull/tools.mjs';
import { openLedger } from '../rev6/pull/ledger.mjs';
import { closeAll, openStore } from '../store/memory.mjs';

const stubs = { cua: () => ({ specs: [], ready: async () => {}, prompt: () => null, run: async () => ({ content: '', isError: true }), close() {} }), tabs: () => ({ around: (f) => f() }) };
test.after(() => closeAll());

/** A team-shaped instance: write scope `team`, a founders group `founders` this replica holds, chats in several scopes. */
function instance(t, { scopesOn = true, groups = 'founders' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tophat-apply-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, 'events.sqlite'));
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, session_id TEXT, scope TEXT)');
  const add = db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)');
  for (const [id, scope] of [['c-team', 'team'], ['c-open', 'commons'], ['c-personal', 'personal:sam'], ['c-founders', 'founders']]) add.run(id, id, `s-${id}`, scope);
  db.close();
  writeFileSync(path.join(dir, 'scopes.json'), JSON.stringify({ version: 1, accounts: {}, scopes: { 'personal:sam': { kind: 'personal' }, commons: { kind: 'group', everyone: true }, founders: { kind: 'group', members: ['sam'] } } }));
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(scopesOn ? { scopes: { enabled: true, registryFile: path.join(dir, 'scopes.json') } } : { version: 1 }));
  const env = { HOME: dir, PATH: process.env.PATH, TOPHAT_CONFIG: path.join(dir, 'config.json'), WEBCHAT_DB: path.join(dir, 'events.sqlite'), TOPHAT_SCOPE: 'team', ...(groups ? { TOPHAT_SCOPE_GROUPS: groups } : {}),
    TOPHAT_RUNNER_DB: path.join(dir, 'memory.sqlite'), TOPHAT_STATE_DIR: dir };
  return { dir, env };
}
const tools = (inst, session) => createTools({ db: openLedger(':memory:').db, sessionId: session, cwd: inst.dir, roots: [inst.dir], env: inst.env, factories: stubs, mail: false });
let n = 0;
const apply = async (inst, session, extra = {}, body = `a private plan ${++n}`) => JSON.parse((await tools(inst, session).run('memory_apply', { batch_id: `b-${body}`, changes: { entities: [{ id: '$e', name: `Topic ${body}`, type: 'topic' }], notes: [{ body, entities: ['$e'] }] }, ...extra })).content);
const rows = (inst) => { const s = openStore(inst.env.TOPHAT_RUNNER_DB, inst.env).store; return s.all('SELECT id, body FROM notes').map((r) => ({ body: r.body, groups: s.aclOf('notes', r.id) })); };

test('control, scopes off: a personal chat\'s memory_apply lands under the instance default group, as before', async (t) => {
  const inst = instance(t, { scopesOn: false });
  const out = await apply(inst, 's-c-personal', {}, 'plan off');
  assert.notEqual(out.ok, false, JSON.stringify(out).slice(0, 300));
  assert.deepEqual(rows(inst), [{ body: 'plan off', groups: ['team'] }]);
});

test('scopes on: a personal chat\'s memory_apply is refused with a clear error and nothing is written', async (t) => {
  const inst = instance(t);
  const out = await apply(inst, 's-c-personal', {}, 'plan personal');
  assert.equal(out.ok, false);
  assert.match(out.error, /this chat is in scope "personal:sam", outside this instance's write scope "team".*Nothing was written; the instance's default group is never used/);
  assert.deepEqual(rows(inst), []);
});

test('scopes on: a model-named groups cannot widen a personal chat into team', async (t) => {
  const inst = instance(t);
  for (const extra of [{ groups: ['team'] }, { changes: { notes: [{ body: 'x', groups: ['team'] }] } }]) {
    const out = await apply(inst, 's-c-personal', extra, 'plan widen');
    assert.equal(out.ok, false);
    assert.match(out.error, /may only write to the group "personal:sam"/);
  }
  assert.deepEqual(rows(inst), []);
});

test('scopes on: a member-limited chat is filed only under its own group (founders), never team; without that group it is refused', async (t) => {
  const inst = instance(t);
  const out = await apply(inst, 's-c-founders', {}, 'plan founders');
  assert.notEqual(out.ok, false, JSON.stringify(out).slice(0, 300));
  assert.deepEqual(rows(inst), [{ body: 'plan founders', groups: ['founders'] }]);
  const bare = instance(t, { groups: '' });
  const refused = await apply(bare, 's-c-founders', {}, 'plan founders 2');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /scope "founders".*Nothing was written/);
  assert.deepEqual(rows(bare), []);
});

test('scopes on: chats in the write scope and in an everyone group write to the default group as before', async (t) => {
  const inst = instance(t);
  for (const session of ['s-c-team', 's-c-open']) { const o = await apply(inst, session, {}, `plan ${session}`); assert.notEqual(o.ok, false, JSON.stringify(o).slice(0, 400)); }
  assert.deepEqual(rows(inst).map((r) => r.groups), [['team'], ['team']]);
});
