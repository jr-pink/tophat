// Over a real MemoryStore (two sqlite replicas through a hub, temp files only): the viewer's notes and scopes come from
// the store, a narrowing share shrinks the audience, and a group member adopts what the other built.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { settle, world } from '@tophat-md/linknotes/testing';
import { audience, buildPage, publish, scopesFrom, storeLog, viewerNotes } from '../index.mjs';
import { actors, stubGenerate } from './helpers.mjs';

const worlds = [];
let w;
after(async () => { await w?.close(); for (const x of worlds) await x.close(); });

test('notes and scopes from the store; unshare shrinks the audience; the other member adopts the shared branch', async () => {
  w = await world();
  const A = w.sqlite('ga'), B = w.sqlite('gb');
  await A.createScope('ga'); await A.createScope('gshared'); await B.createScope('gb');
  await settle(A, B); await A.addMember('gshared', 'gb', 'write'); await settle(A, B);
  const r = await A.apply({ entities: [{ id: '$p', name: 'Pump', type: 'topic', scopes: ['ga', 'gshared'] }, { id: '$v', name: 'Valve', type: 'topic', scopes: ['ga', 'gshared'] }, { id: '$s', name: 'Seal', type: 'topic', scopes: ['ga', 'gshared'] }],
    notes: [
      { body: 'The pump feeds the valve.', entities: ['$p', '$v'], scopes: ['gshared'], at: '2026-03-01T00:00:00Z' },
      { body: 'The valve sticks when cold.', entities: ['$p', '$v'], scopes: ['gshared'], at: '2026-03-02T00:00:00Z' },
      { body: 'The seal was replaced.', entities: ['$p', '$s'], scopes: ['gshared'], at: '2026-03-03T00:00:00Z' },
      { body: 'The seal cost too much.', entities: ['$p', '$s'], scopes: ['ga'], at: '2026-03-04T00:00:00Z' },
    ] }, { scopes: ['ga', 'gshared'] });
  await settle(A, B);
  const pump = r.id_map.$p;
  const aNotes = await viewerNotes(A, pump), bNotes = await viewerNotes(B, pump);
  assert.equal(aNotes.length, 4); assert.equal(bNotes.length, 3);
  assert.ok(aNotes.every((n) => n.entities.includes(pump) && n.scopes.length));
  const keys = actors(['ga', 'gb']);
  const trust = (u) => ({ groups: u === 'ga' ? ['ga', 'gshared'] : ['gb', 'gshared'], pagewriters: { gshared: ['ga', 'gb'] }, publicKeyOf: keys.publicKeyOf });
  const log = storeLog(A);
  const built = await buildPage({ store: A, entity: pump, published: [], trust: trust('ga'), generate: stubGenerate(), author: 'ga', clock: keys.ga.clock, privateKey: keys.ga.privateKey });
  const res = await publish(log, built.records, 'gshared', { scopesOf: scopesFrom(aNotes) });
  const valve = `f:${r.id_map.$v}`;
  assert.deepEqual(res.published.map((p) => p.path), [valve]);   // the seal branch and the root rest on a ga-only note
  await settle(A, B);
  // the record travelled as a replicated row: B reads it out of its own store, not out of A's process
  const published = await storeLog(B).list({ entity: pump, groups: ['gb', 'gshared'] });
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].record, built.records.find((r) => r.path === valve));
  assert.deepEqual(published[0].scopes, ['gshared']);   // B holds only the grant it came through; the ga grant is A's
  const gen = stubGenerate();
  const got = await buildPage({ store: B, entity: pump, published, trust: trust('gb'), generate: gen, author: 'gb', clock: keys.gb.clock, privateKey: keys.gb.privateKey });
  assert.equal(got.decisions.get(valve).action, 'adopt');
  assert.ok(!gen.paths().includes(valve));
  // narrowing a note's share shrinks the audience of everything resting on it
  const shared = aNotes.find((n) => /sticks/.test(n.body));
  assert.deepEqual(audience([shared.id], scopesFrom(aNotes)), ['gshared']);
  await A.share('note', shared.id, ['ga']);
  assert.deepEqual(audience([shared.id], scopesFrom(await viewerNotes(A, pump))), ['ga']);
});

