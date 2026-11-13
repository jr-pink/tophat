// The vault's reducer: one pure module, run on the server and in a browser alike.
//
// The vault merges as a last-writer-wins CRDT with per-entry clocks and tombstones, and a device replica reads
// offline from a client-side reducer. What has to hold: merge is commutative,
// associative and idempotent; a deletion is a tombstone that beats older writes and loses to
// newer ones; a catalog from before clocks existed migrates by its own updatedAt; folding a
// device's pending ops over the confirmed catalog is pure and does not depend on the order of the
// queue; the list and search views match what /secrets draws; and nothing anywhere is plaintext.
//
// Enrolment and op replay between a server and a device live in the server code, not here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PasswordManager} from '../src/vault/manager.mjs';
import {applyOpToCatalog, classifyOp, compareHlc, encodeHlc, foldCatalog, mergeStates,
  replicatedView, tick, vaultList, vaultSearch, withClocks} from '../src/vault/replica.mjs';

const CANARY = 'REPLICA-CANARY-PASSWORD-7d31';
const SITE = 'https://replica.example.test';

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tophat-vault-replica-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// Two replicas sharing one master key: the key file is copied, never derived or transmitted.
function pair(t) {
  const dir = root(t);
  const a = new PasswordManager({directory: path.join(dir, 'a/vault'), keyFile: path.join(dir, 'a/key')});
  a.initialize();
  fs.mkdirSync(path.join(dir, 'b'), {mode: 0o700});
  fs.copyFileSync(path.join(dir, 'a/key'), path.join(dir, 'b/key'));
  fs.chmodSync(path.join(dir, 'b/key'), 0o600);
  const b = new PasswordManager({directory: path.join(dir, 'b/vault'), keyFile: path.join(dir, 'b/key')});
  b.initialize();
  return {dir, a, b};
}

const login = (id, password = CANARY, extra = {}) => ({id, name: `Account ${id}`, kind: 'login',
  origins: [SITE], value: {username: `${id}-user`, password}, ...extra});

const state = m => ({catalog: withClocks(m.catalog(), m.passkeyIndex(), m.replicaId()), passkeys: m.passkeyIndex()});
const view = s => replicatedView(s);

function grepTree(dir, needle) {
  const hits = [];
  for (const name of fs.readdirSync(dir, {recursive: true})) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile() && fs.readFileSync(file).includes(needle)) hits.push(file);
  }
  return hits;
}

// A catalog as the device holds it after a snapshot: metadata and clocks, values by reference.
const entryOf = (id, hlc, extra = {}) => ({id, name: `Account ${id}`, kind: 'login', origins: [SITE],
  groups: [], notes: '', archived: false, keyringName: `value-${'0'.repeat(32)}`, hlc, ...extra});
const catalogOf = (entries, tombstones = {}) =>
  ({version: 2, revision: 1, entries: Object.fromEntries(entries.map(e => [e.id, e])), tombstones});

const op = (kind, id, hlc, extra = {}) => ({opId: `vop_${id.slice(0, 12).padEnd(16, '0')}`, seq: 1,
  at: '2026-10-23T00:00:00.000Z', hlc, kind, id, ...extra});
const putOp = (id, hlc, extra = {}) => op('put', id, hlc,
  {keyringName: `value-${'1'.repeat(32)}`, sealedValue: 'AV01-fake-ciphertext',
    entry: {name: `Account ${id}`, kind: 'login', origins: [SITE], groups: [], notes: '', archived: false},
    ...extra});

test('clocks order by wall time, then counter, then replica; tick is monotonic', () => {
  const x = encodeHlc(1000, 0, 'aaaa'), y = encodeHlc(1000, 1, 'aaaa'), z = encodeHlc(1000, 1, 'bbbb');
  assert.equal(compareHlc(x, y), -1);
  assert.equal(compareHlc(y, z), -1);
  assert.equal(compareHlc(encodeHlc(999, 5, 'zzzz'), x), -1);
  // A clock ahead of the wall (a peer with a fast clock) is still exceeded.
  const ahead = encodeHlc(5000, 3, 'peer');
  const next = tick(ahead, 'mine', 1000);
  assert.equal(compareHlc(next, ahead), 1);
  assert.equal(compareHlc(tick(null, 'mine', 2000), encodeHlc(1999, 999999, 'zzzz')), 1);
});

