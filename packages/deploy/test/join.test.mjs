// Groups on a hub as explicit commands: `instance join` (opt in, never automatic), `instance group create` and `instance group add`.
// A local hub on a temp port; nothing reaches the community hub, no token is minted outside the test's own secret.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMember, createGroup, joinGroup } from '../src/join.mjs';
import { COMMUNITY_HUB_URL, instanceEnv, loadInstance } from '../src/instance.mjs';
import { setup } from '../src/setup.mjs';
import { componentDir } from '../src/start.mjs';

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tophat-join-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '../bin/tophat-deploy.mjs');
const mem = await import(path.join(componentDir('runner'), 'store/memory.mjs'));
test.after(() => mem.closeAll());

function instance(name, extra = {}) {
  const d = tmp(), file = path.join(d, 'tophat.instance.json');
  writeFileSync(file, JSON.stringify({ name, components: ['linknotes', 'runner'], paths: { state: path.join(d, 'state'), config: path.join(d, 'config') }, ...extra }, null, 2), { mode: 0o600 });
  return file;
}
const rawOf = (f) => JSON.parse(readFileSync(f, 'utf8'));

test('setup never adds the group, a hub block or a join', async () => {
  const d = tmp(), config = path.join(d, 'conf/tophat.instance.json');
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try { await setup({ name: 'demo', owner: 'Sam', config, install: false, start: false, port: 47998 }, () => {}); } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
  const raw = rawOf(config);
  assert.ok(!raw.hub && !raw.scope?.join?.length, JSON.stringify(raw.scope));
  assert.ok(!readFileSync(config, 'utf8').includes('tophat-users') && !readFileSync(config, 'utf8').includes('hub.tophat.md'));
});

test('join: scope.join, the community hub, a unique user and the device public key; idempotent; the token stays pending', async () => {
  const file = instance('sam');
  const r = await joinGroup({ configFile: file, mem });
  const raw = rawOf(file);
  assert.deepEqual(raw.scope.join, ['tophat-users']);
  assert.equal(raw.hub.url, COMMUNITY_HUB_URL);
  assert.match(raw.scope.user, /^th-[0-9a-f]{8}$/);
  assert.equal(r.user, raw.scope.user);
  assert.ok(r.devicePublicKey && r.devicePublicKey.length > 20 && !/private/i.test(JSON.stringify(r)), 'a public key is printed, nothing else of the key file');
  assert.equal(r.tokenPresent, false);
  assert.ok(r.tokenFile.endsWith('/secrets/hub-token'));
  assert.equal(r.next.length, 2);
  const c = loadInstance(file), env = instanceEnv(c);
  assert.equal(env.TOPHAT_SCOPE_JOIN, 'tophat-users');
  assert.equal(env.TOPHAT_HUB_URL, COMMUNITY_HUB_URL);
  const again = await joinGroup({ configFile: file, mem });
  assert.equal(again.user, r.user);
  assert.equal(again.devicePublicKey, r.devicePublicKey);
  assert.deepEqual(rawOf(file).scope.join, ['tophat-users']);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the file mode is kept');
  // the guidance sits in an instructions file the instance now names, once, and a second join does not stack it
  assert.equal(r.guidance, c.paths.instructions);
  const text = readFileSync(r.guidance, 'utf8');
  assert.match(text, /Sharing with tophat-users\./);
  assert.equal(text.split('tophat:sharing tophat-users begin').length, 2);
  assert.ok(existsSync(env.TOPHAT_RUNNER_DB));
  // the sync job exists now that a hub block does, and a sync without a token is refused by name
  assert.deepEqual(rawOf(file).hub, { url: COMMUNITY_HUB_URL });
  const sync = await mem.syncStore(env.TOPHAT_RUNNER_DB, env);
  assert.equal(sync.code, 2);
  assert.match(sync.result.detail, /token file is not readable/);
});

test('join keeps the owner\'s own instructions file and adds the guidance after it', async () => {
  const d = tmp(), own = path.join(d, 'mine.md');
  writeFileSync(own, 'Always answer in French.\n');
  const file = instance('fr', { paths: { state: path.join(d, 'state'), config: path.join(d, 'config'), instructions: own } });
  const r = await joinGroup({ configFile: file, mem });
  assert.equal(r.guidance, own);
  const text = readFileSync(own, 'utf8');
  assert.ok(text.startsWith('Always answer in French.\n') && text.includes('Sharing with tophat-users.'));
});

