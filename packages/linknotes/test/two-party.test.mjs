// Two parties, each with their own sqlite replica, sharing one scope through one hub and each keeping a private scope;
// B also runs a second device (B2). Checks visibility, cross-scope page composition (shared + the viewer's private, linked
// entities merged), and the leak property: no private note of one party reaches the other's replica files, reads,
// search, pages, or the hub, which holds ciphertext only (no note, entity name or marker in its bytes at all).
import assert from 'node:assert/strict';
import { describe, test, after } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { world, settle } from './kit.mjs';

const T = '2026-11-02T09:00:00Z';
const bytesOf = (file) => Buffer.concat([file, `${file}-wal`].filter(existsSync).map((f) => readFileSync(f))).toString('latin1');
const bodies = (e) => e.notes.map((n) => n.body).sort();

{
  describe('two parties on their own replicas through one hub', () => {
    let w;
    after(async () => { await w?.close(); });

    test('shared scope carries notes both ways; pages combine shared with the viewer\'s private only; nothing private leaks', async () => {
      w = await world();
      const A = w.sqlite('alice'), B = w.sqlite('bob'), B2 = w.replica(B);

      await A.createScope('alice'); await A.createScope('proj');
      await B.createScope('bob');
      await settle(A, B, B2);
      await A.addMember('proj', 'bob', 'write');
      await settle(A, B, B2);
      assert.deepEqual(await B.scopes(), [{ scope: 'bob', role: 'admin' }, { scope: 'proj', role: 'write' }]);

      // A: a shared entity, one shared note and one private note on it
      const a1 = await A.apply({ entities: [{ id: '$rig', name: 'Garden Shed', type: 'artifact', scopes: ['alice', 'proj'] }],
        notes: [{ body: 'SHARED-A: the rig frame is welded.', entities: ['$rig'], scopes: ['proj'], at: T },
          { body: 'PRIVATE-A-SECRET: the rig budget is tight.', entities: ['$rig'], scopes: ['alice'], at: T }] }, { scopes: ['alice', 'proj'] });
      const rig = a1.id_map.$rig;
      await settle(A, B, B2);

      // B sees the shared entity and only the shared note
      const bRig = await B.entity(rig);
      assert.deepEqual(bodies(bRig), ['SHARED-A: the rig frame is welded.']);

      // B: a shared note on the shared entity, and a private entity for the same thing with a private note, linked
      await B.apply({ notes: [{ body: 'SHARED-B: sprinkler calibrated against the rig.', entities: [rig], scopes: ['proj'], at: T }] });
      const b1 = await B.apply({ entities: [{ id: '$mine', name: 'My Rig Notes', type: 'artifact' }], notes: [{ body: 'PRIVATE-B-SECRET: I think the rig is overbuilt.', entities: ['$mine'], at: T }] });
      const mine = b1.id_map.$mine;
      await B.link(rig, mine);
      await settle(A, B, B2);

      // A: shared from both parties plus A's private; never B's private
      assert.deepEqual(bodies(await A.entity(rig)), ['PRIVATE-A-SECRET: the rig budget is tight.', 'SHARED-A: the rig frame is welded.', 'SHARED-B: sprinkler calibrated against the rig.']);
      const pa = await A.page(rig);
      assert.match(pa.outline, /SHARED-A/); assert.match(pa.outline, /SHARED-B/); assert.match(pa.outline, /PRIVATE-A-SECRET/);
      assert.doesNotMatch(pa.outline, /PRIVATE-B/);

      // B: its private entity's page merges the linked shared entity's notes with its own private note; never A's private
      const pb = await B.page(mine);
      assert.match(pb.outline, /SHARED-A/); assert.match(pb.outline, /SHARED-B/); assert.match(pb.outline, /PRIVATE-B-SECRET/);
      assert.doesNotMatch(pb.outline, /PRIVATE-A/);
      assert.deepEqual(pb.cnf, [['bob'], ['proj']], 'the cached page needs both of B\'s scopes');
      assert.deepEqual(bodies(await B.entity(rig)), ['PRIVATE-B-SECRET: I think the rig is overbuilt.', 'SHARED-A: the rig frame is welded.', 'SHARED-B: sprinkler calibrated against the rig.']);

      // search never returns the other party's private material
      assert.equal((await B.search('budget')).hits.length, 0);
      assert.equal((await A.search('overbuilt')).hits.length, 0);
      assert.ok((await A.search('sprinkler')).hits.some((h) => h.kind === 'note'));

      // leak property on bytes: B's replica file, A's replica file, and the hub (which holds no plaintext at all)
      const bBytes = bytesOf(B.config.file), b2Bytes = bytesOf(B2.config.file), aBytes = bytesOf(A.config.file), hubBytes = bytesOf(w.hubFile);
      assert.ok(!bBytes.includes('PRIVATE-A-SECRET') && !bBytes.includes('rig budget'), 'no private note of A in B\'s store');
      assert.ok(!b2Bytes.includes('PRIVATE-A-SECRET') && !b2Bytes.includes('rig budget'), 'no private note of A in B\'s second device');
      assert.ok(b2Bytes.includes('PRIVATE-B-SECRET') && b2Bytes.includes('SHARED-A'), 'B\'s second device holds B\'s private and the shared notes');
      // B's link joins entities with no scope in common, so it replicates nowhere (a link goes only into scopes both
      // entities share) and stays on the device that made it; B2 reads each entity on its own
      assert.deepEqual(bodies(await B2.entity(rig)), ['SHARED-A: the rig frame is welded.', 'SHARED-B: sprinkler calibrated against the rig.']);
      assert.deepEqual(bodies(await B2.entity(mine)), ['PRIVATE-B-SECRET: I think the rig is overbuilt.']);
      assert.equal((await B2.search('budget')).hits.length, 0);
      assert.ok(!aBytes.includes('PRIVATE-B-SECRET') && !aBytes.includes('overbuilt'), 'no private note of B in A\'s store');
      assert.ok(bBytes.includes('SHARED-A') && aBytes.includes('SHARED-B'), 'shared notes did arrive');
      for (const s of ['PRIVATE-A-SECRET', 'PRIVATE-B-SECRET', 'SHARED-A', 'SHARED-B', 'Garden Shed', 'My Rig Notes']) assert.ok(!hubBytes.includes(s), `hub holds no plaintext (${s})`);

      // retract a shared note: it leaves the other party's reads after sync
      const sharedA = (await A.entity(rig)).notes.find((n) => n.body.startsWith('SHARED-A')).id;
      await A.retract('note', sharedA);
      await settle(A, B, B2);
      assert.ok(!bodies(await B.entity(rig)).some((b) => b.startsWith('SHARED-A')));
      assert.ok(!bodies(await B2.entity(rig)).some((b) => b.startsWith('SHARED-A')));
    });
  });
}
