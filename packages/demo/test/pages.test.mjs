// Model-written entity pages: the page step writes them as signed PageNodes through a provider, once a day, leaves a page alone when the
// model fails, and the snapshot prefers them over the mechanical outline. Scratch stores only (temp dirs); the model is the page writer's
// own provider-free stub, wrapped in the provider interface the push package uses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubPageModel } from '@tophat-md/linknotes/pages';
import { openStore } from '@tophat-md/runner/store/memory.mjs';
import { entitiesOf } from '../src/entities.mjs';
import { PAGE_AUTHOR, buildPages, buildPagesFromConfig, modelPageOf, pagesConfig } from '../src/pages.mjs';
import { seed, snapshot } from '../src/seed.mjs';
// The widget builder is host-only (export-ignored in .gitattributes, shipped to the demo host through DEMO_HOST_FILES), so a release
// tree has no builder to check: its reading of model pages is asserted wherever the builder exists (the source repository and the host).
const graphBuilder = await import('../widgets/build-graph.mjs').catch((e) => { if (e?.code === 'ERR_MODULE_NOT_FOUND' && /build-graph\.mjs/.test(String(e.url || e.message))) return null; throw e; });

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'demo-pages-test';
const LIMITS = { model: 'x', maxCalls: 100, maxTokens: 4000, maxInputChars: 60000 };
const DAY1 = new Date('2026-11-12T06:00:00Z'), DAY2 = new Date('2026-11-13T06:00:00Z'), DAY3 = new Date('2026-11-14T06:00:00Z');

const TEXTS = [
  'The hub is a ciphertext relay: it stores sealed rows and never holds a key.',
  'A scope is a group; every row carries the scopes that may read it, and members share by scope.',
  'The linknotes package keeps entities, notes and work items in SQLite, with scopes on every row.',
  'Derived pages are built from the notes a viewer can read; a page is an outline, one point per idea.',
  'The push plane derives notes from raw records under a daily budget with a configured model.',
  'Share links give anyone with the URL one document or one chat, no sign-in.',
];
const NEW_TEXT = 'The hub relays ciphertext between devices and keeps no plaintext, ever.';
const record = (i, text) => ({ id: `doc:t${i}`, source: 'tophat-docs', revision: 'r1', time: `2026-11-1${i % 9}T12:00:00Z`, text, title: `T${i}`, entities: entitiesOf(text) });
const lines = (texts) => texts.map((t, i) => JSON.stringify(record(i, t))).join('\n') + '\n';
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'demo-pages-'));
  const records = path.join(dir, 'records.jsonl');
  writeFileSync(records, lines(TEXTS));
  return { dir, db: path.join(dir, 'memory.sqlite'), records, stateDir: path.join(dir, 'state'), out: path.join(dir, 'snapshot.json') };
}
/** The push provider interface over the page writer's stub model; counts calls, optionally breaks. */
function provider(mode = 'ok') {
  const p = { calls: 0, async complete(req) {
    p.calls++;
    if (mode === 'throw') throw Object.assign(new Error('provider http 500'), { code: 'provider-http-500' });
    if (mode === 'garbage') return { text: 'not json at all', model: 'stub', usage: {} };
    const r = stubPageModel(req);
    return { text: r.text, model: r.model, usage: { input_tokens: 10, output_tokens: 5 } };
  } };
  return p;
}
const run = (w, prov, now, extra = {}) => buildPages({ db: w.db, scope: SCOPE, stateDir: w.stateDir, provider: prov, limits: LIMITS, now, ...extra });
const snap = async (w) => { await snapshot({ db: w.db, scope: SCOPE, out: w.out }); return JSON.parse(readFileSync(w.out, 'utf8')); };
const nameOf = (s, name) => s.entities.find((e) => e.name === name).id;
const stateOf = (w) => JSON.parse(readFileSync(path.join(w.stateDir, 'state.json'), 'utf8'));
const addNote = async (w) => { writeFileSync(w.records, lines([...TEXTS, NEW_TEXT])); await seed({ db: w.db, scope: SCOPE, records: w.records }); };

