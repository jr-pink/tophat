import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { world, settle } from '@tophat-md/linknotes/testing';
import { fuzzParties, differential, cast, replicaPair } from '../index.mjs';

const worlds = [];
after(async () => { for (const w of worlds) await w.close(); });

for (const seed of [1, 2, 3]) {
  test(`three users on sqlite replicas (one on two devices), two shared scopes: visibility, pages and bytes hold (seed ${seed})`, async () => {
    const w = await world(); worlds.push(w);
    const r = await fuzzParties({ seed, ops: 40, ...(await cast(w, seed, settle)) });
    assert.deepEqual(r.failures, []);
    assert.ok(r.stats.notes > 5);
    assert.equal(r.stats.parties, 4);
  });
}

for (const seed of [7, 8]) {
  test(`differential: a replica after hub sync reads the same as its origin (seed ${seed})`, async () => {
    const w = await world(); worlds.push(w);
    const r = await differential({ seed, ops: 30, ...(await replicaPair(w, `d${seed}`, settle)) });
    assert.deepEqual(r.failures, []);
    assert.ok(r.stats.entities > 3 && r.stats.notes > 8);
  });
}

for (const seed of [11]) {
  test(`differential with both devices changing one note's scopes between syncs (seed ${seed})`, async () => {
    const w = await world(); worlds.push(w);
    const r = await differential({ seed, ops: 30, concurrent: true, ...(await replicaPair(w, `c${seed}`, settle)) });
    assert.deepEqual(r.failures, []);
    assert.ok(r.stats.notes > 5);
  });
}

// Grants converge: two devices of one user change the same note's scopes between syncs, then one shares again. The
// vendored core keeps a last-writer-wins register per (row, group) ordered by hub position, so after settling both
// devices read the same scopes.
test('two devices sharing one note concurrently, then a later share, converge', async () => {
  const w = await world(); worlds.push(w);
  const O = w.sqlite('cc'), R = w.replica(O);
  await O.createScope('cc'); await O.createScope('cc-team'); await settle(O, R);
  const n = (await O.apply({ entities: [{ id: '$e', name: 'X', type: 'topic' }], notes: [{ body: 'n1', entities: ['$e'] }] })).notes[0].id;
  await settle(O, R);
  await O.share('note', n, ['cc', 'cc-team']); await R.share('note', n, ['cc-team']); await settle(O, R);
  await O.share('note', n, ['cc']); await settle(O, R);
  const scopes = async (s) => { try { return (await s.read('note', n)).scopes; } catch (e) { return e.message; } };
  assert.deepEqual(await scopes(R), await scopes(O));
});

// Order is the same everywhere: under tenancy an entity's notes are ordered by `at` and ties broken by note id, not by
// the local SQLite rowid, so notes written in a different order on each device still render in one order.
test('notes with the same `at` render in the same order on every replica', async () => {
  const w = await world(); worlds.push(w);
  const O = w.sqlite('tie'), R = w.replica(O);
  await O.createScope('tie'); await settle(O, R);
  const at = '2026-11-01T10:00:00Z';
  const e = (await O.apply({ entities: [{ id: '$e', name: 'Tie', type: 'topic' }], notes: [{ body: 'first written', entities: ['$e'], at }] })).id_map.$e;
  await settle(O, R);
  await R.apply({ notes: [{ body: 'second written on the replica', entities: [e], at }] });
  await O.apply({ notes: [{ body: 'third written', entities: [e], at }] });
  await settle(O, R);
  assert.equal((await R.page(e)).outline, (await O.page(e)).outline);
});
