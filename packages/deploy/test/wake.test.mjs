// Arrival wakes and the fast-model header proxy. Scratch state only; the model is a function, the webchat a function, the
// upstream a local server: nothing leaves the machine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveInstance } from '../src/instance.mjs';
import { runIntake } from '../src/intake.mjs';
import { createFastProxy } from '../src/fast-proxy.mjs';
import { parseWakes, settled, AUTOMATED } from '../src/wake.mjs';
import { componentDir } from '../src/start.mjs';

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tophat-wake-')); dirs.push(d); return d; };
test.after(async () => {
  const runner = componentDir('runner');
  if (runner) (await import(path.join(runner, 'store/memory.mjs'))).closeAll();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('parseWakes: unknown arrivals and empty texts are dropped, an unknown chat id becomes a new chat, one wake per arrival', () => {
  const rows = [{ id: 'r1' }, { id: 'r2' }];
  const chats = [{ id: 'c1' }];
  const text = JSON.stringify({ wakes: [{ arrival: 'A1', conversation: 'c1', title: 'Dana: boiler', text: 'Dana asks for the boiler quote.' },
    { arrival: 'A1', conversation: null, text: 'again' }, { arrival: 'A2', conversation: 'ghost', text: 'x' }, { arrival: 'A9', text: 'no such arrival' }, { arrival: 'A2', text: '  ' }] });
  const out = parseWakes(text, rows, chats);
  assert.deepEqual(out.map((w) => [w.row.id, w.conversation]), [['r1', 'c1'], ['r2', null]]);
  assert.throws(() => parseWakes('nope', rows, chats), /not JSON/);
});

test('the intake wakes the chat that owns an arrival, once: ledger decides, a failed post retries, transcripts are never arrivals', { skip: (!componentDir('runner') || !componentDir('upkeep') || !componentDir('push')) && 'packages not installed' }, async () => {
  const dir = tmp(), drop = path.join(dir, 'drop'), home = path.join(dir, 'home');
  mkdirSync(drop); mkdirSync(path.join(dir, 'config/secrets'), { recursive: true });
  writeFileSync(path.join(dir, 'config/secrets/webchat-service-token'), 'tok-123\n');
  const now = '2026-11-08T12:00:00Z';
  writeFileSync(path.join(drop, 'a.jsonl'), [
    { id: 'm1', text: 'Dana Okafor asks: can you send the Lab Boiler quote by Friday?', time: '2026-11-08T11:00:00Z', author: 'Dana Okafor' },
    { id: 'm2', text: 'Your newsletter digest is ready.', time: '2026-11-08T11:30:00Z', author: 'news@example.org' },
    { id: 'm3', text: 'Old: please call me', time: '2026-11-01T11:30:00Z', author: 'Sam' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const c = resolveInstance({ name: 'lab', components: ['linknotes', 'runner', 'sources', 'push', 'upkeep'], scope: { default: 'lab' }, paths: { state: './state', config: './config' },
    sources: [{ id: 'drop', family: 'jsonl', config: { dir: drop } }], intake: { everySeconds: 600, model: { provider: 'stub' }, wake: true } }, { dir, home });
  // the webchat store the judge lists chats from
  const wdb = path.join(dir, 'state/webchat/events.sqlite');
  mkdirSync(path.dirname(wdb), { recursive: true });
  const db = new DatabaseSync(wdb);
  db.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT, archived INTEGER DEFAULT 0, sidechat TEXT, aside INTEGER DEFAULT 0)");
  db.prepare('INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)').run('chat-boiler', 'Lab Boiler purchase', '2026-11-08T10:00:00Z');
  db.close();
  const asked = []; const posts = [];
  const wakeProvider = { async complete({ system, user }) { asked.push(user); return { text: JSON.stringify({ wakes: [{ arrival: 'A1', conversation: 'chat-boiler', title: 'Dana: Lab Boiler quote by Friday', text: 'Dana Okafor asks for the Lab Boiler quote by Friday (arrival lab-1).' }] }), usage: { input_tokens: 1, output_tokens: 1 }, model: 'judge' }; } };
  let fail = true;
  const wakeFetch = async (url, init) => {
    posts.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    if (fail) return { ok: false, status: 500, json: async () => ({ error: 'down' }) };
    return { ok: true, status: 200, json: async () => ({ id: 'ff1', conversationId: 'chat-boiler' }) };
  };
  const t0 = Date.parse(now);
  const first = await runIntake(c, { now: t0, deps: { wakeProvider, wakeFetch } });
  assert.equal(first.wake.judged, 2, 'the week-old arrival is past maxAgeHours');
  assert.equal(first.wake.failed, 1); assert.equal(first.wake.none, 1);
  assert.match(asked[0], /A1 \| 2026-11-08T11:00:00.000Z \| source drop/); assert.match(asked[0], /chat-boiler \| Lab Boiler purchase/);
  assert.equal(posts[0].auth, 'Bearer tok-123');
  assert.ok(posts[0].url.endsWith('/api/inbound'));
  assert.equal(posts[0].body.conversationId, 'chat-boiler'); assert.equal(posts[0].body.source, 'push'); assert.equal(posts[0].body.title, 'Dana: Lab Boiler quote by Friday');
  assert.ok(posts[0].body.text.startsWith(AUTOMATED));
  // the failed post is retried on the next pass (not judged-none); the none decision is final
  fail = false;
  const second = await runIntake(c, { now: t0 + 31_000, deps: { wakeProvider, wakeFetch } });
  assert.equal(second.wake.judged, 1); assert.equal(second.wake.woken, 1);
  assert.equal(posts.length, 2);
  // then nothing is left to judge: no wake key, no model call
  const asks = asked.length;
  const third = await runIntake(c, { now: t0 + 62_000, deps: { wakeProvider, wakeFetch } });
  assert.equal(third.wake, undefined); assert.equal(asked.length, asks);
  const stateDir = path.join(dir, 'state/intake');
  assert.equal(settled(stateDir).size, 2);
  const ledger = readFileSync(path.join(stateDir, 'wakes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ledger.map((l) => l.status), ['none', 'failed', 'posted']);
});

test('the fast-model proxy adds the workspace header, forwards the caller bearer, and serves one path only', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"content":"pong"}}]}'); }); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = createFastProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, workspace: () => 'wrkspc_9' });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const ok = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer key-1', 'content-type': 'application/json' }, body: '{"model":"m"}' });
  assert.equal(ok.status, 200); assert.match(await ok.text(), /pong/);
  assert.equal(seen[0].url, '/v1/chat/completions'); assert.equal(seen[0].headers['anthropic-workspace-id'], 'wrkspc_9'); assert.equal(seen[0].headers.authorization, 'Bearer key-1'); assert.equal(seen[0].body, '{"model":"m"}');
  assert.equal((await fetch(`${base}/other`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/chat/completions`)).status, 404);
  proxy.close(); upstream.close();
  const dead = createFastProxy({ upstream: 'http://127.0.0.1:1/v1', workspace: () => null });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  assert.equal((await fetch(`http://127.0.0.1:${dead.address().port}/chat/completions`, { method: 'POST', body: '{}' })).status, 502);
  dead.close();
});

test('chat transcripts the runner ingested are claimed and derived; with scopes on only chats open to everyone are', { skip: (!componentDir('runner') || !componentDir('upkeep') || !componentDir('push')) && 'packages not installed' }, async () => {
  const dir = tmp(), home = path.join(dir, 'home');
  mkdirSync(path.join(dir, 'config'), { recursive: true });
  writeFileSync(path.join(dir, 'config/registry.json'), JSON.stringify({ version: 1, accounts: {}, scopes: { 'personal:sam': { kind: 'personal', owner: 'sam' }, everyone: { kind: 'group', everyone: true }, founders: { kind: 'group', members: ['sam'] } } }));
  writeFileSync(path.join(dir, 'config/config.json'), JSON.stringify({ scopes: { enabled: true, registryFile: path.join(dir, 'config/registry.json') } }));
  const c = resolveInstance({ name: 'lab', components: ['linknotes', 'runner', 'sources', 'push', 'upkeep'], scope: { default: 'lab' }, paths: { state: './state', config: './config' },
    runner: { env: { TOPHAT_CONFIG: path.join(dir, 'config/config.json') } }, intake: { everySeconds: 600, model: { provider: 'stub' } } }, { dir, home });
  const wdb = path.join(dir, 'state/webchat/events.sqlite');
  mkdirSync(path.dirname(wdb), { recursive: true });
  const db = new DatabaseSync(wdb);
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, session_id TEXT, scope TEXT)');
  const ins = db.prepare('INSERT INTO conversations VALUES (?, ?, ?)');
  for (const [id, scope] of [['c-open', 'everyone'], ['c-legacy', 'legacy'], ['c-personal', 'personal:sam'], ['c-founders', 'founders']]) ins.run(id, `s-${id}`, scope);
  db.close();
  const { answer, closeAll } = await import(path.join(componentDir('runner'), 'store/memory.mjs'));
  const dbf = path.join(dir, 'state/runner/memory.sqlite'), env = { TOPHAT_SCOPE: 'lab' };
  const rec = (thread, n) => ({ source: 'webchat', account: '', native_id: `${thread}/${n}`, revision: '1', role: 'owner', author: 'owner', thread: `s-${thread}`, text: `Dana Okafor ordered the Lab Boiler (${thread}).`,
    occurred_at: '2026-11-08T10:00:00Z', available_at: '2026-11-08T10:00:00Z', policy: { model: 'allow', publish: 'none' } });
  const got = answer('ingest', { records: ['c-open', 'c-legacy', 'c-personal', 'c-founders', 'c-ghost'].map((t) => rec(t, 1)) }, { db: dbf, env });
  assert.equal(got.code, 0, JSON.stringify(got.result));
  const r = await runIntake(c, { now: Date.parse('2026-11-08T12:00:00Z') });
  assert.deepEqual(r.transcripts, { claimed: 2, held: 3 });
  assert.equal(r.intake.derived, 2, JSON.stringify(r));
  closeAll();
  const d2 = new DatabaseSync(dbf, { readOnly: true });
  const state = d2.prepare("SELECT thread, processed_batch IS NOT NULL AS done, json_extract(locator,'$.pusher') AS pusher FROM raw_data WHERE source='webchat' ORDER BY thread").all();
  d2.close();
  assert.deepEqual(state.map((x) => [x.thread, x.done, x.pusher]), [['s-c-ghost', 0, null], ['s-c-founders', 0, null], ['s-c-legacy', 1, 'lab-intake'], ['s-c-open', 1, 'lab-intake'], ['s-c-personal', 0, null]].sort((a, b) => a[0].localeCompare(b[0])));
});
