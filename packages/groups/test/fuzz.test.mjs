// Fuzz: random notes, groups, members and an adversary who is a trusted pagewriter everywhere and appends forged
// records straight into the log (bypassing the publish check). Property: no record is ever adopted by a viewer who
// cannot read every note it cites; and every honestly published record sits only in scopes that hold all its notes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPage, decide, memoryLog, nodeKey, publish, scopesFrom, sign, walk } from '../index.mjs';
import { actors, rng } from './helpers.mjs';

const E = 'e-fuzz';
const GROUPS = ['g0', 'g1', 'g2'];
const USERS = ['u0', 'u1', 'u2', 'u3', 'u4'];
const FACETS = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5'];

const SEEDS = Number(process.env.GROUPS_FUZZ_SEEDS || 40);

test(`fuzz (${SEEDS} seeds): no adopted record cites a note its viewer cannot read`, async () => {
  let adoptedTotal = 0, rejectedForged = 0, checked = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const A = actors([...USERS, 'mallory']);
    const member = Object.fromEntries(USERS.map((u) => [u, GROUPS.filter(() => r() < 0.6)]));
    member.mallory = [...GROUPS];
    const notes = [];
    const n = 15 + r.int(40);
    for (let i = 0; i < n; i++) {
      const ents = [E, r.pick(FACETS), ...(r() < 0.3 ? [r.pick(FACETS)] : [])];
      const scopes = r() < 0.3 ? [r.pick(USERS)] : GROUPS.filter(() => r() < 0.5);
      if (!scopes.length) scopes.push(r.pick(GROUPS));
      const at = new Date(Date.UTC(2026, r.int(4), 1 + r.int(28), r.int(24))).toISOString();
      notes.push({ id: `n${seed}-${i}`, at, body: `fact ${i}`, entities: [...new Set(ents)], scopes });
    }
    const readable = (u) => { const mine = new Set([...member[u], u]); return notes.filter((x) => x.scopes.some((s) => mine.has(s))); };
    const pagewriters = Object.fromEntries(GROUPS.map((g) => [g, [...USERS.filter((u) => member[u].includes(g)), 'mallory']]));
    const trustOf = (u) => ({ groups: [...member[u], u], pagewriters: { ...pagewriters, [u]: [u] }, local: r() < 0.5 ? ['mallory'] : [], publicKeyOf: A.publicKeyOf });
    const log = memoryLog();
    const honest = new Set();
    const generate = async (p) => (p.kind === 'leaf' ? p.notes.map((x) => x.id).join(' ') : `${p.path}:${p.kind}`);
    const leafMax = 2 + r.int(4);

    for (let round = 0; round < 2; round++) {
      for (const u of USERS) {
        const view = readable(u);
        if (!view.length) continue;
        const pub = await log.list({ entity: E, groups: [...member[u], u] });
        const out = await buildPage({ notes: view, entity: E, published: pub, trust: trustOf(u), generate, author: u, clock: A[u].clock, privateKey: A[u].privateKey, leafMax });
        for (const dd of out.decisions.values()) if (dd.action === 'adopt') {
          const ids = new Set(view.map((x) => x.id));
          assert.ok(dd.entry.record.citedNoteIds.every((id) => ids.has(id)), `seed ${seed}: ${u} adopted a record citing an unreadable note`);
          adoptedTotal++;
        }
        const so = scopesFrom(view, { own: u });
        for (const target of [...member[u], u]) {
          const res = await publish(log, out.records, target, { scopesOf: so, writable: [...member[u], u] });
          for (const p of res.published) honest.add(p.key + target);
        }
        // honest records sit only in scopes holding every note they cite
        for (const rec of out.records) {
          const entries = await log.list({ entity: E, groups: [...GROUPS, ...USERS] });
          for (const e of entries.filter((x) => x.record === rec)) for (const s of e.scopes) {
            const holds = USERS.includes(s) ? new Set(readable(s).map((x) => x.id)) : new Set(notes.filter((x) => x.scopes.includes(s)).map((x) => x.id));
            assert.ok(rec.citedNoteIds.every((id) => holds.has(id)), `seed ${seed}: record in ${s} cites a note ${s} does not hold`);
            checked++;
          }
        }
      }
      // the adversary: forged records straight into the log, signed by a pagewriter every group trusts
      const all = await log.list({ entity: E, groups: [...GROUPS, ...USERS] });
      for (const e of all.slice(0, 40)) {
        const rec = e.record;
        const extra = notes.filter((x) => !rec.citedNoteIds.includes(x.id)).slice(0, 1 + r.int(3)).map((x) => x.id);
        const forgedScopes = [r.pick(GROUPS)];
        // (a) same key, more cited notes
        await log.append(sign({ ...rec, author: 'mallory', sig: undefined, citedNoteIds: [...rec.citedNoteIds, ...extra] }, A.mallory.privateKey), forgedScopes);
        // (b) cited set and key consistent, but resting on extra notes
        const cited = [...rec.citedNoteIds, ...extra];
        await log.append(sign({ ...rec, author: 'mallory', sig: undefined, citedNoteIds: cited, key: nodeKey(E, cited, rec.generatorVersion, rec.path) }, A.mallory.privateKey), forgedScopes);
        // (c) someone's own-page record reposted into a group, re-signed
        await log.append(sign({ ...rec, author: 'mallory', sig: undefined }, A.mallory.privateKey), forgedScopes);
        // (d) a tampered record keeping the original author's signature
        await log.append({ ...rec, citedNoteIds: rec.citedNoteIds.slice(1) }, forgedScopes);
      }
    }
    // final check from every viewer's side over everything they can list
    for (const u of USERS) {
      const view = readable(u);
      if (!view.length) continue;
      const pub = await log.list({ entity: E, groups: [...member[u], u] });
      const d = decide({ entity: E, notes: view, facets: [] }, pub, trustOf(u));
      const ids = new Set(view.map((x) => x.id));
      for (const node of walk(d.tree)) {
        const dd = d.decisions.get(node.path);
        rejectedForged += dd.rejected.length;
        if (dd.action !== 'adopt') continue;
        assert.equal(dd.entry.record.key, node.key);
        assert.ok(dd.entry.record.citedNoteIds.every((id) => ids.has(id)), `seed ${seed}: ${u} adopted a record citing an unreadable note`);
        adoptedTotal++;
      }
    }
  }
  assert.ok(adoptedTotal > SEEDS, `adoption happened (${adoptedTotal})`);
  assert.ok(rejectedForged > 0, 'forged records were seen and rejected');
  assert.ok(checked > 0);
});
