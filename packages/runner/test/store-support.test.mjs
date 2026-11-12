// Note support through the runner's store (store/memory.mjs over linknotes support.mjs and usage.mjs): a reinforce op
// adds separate raw records to an existing note (count, first and last seen from the records' own times, the note row
// untouched), search annotates note hits with their support and, with memory-ranking.json beside the store, re-ranks by a
// small prior, and the usage command appends shown / opened / cited events parsed from a runner transcript. Scratch files only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { answer, closeAll } from '../store/memory.mjs';
import { reinforceNote, supportOf, withPriors } from '@tophat-md/linknotes/support';
import { hybridSearch } from '@tophat-md/linknotes/hybrid';
import { world, settle } from '@tophat-md/linknotes/testing';

const dirs = [];
test.after(() => { closeAll(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const db = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tophat-support-')); dirs.push(d); return path.join(d, 'memory.sqlite'); };
const ok = (r) => { assert.equal(r.code, 0, JSON.stringify(r.result)); return r.result; };
const env = { TOPHAT_TIMEZONE: 'America/Los_Angeles' };

function seed(file) {
  const got = ok(answer('ingest', { records: [
    { source: 'chat', native_id: 'a', author: 'owner', role: 'owner', text: 'the bike rack clip broke on the left', occurred_at: '2026-06-01T17:00:00Z' },
    { source: 'chat', native_id: 'b', author: 'owner', role: 'owner', text: 'bike rack clip is plastic', occurred_at: '2026-07-01T17:00:00Z' },
    { source: 'chat', native_id: 'c', author: 'owner', role: 'owner', text: 'clip on the bike rack still broken', occurred_at: '2026-09-01T17:00:00Z' },
    { source: 'chat', native_id: 'd', author: 'owner', role: 'owner', text: 'yep the rack clip is broken', occurred_at: '2026-10-01T17:00:00Z' },
  ] }, { db: file, env }));
  const [ra, rb, rc, rd] = got.stored;
  const n1 = ok(answer('apply', { batch_id: 'n1', changes: { entities: [{ id: '$r', name: 'Bike Rack Clip Test', type: 'thing' }],
    notes: [{ body: 'The Thule bike rack clip broke on the left side; replacement part 52211 costs 18 dollars', entities: ['$r'], source_refs: [ra] }, { body: 'The bike rack clip is plastic', entities: ['$r'], source_refs: [rb] }] } }, { db: file, env }));
  return { raws: { ra, rb, rc, rd }, notes: n1.notes.map((n) => n.id) };
}

test('runner store: reinforce adds separate records to a note; first and last seen come from the records; the note row is unchanged', () => {
  const file = db();
  const { raws, notes: [broke] } = seed(file);
  const r = ok(answer('apply', { batch_id: 'r1', changes: { reinforce: [{ note_id: broke, source_refs: [raws.rd, raws.rc, raws.ra] }] } }, { db: file, env }));
  assert.equal(r.reinforced[0].added, 2, 'ra is already cited');
  assert.equal(r.reinforced[0].sources, 3);
  assert.equal(r.reinforced[0].first_seen, '2026-06-01T17:00:00.000Z');
  assert.equal(r.reinforced[0].last_seen, '2026-10-01T17:00:00.000Z');
  const again = ok(answer('apply', { batch_id: 'r2', changes: { reinforce: [{ note_id: broke, source_refs: [raws.rd] }] } }, { db: file, env }));
  assert.equal(again.reinforced[0].op, 'unchanged');
  const h = ok(answer('search', { query: 'bike rack clip', kind: 'note', limit: 5 }, { db: file, env }));
  assert.equal(h.hits.find((x) => x.id === broke).support.sources, 3);
  assert.equal(h.coverage.priors, undefined, 'no memory-ranking.json: no priors');
});

test('runner store: memory-ranking.json turns on the support and recency prior; a missing key is refused', () => {
  const file = db();
  const { raws, notes } = seed(file);
  const base = ok(answer('search', { query: 'bike rack clip', kind: 'note', limit: 5 }, { db: file, env })).hits.map((x) => x.id);
  const last = base.at(-1);
  ok(answer('apply', { batch_id: 'r1', changes: { reinforce: [{ note_id: last, source_refs: [raws.rc, raws.rd] }] } }, { db: file, env }));
  writeFileSync(path.join(path.dirname(file), 'memory-ranking.json'), JSON.stringify({ support_weight: 0.1, recency_weight: 0.1, recency_half_life_days: 90, usage_prior: false, usage_weight: 0.02, widen: 2 }));
  const ranked = ok(answer('search', { query: 'bike rack clip', kind: 'note', limit: 5 }, { db: file, env }));
  assert.equal(ranked.hits[0].id, last);
  assert.ok(notes.includes(last));
  writeFileSync(path.join(path.dirname(file), 'memory-ranking.json'), JSON.stringify({ support_weight: 0.1 }));
  const bad = answer('search', { query: 'bike rack clip', kind: 'note', limit: 5 }, { db: file, env });
  assert.notEqual(bad.code, 0);
  assert.match(bad.result.detail, /missing/u);
});

test('runner store: the usage command appends shown, opened and cited events from the runner transcript beside the store, once', () => {
  const file = db();
  const { notes: [broke, plastic] } = seed(file);
  const run = new DatabaseSync(path.join(path.dirname(file), 'runner.sqlite'));
  run.exec('CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)');
  const put = run.prepare('INSERT INTO messages(session_id, role, kind, content, created_at) VALUES(?,?,?,?,?)');
  const m = (kind, content, at = '2026-11-01T10:00:00Z') => put.run('s1', kind === 'owner' || kind === 'tool_result' ? 'user' : 'assistant', kind, JSON.stringify(content), at);
  m('owner', [{ type: 'text', text: 'what is up with my bike?' }]);
  m('assistant', [{ type: 'tool_use', id: 't1', name: 'search', input: { query: 'bike' } }]);
  m('tool_result', [{ type: 'tool_result', tool_use_id: 't1', content: `note ${broke} | model\nnote ${plastic} | model` }]);
  m('assistant', [{ type: 'tool_use', id: 't2', name: 'memory_read', input: { kind: 'note', id: plastic } }]);
  m('assistant', [{ type: 'text', text: 'The Thule rack clip broke; the replacement part is 52211 and costs 18 dollars.' }]);
  m('owner', [{ type: 'text', text: 'ok' }], '2026-11-01T10:10:00Z');
  run.close();
  const u = ok(answer('usage', { since: '2026-10-01T00:00:00Z' }, { db: file, env }));
  assert.equal(u.shown, 2); assert.equal(u.opened, 1); assert.equal(u.cited, 1);
  assert.equal(ok(answer('usage', {}, { db: file, env })).added ?? 0, 0, 'the cursor and the keys add nothing twice');
  assert.ok(supportOf);
});

test('kit replicas: reinforcement counts on the replica that wrote it; a reader sees the note with its own cited support', async () => {
  const w = await world();
  try {
    const kim = w.sqlite('kim'), sam = w.sqlite('sam');
    await kim.createScope('kim'); await kim.createScope('gym'); await sam.createScope('sam');
    await settle(kim, sam);
    await kim.addMember('gym', 'sam', 'read');
    await settle(kim, sam);
    const ing = await kim.ingest([{ source: 'chat', id: 'a', author: 'kim', text: 'squat rack is in bay 3', time: '2026-09-01T17:00:00Z' },
      { source: 'chat', id: 'b', author: 'kim', text: 'rack still in bay 3', time: '2026-10-01T17:00:00Z' }], { scopes: ['gym'] });
    const [ra, rb] = ing.stored;
    const out = await kim.apply({ entities: [{ id: '$r', name: 'Squat Rack Bay Test', type: 'thing' }], notes: [{ body: 'The squat rack is in bay 3', entities: ['$r'], source_refs: [ra] }] }, { scopes: ['gym'], batchId: 'k1' });
    const nid = out.notes[0].id;
    await import('@tophat-md/linknotes/support').then(({ ensureSupportSchema }) => ensureSupportSchema(kim.store.db));
    kim.store.tx(() => reinforceNote(kim.store, nid, [rb], { batchId: 'k2', now: '2026-10-02T00:00:00Z' }));
    assert.equal(supportOf(kim.store, [nid]).get(nid).sources, 2);
    await settle(kim, sam);
    const r = withPriors(sam.store, () => hybridSearch(sam.store, 'squat rack bay', { kind: 'note', limit: 5 }), { limit: 5 });
    const hit = r.hits.find((x) => x.id === nid);
    assert.ok(hit, 'the shared note reaches sam');
    assert.equal(hit.support.sources, 1, 'note_support is a local derived table: not replicated (a known gap)');
  } finally { await w.close(); }
});

test('runner store: a store holding the old reinforcement table under note_sources is migrated at open; support rows kept, citation index rebuilt, note writes work', () => {
  const file = db();
  const { raws, notes: [broke] } = seed(file);
  closeAll();
  // the pre-split shape: reinforcement rows in note_sources (append-only), as stores written before the citation index hold it
  const raw = new DatabaseSync(file);
  raw.exec(`DROP TRIGGER IF EXISTS note_sources_ins; DROP TRIGGER IF EXISTS note_sources_upd; DROP TRIGGER IF EXISTS note_sources_del;
    DROP TABLE note_sources; DROP TABLE IF EXISTS note_support;
    CREATE TABLE note_sources(note_id TEXT NOT NULL, raw_id TEXT NOT NULL, occurred_at TEXT NOT NULL, batch_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(note_id, raw_id));
    CREATE INDEX note_sources_raw ON note_sources(raw_id);
    CREATE TRIGGER note_sources_append_only_delete BEFORE DELETE ON note_sources BEGIN SELECT RAISE(ABORT, 'append-only: note_sources'); END;`);
  raw.prepare('INSERT INTO note_sources VALUES(?,?,?,?,?)').run(broke, raws.rd, '2026-10-01T17:00:00.000Z', 'old', '2026-10-02T00:00:00Z');
  raw.close();
  const h = ok(answer('search', { query: 'bike rack clip', kind: 'note', limit: 5 }, { db: file, env }));
  assert.equal(h.hits.find((x) => x.id === broke).support.sources, 2, 'the old reinforcement row still counts');
  const n = ok(answer('apply', { batch_id: 'n2', changes: { notes: [{ body: 'The bike rack clip was replaced in October', entities: ['Bike Rack Clip Test'], source_refs: [raws.rd] }] } }, { db: file, env }));
  closeAll();
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(after.prepare("SELECT name FROM pragma_table_info('note_sources') ORDER BY cid").all().map((r) => r.name), ['raw_id', 'note_id'], 'note_sources is the citation index again');
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM note_support').get().n, 1);
    assert.ok(after.prepare('SELECT 1 AS ok FROM note_sources WHERE raw_id=? AND note_id=?').get(raws.rd, n.notes[0].id), 'the new note is in the citation index');
    assert.ok(after.prepare('SELECT 1 AS ok FROM note_sources WHERE raw_id=? AND note_id=?').get(raws.ra, broke), 'existing notes are backfilled');
  } finally { after.close(); }
});
