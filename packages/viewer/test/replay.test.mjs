// Replay equivalence and the scope-leak property. Three users write a generated multi-scope log through a real hub
// (shares, narrowings, retractions, links, a removal with key rotation, a scope gained late). The viewer replays the
// ciphertext log with WebCrypto only and must read exactly what the same user's linknotes replica reads: visible notes,
// visible entities, the whole graph, and every entity page. A viewer without a scope's key reads nothing of it.
import assert from 'node:assert/strict';
import { describe, test, after, before } from 'node:test';
import { world, settle, SECRET } from '@tophat-md/linknotes/testing';
import { issueToken } from '@tophat-md/linknotes';
import { ViewState, tokenClaims } from '../src/core/state.mjs';
import { pullInto } from '../src/core/pull.mjs';
import { buildGraph, entityPage, plainGraph } from '../src/core/graph.mjs';
import { readKeyFile } from '../src/core/keys.mjs';
import { exportKeys, enrollDevice } from '../src/index.mjs';
import { storeView } from './store-view.mjs';

const token = (device, user) => issueToken(SECRET, { device, user, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const PASS = 'viewer test passphrase';
const ITER = 1000;
function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
const strip = (g) => { const p = plainGraph(g); return { ...p, meta: { ...p.meta, built_at: null, ms: null } }; };

async function viewerFor(w, keyFileBox, tokenDevice, user, { limit } = {}) {
  const t = token(tokenDevice, user);
  const keys = await readKeyFile(JSON.stringify(keyFileBox), PASS);
  const claims = tokenClaims(t);
  const v = new ViewState({ user: claims.user, device: claims.device, keys });
  const progress = [];
  const r = await pullInto(v, { hubUrl: w.hubUrl, token: t, limit, onProgress: (p) => progress.push(p) });
  return { v, r, progress, token: t };
}

/** The graph, visible ids and every page, as the viewer and as the replica. */
async function compare(v, backend, user, label) {
  const sv = storeView(backend, user);
  assert.deepEqual(v.viewer.groups, sv.viewer.groups, `${label}: scopes`);
  const vn = v.visibleNotes().map((n) => n.id).sort(), sn = sv.visibleNotes().map((n) => n.id).sort();
  assert.ok(sn.length > 5, `${label}: the replica reads notes (${sn.length})`);
  assert.deepEqual(vn, sn, `${label}: visible notes`);
  const ve = v.entityRows().filter((e) => v.entityAclVisible(e.id)).map((e) => e.id).sort();
  assert.deepEqual(ve, sv.visibleEntityIds(), `${label}: visible entities`);
  const gv = buildGraph(v), gs = buildGraph(sv);
  assert.deepEqual(strip(gv), strip(gs), `${label}: graph`);
  assert.ok(gv.nodes.length > 3 && gv.hyper.length > 0, `${label}: a real graph (${gv.nodes.length} nodes, ${gv.hyper.length} hyperedges)`);
  for (const n of gs.nodes) {
    const [pv, ps] = [await entityPage(v, gv, n.id), await entityPage(sv, gs, n.id)];
    // a page's cached flag and its generation time depend on who generated it first; its content must not
    const norm = (p) => ({ ...p, page: p.page && { ...p.page, cached: null, as_of: null } });
    assert.deepEqual(norm(pv), norm(ps), `${label}: page of ${n.name}`);
  }
  return { notes: vn, graph: gv };
}

// The comparison replica is carol's second device: a link carol makes between entities with no scope in common stays on
// the device that made it (it replicates nowhere), so her laptop reads it and every other device, the viewer included, does not.
describe('viewer replay over a generated multi-scope log', () => {
  let w, A, B, C, C2, ckeyBox, viewerDevBox;
  before(async () => {
    w = await world();
    A = w.sqlite('alice'); B = w.sqlite('bob'); C = w.sqlite('carol'); C2 = w.replica(C); // carol's phone: only syncs
    await A.createScope('alice'); await B.createScope('bob'); await C.createScope('carol');
    await A.createScope('proj'); await A.createScope('ops'); await B.createScope('team');
    await settle(A, B, C, C2);
    // carol's viewer device registers its key with the hub before the scope admins sync, so they wrap keys to it
    viewerDevBox = await enrollDevice({ hubUrl: w.hubUrl, token: token('carol-viewer', 'carol'), user: 'carol', device: 'carol-viewer', passphrase: PASS, iterations: ITER });
    await A.addMember('proj', 'bob', 'write'); await A.addMember('proj', 'carol', 'read');
    await B.addMember('team', 'carol', 'write'); await B.addMember('team', 'alice', 'write');
    await settle(A, B, C, C2);

    const R = rng(7);
    const pick = (xs) => xs[Math.floor(R() * xs.length)];
    let minute = 0;
    const at = () => new Date(Date.UTC(2026, 9, 1) + 60000 * minute++).toISOString();
    const pools = new Map(); // scope -> [entity id]
    const writable = { alice: ['alice', 'proj', 'ops', 'team'], bob: ['bob', 'proj', 'team'], carol: ['carol', 'team'] };
    const who = { alice: A, bob: B, carol: C };
    const TYPES = ['person', 'project', 'place', 'organization', 'topic', 'artifact'];
    let n = 0;
    async function round(r) {
      for (const user of ['alice', 'bob', 'carol']) {
        const s = who[user];
        const scopes = writable[user].filter((g) => s.store.writes(g) && s.store.keyFor(g, s.store.currentEpoch(g)));
        for (let k = 0; k < 4; k++) {
          const scope = pick(scopes), acl = R() < 0.25 && scope !== user ? [scope, user] : [scope];
          const ents = [], newEnts = [];
          const pool = (pools.get(scope) || []).filter((id) => s.store.one('SELECT 1 AS ok FROM entities WHERE id=? AND merged_into IS NULL', [id]));
          const count = 1 + Math.floor(R() * 4);
          for (let e = 0; e < count; e++) {
            if (pool.length && R() < 0.6) { const id = pick(pool); if (!ents.includes(id)) ents.push(id); }
            else { const tmp = `$e${n}_${e}`; newEnts.push({ id: tmp, name: `Thing ${n}.${e}`, type: pick(TYPES), scopes: [scope] }); ents.push(tmp); }
          }
          const secret = `${user.toUpperCase()}-${scope.toUpperCase()}-${n}`;
          const res = await s.apply({ entities: newEnts, notes: [{ body: `${secret}: round ${r} note about ${ents.length} things`, entities: ents, scopes: acl, at: at() }] }, { scopes: acl });
          for (const ne of newEnts) { const id = res.id_map[ne.id]; pools.set(scope, [...(pools.get(scope) || []), id]); }
          n++;
        }
        // occasionally widen, narrow or retract one of this user's notes, or link two entities
        const mine = s.store.all("SELECT DISTINCT pk FROM mc_acl WHERE t='notes' AND revoked=0").map((x) => x.pk).filter((id) => { const a = s.store.aclOf('notes', id); return a.length && a.every((g) => s.store.writes(g)); });
        if (mine.length && R() < 0.7) {
          const id = pick(mine), cur = s.store.aclOf('notes', id), op = R();
          try {
            if (op < 0.4) await s.share('note', id, [...new Set([...cur, pick(scopes)])]);
            else if (op < 0.7 && cur.length > 1) await s.share('note', id, [cur[0]]);
            else await s.retract('note', id);
          } catch (e) { if (!/cannot|no ACL/.test(e.message)) throw e; }
        }
        const ent = [...pools.values()].flat().filter((id) => s.store.one('SELECT 1 AS ok FROM entities WHERE id=?', [id]));
        if (ent.length > 2 && R() < 0.5) { const a = pick(ent), b = pick(ent); if (a !== b) try { await s.link(a, b); } catch (e) { if (!/no entity/.test(e.message)) throw e; } }
      }
      await settle(A, B, C, C2);
    }
    for (let r = 0; r < 3; r++) await round(r);
    // bob leaves team: alice... bob is team's admin, so he removes alice instead: a key rotation the viewer device must follow
    await B.addMember('team', 'alice', 'none');
    await settle(A, B, C, C2);
    for (let r = 3; r < 5; r++) await round(r);
    // carol gains ops late: the hub now serves ops history to her, and the viewer restarts its pull from 0
    await A.addMember('ops', 'carol', 'read');
    await settle(A, B, C, C2);
    await round(5);
    ckeyBox = await exportKeys({ config: C.config, passphrase: PASS, iterations: ITER });
  });
  after(async () => { await w?.close(); });

  test('a viewer device (key file holds only its device key) reads what carol\'s replica reads', async () => {
    const { v, r, progress } = await viewerFor(w, viewerDevBox, 'carol-viewer', 'carol');
    assert.ok(r.pulled > 20 && r.cursor === r.head, `pulled ${r.pulled} actions to the head ${r.head}`);
    assert.ok(progress.some((p) => p.phase === 'pull') && progress.at(-1).cursor === r.head);
    assert.ok(v.heldScopes().includes('team') && [...v.keys.keys()].some((k) => k.startsWith('team|2')), 'unwrapped the rotated team key from the log');
    await compare(v, C2, 'carol', 'device-key viewer');
  });

  test('scope keys exported from carol\'s replica, a token for another device id, paged 7 actions at a time: the same reads', async () => {
    const { v, r } = await viewerFor(w, ckeyBox, 'carol-browser', 'carol', { limit: 7 });
    assert.ok(r.pages > 5, `${r.pages} pages`);
    const out = await compare(v, C2, 'carol', 'scope-key viewer');
    assert.ok(v.viewer.groups.includes('ops') && out.notes.length);
  });

  test('incremental: a cached state pulled in two steps equals a fresh pull; the encrypted cache round-trips', async () => {
    const { v } = await viewerFor(w, ckeyBox, 'carol-browser', 'carol');
    const { cacheKey, sealCache, openCache } = await import('../src/core/keys.mjs');
    const ck = await cacheKey(PASS, null, ITER);
    const box = await sealCache(v.toJSON(), ck);
    assert.ok(!JSON.stringify(box).includes('CAROL-'), 'the cache holds no plaintext');
    const back = ViewState.fromJSON(await openCache(box, await cacheKey(PASS, box.kdf.salt, ITER)));
    await assert.rejects(openCache(box, await cacheKey('another passphrase', box.kdf.salt, ITER)));
    await C.apply({ entities: [{ id: '$late', name: 'Late Thing', type: 'topic', scopes: ['team'] }], notes: [{ body: 'CAROL-LATE: one more', entities: ['$late'], scopes: ['team'], at: '2027-01-01T00:00:00Z' }] }, { scopes: ['team'] });
    await settle(A, B, C, C2);
    const r = await pullInto(back, { hubUrl: w.hubUrl, token: token('carol-browser', 'carol') });
    assert.ok(r.pulled >= 1);
    await compare(back, C2, 'carol', 'incremental viewer');
  });

  test('scope leak: without a scope\'s key nothing of it is read or decryptable, even with the hub serving its parts', async () => {
    // carol's key file minus the ops and team keys; the hub still serves ops and team parts (carol is a member)
    const full = await readKeyFile(JSON.stringify(ckeyBox), PASS);
    const t = token('carol-browser', 'carol');
    const v = new ViewState({ user: 'carol', device: 'carol-browser', keys: { scopes: { carol: full.scopes.carol, proj: full.scopes.proj } } });
    await pullInto(v, { hubUrl: w.hubUrl, token: t });
    const read = JSON.stringify(v.toJSON());
    const opsOnly = A.store.all("SELECT pk FROM mc_acl WHERE t='notes' GROUP BY pk HAVING SUM(grp NOT IN ('ops', 'alice')) = 0 AND SUM(grp = 'ops') > 0").map((r) => A.store.one('SELECT body FROM notes WHERE id=?', [r.pk])?.body).filter(Boolean);
    assert.ok(opsOnly.length > 0, 'the log has notes only ever in ops');
    for (const body of opsOnly) assert.ok(!read.includes(body), `no ops note in the state (${body})`);
    assert.ok(v.unopened.length > 0, 'ops and team parts stay sealed');
    const held = new Set(['carol', 'proj']);
    for (const u of v.unopened) {
      const p = u.action.parts[0], clauses = p.cnf ?? [p.acl];
      assert.ok(clauses.some((c) => !c.some((g) => held.has(g))), `an unopened part has a clause with no held key (${JSON.stringify(clauses)})`);
      assert.ok(clauses.flat().some((g) => g === 'ops' || g === 'team'), `only parts of the withheld scopes stay sealed (${JSON.stringify(clauses)})`);
    }
    for (const n of v.visibleNotes()) assert.ok(v.activeAcl('notes', n.id).some((g) => g === 'carol' || g === 'proj'), 'every note read is in a scope whose key is held');
    // a user who is not a member at all: the hub serves nothing of alice's private or ops scope, and a stolen key file of
    // carol's does not help a token of another user (the hub filters by the token's user)
    const dave = new ViewState({ user: 'dave', device: 'dave-browser', keys: { scopes: full.scopes } });
    await pullInto(dave, { hubUrl: w.hubUrl, token: token('dave-browser', 'dave') });
    assert.equal(dave.visibleNotes().length, 0);
    assert.equal(dave.tables.notes.size, 0, 'nothing delivered to a non-member');
    // notes that were only ever in alice's or bob's private scope (never shared, so their bodies never reached carol) are
    // nowhere in carol's full viewer state
    const { v: cv } = await viewerFor(w, ckeyBox, 'carol-browser', 'carol');
    const cread = JSON.stringify(cv.toJSON());
    let checked = 0;
    for (const [s, own] of [[A, 'alice'], [B, 'bob']]) {
      const only = new Set(s.store.all("SELECT pk FROM mc_acl WHERE t='notes' GROUP BY pk HAVING SUM(grp <> ?) = 0", [own]).map((r) => r.pk));
      for (const id of only) { const body = s.store.one('SELECT body FROM notes WHERE id=?', [id])?.body; if (!body) continue; checked++; assert.ok(!cread.includes(body), `no private note of ${own} (${body})`); }
    }
    assert.ok(checked > 3, `checked ${checked} private notes`);
  });
});
