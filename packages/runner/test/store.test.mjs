// The runner's store layer: memory and shared work over @tophat-md/linknotes, in process (store/memory.mjs) and as a
// child (store/cli.mjs), plus the assembled callers that used to spawn a Python CLI. Scratch files only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answer, closeAll, hubOf, scopeOf, syncStore } from '../store/memory.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(HERE, '../store/cli.mjs');
const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tophat-store-')); dirs.push(d); return d; };
test.after(() => { closeAll(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const db = () => path.join(tmp(), 'memory.sqlite');
const ok = (r) => { assert.equal(r.code, 0, JSON.stringify(r.result)); return r.result; };

test('scopeOf: default, groups, and a refused name', () => {
  assert.deepEqual(scopeOf({}), { scope: 'local', user: 'local', groups: [] });
  assert.deepEqual(scopeOf({ TOPHAT_SCOPE: 'lab', TOPHAT_SCOPE_GROUPS: 'lab, team ,' }), { scope: 'lab', user: 'lab', groups: ['team'] });
  assert.deepEqual(scopeOf({ TOPHAT_SCOPE: 'sam-private', TOPHAT_SCOPE_USER: 'sam' }), { scope: 'sam-private', user: 'sam', groups: [] });
  assert.throws(() => scopeOf({ TOPHAT_SCOPE_USER: 'Sam' }), /must match/);
  assert.throws(() => scopeOf({ TOPHAT_SCOPE: 'Lab Group' }), /must match/);
});

test('shared work: apply, list, get, status and a stale write', () => {
  const file = db(), env = {};
  const made = ok(answer('tasks', { op: 'apply', op_id: 'op-1', actor: 'chat:s1', tasks: [{ id: '$a', title: 'order the tank', status: 'todo', owner_kind: 'me' }] }, { db: file, env }));
  const id = made.id_map.$a;
  assert.match(id, /^w_/);
  const list = ok(answer('tasks', { op: 'list' }, { db: file, env }));
  assert.equal(list.total, 1);
  assert.equal(list.tasks[0].title, 'order the tank');
  const got = ok(answer('tasks', { op: 'get', id }, { db: file, env }));
  assert.equal(got.work.id, id);
  // the op id is the receipt: the same call twice applies once
  const again = ok(answer('tasks', { op: 'apply', op_id: 'op-1', actor: 'chat:s1', tasks: [{ id: '$a', title: 'order the tank', status: 'todo', owner_kind: 'me' }] }, { db: file, env }));
  assert.equal(again.replayed, true);
  assert.equal(ok(answer('tasks', { op: 'list' }, { db: file, env })).total, 1);
  // a write against the wrong version comes back as current state, not an overwrite
  const stale = answer('tasks', { op: 'apply', op_id: 'op-2', actor: 'chat:s1', tasks: [{ id, title: 'x', status: 'done', expected_version: 99 }] }, { db: file, env });
  assert.equal(stale.code, 2);
  assert.equal(stale.result.reason, 'conflict');
  assert.equal(stale.result.current.id, id);
  const done = ok(answer('tasks', { op: 'apply', op_id: 'op-3', actor: 'chat:s1', tasks: [{ id, title: 'order the tank', status: 'done', expected_version: 1 }] }, { db: file, env }));
  assert.equal(done.work[0].status, 'done');
  const st = ok(answer('status', {}, { db: file, env }));
  assert.equal(st.counts.work, 1);
  assert.equal(st.default_scope, 'local');
});

test('a chat is one work item, created once per session', () => {
  const file = db(), env = {};
  const a = ok(answer('tasks', { op: 'chat', session: 's-1', title: '[Automated event] hello there' }, { db: file, env }));
  assert.equal(a.work.owner_kind, 'chat');
  assert.equal(a.work.owner_ref, 's-1');
  assert.equal(a.work.title, 'Chat: hello there');
  assert.deepEqual(a.work.bindings, [{ source: 'chat-goal', native_id: 's-1:chat' }]);
  const b = ok(answer('tasks', { op: 'chat', session: 's-1', title: 'another title' }, { db: file, env }));
  assert.equal(b.work.id, a.work.id);
  assert.equal(ok(answer('tasks', { op: 'list' }, { db: file, env })).total, 1);
  assert.equal(answer('tasks', { op: 'nope' }, { db: file, env }).result.reason, 'refused');
});

test('memory: ingest, apply, search, read', () => {
  const file = db(), env = {};
  const ing = ok(answer('ingest', { records: [{ source: 'webchat', id: 'r1', role: 'owner', author: 'owner', text: 'the kiln arrives friday', time: '2026-01-02T03:04:05Z' }] }, { db: file, env }));
  assert.equal(ing.stored.length, 1);
  const raw = ing.stored[0];
  const ap = ok(answer('apply', { batch_id: 'b1', changes: { entities: [{ id: '$d', name: 'Kiln Mk1', type: 'thing' }], notes: [{ body: 'The kiln arrives on Friday.', entities: ['$d'], source_refs: [raw] }] }, source_refs: [raw] }, { db: file, env }));
  assert.equal(ap.ok, true);
  const hits = ok(answer('search', { query: 'kiln', limit: 5 }, { db: file, env }));
  assert.ok(hits.hits.length > 0, JSON.stringify(hits));
  // no memory-embeddings.json beside the store: lexical only, no dense leg; `derived` gives notes their own allowance
  assert.equal(hits.coverage.dense, undefined);
  const both = ok(answer('search', { query: 'kiln', limit: 1, derived: 2 }, { db: file, env }));
  assert.deepEqual(both.hits.map((h) => h.kind).sort(), ['entity', 'note', 'raw']);
  const ent = ok(answer('read', { kind: 'entity', id: ap.id_map.$d }, { db: file, env }));
  assert.equal(ent.entity.name, 'Kiln Mk1');
  assert.equal(ent.notes.length, 1);
  assert.equal(answer('apply', { batch_id: 'b2', changes: { notes: [{ body: 'x', entities: [], source_refs: [raw] }] } }, { db: file, env, readOnly: true }).result.reason, 'refused');
  // push: the model-free consolidation; the entity the apply touched gets its page built from its notes
  const pushed = ok(answer('push', {}, { db: file, env }));
  assert.equal(pushed.interpret.status, 'not_run');
  assert.deepEqual(pushed.pages.map((p) => [p.entity_id, p.status]), [[ap.id_map.$d, 'built']]);
  assert.equal(pushed.pages_dirty_after, 0);
  assert.equal(ok(answer('push', {}, { db: file, env })).pages.length, 0, 'a clean page is not rebuilt');
  assert.equal(answer('push', {}, { db: file, env, readOnly: true }).result.reason, 'refused');
});

test('chat work titles drop the runtime-clock block, closed or cut off', () => {
  const file = db(), env = {};
  const a = ok(answer('tasks', { op: 'chat', session: 's-c1', title: 'order the tank\n<runtime-clock>UTC 2026-11-08T00:00:00.000Z; elapsed 0 ms. Check elapsed time against concrete progress.</runtime-clock>' }, { db: file, env }));
  assert.equal(a.work.title, 'Chat: order the tank');
  const b = ok(answer('tasks', { op: 'chat', session: 's-c2', title: 'order the kiln\n<runtime-clock>UTC 2026-11-08T00:00:00.000Z; elapsed 0 m' }, { db: file, env }));
  assert.equal(b.work.title, 'Chat: order the kiln');
});

test('apply is atomic: a refused batch leaves no evidence row behind', () => {
  const file = db(), env = {};
  const rawCount = () => ok(answer('search', { query: 'Boiler', kind: 'raw', limit: 50 }, { db: file, env })).hits.length;
  const before = ok(answer('status', {}, { db: file, env })).counts;
  // the note names an entity that does not exist: refused after cite() would have written its evidence record
  const refused = answer('apply', { batch_id: 'atomic-1', changes: { notes: [{ body: 'The Lab Boiler was fixed.', entities: ['no such entity anywhere'] }] } }, { db: file, env });
  assert.equal(refused.code, 2, JSON.stringify(refused.result));
  const after = ok(answer('status', {}, { db: file, env })).counts;
  assert.deepEqual(after, before, 'nothing written');
  assert.equal(rawCount(), 0);
  // the same batch, fixed, lands with its one evidence row
  const landed = ok(answer('apply', { batch_id: 'atomic-2', changes: { entities: [{ id: '$b', name: 'Lab Boiler', type: 'thing' }], notes: [{ body: 'The Lab Boiler was fixed.', entities: ['$b'] }] } }, { db: file, env }));
  assert.equal(landed.notes.length, 1);
  assert.equal(rawCount(), 1);
  // a store write still works outside apply (the nesting is undone)
  ok(answer('ingest', { records: [{ source: 'webchat', id: 'r-after', role: 'owner', author: 'owner', text: 'after the apply', time: '2026-01-02T03:04:05Z' }] }, { db: file, env }));
});

test('the replica writes as its scope, and shares into a configured group', () => {
  const file = db(), env = { TOPHAT_SCOPE: 'lab', TOPHAT_SCOPE_GROUPS: 'funders' };
  const r = ok(answer('apply', { batch_id: 'g1', changes: { entities: [{ id: '$e', name: 'Lab Notebook 7', type: 'thing' }], notes: [{ body: 'Private to the lab.', entities: ['$e'] }] } }, { db: file, env }));
  const shared = ok(answer('apply', { batch_id: 'g2', changes: { notes: [{ body: 'Readable by the funders too.', entities: [r.id_map.$e], groups: ['lab', 'funders'] }] } }, { db: file, env }));
  assert.equal(shared.ok, true);
  const st = ok(answer('status', {}, { db: file, env }));
  assert.deepEqual(st.scope.write, ['lab']);
  assert.deepEqual(st.scope.groups, ['funders']);
  assert.ok(st.scope.readable.includes('funders'), JSON.stringify(st.scope));
});

const cli = (args, input, env = {}) => spawnSync(process.execPath, [CLI, ...args], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });

test('store/cli.mjs: one request, one JSON answer, an exit code per outcome', () => {
  const file = db();
  const a = cli(['--db', file, 'tasks'], { op: 'apply', op_id: 'c1', actor: 'cli', tasks: [{ id: '$t', title: 'from the cli', status: 'todo' }] });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(JSON.parse(a.stdout).ok, true);
  const l = cli(['--db', file, 'tasks'], { op: 'list' });
  assert.equal(JSON.parse(l.stdout).tasks[0].title, 'from the cli');
  const ro = cli(['--db', file, '--read-only', 'apply'], { batch_id: 'z', changes: {} });
  assert.equal(ro.status, 2);
  assert.equal(JSON.parse(ro.stdout).reason, 'refused');
  const bad = cli(['--db', file, 'nonsense'], {});
  assert.equal(bad.status, 2);
});

test('store/cli.mjs serve: a warm reader answers reads and refuses writes', async () => {
  const file = db();
  cli(['--db', file, 'apply'], { batch_id: 's1', changes: { entities: [{ id: '$e', name: 'the glaze tank', type: 'thing' }], notes: [{ body: 'The tank is 60 cm deep.', entities: ['$e'] }] } });
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [CLI, '--db', file, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.setEncoding('utf8');
  let buf = '';
  child.stdout.on('data', (c) => { buf += c; let n; while ((n = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, n))); buf = buf.slice(n + 1); } });
  child.stdin.write(JSON.stringify({ id: 1, command: 'search', request: { query: 'glaze' } }) + '\n');
  child.stdin.write(JSON.stringify({ id: 2, command: 'apply', request: { batch_id: 'x', changes: {} } }) + '\n');
  for (let i = 0; i < 60 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end(); child.kill();
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.equal(lines[0].code, 0);
  assert.ok(lines[0].result.hits.length > 0);
  assert.equal(lines[1].code, 2);
});

test('the assembled callers reach this store, not a Python CLI', async () => {
  const src = readFileSync(path.join(HERE, '../rev5/tasks.mjs'), 'utf8');
  assert.match(src, /store', 'cli\.mjs'/);
  for (const f of ['rev5/tasks.mjs', 'rev6/pull/tools.mjs', 'rev6/pull/goals.mjs', 'rev6/pull/memory-worker.mjs', 'rev6/base/memory-groups.mjs']) {
    assert.ok(!/'-m', 'rev5\.cli'/.test(readFileSync(path.join(HERE, '..', f), 'utf8')), `${f} still spawns the Python CLI`);
  }
  const file = db();
  const { taskRequest, taskRequestAsync } = await import(path.join(HERE, '../rev5/tasks.mjs'));
  const out = taskRequest({ op: 'apply', op_id: 'tr1', actor: 'test', tasks: [{ id: '$t', title: 'through the assembled caller', status: 'todo' }] }, { TOPHAT_RUNNER_DB: file });
  assert.equal(out.ok, true);
  assert.equal(taskRequest({ op: 'list' }, { TOPHAT_RUNNER_DB: file }).tasks[0].title, 'through the assembled caller');
  // the sweeper's non-blocking reader goes through the same store child
  const listed = await taskRequestAsync({ op: 'list' }, { TOPHAT_RUNNER_DB: file });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.tasks[0].title, 'through the assembled caller');
  // rev6/pull/tools.mjs needs the runner's npm dependencies to import, so the store wiring is read from its text.
  const tools = readFileSync(path.join(HERE, '../rev6/pull/tools.mjs'), 'utf8');
  assert.match(tools, /installed: true, python: process\.execPath, cli: join\(REPO, 'store', 'cli\.mjs'\)/);
  assert.ok(existsSync(path.join(HERE, '../store/cli.mjs')));
});

test('hub sync: a group runner and a member replica exchange the group scope through a local hub; a private note stays home', async () => {
  const { Hub, issueToken } = await import('../../linknotes/core/src/hub.mjs');
  const { writeFileSync } = await import('node:fs');
  const dir = tmp(), secret = 'local-test-secret-of-at-least-32-characters';
  const hub = new Hub(path.join(dir, 'hub.sqlite'), { secret });
  const server = await hub.listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const tokenFile = (device, user) => { const f = path.join(dir, `${device}.token`); writeFileSync(f, issueToken(secret, { device, user, expiresAt: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 }); return f; };
  try {
    const labDb = path.join(dir, 'lab.sqlite'), samDb = path.join(dir, 'sam.sqlite');
    const lab = { TOPHAT_SCOPE: 'lab', TOPHAT_DEVICE: 'lab-runner', TOPHAT_HUB_URL: url, TOPHAT_HUB_TOKEN_FILE: tokenFile('lab-runner', 'lab') };
    const sam = { TOPHAT_SCOPE: 'sam', TOPHAT_DEVICE: 'sam-laptop', TOPHAT_HUB_URL: url, TOPHAT_HUB_TOKEN_FILE: tokenFile('sam-laptop', 'sam') };
    assert.deepEqual(hubOf(lab), { url, tokenFile: lab.TOPHAT_HUB_TOKEN_FILE });
    assert.equal(hubOf({}), null);
    assert.equal((await syncStore(labDb, {})).code, 2, 'no hub block is a refusal');
    // the member's device must be known to the hub before the group key can be wrapped to it
    ok(await syncStore(samDb, sam));
    ok(answer('apply', { batch_id: 'lab-1', changes: { entities: [{ id: '$t', name: 'Water tank', type: 'topic' }], notes: [{ body: 'GROUP-NOTE the tank holds 40 litres', entities: ['$t'] }] } }, { db: labDb, env: lab }));
    ok(answer('apply', { batch_id: 'sam-1', changes: { entities: [{ id: '$p', name: 'Sam diary', type: 'topic' }], notes: [{ body: 'PRIVATE-SAM do not share', entities: ['$p'] }] } }, { db: samDb, env: sam }));
    const { openStore } = await import('../store/memory.mjs');
    openStore(labDb, lab).store.setMember('lab', 'sam', 'write');
    const pushed = ok(await syncStore(labDb, lab));
    assert.ok(pushed.pushed >= 1 && pushed.keys_wrapped >= 1, JSON.stringify(pushed));
    ok(await syncStore(samDb, sam));
    ok(await syncStore(samDb, sam));
    const seen = ok(answer('search', { query: 'GROUP-NOTE', kind: 'note' }, { db: samDb, env: sam }));
    assert.ok(JSON.stringify(seen).includes('40 litres'), `the member reads the group note: ${JSON.stringify(seen).slice(0, 400)}`);
    ok(await syncStore(labDb, lab));
    const leak = ok(answer('search', { query: 'PRIVATE-SAM', kind: 'note' }, { db: labDb, env: lab }));
    assert.ok(!JSON.stringify(leak).includes('do not share'), 'a private note never reaches the group runner');
    assert.equal(ok(answer('status', {}, { db: labDb, env: lab })).hub.url, url);
  } finally { await new Promise((r) => server.close(r)); hub.close(); }
});
