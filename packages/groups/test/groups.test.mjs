import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Clock, allocate, audience, buildPage, decide, facetIdentities, materialize, memoryLog, nodeKey, pagewritersFor, plan, publish, scopesFrom, sign, walk } from '../index.mjs';
import { actors, note, stubGenerate, stubRank } from './helpers.mjs';

const E = 'e-page';
const trustFor = (A, groups, pagewriters, local = []) => ({ groups, pagewriters, local, publicKeyOf: A.publicKeyOf });

test('nodeKey hashes the sorted ids; audience is the groups holding every note', () => {
  assert.equal(nodeKey(E, ['b', 'a', 'a'], 'g1'), nodeKey(E, ['a', 'b'], 'g1'));
  assert.notEqual(nodeKey(E, ['a', 'b'], 'g1'), nodeKey(E, ['a', 'b'], 'g2'));
  assert.notEqual(nodeKey(E, ['a', 'b'], 'g1', 'f:x'), nodeKey(E, ['a', 'b'], 'g1'));
  const s = { a: ['g', 'h', 'me'], b: ['g', 'h'], c: ['h'] };
  assert.deepEqual(audience(['a', 'b'], (id) => s[id]), ['g', 'h']);
  assert.deepEqual(audience(['a', 'b', 'c'], (id) => s[id]), ['h']);
  assert.deepEqual(audience([], (id) => s[id]), []);
});

test('hybrid logical clock: monotonic under a stuck wall clock, and after observing a later remote stamp', () => {
  const wall = { t: 1000 };
  const a = new Clock('a', () => wall.t), b = new Clock('b', () => wall.t);
  const t1 = a.tick(), t2 = a.tick();
  assert.ok(t1 < t2);
  wall.t = 500;
  const r = b.observe(t2);
  assert.ok(r > t2);
  assert.ok(b.tick() > r);
});

test('Merkle adoption: a viewer with one private note adopts every other branch and regenerates only the path to the root', async () => {
  const A = actors(['runner', 'viewer']);
  const g = ['g'];
  const groupNotes = [
    note(E, ['F1'], g, '2026-01-03T00:00:00Z'), note(E, ['F1'], g, '2026-01-04T00:00:00Z'), note(E, ['F1'], g, '2026-01-05T00:00:00Z'),
    note(E, ['F2'], g, '2026-01-06T00:00:00Z'), note(E, ['F2'], g, '2026-01-07T00:00:00Z'), note(E, ['F2'], g, '2026-02-06T00:00:00Z'), note(E, ['F2'], g, '2026-02-07T00:00:00Z'),
    note(E, ['F3'], g, '2026-01-08T00:00:00Z'), note(E, ['F3'], g, '2026-01-09T00:00:00Z'), note(E, ['F3'], g, '2026-03-08T00:00:00Z'), note(E, ['F3'], g, '2026-03-09T00:00:00Z'),
    note(E, ['F4'], g, '2026-02-10T00:00:00Z'), note(E, ['F4'], g, '2026-02-11T00:00:00Z'),
  ];
  const priv = note(E, ['F2'], ['viewer'], '2026-02-20T00:00:00Z');
  const log = memoryLog();
  const genR = stubGenerate();
  const R = await buildPage({ notes: groupNotes, entity: E, published: [], trust: trustFor(A, g, {}), generate: genR, rankFacets: stubRank(), author: 'runner', clock: A.runner.clock, privateKey: A.runner.privateKey, leafMax: 3 });
  assert.equal(R.stats.generated, R.stats.nodes);
  const pubR = await publish(log, R.records, 'g', { scopesOf: scopesFrom(groupNotes) });
  assert.equal(pubR.skipped.length, 0);
  assert.equal(pubR.published.length, R.stats.nodes);

  const vNotes = [...groupNotes, priv];
  const genV = stubGenerate();
  const trust = trustFor(A, ['g', 'viewer'], { g: pagewritersFor({ runner: 'runner' }) });
  const V = await buildPage({ notes: vNotes, entity: E, published: await log.list({ entity: E, groups: ['g', 'viewer'] }), trust, generate: genV, rankFacets: stubRank(), author: 'viewer', clock: A.viewer.clock, privateKey: A.viewer.privateKey, leafMax: 3 });
  assert.equal(V.stats.nodes, R.stats.nodes);
  assert.equal(V.stats.generated, 3);
  assert.equal(V.stats.adopted, V.stats.nodes - 3);
  assert.ok(V.stats.elided >= 2, 'children of adopted branches are elided');
  assert.deepEqual(genV.paths('leaf'), ['f:F2/month:2026-02']);
  assert.deepEqual(genV.paths('rollup'), ['f:F2', '']);
  assert.equal(V.texts.get('f:F1'), R.texts.get('f:F1'));
  assert.equal(V.texts.get('f:F2/month:2026-01'), R.texts.get('f:F2/month:2026-01'));
  assert.match(V.text, /status: 5 newest/);
  for (const f of ['F1', 'F2', 'F3', 'F4']) assert.match(V.text, new RegExp(`## ${f}\\n\\[f:${f}`));
  // the viewer's regenerated path rests on the private note: not publishable to the group, publishable to the viewer alone
  const toGroup = await publish(log, V.records, 'g', { scopesOf: scopesFrom(vNotes) });
  assert.equal(toGroup.published.length, 0);
  assert.equal(toGroup.skipped.length, 3);
  const own = await publish(log, V.records, 'viewer', { scopesOf: scopesFrom(vNotes, { own: 'viewer' }) });
  assert.equal(own.published.length, 3);
  assert.ok(own.published.every((p) => p.scopes.join() === 'viewer'));
  // the runner cannot see the viewer's own page
  assert.equal((await log.list({ entity: E, groups: ['g'] })).length, R.stats.nodes);
});

