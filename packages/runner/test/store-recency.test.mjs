// The dated pass of memory search (linknotes recency.mjs) through the runner's store (store/memory.mjs) and on linknotes kit
// replicas: newest-first for latest-value queries, every dated record of a named period or a count, the as-of cut and the
// scopes held. Scratch files only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answer, closeAll } from '../store/memory.mjs';
import { world, settle } from '@tophat-md/linknotes/testing';
import { withDatedPass } from '@tophat-md/linknotes/recency';
import { hybridSearch } from '@tophat-md/linknotes/hybrid';

const TZ = 'America/Los_Angeles';
const dirs = [];
test.after(() => { closeAll(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const db = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tophat-recency-')); dirs.push(d); return path.join(d, 'memory.sqlite'); };
const ok = (r) => { assert.equal(r.code, 0, JSON.stringify(r.result)); return r.result; };
const at = (m, d, h = 15) => new Date(Date.UTC(2026, m - 1, d, h)).toISOString();

// Scale readings whose text never names the topic (source `scale-weight`), lift logs on many days, and chatter.
function records() {
  const out = [];
  [[9, 1], [9, 10], [10, 1], [10, 5], [10, 6], [10, 7], [10, 8], [10, 20], [10, 22]].forEach(([m, d], i) =>
    out.push({ source: 'scale-weight', native_id: `w${i}`, author: 'owner', role: 'owner', text: `[08:00] ${(117 + (i % 4) * 0.6).toFixed(1)}`, occurred_at: at(m, d) }));
  [[8, 1, 115], [9, 1, 155], [10, 6, 175], [10, 17, 185], [10, 22, 185], [11, 3, 185], [11, 7, 195]].forEach(([m, d, w], i) =>
    out.push({ source: 'lifts', native_id: `l${i}`, author: 'owner', role: 'owner', text: `B day: rows 3x8. hip thrust ${w} for 8, 8, 6. press 3x8`, occurred_at: at(m, d, 19) }));
  for (let i = 0; i < 20; i++) out.push({ source: 'chat', native_id: `c${i}`, author: 'owner', role: 'owner', text: `note ${i}: the weight of the argument`, occurred_at: at(8, 1 + i, 3) });
  return out;
}

test('runner store: a latest-value query leads with the newest records about its topic, even ones that never name it', () => {
  const file = db(), env = { TOPHAT_TIMEZONE: TZ };
  ok(answer('ingest', { records: records() }, { db: file, env }));
  const w = ok(answer('search', { query: 'when did I last weigh myself', limit: 5, derived: 5 }, { db: file, env }));
  assert.equal(w.coverage.dated.mode, 'newest-first');
  assert.equal(w.hits[0].occurred_at, at(10, 22), 'the newest scale reading leads');
  const h = ok(answer('search', { query: "what's my current hip thrust weight", limit: 5, derived: 5 }, { db: file, env }));
  assert.match(h.hits[0].snippet, /195/u);
});

test('runner store: a period or a count lists every matching dated record, not the top-k; a plain query keeps its ranking', () => {
  const file = db(), env = { TOPHAT_TIMEZONE: TZ };
  ok(answer('ingest', { records: records() }, { db: file, env }));
  const r = ok(answer('search', { query: 'average weight across my October weigh-ins', limit: 3, derived: 3 }, { db: file, env }));
  assert.equal(r.coverage.dated.mode, 'period');
  const oct = r.hits.filter((x) => x.dated === 'in-period' && x.source === 'scale-weight');
  assert.equal(oct.length, 7, 'all seven October readings, though limit is 3');
  assert.deepEqual(oct.map((x) => x.occurred_at), [...oct.map((x) => x.occurred_at)].sort());
  const plain = ok(answer('search', { query: 'hip thrust', kind: 'raw', limit: 4 }, { db: file, env }));
  assert.ok(plain.hits.length <= 4, 'a kinded search keeps its limit');
  assert.ok(plain.hits.some((x) => x.occurred_at === at(11, 7, 19)), 'the newest matching record is in it');
});

test('runner store: the as-of cut holds for the dated pass', () => {
  const file = db(), env = { TOPHAT_TIMEZONE: TZ };
  ok(answer('ingest', { records: records() }, { db: file, env }));
  const r = ok(answer('search', { query: 'latest hip thrust', limit: 5, derived: 5, as_of: '2026-10-25T00:00:00Z' }, { db: file, env }));
  assert.ok(r.hits.every((x) => !x.occurred_at || x.occurred_at <= '2026-10-25T00:00:00.000Z'));
  assert.match(r.hits[0].snippet, /185/u);
});

test('kit replicas: the dated pass reads only rows shared with the replica, on every device of the reader', async () => {
  const w = await world();
  try {
    const kim = w.sqlite('kim'), sam = w.sqlite('sam'), phone = w.replica(sam);
    await kim.createScope('kim'); await kim.createScope('gym'); await sam.createScope('sam');
    await settle(kim, sam, phone);
    await kim.addMember('gym', 'sam', 'read');
    await settle(kim, sam, phone);
    await kim.ingest([{ source: 'scale-weight', id: 'g1', author: 'kim', text: '[08:00] 120.4', time: at(10, 1) }, { source: 'scale-weight', id: 'g2', author: 'kim', text: '[08:00] 119.0', time: at(10, 22) }], { scopes: ['gym'] });
    await kim.ingest([{ source: 'scale-weight', id: 'k1', author: 'kim', text: '[08:00] 140.2 PRIVATE', time: at(11, 1) }], { scopes: ['kim'] });
    await settle(kim, sam, phone);
    const q = { query: 'when did kim last weigh in', limit: 5 };
    const own = withDatedPass(kim.store, hybridSearch(kim.store, q.query, { limit: 5 }), q, { tz: TZ });
    assert.equal(own.hits[0].occurred_at, at(11, 1), 'kim sees her private, newest reading first');
    for (const b of [sam, phone]) {
      const r = withDatedPass(b.store, hybridSearch(b.store, q.query, { limit: 5 }), q, { tz: TZ });
      assert.equal(r.hits[0].occurred_at, at(10, 22), 'the newest reading shared with sam leads');
      assert.ok(r.hits.every((x) => !/PRIVATE/u.test(x.snippet || '') && x.occurred_at !== at(11, 1)), 'a reading not shared with sam never surfaces');
    }
  } finally { await w.close(); }
});