test('every mutation stamps a clock; forget leaves a tombstone, archive bumps the clock', t => {
  const {a} = pair(t);
  a.save(login('one'));
  const first = a.catalog().entries.one.hlc;
  assert.match(first, /^\d{15}\.\d{6}\.[0-9a-f]{16}$/);
  a.archive('one');
  const archived = a.catalog().entries.one;
  assert.equal(compareHlc(archived.hlc, first), 1);
  a.forget('one');
  const catalog = a.catalog();
  assert.equal(catalog.entries.one, undefined);
  assert.equal(compareHlc(catalog.tombstones.one.hlc, archived.hlc), 1);
  assert.equal(catalog.tombstones.one.kind, 'login');
  assert.deepEqual(Object.keys(catalog.sync.pending), ['one']);
});

test('merge is commutative, associative and idempotent', t => {
  const {dir, a, b} = pair(t);
  const c = new PasswordManager({directory: path.join(dir, 'c/vault'), keyFile: path.join(dir, 'a/key')});
  a.save(login('shared', 'A-1'));
  a.save(login('only-a'));
  b.save(login('shared', 'B-1'));
  b.save(login('only-b'));
  b.forget('only-b');
  c.save(login('only-a', 'C-later'));
  c.archive('only-a');
  const [sa, sb, sc] = [state(a), state(b), state(c)];
  assert.equal(view(mergeStates(sa, sb)), view(mergeStates(sb, sa)), 'commutative');
  assert.equal(view(mergeStates(mergeStates(sa, sb), sc)), view(mergeStates(sa, mergeStates(sb, sc))), 'associative');
  const ab = mergeStates(sa, sb);
  assert.equal(view(mergeStates(ab, ab)), view(ab), 'idempotent');
  assert.equal(view(mergeStates(ab, sa)), view(ab), 'absorbs a side already merged');
});

test('last writer wins per entry; a tombstone beats older writes and loses to newer ones', () => {
  const entry = (id, hlc, name = id) => ({id, name, kind: 'secret', origins: [], groups: [],
    keyringName: `value-${'0'.repeat(32)}`, hlc});
  const s = (entries, tombstones = {}) => ({catalog: {version: 2, revision: 1, entries, tombstones}, passkeys: []});
  const old = encodeHlc(1000, 0, 'aaaa'), mid = encodeHlc(2000, 0, 'bbbb'), late = encodeHlc(3000, 0, 'aaaa');
  // edit vs edit
  let m = mergeStates(s({x: entry('x', old, 'old')}), s({x: entry('x', mid, 'new')}));
  assert.equal(m.catalog.entries.x.name, 'new');
  // delete after edit: stays deleted, never resurrected by the older edit
  m = mergeStates(s({x: entry('x', mid)}), s({}, {x: {hlc: late, name: 'x', kind: 'secret'}}));
  assert.equal(m.catalog.entries.x, undefined);
  assert.equal(m.catalog.tombstones.x.hlc, late);
  // re-create after delete: the newer write wins and the tombstone goes
  m = mergeStates(s({}, {x: {hlc: mid, name: 'x', kind: 'secret'}}), s({x: entry('x', late)}));
  assert.equal(m.catalog.entries.x.hlc, late);
  assert.equal(m.catalog.tombstones.x, undefined);
  // equal clocks: tombstone wins deterministically on either side
  const t1 = mergeStates(s({x: entry('x', mid)}), s({}, {x: {hlc: mid, name: 'x', kind: 'secret'}}));
  const t2 = mergeStates(s({}, {x: {hlc: mid, name: 'x', kind: 'secret'}}), s({x: entry('x', mid)}));
  assert.equal(t1.catalog.entries.x, undefined);
  assert.equal(view(t1), view(t2));
});

