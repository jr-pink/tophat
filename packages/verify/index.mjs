// @tophat-md/verify: property harnesses over the MemoryStore interface.
//
//   fuzzParties({ seed, ops, parties }): random writes, shares, retracts, links and syncs by several parties (each a
//     replica; one user may appear twice, as two devices) through one hub, with an oracle of which scopes each note was
//     written into. After everyone settles:
//       visibility  a party sees a note iff the note's current scopes meet the party's scopes (no leak, no loss)
//       pages       every page a party builds contains only notes it may read
//       bytes       no party's replica file holds a marker of a note it may not read; the hub file holds no marker at all
//   differential({ seed, ops, origin, replica, settle, scopes }): one user on two replicas syncing through the hub; writes
//     on either, then both read the same (entities, notes, pages, search).
// Both return { ok, failures, stats }; the CLI (tophat-verify) and test/ run them on fresh temp stores only.
import { existsSync, readFileSync } from 'node:fs';

export function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const bytes = (file) => (file ? [file, `${file}-wal`].filter(existsSync).map((f) => readFileSync(f).toString('latin1')).join('') : '');

/**
 * parties: [{ name, store, file }] already created (each holds its private scope `name`); hubFile; shared: scope names
 * created by parties[0] with every party a writer. settle(): sync everyone until quiet.
 */
export async function fuzzParties({ seed = 1, ops = 40, parties, shared, hubFile, settle }) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)];
  const notes = new Map(); // marker -> { id, owner, scopes: Set }
  const entities = new Map(parties.map((p) => [p, []])); // per replica: a device edits only what it wrote itself
  const failures = [];
  let n = 0;
  for (let i = 0; i < ops; i++) {
    const p = pick(parties), k = r();
    try {
      if (k < 0.5) {
        const marker = `MK${seed}x${n++}Z`;
        const scopes = r() < 0.5 ? [p.name] : [pick(shared)];
        const reuse = entities.get(p).filter((e) => e.scopes.every((s) => scopes.includes(s) || s === p.name)).filter((e) => e.scopes.some((s) => scopes.includes(s)));
        let res;
        if (reuse.length && r() < 0.5) res = await p.store.apply({ notes: [{ body: `note ${marker}`, entities: [pick(reuse).id], scopes }] });
        else {
          res = await p.store.apply({ entities: [{ id: '$e', name: `Thing ${marker}`, type: 'topic', scopes }], notes: [{ body: `note ${marker}`, entities: ['$e'], scopes }] });
          entities.get(p).push({ id: res.id_map.$e, scopes });
        }
        notes.set(marker, { id: res.notes[0].id, owner: p.name, by: p, scopes: new Set(scopes), everScopes: new Set(scopes) });
      } else if (k < 0.62) {
        const mine = [...notes.entries()].filter(([, v]) => v.by === p && v.scopes.size);
        if (mine.length) { const [m, v] = pick(mine); const to = [...new Set([...v.scopes, pick([p.name, ...shared])])]; await p.store.share('note', v.id, to); notes.set(m, { ...v, scopes: new Set(to), everScopes: new Set([...v.everScopes, ...to]) }); }
      } else if (k < 0.7) {
        const mine = [...notes.entries()].filter(([, v]) => v.by === p && v.scopes.size);
        if (mine.length) { const [m, v] = pick(mine); await p.store.retract('note', v.id); notes.set(m, { ...v, scopes: new Set() }); }
      } else await p.store.sync();
    } catch (e) { failures.push({ op: i, party: p.label ?? p.name, error: `${e.constructor.name}: ${e.message}` }); }
  }
  await settle();
  const scopesOf = new Map(parties.map((p) => [p.name, new Set([p.name, ...shared])]));
  for (const p of parties) {
    const mine = scopesOf.get(p.name), fileBytes = bytes(p.file);
    for (const [marker, v] of notes) {
      const may = [...v.scopes].some((s) => mine.has(s));
      const seen = (await p.store.search(marker, { kind: 'note', limit: 5 })).hits.length > 0;
      if (may !== seen) failures.push({ party: p.label ?? p.name, marker, expected: may ? 'visible' : 'hidden', got: seen ? 'visible' : 'hidden', scopes: [...v.scopes] });
      const everReadable = v.owner === p.name || [...v.everScopes].some((s) => mine.has(s)); // once readable, bytes may remain (append-only log); never readable must mean never present
      if (!everReadable && fileBytes.includes(marker)) failures.push({ party: p.label ?? p.name, marker, leak: 'replica file' });
    }
    for (const es of entities.get(p)) {
      try {
        const page = await p.store.page(es.id);
        for (const m of (page.outline.match(/note MK\d+x\d+Z/g) || []).map((x) => x.slice(5))) { /* note lines only: an entity's own name may carry a marker */ const v = notes.get(m); if (v && ![...v.scopes].some((s) => mine.has(s))) failures.push({ party: p.label ?? p.name, marker: m, leak: 'page' }); }
      } catch { /* retracted or not visible */ }
    }
  }
  const hub = bytes(hubFile);
  for (const m of notes.keys()) if (hub.includes(m)) failures.push({ marker: m, leak: 'hub plaintext' });
  return { ok: failures.length === 0, failures, stats: { notes: notes.size, parties: parties.length } };
}