test('join: a replica that already exists keeps its user; creating and joining one group is refused', async () => {
  const file = instance('old');
  const env = instanceEnv(loadInstance(file));
  mem.openStore(env.TOPHAT_RUNNER_DB, env);
  const r = await joinGroup({ configFile: file, mem });
  assert.equal(rawOf(file).scope.user, undefined);
  assert.equal(r.user, 'old');
  assert.match(r.notes[0], /already has a memory replica/);
  await assert.rejects(createGroup({ configFile: file, group: 'tophat-users', mem }), /joins tophat-users/);
  const f2 = instance('mk', { scope: { groups: ['tophat-users'] } });
  await assert.rejects(joinGroup({ configFile: f2, mem }), /creates tophat-users/);
  await assert.rejects(joinGroup({ configFile: file, group: 'Bad Name', mem }), /must be lower case/);
});

test('create, join and add through a local hub: the key arrives after the admin adds the member', async () => {
  const { Hub, issueToken } = await import('../../linknotes/core/src/hub.mjs');
  const secret = 'local-test-secret-of-at-least-32-characters';
  const dir = tmp();
  const hub = new Hub(path.join(dir, 'hub.sqlite'), { secret });
  const server = await hub.listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const putToken = (file, device, user) => {
    const c = loadInstance(file), f = path.join(c.paths.secrets, 'hub-token');
    mkdirSync(c.paths.secrets, { recursive: true, mode: 0o700 });
    writeFileSync(f, issueToken(secret, { device, user, expiresAt: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 });
  };
  try {
    const adminFile = instance('maint', { hub: { url, device: 'maint-1' } });
    putToken(adminFile, 'maint-1', 'maint');
    const made = await createGroup({ configFile: adminFile, group: 'tophat-users', mem });
    assert.equal(made.ok, true); assert.equal(made.created, true);
    assert.equal(made.sync.ok, true, JSON.stringify(made.sync));
    assert.deepEqual(rawOf(adminFile).scope.groups, ['tophat-users']);
    assert.equal((await createGroup({ configFile: adminFile, group: 'tophat-users', mem })).created, false, 'a second create is a no-op');

    const samFile = instance('sam', { hub: { url, device: 'sam-1' } });
    const joined = await joinGroup({ configFile: samFile, mem });
    putToken(samFile, 'sam-1', joined.user);
    const samEnv = instanceEnv(loadInstance(samFile));
    assert.deepEqual(mem.answer('status', {}, { db: samEnv.TOPHAT_RUNNER_DB, env: samEnv }).result.scope.pending, ['tophat-users']);
    assert.equal((await mem.syncStore(samEnv.TOPHAT_RUNNER_DB, samEnv)).code, 0);

    const added = await addMember({ configFile: adminFile, group: 'tophat-users', user: joined.user, mem });
    assert.equal(added.ok, true); assert.ok(added.devices.length >= 1, JSON.stringify(added));
    await mem.syncStore(samEnv.TOPHAT_RUNNER_DB, samEnv);
    await mem.syncStore(samEnv.TOPHAT_RUNNER_DB, samEnv);
    assert.deepEqual(mem.answer('status', {}, { db: samEnv.TOPHAT_RUNNER_DB, env: samEnv }).result.scope.pending, []);
    const w = mem.answer('apply', { batch_id: 'b1', groups: ['tophat-users'], changes: { entities: [{ id: '$e', name: 'Pump fix', type: 'topic' }], notes: [{ body: 'BUGFIX restart the pump after a power cut', entities: ['$e'] }] } }, { db: samEnv.TOPHAT_RUNNER_DB, env: samEnv });
    assert.equal(w.code, 0, JSON.stringify(w.result));
    await assert.rejects(addMember({ configFile: samFile, group: 'tophat-users', user: 'someone', mem }), /not an admin/);
  } finally { await new Promise((r) => server.close(r)); hub.close(); }
});

test('the CLI: instance join writes the file and prints JSON; group create without NAME is a usage error', () => {
  const file = instance('cli');
  const run = (...a) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, ...a], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.homedir() } });
  const r = run('instance', 'join', '--config', file);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.group, 'tophat-users');
  assert.deepEqual(rawOf(file).scope.join, ['tophat-users']);
  const bad = run('instance', 'group', 'create', '--config', file);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /NAME is required/);
});