test('passkeys merge per credential with their own clocks and tombstones', () => {
  const early = encodeHlc(1000, 0, 'aaaa'), later = encodeHlc(2000, 0, 'bbbb');
  const side = (passkeys, passkeyClocks, passkeyTombstones = {}) =>
    ({catalog: {version: 2, revision: 1, entries: {}, tombstones: {}, passkeyClocks, passkeyTombstones}, passkeys});
  // One side deleted pk-1; the other touched it afterwards, so it survives with the newer counter.
  const deleted = side([], {}, {'pk-1': early});
  const touched = side([{id: 'pk-1', rpId: 'example.test', signCount: 7},
    {id: 'pk-2', rpId: 'other.test', signCount: 0}], {'pk-1': later, 'pk-2': later});
  const merged = mergeStates(deleted, touched);
  assert.deepEqual(merged.passkeys.map(k => [k.id, k.signCount]), [['pk-1', 7], ['pk-2', 0]]);
  assert.equal(view(merged), view(mergeStates(touched, deleted)));
  // And the other way round in time: a delete after the edit keeps the tombstone.
  const buried = mergeStates(side([{id: 'pk-1', rpId: 'example.test', signCount: 7}], {'pk-1': early}),
    side([], {}, {'pk-1': later}));
  assert.deepEqual(buried.passkeys, []);
  assert.equal(buried.catalog.passkeyTombstones['pk-1'], later);
});

test('a catalog from before clocks migrates by its updatedAt and keeps every entry', t => {
  const {a} = pair(t);
  a.save(login('legacy-1'));
  a.save(login('legacy-2'));
  // Strip the replica fields, as a pre-clock catalog on disk looks.
  a.mutate(catalog => {
    for (const entry of Object.values(catalog.entries)) delete entry.hlc;
    delete catalog.tombstones; delete catalog.passkeyClocks; delete catalog.passkeyTombstones; delete catalog.sync;
    delete catalog.crdt;
  }, {replicate: false});
  assert.equal(a.catalog().entries['legacy-1'].hlc, undefined);
  a.save(login('fresh'));
  const catalog = a.catalog();
  const legacy = catalog.entries['legacy-1'].hlc;
  assert.equal(Number(legacy.slice(0, 15)), Date.parse(catalog.entries['legacy-1'].updatedAt));
  assert.equal(legacy.split('.')[1], '000000');
  assert.deepEqual(Object.keys(catalog.sync.pending), ['fresh'], 'migration queues nothing');
  assert.equal(Object.keys(catalog.entries).length, 3);
});

test('the vault directory never holds a plaintext value', t => {
  const {dir, a} = pair(t);
  a.save(login('canary'));
  a.mutate(() => a.write('passkeys-index', JSON.stringify([{id: 'pk', rpId: 'x.test', privateKey: CANARY}])));
  assert.deepEqual(grepTree(dir, CANARY), []);
  a.forget('canary');
  assert.deepEqual(grepTree(dir, CANARY), []);
  // The ciphertext of a forgotten credential is collected, not left behind.
  assert.deepEqual(fs.readdirSync(a.directory).filter(file => file.startsWith('value-')), []);
});