/**
 * Replica differential: one user, two replicas (origin and replica, two devices) syncing through the hub. Random writes
 * (new entities, more notes, links, shares into the user's other scope, retracts), mostly on the origin and sometimes on
 * the replica, with syncs at random points; after settle() both must read the same: every entity (name, scopes, note
 * bodies and their scopes), every note by id, the derived page of every entity (outline lines, note ids, scope CNF) and the
 * search hits (kind and id) for every word used. scopes: the user's two scopes, the first the default write scope.
 * concurrent: also let both devices change the same note's scopes between syncs (the core converges then: grants are a
 * last-writer-wins register per (row, group) by hub position).
 */
export async function differential({ seed = 1, ops = 30, origin, replica, settle, scopes, concurrent = false }) {
  const r = rng(seed), pick = (x) => x[Math.floor(r() * x.length)];
  const words = ['tank', 'rig', 'frame', 'cable', 'bench', 'pump', 'lens'];
  const ents = [], notes = [], failures = []; // { id, on: Set of sides holding the row }: a side edits only rows it has
  const mineOn = (list, side) => list.filter((x) => x.on.has(side) && !x.retracted).map((x) => x.id);
  // without `concurrent`, a note's scopes are changed only on the device that wrote it
  const editable = (side) => notes.filter((x) => x.on.has(side) && !x.retracted && (concurrent || x.by === side)).map((x) => x.id);
  const settleAll = async () => { await settle(); for (const x of [...ents, ...notes]) { x.on.add('origin'); x.on.add('replica'); } };
  for (let i = 0; i < ops; i++) {
    const side = r() < 0.8 ? 'origin' : 'replica', s = side === 'origin' ? origin : replica, k = r(), w = `${pick(words)} ${pick(words)} ${i}`;
    const myEnts = mineOn(ents, side), myNotes = editable(side), row = (id) => ({ id, by: side, on: new Set([side]) });
    try {
      if (k < 0.35 || !myEnts.length) { const res = await s.apply({ entities: [{ id: '$e', name: `Item ${i}`, type: 'artifact' }], notes: [{ body: `the ${w}`, entities: ['$e'] }] }, { batchId: `d${seed}-${i}` }); ents.push(row(res.id_map.$e)); notes.push(row(res.notes[0].id)); }
      else if (k < 0.65) { const res = await s.apply({ notes: [{ body: `more ${w}`, entities: [pick(myEnts)] }] }, { batchId: `d${seed}-${i}` }); notes.push(row(res.notes[0].id)); }
      else if (k < 0.75 && myEnts.length > 1) { const a = pick(myEnts), b = pick(myEnts.filter((x) => x !== a)); await s.link(a, b); }
      else if (k < 0.85 && myNotes.length) await s.share('note', pick(myNotes), r() < 0.5 ? [scopes[0], scopes[1]] : [scopes[1]]);
      else if (k < 0.9 && myNotes.length) { const id = pick(myNotes); await s.retract('note', id); notes.find((x) => x.id === id).retracted = true; }
      else await settleAll();
    } catch (e) { failures.push({ op: i, on: side, error: `${e.constructor.name}: ${e.message}` }); }
    if (r() < 0.15) await s.sync(); // one side pushes without the other pulling
  }
  await settleAll();
  const same = (what, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) failures.push({ differs: what, origin: a, replica: b }); };
  const entityView = (e) => ({ name: e.entity.name, scopes: e.entity.scopes, notes: e.notes.map((n) => [n.body, n.scopes]).sort() });
  const tryRead = async (f) => { try { return { v: await f() }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
  for (const { id } of ents) {
    same(`entity ${id}`, (await tryRead(async () => entityView(await origin.entity(id)))), (await tryRead(async () => entityView(await replica.entity(id)))));
    // outline lines compared in order: under tenancy the core breaks equal-`at` ties by note id, so the order is the
    // same on every device; the leading numbering is dropped because it is positional
    const lines = (o) => o.split('\n').map((l) => l.replace(/^[\d.]+\s/, ''));
    const pg = (x) => tryRead(async () => { const p = await x.page(id); return { lines: lines(p.outline), note_ids: p.note_ids, cnf: p.cnf }; });
    same(`page ${id}`, await pg(origin), await pg(replica));
  }
  // a retracted note is unreadable on both, but only the device that wrote it keeps the row (withheld, no scopes); any
  // other replica drops a row its user can no longer read, so read() there says it has no such note
  const gone = (x) => (x.error?.endsWith(' no note ' + x.id) || (x.v?.withheld && !x.v.scopes?.length) ? { unreadable: true } : x);
  for (const { id } of notes) {
    const rd = async (s) => { const x = await tryRead(() => s.read('note', id)); return gone({ ...x, id }); };
    same(`note ${id}`, await rd(origin), await rd(replica));
  }
  for (const wd of words) {
    const hits = async (x) => (await x.search(wd, { limit: 200 })).hits.map((h) => `${h.kind}:${h.id}`).sort();
    same(`search ${wd}`, await hits(origin), await hits(replica));
  }
  return { ok: failures.length === 0, failures, stats: { entities: ents.length, notes: notes.length } };
}

/**
 * The standard fuzz cast in a test world (`world()` from @tophat-md/linknotes/testing): three users a, b, c, each a
 * sqlite replica with a private scope, b also on a second device; two shared scopes created by a with b and c as writers.
 * Returns fuzzParties' arguments minus seed and ops.
 */
export async function cast(w, seed, settle) {
  const names = [`a${seed}`, `b${seed}`, `c${seed}`];
  const stores = names.map((n) => w.sqlite(n));
  const b2 = w.replica(stores[1]);
  for (let i = 0; i < 3; i++) await stores[i].createScope(names[i]);
  const shared = [`s${seed}x`, `s${seed}y`];
  for (const s of shared) await stores[0].createScope(s);
  const all = [...stores, b2], settleAll = () => settle(...all);
  await settleAll();
  for (const s of shared) for (const n of names.slice(1)) await stores[0].addMember(s, n, 'write');
  await settleAll();
  const parties = [...names.map((name, i) => ({ name, store: stores[i], file: stores[i].config.file })), { name: names[1], label: `${names[1]}-phone`, store: b2, file: b2.config.file }];
  return { parties, shared, hubFile: w.hubFile, settle: settleAll };
}

/** A user on two replicas (origin, replica) with two scopes, ready for differential(). */
export async function replicaPair(w, user, settle) {
  const origin = w.sqlite(user), replica = w.replica(origin);
  const scopes = [user, `${user}-team`];
  for (const s of scopes) await origin.createScope(s);
  await settle(origin, replica);
  return { origin, replica, scopes, settle: () => settle(origin, replica) };
}
