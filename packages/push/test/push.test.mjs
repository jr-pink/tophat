// The push plane over sqlite replicas: records derive into entities, notes and pages; a second replica of the same user
// reads the same derived shape after hub sync; repeated polls are idempotent; candidates are reused; the budget cap stops
// a priced call before it is made; an OpenAI-compatible provider's JSON is applied; derived notes in a shared scope reach
// the other party and private ones never do.
import assert from 'node:assert/strict';
import { describe, test, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { world, settle, tmp } from '@tophat-md/linknotes/testing';
import { pollOnce, makeProvider } from '../index.mjs';

const recs = [
  { id: 'r1', text: 'Dana Okafor said the Garden Shed frame is welded.', time: '2026-11-01T10:00:00Z', author: 'Dana Okafor' },
  { id: 'r2', text: 'ok thanks', time: '2026-11-01T10:01:00Z', author: 'Dana Okafor' },
  { id: 'r3', text: 'The Garden Shed needs a compressor before Friday.', time: '2026-11-01T10:05:00Z', author: 'me' },
];
const drop = (records) => { const d = tmp('linknotes-drop-'); fs.writeFileSync(path.join(d, 'in.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n'); return d; };
const cfgFor = (user, dir, extra = {}) => ({ id: `${user}-push`, scopes: [user], stateDir: tmp('linknotes-push-state-'), sources: [{ id: 'notes-drop', family: 'jsonl', config: { dir } }], model: { provider: 'stub' }, ...extra });
async function shape(store, report) {
  const ents = new Map();
  for (const s of report.derive) for (const p of s.pages) ents.set(p.entity_id, p.notes);
  const out = [];
  for (const [id, n] of ents) { const e = await store.entity(id); out.push({ name: e.entity.name, notes: e.notes.map((x) => x.body).sort(), pageNotes: n }); }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

describe('push plane', () => {
  let w;
  after(async () => { await w?.close(); });
  const shapes = {};
  let origin, first;
  test('derives from file-drop records into a sqlite replica; idempotent; reuses candidates', async () => {
    w ??= await world();
    const user = 'psqlite';
    const store = origin = w.sqlite(user);
    await store.createScope(user);
    const dir = drop(recs), cfg = cfgFor(user, dir);
    const r1 = await pollOnce(store, cfg);
    assert.deepEqual(r1.errors, []);
    assert.equal(r1.sources.delivered['notes-drop'].stored.length, 3);
    assert.equal(r1.derive.length, 1); assert.equal(r1.derive[0].records, 3);
    assert.equal(r1.derive[0].notes, 2, 'the record with nothing durable gives no note');
    shapes.origin = await shape(store, r1); first = r1;
    assert.deepEqual(shapes.origin.map((s) => s.name), ['Dana Okafor', 'Garden Shed']);
    assert.deepEqual(await store.pending({ pusher: cfg.id }), []);
    const r2 = await pollOnce(store, cfg);
    assert.equal(r2.derive.length, 0, 'nothing new');
    fs.appendFileSync(path.join(dir, 'in.jsonl'), JSON.stringify({ id: 'r4', text: 'Dana Okafor ordered sprinkler cables.', time: '2026-11-02T09:00:00Z' }) + '\n');
    const r3 = await pollOnce(store, cfg);
    assert.equal(r3.derive[0].entities, 0, 'Dana Okafor reused as a candidate, no new entity');
    const dana = (await store.search('Okafor', { kind: 'entity' })).hits[0];
    assert.equal((await store.entity(dana.id)).notes.length, 2);
    const page = await store.page(dana.id);
    assert.match(page.outline, /sprinkler cables/);
  });
  test('a second replica of the same user reads the same derived entities, notes and pages after hub sync', async () => {
    const replica = w.replica(origin);
    await settle(origin, replica);
    assert.deepEqual(await shape(replica, first), await shape(origin, first));
    assert.ok(shapes.origin.every((x) => x.notes.length >= 1));
    assert.deepEqual(await replica.pending({ pusher: 'psqlite-push' }), [], 'what the origin derived from is not pending on the replica');
    for (const s of first.derive) for (const p of s.pages) assert.equal((await replica.page(p.entity_id)).outline, (await origin.page(p.entity_id)).outline);
  });

  test('budget cap stops a priced call before it is made; records stay pending', async () => {
    const store = w.sqlite('budgeted');
    await store.createScope('budgeted');
    let called = 0;
    const fetch = async () => { called++; return Response.json({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }); };
    const cfg = cfgFor('budgeted', drop(recs), { model: { provider: 'openai', model: 'some-model', apiKeyEnv: 'LINKNOTES_TEST_KEY', price: { inputPerMTok: 3, outputPerMTok: 15 }, maxTokens: 4000 }, budget: { dailyUsd: 0.0001 } });
    const r = await pollOnce(store, cfg, { provider: makeProvider(cfg.model, { fetch, env: { LINKNOTES_TEST_KEY: 'k' } }) });
    assert.equal(called, 0);
    assert.equal(r.errors[0].code, 'budget-exhausted');
    assert.equal((await store.pending({ pusher: cfg.id })).length, 3);
  });

  test('an OpenAI-compatible provider: JSON reply applied, spend recorded at configured prices', async () => {
    const store = w.sqlite('oai');
    await store.createScope('oai');
    const reply = { entities: [{ ref: '$1', name: 'Dana Okafor', type: 'person' }, { ref: '$9', name: 'Unused', type: 'topic' }], notes: [{ body: 'Dana Okafor reports the rig frame is welded.', entities: ['$1', 'E99'], sources: ['R1'] }] };
    const fetch = async (url, init) => { assert.match(String(url), /\/chat\/completions$/); assert.equal(init.headers.authorization, 'Bearer k'); return Response.json({ model: 'm', choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }); };
    const cfg = cfgFor('oai', drop(recs), { model: { provider: 'openai', model: 'm', apiKeyEnv: 'K', price: { inputPerMTok: 3, outputPerMTok: 15 }, maxTokens: 1000 }, budget: { dailyUsd: 5 } });
    const r = await pollOnce(store, cfg, { provider: makeProvider(cfg.model, { fetch, env: { K: 'k' } }) });
    assert.deepEqual(r.errors, []);
    assert.equal(r.derive[0].notes, 1); assert.equal(r.derive[0].entities, 1, 'an entity no note uses is dropped');
    assert.ok(Math.abs(r.derive[0].usd - 0.0045) < 1e-9);
    const ledger = fs.readFileSync(path.join(cfg.stateDir, 'spend.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(ledger.length, 1); assert.equal(ledger[0].input_tokens, 1000);
  });

  test('two parties: A pushes private and shared streams; B (its own replica) sees only the shared derivations', async () => {
    const A = w.sqlite('pa'), B = w.sqlite('pb');
    await A.createScope('pa'); await A.createScope('pshared'); await B.createScope('pb');
    await settle(A, B); await A.addMember('pshared', 'pb', 'read'); await settle(A, B);
    await pollOnce(A, cfgFor('pa', drop([{ id: 'x1', text: 'Secret Project Alpha budget is tight.', time: '2026-11-03T00:00:00Z' }])));
    await pollOnce(A, { ...cfgFor('pa', drop([{ id: 'y1', text: 'The Shared Boiler is filled.', time: '2026-11-03T00:00:00Z' }])), id: 'pa-shared-push', scopes: ['pshared'], syncAfter: true });
    await settle(A, B);
    assert.ok((await B.search('Boiler')).hits.some((h) => h.kind === 'note'));
    assert.equal((await B.search('Alpha')).hits.length, 0);
  });
});

test('the anthropic provider sends the workspace id header only when its config names a workspace variable', async () => {
  const seen = [];
  const f = async (url, init) => { seen.push({ url, headers: init.headers }); return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }) }; };
  const env = { K: 'sk-test', W: 'wrkspc_1' };
  await makeProvider({ provider: 'anthropic', model: 'm', apiKeyEnv: 'K', workspaceEnv: 'W' }, { fetch: f, env }).complete({ system: 's', user: 'u', maxTokens: 5 });
  await makeProvider({ provider: 'anthropic', model: 'm', apiKeyEnv: 'K' }, { fetch: f, env }).complete({ system: 's', user: 'u', maxTokens: 5 });
  assert.equal(seen[0].headers['anthropic-workspace-id'], 'wrkspc_1');
  assert.equal(seen[1].headers['anthropic-workspace-id'], undefined);
  assert.equal(seen[0].headers['x-api-key'], 'sk-test');
});