test('pages become model-written nodes in the snapshot; before the step they are the mechanical outline', async () => {
  const w = scratch();
  try {
    await seed({ db: w.db, scope: SCOPE, records: w.records });
    const before = await snap(w), hub = nameOf(before, 'hub (ciphertext relay)');
    assert.match(before.pages[hub].nodes[0].text, /^.+ \((service|concept|feature|software|project)\)$/, 'mechanical: the entity, then a line per note');
    assert.equal(before.pages[hub].kind, undefined);
    const r = await run(w, provider(), DAY1);
    assert.ok(r.written >= 5 && r.failed === 0, JSON.stringify(r));
    const after = await snap(w), page = after.pages[hub];
    assert.equal(page.kind, 'model');
    assert.ok(page.nodes.length >= 1 && page.nodes.every((n) => /^Note N\d+ /.test(n.text)), 'the stub model wrote the points');
    assert.ok(page.nodes.every((n) => 'id' in n && 'parent' in n && 'order' in n && typeof n.text === 'string' && Array.isArray(n.notes) && n.notes.length), 'the snapshot node shape');
    assert.ok(page.nodes.every((n) => after.notes.some((x) => x.id === n.notes[0])), 'each point cites notes of the snapshot');
    // the widget builder reads model pages as their level-1 points
    if (graphBuilder) {
      const g = graphBuilder.graphData(after);
      assert.ok(g.nodes.some((n) => n.page.lines.some(([, t]) => /^Note N\d+ /.test(t))));
    }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('the records are signed PageNodes of the instance scope, authored by the page step', async () => {
  const w = scratch();
  try {
    await seed({ db: w.db, scope: SCOPE, records: w.records });
    await run(w, provider(), DAY1);
    const b = openStore(w.db, { TOPHAT_SCOPE: SCOPE }), s = b.store; s.setViewer(s.user);
    const hub = s.one("SELECT id FROM entities WHERE name='hub (ciphertext relay)'").id;
    const entries = await b.pageNodes({ entity: hub });
    assert.ok(entries.length >= 2);
    for (const e of entries) {
      assert.equal(e.record.type, 'PageNode'); assert.equal(e.record.author, PAGE_AUTHOR);
      assert.deepEqual(e.scopes, [SCOPE]); assert.ok(e.record.sig && e.record.citedNoteIds.length);
    }
    assert.ok(entries.some((e) => e.record.path === ''), 'the root names the top-level points');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('a second run the same day does nothing; the next day with nothing new makes no model call', async () => {
  const w = scratch();
  try {
    await seed({ db: w.db, scope: SCOPE, records: w.records });
    const p = provider();
    const first = await run(w, p, DAY1);
    const calls = p.calls;
    assert.equal(calls, first.calls); assert.ok(calls > 0);
    const state1 = readFileSync(path.join(w.stateDir, 'state.json'), 'utf8');
    const again = await run(w, p, new Date('2026-11-12T23:00:00Z'));
    assert.equal(again.skipped, 'already built today');
    assert.equal(p.calls, calls); assert.equal(readFileSync(path.join(w.stateDir, 'state.json'), 'utf8'), state1, 'state untouched by a skipped run');
    const next = await run(w, p, DAY2);
    assert.equal(next.calls, 0); assert.equal(next.written, 0); assert.equal(p.calls, calls, 'unchanged input: no call');
    assert.equal(next.unchanged, first.written);
    const forced = await run(w, p, DAY2, { force: true });
    assert.equal(forced.skipped, undefined); assert.equal(p.calls, calls, 'force runs the day again but unchanged entities still cost nothing');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('a new note rewrites only the pages it touches', async () => {
  const w = scratch();
  try {
    await seed({ db: w.db, scope: SCOPE, records: w.records });
    const p = provider();
    const first = await run(w, p, DAY1);
    const before = await snap(w);
    await addNote(w);
    const next = await run(w, p, DAY2);
    assert.ok(next.calls >= 1 && next.calls < first.calls, `${next.calls} of ${first.calls}`);
    const after = await snap(w), hub = nameOf(after, 'hub (ciphertext relay)'), shares = nameOf(after, 'share links');
    assert.ok(after.pages[hub].nodes.length > before.pages[hub].nodes.length, 'the hub page took the new note');
    assert.deepEqual(after.pages[shares].nodes, before.pages[shares].nodes, 'a page the note does not touch is the same page');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('a failing model leaves the existing page untouched, and an unusable reply is a failure too', async () => {
  const w = scratch();
  try {
    await seed({ db: w.db, scope: SCOPE, records: w.records });
    await run(w, provider(), DAY1);
    const before = await snap(w);
    const stateBefore = stateOf(w).entities;
    await addNote(w);
    for (const [mode, day] of [['throw', DAY2], ['garbage', DAY3]]) {
      const r = await run(w, provider(mode), day);
      assert.ok(r.failed >= 1 && r.written === 0, JSON.stringify(r));
      assert.ok(r.errors.length >= 1);
      const after = await snap(w), hub = nameOf(after, 'hub (ciphertext relay)');
      assert.deepEqual(after.pages[hub], before.pages[hub], `${mode}: the old model page is served as it was`);
      assert.equal(after.pages[hub].kind, 'model');
    }
    assert.deepEqual(stateOf(w).entities, stateBefore, 'a failed entity keeps its recorded input, so the next day retries it');
    const retry = await run(w, provider(), new Date('2026-11-15T06:00:00Z'));
    assert.ok(retry.written >= 1, 'the next day the model answers and the page is rewritten');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('a first run whose model fails keeps the mechanical pages', async () => {
  const w = scratch();
  try {
    await seed({ db: w.db, scope: SCOPE, records: w.records });
    const r = await run(w, provider('throw'), DAY1);
    assert.equal(r.written, 0); assert.ok(r.failed > 0);
    const s = await snap(w);
    assert.ok(Object.values(s.pages).length > 0 && Object.values(s.pages).every((p) => p.kind === undefined), 'no model page, the mechanical outline stays');
    // the failed day still counts: a broken model spends nothing twice in a day
    assert.equal((await run(w, provider(), DAY1)).skipped, 'already built today');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('the per-run cap stops the calls; the rest wait for the next day', async () => {
  const w = scratch();
  try {
    await seed({ db: w.db, scope: SCOPE, records: w.records });
    const p = provider();
    const r = await run(w, p, DAY1, { limits: { ...LIMITS, maxCalls: 2 } });
    assert.equal(r.calls, 2); assert.equal(p.calls, 2); assert.ok(r.capped > 0);
    const next = await run(w, p, DAY2);
    assert.ok(next.calls > 0 && next.written > 0, 'the next day continues where the cap stopped');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('a page cut to the input budget shows the newest notes and still writes', async () => {
  const w = scratch();
  try {
    await seed({ db: w.db, scope: SCOPE, records: w.records });
    const p = provider(); let seen = null;
    const spy = { complete: async (req) => { seen = req.user; return p.complete(req); } };
    await run(w, spy, DAY1, { limits: { ...LIMITS, maxInputChars: 900 } });
    assert.ok(seen && seen.length < 3000, 'the packet is small');
    const s = await snap(w);
    assert.ok(Object.values(s.pages).some((x) => x.kind === 'model'));
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('a generation with a missing record is not a page: the snapshot falls back', () => {
  const rec = (p, childKeys, at, extra = {}) => ({ record: { type: 'PageNode', author: PAGE_AUTHOR, generatorVersion: 'outline-1:g', key: `k${p}`, path: p, text: `t${p}`, citedNoteIds: ['n'], childKeys, at, ...extra } });
  const whole = [rec('', ['k1', 'k2'], '3'), rec('1', [], '1'), rec('2', ['k2.1'], '1'), rec('2.1', [], '1')];
  const page = modelPageOf(whole);
  assert.deepEqual(page.nodes.map((n) => [n.id, n.parent, n.order]), [['n1', null, 1], ['n2', null, 2], ['n2.1', 'n2', 1]]);
  assert.equal(modelPageOf(whole.filter((e) => e.record.path !== '2.1')), null, 'a child key with no record');
  assert.equal(modelPageOf(whole.filter((e) => e.record.path !== '')), null, 'no root: the writer died before finishing');
  assert.equal(modelPageOf(whole.map((e) => ({ record: { ...e.record, author: 'someone-else' } }))), null, 'only the page step\'s own records');
  // the newest complete generation wins over an older complete one and over a newer incomplete one
  const older = whole.map((e) => ({ record: { ...e.record, generatorVersion: 'outline-1:old', key: `o${e.record.key}`, childKeys: e.record.childKeys.map((k) => `o${k}`), text: 'old', at: '0' } }));
  const newerBroken = [rec('', ['k1'], '9', { generatorVersion: 'outline-1:broken' })];
  assert.equal(modelPageOf([...older, ...newerBroken]).nodes[0].text, 'old');
  assert.equal(modelPageOf([...older, ...whole]).nodes[0].text, 't1');
});

test('the config is demo.json pages; a missing value is an error naming it', () => {
  assert.deepEqual(pagesConfig({ pages: { model: 'fast', maxCalls: 3, maxTokens: 4, maxInputChars: 5 } }), { model: 'fast', maxCalls: 3, maxTokens: 4, maxInputChars: 5 });
  assert.throws(() => pagesConfig({}), /pages is required/);
  assert.throws(() => pagesConfig({ pages: { model: 'fast', maxTokens: 4, maxInputChars: 5 } }), /pages\.maxCalls/);
  assert.throws(() => pagesConfig({ pages: { maxCalls: 1, maxTokens: 4, maxInputChars: 5 } }), /pages\.model/);
  assert.throws(() => pagesConfig({ pages: { model: 'fast', maxCalls: 1.5, maxTokens: 4, maxInputChars: 5 } }), /pages\.maxCalls/);
});

test('the page prompt ships and names nobody', () => {
  const text = readFileSync(path.join(DEMO, '../linknotes/core/vendor/rev6/push/prompts/page_prompt.txt'), 'utf8');
  assert.match(text, /^You maintain the standing page for ONE entity/);
  assert.ok(!text.includes('\u2014'), 'no em dash');
  const personal = new RegExp(['hu' + 'xley', 'mar' + 'vit', 'al' + 'bert', 'pi' + 'nk\\s*matter'].join('|'), 'i');
  assert.ok(!personal.test(text));
});

test('from demo.json: the instance file names the model, its key comes from the keyring, and the request goes through the push provider', async () => {
  const w = scratch();
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, model: j.model, max: j.max_tokens, system: j.messages[0].content.slice(0, 20) });
      const r = stubPageModel({ system: j.messages[0].content, user: j.messages[1].content });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: r.text } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const secrets = path.join(w.dir, 'secrets'), state = path.join(w.dir, 'inst-state');
    mkdirSync(secrets, { recursive: true });
    writeFileSync(path.join(secrets, 'scratch-key'), 'sk-scratch-test\n');
    const instance = path.join(w.dir, 'instance.json');
    writeFileSync(instance, JSON.stringify({ name: 'scratch', paths: { state, secrets }, models: { fast: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'cheap-1', credential: { keyring: 'scratch-key' } } } }));
    await seed({ db: w.db, scope: SCOPE, records: w.records });
    const c = { instance, db: w.db, scope: SCOPE, pages: { model: 'fast', maxCalls: 3, maxTokens: 1234, maxInputChars: 60000 } };
    const r = await buildPagesFromConfig(c, { now: DAY1 });
    assert.equal(r.calls, 3); assert.equal(r.written, 3); assert.equal(r.usage.input_tokens, 21);
    assert.deepEqual([...new Set(seen.map((x) => x.auth))], ['Bearer sk-scratch-test']);
    assert.ok(seen.every((x) => x.model === 'cheap-1' && x.max === 1234 && x.system === 'You maintain the sta'));
    assert.equal((await buildPagesFromConfig(c, { now: DAY1 })).skipped, 'already built today');
    assert.equal(seen.length, 3);
    assert.ok(JSON.parse(readFileSync(path.join(state, 'demo-pages/state.json'), 'utf8')).day === '2026-11-12');
    await assert.rejects(() => buildPagesFromConfig({ ...c, pages: { ...c.pages, model: 'nope' } }, { now: DAY2 }), /names no entry/);
    await assert.rejects(() => buildPagesFromConfig({ ...c, pages: undefined }, { now: DAY2 }), /pages is required/);
  } finally { server.close(); rmSync(w.dir, { recursive: true, force: true }); }
});
