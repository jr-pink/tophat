// One suite, run in two modes over the sqlite backend: a single replica, and a replicated pair (A writes, B is a second
// device of the same user, both syncing through a local hub that holds ciphertext only), where every read the suite makes
// is answered by both replicas and must be identical (kit.mjs mirror). Every MemoryStore method, same observable results.
import assert from 'node:assert/strict';
import { describe, test, after } from 'node:test';
import { world, mirror } from './kit.mjs';
import { METHODS } from '../src/interface.mjs';

const T = '2026-11-01T10:00:00Z';
for (const mode of ['single replica', 'replicas A<->B through the hub']) {
  describe(`MemoryStore conformance: sqlite, ${mode}`, () => {
    let w;
    const made = [];
    const make = async (user, opts) => {
      w ??= await world();
      const a = w.sqlite(user, opts);
      const m = mode === 'single replica' ? a : mirror(a, w.replica(a));
      made.push(m);
      return m;
    };
    after(async () => { await w?.close(); });

    test('exposes every interface method', async () => {
      const m = await make('carol');
      for (const k of [...METHODS, 'close']) assert.equal(typeof m[k], 'function', k);
      const me = await m.whoami();
      assert.equal(me.user, 'carol'); assert.equal(me.backend, 'sqlite'); assert.deepEqual(me.writeScopes, ['carol']);
    });

    test('scopes: create, list, members', async () => {
      const m = await make('dave');
      await m.createScope('dave');
      await m.createScope('dave-team');
      await m.addMember('dave-team', 'erin', 'read');
      assert.deepEqual(await m.scopes(), [{ scope: 'dave', role: 'admin' }, { scope: 'dave-team', role: 'admin' }]);
      await m.sync();
    });

    test('apply, read, entity, search, page (cached by visible note set)', async () => {
      const m = await make('fay');
      await m.createScope('fay');
      const r = await m.apply({ entities: [{ id: '$d', name: 'Dana Okafor', type: 'person' }], notes: [{ body: 'Fay met Dana Okafor at the sprinkler bench.', entities: ['$d'], at: T }] });
      assert.equal(r.ok, true);
      const id = r.id_map.$d;
      const e = await m.entity(id);
      assert.equal(e.entity.name, 'Dana Okafor');
      assert.deepEqual(e.entity.scopes, ['fay']);
      assert.deepEqual(e.notes.map((n) => n.body), ['Fay met Dana Okafor at the sprinkler bench.']);
      assert.deepEqual(e.notes[0].scopes, ['fay']);
      const note = await m.read('note', e.notes[0].id);
      assert.equal(note.note.body, 'Fay met Dana Okafor at the sprinkler bench.');
      const hits = (await m.search('sprinkler')).hits;
      assert.ok(hits.some((h) => h.kind === 'note'));
      const p1 = await m.page(id);
      assert.equal(p1.cached, false); assert.match(p1.outline, /sprinkler bench/); assert.deepEqual(p1.cnf, [['fay']]);
      const p2 = await m.page(id);
      assert.equal(p2.cached, true); assert.equal(p2.key, p1.key);
      await m.apply({ notes: [{ body: 'Dana Okafor calibrated the boiler.', entities: [id], at: T }] });
      const p3 = await m.page(id);
      assert.notEqual(p3.key, p1.key, 'a new visible note is a new page');
      assert.equal(p3.note_ids.length, 2);
    });

    test('declaring a $new entity whose name a live same-typed entity holds is refused with its id; the original keeps its name', async () => {
      const m = await make('hal');
      await m.createScope('hal');
      const first = await m.apply({ entities: [{ id: '$p', name: 'Pat Moreno', type: 'person' }] });
      const id = first.id_map.$p;
      await assert.rejects(m.apply({ entities: [{ id: '$q', name: 'pat moreno', type: 'person' }], notes: [{ body: 'Hal met Pat.', entities: ['$q'] }] }), (e) => e.constructor.name === 'StoreError' && e.message.includes(`already exists: ${id} (Pat Moreno, person)`));
      assert.equal((await m.entity(id)).entity.name, 'Pat Moreno');
      assert.equal((await m.apply({ entities: [{ id: '$t', name: 'Pat Moreno', type: 'topic' }] })).ok, true);
      assert.equal((await m.apply({ entities: [{ id: '$d', name: 'Pat Moreno', type: 'person', name_status: 'distinct' }] })).ok, true);
    });

    test('ingest, pending, apply with ackRaw clears pending; duplicates are idempotent', async () => {
      const m = await make('gus');
      await m.createScope('gus');
      const recs = [{ id: 'm1', source: 'jsonl', text: 'Gus ordered the compressor', time: T }, { id: 'm2', source: 'jsonl', text: 'Gus booked the boiler', time: T }];
      const a = await m.ingest(recs, { pusher: 'gus-push' });
      assert.equal(a.stored.length, 2);
      const b = await m.ingest(recs, { pusher: 'gus-push' });
      assert.equal(b.stored.length, 0); assert.equal(b.duplicates.length, 2);
      const pend = await m.pending({ pusher: 'gus-push' });
      assert.deepEqual(pend.map((p) => p.text), ['Gus ordered the compressor', 'Gus booked the boiler']);
      assert.deepEqual(await m.pending({ pusher: 'someone-else' }), []);
      await m.apply({ entities: [{ id: '$g', name: 'Gus', type: 'person' }], notes: [{ body: 'Gus ordered the compressor and booked the boiler.', entities: ['$g'] }] }, { sourceRefs: pend.map((p) => p.id), ackRaw: pend.map((p) => p.id) });
      assert.deepEqual(await m.pending({ pusher: 'gus-push' }), []);
    });

    test('share widens, retract removes from every read; link merges entities for reads', async () => {
      const m = await make('hal');
      await m.createScope('hal'); await m.createScope('hal-team');
      const r = await m.apply({ entities: [{ id: '$a', name: 'Lab Boiler', type: 'artifact' }, { id: '$b', name: 'Big Boiler', type: 'artifact' }],
        notes: [{ body: 'The lab boiler holds 200 litres.', entities: ['$a'], at: T }, { body: 'The big boiler leaks at the seam.', entities: ['$b'], at: T }] });
      const [a, b] = [r.id_map.$a, r.id_map.$b];
      const n = (await m.entity(a)).notes[0].id;
      const s = await m.share('note', n, ['hal', 'hal-team']);
      assert.deepEqual(s.acl, ['hal', 'hal-team']);
      assert.deepEqual((await m.read('note', n)).scopes, ['hal', 'hal-team']);
      await m.link(a, b);
      assert.deepEqual((await m.entity(a)).notes.map((x) => x.body).sort(), ['The big boiler leaks at the seam.', 'The lab boiler holds 200 litres.']);
      await m.retract('note', n);
      assert.deepEqual((await m.entity(a)).notes.map((x) => x.body), ['The big boiler leaks at the seam.']);
      assert.ok(!(await m.search('litres')).hits.some((h) => h.kind === 'note'));
    });

    test('errors are StoreErrors: unknown scope, no visible entity', async () => {
      const m = await make('ivy');
      await m.createScope('ivy');
      await assert.rejects(m.apply({ entities: [{ id: '$x', name: 'X', type: 'topic' }], notes: [{ body: 'x', entities: ['$x'], scopes: ['nope-scope'] }] }), (e) => e.constructor.name === 'StoreError' && /unknown group nope-scope/.test(e.message));
      await assert.rejects(m.page('e_0000000000'), (e) => e.constructor.name === 'StoreError');
    });

    test('a configured screen refuses matching text into a screened scope', async () => {
      const m = await make('jon', { writeScopes: ['jon'], screens: [{ groups: ['jon-public'], pattern: 'salary|password', label: 'private-words screen' }] });
      await m.createScope('jon'); await m.createScope('jon-public');
      await assert.rejects(m.apply({ entities: [{ id: '$t', name: 'Boiler', type: 'artifact', scopes: ['jon-public'] }], notes: [{ body: 'my salary is high', entities: ['$t'], scopes: ['jon-public'] }] }), /private-words screen/);
      const ok = await m.apply({ entities: [{ id: '$t', name: 'Boiler', type: 'artifact', scopes: ['jon-public'] }], notes: [{ body: 'the boiler is full', entities: ['$t'], scopes: ['jon-public'] }] });
      assert.equal(ok.ok, true);
    });

    test('sync with the hub round-trips and is idempotent', async () => {
      const m = await make('kim');
      await m.createScope('kim');
      await m.apply({ entities: [{ id: '$k', name: 'Kim', type: 'person' }], notes: [{ body: 'Kim synced.', entities: ['$k'] }] });
      const r1 = await m.sync();
      assert.ok(r1.pushed >= 1);
      const r2 = await m.sync();
      assert.equal(r2.pushed, 0);
    });

    if (mode !== 'single replica') test('the replicated mode compared every read the suite made on both replicas', () => {
      const n = made.reduce((k, m) => k + m.checked, 0);
      assert.ok(n >= 16, `compared ${n} reads`);
    });
  });
}