test('classifyOp: applied, superseded and the shapes the vault will never accept', () => {
  const mid = encodeHlc(2000, 0, 'bbbb'), late = encodeHlc(3000, 0, 'daaaaaaa');
  const catalog = catalogOf([entryOf('live', mid)], {gone: {hlc: mid, name: 'gone', kind: 'login'}});
  assert.deepEqual(classifyOp(catalog, putOp('live', late)), {status: 'applied'});
  assert.deepEqual(classifyOp(catalog, putOp('live', mid)), {status: 'superseded'});
  assert.deepEqual(classifyOp(catalog, putOp('gone', mid)), {status: 'superseded'});
  assert.deepEqual(classifyOp(catalog, putOp('gone', late)), {status: 'applied'});
  assert.deepEqual(classifyOp(catalog, op('delete', 'live', late)), {status: 'applied'});
  assert.deepEqual(classifyOp(catalog, op('meta', 'live', late, {patch: {name: 'Renamed'}})), {status: 'applied'});
  // A meta op for a credential this catalog has never heard of waits for its put.
  assert.deepEqual(classifyOp(catalog, op('meta', 'unheard', late, {patch: {name: 'x'}})),
    {status: 'rejected', reason: 'unknown credential'});
  assert.deepEqual(classifyOp(catalog, op('meta', 'live', late, {patch: {value: 'nice try'}})),
    {status: 'rejected', reason: 'unknown field'});
  assert.deepEqual(classifyOp(catalog, {...putOp('live', late), keyringName: 'catalog'}),
    {status: 'rejected', reason: 'malformed value'});
  assert.deepEqual(classifyOp(catalog, op('burn', 'live', late)), {status: 'rejected', reason: 'malformed op'});
  assert.deepEqual(classifyOp(catalog, op('put', 'Live Upper', late)), {status: 'rejected', reason: 'malformed op'});
  assert.deepEqual(classifyOp(catalog, {...putOp('live', late), hlc: 'yesterday'}),
    {status: 'rejected', reason: 'malformed op'});
  assert.deepEqual(classifyOp(catalog, null), {status: 'rejected', reason: 'malformed op'});
});

test('applyOpToCatalog is pure: the catalog handed in is never touched', () => {
  const mid = encodeHlc(2000, 0, 'bbbb'), late = encodeHlc(3000, 0, 'daaaaaaa');
  const catalog = catalogOf([entryOf('one', mid)]);
  const frozen = JSON.stringify(catalog);
  const next = applyOpToCatalog(catalog, putOp('one', late, {entry: {name: 'Edited', kind: 'login',
    origins: [SITE], groups: ['work'], notes: 'n', archived: true}}));
  assert.equal(JSON.stringify(catalog), frozen, 'input untouched');
  assert.notEqual(next, catalog);
  assert.equal(next.entries.one.name, 'Edited');
  assert.deepEqual(next.entries.one.groups, ['work']);
  assert.equal(next.entries.one.archived, true);
  assert.equal(next.entries.one.hlc, late);
  assert.equal(next.entries.one.keyringName, putOp('one', late).keyringName);
  // An op that does not apply gives the catalog straight back, so a fold allocates nothing.
  assert.equal(applyOpToCatalog(catalog, putOp('one', mid)), catalog);
  assert.equal(applyOpToCatalog(catalog, op('meta', 'nobody', late, {patch: {name: 'x'}})), catalog);
});

test('folding a device op log is order independent and settles on clock order', () => {
  const base = catalogOf([entryOf('kept', encodeHlc(1000, 0, 'aaaa'))]);
  const ops = [
    putOp('kept', encodeHlc(2000, 0, 'daaaaaaa'), {opId: 'vop_a', entry: {name: 'First edit', kind: 'login',
      origins: [SITE], groups: [], notes: '', archived: false}}),
    op('meta', 'kept', encodeHlc(3000, 0, 'daaaaaaa'), {opId: 'vop_b', patch: {name: 'Second edit', groups: ['x']}}),
    putOp('added', encodeHlc(2500, 0, 'daaaaaaa'), {opId: 'vop_c'}),
    op('delete', 'added', encodeHlc(4000, 0, 'daaaaaaa'), {opId: 'vop_d'}),
  ];
  const forwards = foldCatalog(base, ops);
  const backwards = foldCatalog(base, [...ops].reverse());
  const shuffled = foldCatalog(base, [ops[3], ops[0], ops[2], ops[1]]);
  assert.equal(JSON.stringify(forwards), JSON.stringify(backwards));
  assert.equal(JSON.stringify(forwards), JSON.stringify(shuffled));
  assert.equal(forwards.entries.kept.name, 'Second edit');
  assert.deepEqual(forwards.entries.kept.groups, ['x']);
  assert.equal(forwards.entries.kept.keyringName, ops[0].keyringName, 'the metadata edit keeps the new value');
  assert.equal(forwards.entries.added, undefined);
  assert.equal(forwards.tombstones.added.hlc, ops[3].hlc);
  assert.equal(foldCatalog(base, []), base);
});