test('a page node citing a private note never reaches the other member', async () => {
  const w2 = await world(); worlds.push(w2);
  const A = w2.sqlite('pa'), B = w2.sqlite('pb');
  await A.createScope('pa'); await A.createScope('pshared'); await B.createScope('pb');
  await settle(A, B); await A.addMember('pshared', 'pb', 'write'); await settle(A, B);
  const r = await A.apply({ entities: [{ id: '$p', name: 'Rig', type: 'topic', scopes: ['pa', 'pshared'] }, { id: '$v', name: 'Valve', type: 'topic', scopes: ['pa', 'pshared'] }, { id: '$s', name: 'Seal', type: 'topic', scopes: ['pa', 'pshared'] }],
    notes: [
      { body: 'The rig drives the valve.', entities: ['$p', '$v'], scopes: ['pshared'], at: '2026-04-01T00:00:00Z' },
      { body: 'The valve was swapped.', entities: ['$p', '$v'], scopes: ['pshared'], at: '2026-04-02T00:00:00Z' },
      { body: 'The seal leaked at the test.', entities: ['$p', '$s'], scopes: ['pa'], at: '2026-04-03T00:00:00Z' },
      { body: 'The seal supplier overcharged us.', entities: ['$p', '$s'], scopes: ['pa'], at: '2026-04-04T00:00:00Z' },
    ] }, { scopes: ['pa', 'pshared'] });
  await settle(A, B);
  const rig = r.id_map.$p, seal = `f:${r.id_map.$s}`;
  const keys = actors(['pa', 'pb']);
  const trustB = { groups: ['pb', 'pshared'], pagewriters: { pshared: ['pa', 'pb'] }, publicKeyOf: keys.publicKeyOf };
  const aNotes = await viewerNotes(A, rig);
  const built = await buildPage({ store: A, entity: rig, published: [], trust: { groups: ['pa', 'pshared'], pagewriters: { pshared: ['pa'] }, publicKeyOf: keys.publicKeyOf }, generate: stubGenerate(), author: 'pa', clock: keys.pa.clock, privateKey: keys.pa.privateKey });
  const sealNode = built.records.find((x) => x.path === seal), root = built.records.find((x) => x.path === '');
  assert.ok(sealNode && root);
  assert.deepEqual(audience(sealNode.citedNoteIds, scopesFrom(aNotes)), ['pa']);   // rests on pa-only notes
  // the store refuses to widen a node past the audience of its notes, whatever the caller asks for
  await assert.rejects(() => A.putPageNode(sealNode, { scopes: ['pshared'] }), /never widens access/);
  // the root rests on notes no single group holds (private and shared mixed), so it has no audience at all
  assert.deepEqual(audience(root.citedNoteIds, scopesFrom(aNotes)), []);
  await assert.rejects(() => A.putPageNode(root, { scopes: ['pa'] }), /no group holds every note/);
  // the shared branch publishes to pshared; the private branch only to pa; the root to neither
  const valve = `f:${r.id_map.$v}`;
  const shared = await publish(storeLog(A), built.records, 'pshared', { scopesOf: scopesFrom(aNotes) });
  assert.deepEqual(shared.published.map((p) => p.path), [valve]);
  assert.deepEqual(shared.skipped.map((p) => p.path).sort(), [seal, ''].sort());
  const privately = await publish(storeLog(A), built.records, 'pa', { scopesOf: scopesFrom(aNotes) });
  assert.deepEqual(privately.published.map((p) => p.path), [seal]);
  assert.deepEqual(privately.published[0].scopes, ['pa']);
  await settle(A, B);
  const seen = await storeLog(B).list({ entity: rig, groups: ['pb', 'pshared'] });
  assert.deepEqual(seen.map((e) => e.record.path), [valve]);
  assert.ok(!seen.some((e) => /seal|supplier/i.test(e.record.text)));
  assert.deepEqual(await B.pageNodes({ entity: rig, key: sealNode.key }), []);
  assert.deepEqual(await B.pageNodes({ entity: rig, key: root.key }), []);
  // and nothing of the private branch is readable to B at all, with no scope filter
  const all = await B.pageNodes({ entity: rig });
  assert.deepEqual(all.map((e) => e.record.path), [valve]);
});