test('two overlapping groups: each part is publishable only to groups holding all its notes', async () => {
  const A = actors(['both']);
  const ab = ['ga', 'gb'];
  const notes = [
    note(E, ['X'], ab, '2026-01-01T00:00:00Z'), note(E, ['X'], ab, '2026-01-02T00:00:00Z'),
    note(E, ['Y'], ['ga'], '2026-01-03T00:00:00Z'), note(E, ['Y'], ['ga'], '2026-01-04T00:00:00Z'),
    note(E, ['Z'], ['gb'], '2026-01-05T00:00:00Z'), note(E, ['Z'], ['gb'], '2026-01-06T00:00:00Z'),
  ];
  const so = scopesFrom(notes);
  const B = await buildPage({ notes, entity: E, published: [], trust: trustFor(A, ab, {}), generate: stubGenerate(), author: 'both', clock: A.both.clock, privateKey: A.both.privateKey });
  const log = memoryLog();
  const toA = await publish(log, B.records, 'ga', { scopesOf: so });
  const toB = await publish(log, B.records, 'gb', { scopesOf: so });
  assert.deepEqual(toA.published.map((p) => p.path).sort(), ['f:X', 'f:Y']);
  assert.deepEqual(toB.published.map((p) => p.path).sort(), ['f:X', 'f:Z']);
  assert.deepEqual(toA.skipped.map((p) => p.path).sort(), ['', 'f:Z']);
  assert.deepEqual(toA.published.find((p) => p.path === 'f:X').scopes, ['ga', 'gb']);
  assert.deepEqual(toA.published.find((p) => p.path === 'f:Y').scopes, ['ga']);
  // a member of ga only holds X and Y: adopts both, regenerates the root
  const vNotes = notes.filter((n) => n.scopes.includes('ga'));
  const published = await log.list({ entity: E, groups: ['ga'] });
  assert.ok(published.every((e) => !e.record.citedNoteIds.some((id) => !vNotes.find((n) => n.id === id))));
  const d = decide({ entity: E, notes: vNotes, facets: B.facets }, published, trustFor(A, ['ga'], { ga: ['both'] }));
  assert.equal(d.decisions.get('f:X').action, 'adopt');
  assert.equal(d.decisions.get('f:Y').action, 'adopt');
  assert.equal(d.decisions.get('').action, 'generate');
});

test('unshare shrinks the audience, and a record built before it is no longer adopted by those who lost the note', async () => {
  const A = actors(['w']);
  const n1 = note(E, ['X'], ['g', 'h'], '2026-01-01T00:00:00Z'), n2 = note(E, ['X'], ['g', 'h'], '2026-01-02T00:00:00Z');
  const scopes = { [n1.id]: ['g', 'h'], [n2.id]: ['g', 'h'] };
  const so = (id) => scopes[id];
  assert.deepEqual(audience([n1.id, n2.id], so), ['g', 'h']);
  const B = await buildPage({ notes: [n1, n2], entity: E, published: [], trust: trustFor(A, ['g', 'h'], {}), generate: stubGenerate(), author: 'w', clock: A.w.clock, privateKey: A.w.privateKey });
  const log = memoryLog();
  await publish(log, B.records, 'h', { scopesOf: so });
  scopes[n2.id] = ['g'];   // n2 unshared from h
  assert.deepEqual(audience([n1.id, n2.id], so), ['g']);
  assert.equal((await publish(memoryLog(), B.records, 'h', { scopesOf: so })).published.length, 0);
  const hNotes = [{ ...n1, scopes: ['h'] }];
  const d = decide({ entity: E, notes: hNotes, facets: B.facets }, await log.list({ entity: E, groups: ['h'] }), trustFor(A, ['h'], { h: ['w'] }));
  for (const [, x] of d.decisions) assert.equal(x.action, 'generate');
});