test('a folded delete tombstones the id, and a newer put brings it back', () => {
  const base = catalogOf([entryOf('here', encodeHlc(1000, 0, 'aaaa'))]);
  const buried = foldCatalog(base, [op('delete', 'here', encodeHlc(2000, 0, 'daaaaaaa'), {opId: 'vop_x'})]);
  assert.equal(buried.entries.here, undefined);
  assert.deepEqual(buried.tombstones.here, {hlc: encodeHlc(2000, 0, 'daaaaaaa'), name: 'Account here', kind: 'login'});
  const back = foldCatalog(buried, [putOp('here', encodeHlc(3000, 0, 'daaaaaaa'), {opId: 'vop_y'})]);
  assert.equal(back.tombstones.here, undefined);
  assert.equal(back.entries.here.name, 'Account here');
  // The older delete cannot bury it a second time.
  assert.ok(foldCatalog(back, [op('delete', 'here', encodeHlc(2000, 0, 'daaaaaaa'), {opId: 'vop_x'})]).entries.here);
});

test('vaultList scopes by archived, group and kind, and sorts the way the page does', () => {
  const clock = encodeHlc(1000, 0, 'aaaa');
  const catalog = catalogOf([
    entryOf('beta', clock, {name: 'beta account', groups: ['work']}),
    entryOf('alpha', clock, {name: 'Alpha account', groups: ['work', 'home']}),
    entryOf('old', clock, {name: 'Old account', archived: true, groups: ['home']}),
    entryOf('key', clock, {name: 'A token', kind: 'secret', groups: []}),
  ]);
  assert.deepEqual(vaultList(catalog).map(e => e.id), ['key', 'alpha', 'beta']);
  assert.deepEqual(vaultList(catalog, {archived: 'only'}).map(e => e.id), ['old']);
  assert.deepEqual(vaultList(catalog, {archived: true}).map(e => e.id), ['key', 'alpha', 'beta', 'old']);
  assert.deepEqual(vaultList(catalog, {group: 'work'}).map(e => e.id), ['alpha', 'beta']);
  assert.deepEqual(vaultList(catalog, {kind: 'secret'}).map(e => e.id), ['key']);
  assert.deepEqual(vaultList({}).map(e => e.id), []);
});

test('vaultSearch matches the fields /secrets searches, substring and case insensitive', () => {
  const clock = encodeHlc(1000, 0, 'aaaa');
  const catalog = catalogOf([
    entryOf('service-oauth', clock, {name: 'Service', kind: 'oauth', issuer: 'service.com',
      account: 'owner@vault.example.test', scopes: ['accounts.read']}),
    entryOf('home-wifi', clock, {name: 'Home wifi', origins: [], usernames: ['guest'], groups: ["home"]}),
    entryOf('archived-one', clock, {name: 'Service old', archived: true}),
  ]);
  assert.deepEqual(vaultSearch(catalog, 'service').map(e => e.id), ['service-oauth']);
  assert.deepEqual(vaultSearch(catalog, 'SERVICE', {archived: true}).map(e => e.id),
    ['service-oauth', 'archived-one']);
  assert.deepEqual(vaultSearch(catalog, 'owner@vault').map(e => e.id), ['service-oauth']);
  assert.deepEqual(vaultSearch(catalog, 'guest').map(e => e.id), ['home-wifi']);
  assert.deepEqual(vaultSearch(catalog, "home").map(e => e.id), ['home-wifi']);
  assert.deepEqual(vaultSearch(catalog, '  ').map(e => e.id), ['home-wifi', 'service-oauth']);
  assert.deepEqual(vaultSearch(catalog, 'nothing here').map(e => e.id), []);
  // The kind label the page shows is searchable too, when the page passes its own labels.
  assert.deepEqual(vaultSearch(catalog, 'website login', {labels: {login: 'Website login'}}).map(e => e.id),
    ['home-wifi']);
});