test('pagewriters gate adoption: an untrusted author is ignored until the viewer adds them locally', async () => {
  const A = actors(['runner', 'stranger', 'viewer']);
  const notes = [note(E, ['X'], ['g'], '2026-01-01T00:00:00Z'), note(E, ['X'], ['g'], '2026-01-02T00:00:00Z')];
  const B = await buildPage({ notes, entity: E, published: [], trust: trustFor(A, ['g'], {}), generate: stubGenerate(), author: 'stranger', clock: A.stranger.clock, privateKey: A.stranger.privateKey });
  const log = memoryLog();
  await publish(log, B.records, 'g', { scopesOf: scopesFrom(notes) });
  const pub = await log.list({ entity: E, groups: ['g'] });
  const d1 = decide({ entity: E, notes, facets: B.facets }, pub, trustFor(A, ['g'], { g: ['runner'] }));
  assert.equal(d1.stats.adopted, 0);
  assert.ok(d1.decisions.get('').rejected.includes('author is not a trusted pagewriter'));
  const d2 = decide({ entity: E, notes, facets: B.facets }, pub, trustFor(A, ['g'], { g: ['runner'] }, ['stranger']));
  assert.equal(d2.stats.adopted, d2.stats.nodes);
  const d3 = decide({ entity: E, notes, facets: B.facets }, pub, trustFor(A, ['g'], { g: pagewritersFor({ members: ['runner', 'stranger', 'viewer'], allMembers: true }) }));
  assert.equal(d3.stats.adopted, d3.stats.nodes);
  // a valid-looking record with a broken signature is ignored even from a trusted author
  const forged = pub.map((e) => ({ ...e, record: { ...e.record, text: 'changed after signing' } }));
  const d4 = decide({ entity: E, notes, facets: B.facets }, forged, trustFor(A, ['g'], {}, ['stranger']));
  assert.equal(d4.stats.adopted, 0);
});

test('conflicting records for one key among trusted authors: earliest clock wins, the hash breaks ties', async () => {
  const A = actors(['a', 'b']);
  const notes = [note(E, ['X'], ['g'], '2026-01-01T00:00:00Z')];
  const tree = plan(E, notes, {});
  const decisions = new Map(walk(tree).map((n) => [n.path, { action: 'generate' }]));
  const mk = async (who, label) => (await materialize({ entity: E, tree, decisions, generate: async (p) => `${label} ${p.path}`, author: who, clock: A[who].clock, privateKey: A[who].privateKey })).records;
  A.wall.t += 10; const late = await mk('a', 'late-a');
  A.wall.t -= 5; const early = await mk('b', 'early-b');
  const entries = [...late, ...early].map((record) => ({ record, scopes: ['g'] }));
  const trust = trustFor(A, ['g'], { g: ['a', 'b'] });
  for (const order of [entries, [...entries].reverse()]) {
    const d = decide({ entity: E, notes }, order, trust);
    assert.match(d.decisions.get('').entry.record.text, /^early-b/);
  }
  // identical clock values: the same winner whatever the order
  const same = (r) => sign({ ...r, at: '000000000000001.000000.x', sig: undefined }, A[r.author].privateKey);
  const tied = [...late, ...early].map((r) => ({ record: same(r), scopes: ['g'] }));
  const w1 = decide({ entity: E, notes }, tied, trust).decisions.get('').entry.record.text;
  const w2 = decide({ entity: E, notes }, [...tied].reverse(), trust).decisions.get('').entry.record.text;
  assert.equal(w1, w2);
});

test('facet membership is stable under re-ranking: tiers and weights never move a note or change a key', async () => {
  const A = actors(['w']);
  const notes = [];
  for (let i = 0; i < 30; i++) notes.push(note(E, [['P', 'Q', 'R'][i % 3], ...(i % 4 === 0 ? ['S'] : [])], ['g'], new Date(Date.UTC(2026, i % 5, 1 + i)).toISOString()));
  const facets = facetIdentities(E, notes, [], {});
  const keysOf = (t) => walk(t).map((n) => `${n.path}=${n.key}`).join('\n');
  const one = await buildPage({ notes, entity: E, facets, published: [], trust: trustFor(A, ['g'], {}), generate: stubGenerate(), rankFacets: stubRank({ P: ['background', 5], S: ['current', 1] }), author: 'w', clock: A.w.clock, leafMax: 4 });
  const two = await buildPage({ notes, entity: E, facets, published: [], trust: trustFor(A, ['g'], {}), generate: stubGenerate(), rankFacets: stubRank({ P: ['detail', 0.1], Q: ['current', 9], R: ['background', 2] }), author: 'w', clock: A.w.clock, leafMax: 4 });
  assert.equal(keysOf(one.tree), keysOf(two.tree));
  assert.notDeepEqual(one.facets.map((f) => f.tier), two.facets.map((f) => f.tier));
  // the rarest co-linked facet takes the note: S (rarity 8) beats P/Q/R (10 each)
  assert.equal(facets.find((f) => f.id === 'S').rarity, 8);
  assert.ok(one.tree.children.find((c) => c.path === 'f:S').noteIds.length === 8);
  // a note set that grows keeps old identities' rarity frozen
  const more = [...notes, ...Array.from({ length: 5 }, (_, i) => note(E, ['S'], ['g'], `2026-07-0${i + 1}T00:00:00Z`))];
  assert.equal(facetIdentities(E, more, facets).find((f) => f.id === 'S').rarity, 8);
});

test('tier allocation: fractions, proportional to weight times sqrt(count), background floors, per-facet ceiling, flow and the recency floor', () => {
  const opts = { recencyFacets: 0 };
  // proportionality within a tier: weight 1 vs 2 at equal counts; count 4 vs 16 at equal weights (sqrt -> 1:2)
  let r = allocate([{ id: 'a', tier: 'current', weight: 1, count: 9 }, { id: 'b', tier: 'current', weight: 2, count: 9 }], 1000, { ...opts, ceiling: 1 });
  assert.equal(r.units.a + r.units.b, 450);
  assert.equal(r.units.a, 150); assert.equal(r.units.b, 300);
  r = allocate([{ id: 'a', tier: 'detail', weight: 1, count: 4 }, { id: 'b', tier: 'detail', weight: 1, count: 16 }, { id: 'c', tier: 'current', count: 1, maxUnits: 0 }], 900, { ...opts, ceiling: 1 });
  assert.equal(r.units.b, 2 * r.units.a);
  // tier fractions when every tier has room
  r = allocate([{ id: 'bg', tier: 'background', count: 1 }, { id: 'cu', tier: 'current', count: 1 }, { id: 'de', tier: 'detail', count: 1 }], 1000, { ...opts, ceiling: 1 });
  assert.deepEqual(r.units, { bg: 250, cu: 450, de: 300 });
  // ceiling: no facet above 30% of the page; what current cannot use flows to detail, then background
  r = allocate([{ id: 'bg', tier: 'background', count: 1 }, { id: 'cu', tier: 'current', count: 100 }, { id: 'de', tier: 'detail', count: 1, maxUnits: 320 }], 1000, opts);
  assert.equal(r.units.cu, 300);
  assert.equal(r.units.de, 300);
  assert.equal(r.units.bg, 300);
  assert.equal(r.unused, 100);
  r = allocate([{ id: 'cu', tier: 'current', count: 1, maxUnits: 100 }, { id: 'de', tier: 'detail', count: 1, maxUnits: 1000 }, { id: 'bg', tier: 'background', count: 1, maxUnits: 1000 }], 1000, { ...opts, ceiling: 1 });
  assert.deepEqual(r.units, { cu: 100, de: 650, bg: 250 });
  // background floors: a tiny-weight background facet still gets its floor
  r = allocate([{ id: 'big', tier: 'background', weight: 100, count: 100 }, { id: 'tiny', tier: 'background', weight: 0.0001, count: 1 }], 1000, opts);
  assert.ok(r.units.tiny >= 30, `tiny got ${r.units.tiny}`);
  // recency floor: the most active facets get a slot even in a starved tier
  const fs = [{ id: 'cur', tier: 'current', weight: 50, count: 50 }, { id: 'hot', tier: 'detail', weight: 0.0001, count: 2, recent: 2 }, { id: 'cold', tier: 'detail', weight: 0.0001, count: 2, recent: 0 }];
  r = allocate(fs, 1000, { recencyFacets: 1, ceiling: 1, fractions: { detail: 0 } });
  assert.ok(r.units.hot >= 40, `hot got ${r.units.hot}`);
  assert.equal(r.units.cold, 0);
  for (const x of [r]) assert.ok(Object.values(x.units).reduce((a, b) => a + b, 0) <= 1000);
});
