// One real chat turn end to end: `tophat start` on scratch state, a session minted from the instance's own generated
// secret, a message posted through the public action API, the runner child started by the webchat, and the reply read
// back out of the conversation. Offline: the only model is packages/runner/rev5/fake-provider.mjs on loopback, HOME
// and every state directory are temporary, and nothing of the owner's is read.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACE } from '../src/components.mjs';
import { start } from '../src/start.mjs';
import net from 'node:net';
/** A loopback port nothing listens on right now. */
const freePort = () => new Promise((ok, fail) => { const s = net.createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });


const RUNNER = path.join(WORKSPACE, 'packages/runner'), WEBCHAT = path.join(WORKSPACE, 'packages/webchat');
const has = (dir, dep) => existsSync(path.join(dir, dep, 'package.json'));
function modulesFor(pkg, deps, envName) {
  for (const d of [process.env[envName], path.join(pkg, 'node_modules'), path.join(WORKSPACE, 'node_modules')]) if (d && deps.every((x) => has(d, x))) return d;
  return null;
}
const runnerModules = existsSync(RUNNER) ? modulesFor(RUNNER, ['linkedom', '@mozilla/readability'], 'TOPHAT_RUNNER_NODE_MODULES') : null;
const webchatModules = existsSync(WEBCHAT) ? modulesFor(WEBCHAT, ['@sveltejs/kit', 'svelte', 'vite', '@sveltejs/adapter-node', '@tailwindcss/vite'], 'TOPHAT_WEBCHAT_NODE_MODULES') : null;

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-turn-'));
  const pk = path.join(dir, 'packages');
  for (const name of ['runner', 'webchat']) cpSync(path.join(WORKSPACE, 'packages', name), path.join(pk, name), { recursive: true, filter: (s) => !/\/(node_modules|build|\.svelte-kit)(\/|$)/.test(s) });
  // the store package the runner imports by name
  const scope = path.join(pk, 'runner/node_modules/@tophat-md');
  const link = (from, to) => { mkdirSync(to, { recursive: true }); for (const e of readdirSync(from)) if (!e.startsWith('.')) { try { symlinkSync(path.join(from, e), path.join(to, e)); } catch { /* exists */ } } };
  if (runnerModules) link(runnerModules, path.join(pk, 'runner/node_modules'));
  if (webchatModules) link(webchatModules, path.join(pk, 'webchat/node_modules'));
  mkdirSync(scope, { recursive: true });
  for (const p of ['linknotes']) { try { symlinkSync(path.join(WORKSPACE, 'packages', p), path.join(scope, p)); } catch { /* exists */ } }
  mkdirSync(path.join(dir, 'home'));
  return dir;
}

/** A session cookie, signed with the secret `tophat start` generated for this instance (webchat/src/lib/server/auth.js). */
function session(secretFile) {
  const secret = readFileSync(secretFile, 'utf8').trim();
  const payload = `${Date.now() + 3_600_000}.${randomBytes(9).toString('base64url')}`;
  return `tophat_webchat_session=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

test('a chat turn: post a message, the runner answers through the local fake provider', { skip: (!webchatModules || !runnerModules) && 'webchat or runner dependencies not installed (TOPHAT_WEBCHAT_NODE_MODULES / TOPHAT_RUNNER_NODE_MODULES)', timeout: 300_000 }, async () => {
  const dir = scratch();
  let child = null, fake = null;
  try {
    const wc = path.join(dir, 'packages/webchat');
    const b = spawnSync(process.execPath, [path.join(wc, 'node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner', '--logLevel', 'error'], { cwd: wc, encoding: 'utf8', env: { ...process.env, HOME: path.join(dir, 'home') } });
    assert.equal(b.status, 0, `vite build failed:\n${(b.stderr || '').slice(-3000)}`);

    const { startFakeProvider, textReply } = await import(path.join(dir, 'packages/runner/rev5/fake-provider.mjs'));
    fake = await startFakeProvider({ reply: () => textReply('the tank is ordered'), key: 'fake-key-123' });
    writeFileSync(path.join(dir, 'model-key'), 'fake-key-123\n', { mode: 0o600 });

    const port = await freePort(); // the OS picks a free one: a fixed or random range collides with other servers on a shared machine
    const cfg = path.join(dir, 'tophat.instance.json');
    writeFileSync(cfg, JSON.stringify({ name: 'demo', owner: { label: 'Sam' }, scope: { default: 'sam', groups: [] },
      components: ['linknotes', 'runner', 'webchat', 'deploy'], ports: { webchat: port }, paths: { state: './state', config: './config' },
      models: { chat: { model: 'fake-model', baseUrl: fake.url, credential: { file: path.join(dir, 'model-key') } } } }));

    const env = { ...process.env, HOME: path.join(dir, 'home') };
    child = await start({ configFile: cfg, root: dir, env, foreground: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const base = `http://127.0.0.1:${port}`;
    let health = null;
    for (let i = 0; i < 160 && !health; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (child.exitCode !== null) break;
      try { const r = await fetch(`${base}/api/health`); health = await r.json(); } catch { /* not up yet */ }
    }
    assert.ok(health?.ok, `no health answer; log:\n${log.slice(-3000)}`);

    // the secrets the instance made for itself, not any of the machine's
    const cookie = session(path.join(dir, 'config/secrets/webchat-session-secret'));
    const unauth = await fetch(`${base}/api/bootstrap`);
    assert.equal(unauth.status, 401, 'the API is closed without a session');
    const boot = await fetch(`${base}/api/bootstrap`, { headers: { cookie } });
    assert.equal(boot.status, 200, 'the minted session opens the API');

    const { CONTRACT_VERSION, SCHEMA_HASH } = await import(path.join(dir, 'packages/webchat/src/lib/core/contract.js'));
    const conversation = '22222222-2222-4222-8222-222222222222';
    const action = (op, payload) => ({ contract_version: CONTRACT_VERSION, schema_hash: SCHEMA_HASH, op, conversation_id: conversation,
      payload, action_id: randomBytes(8).toString('hex'), device_id: 'test-device', device_seq: 1, at: new Date().toISOString() });
    const post = (body) => fetch(`${base}/api/actions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const created = await post(action('conversation.create', { title: 'ordering' }));
    assert.equal(created.status, 200, `create refused: ${await created.text()}`);
    const sent = await post(action('message.send', { text: 'order the tank' }));
    assert.equal(sent.status, 200, `send refused: ${await sent.text()}`);

    let events = [];
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${base}/api/conversation/${conversation}`, { headers: { cookie } });
      if (r.status === 200) events = (await r.json()).events || [];
      if (events.some((e) => e.kind === 'assistant.message')) break;
      await new Promise((r2) => setTimeout(r2, 250));
    }
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes('message.user'), `no user message; kinds ${kinds.join(', ')}\n${log.slice(-2000)}`);
    const reply = events.find((e) => e.kind === 'assistant.message');
    assert.ok(reply, `no assistant message; kinds ${kinds.join(', ')}\nlog:\n${log.slice(-4000)}`);
    const text = JSON.stringify(reply.content);
    assert.match(text, /the tank is ordered/);
    assert.ok(fake.requests.length >= 1, 'the fake provider was called');
    // the turn went into this instance's own state, nowhere else
    assert.ok(existsSync(path.join(dir, 'state/webchat/events.sqlite')));
    // memory is wired too: the runner's replica exists and holds this chat as one work item
    assert.ok(existsSync(path.join(dir, 'state/runner/memory.sqlite')), 'the runner opened its linknotes replica');
    const { answer } = await import(path.join(dir, 'packages/runner/store/memory.mjs'));
    const work = answer('tasks', { op: 'list' }, { db: path.join(dir, 'state/runner/memory.sqlite'), env: { TOPHAT_SCOPE: 'sam' } });
    assert.equal(work.code, 0, JSON.stringify(work.result));
    // one work item per runner session, owned by the chat and bound to it; the runner awaits its creation before the
    // first model request, so it exists by the time any reply does (no polling: a missing item is a runner bug)
    const chatWork = work.result.tasks.filter((w) => w.owner_kind === 'chat' && w.bindings.some((b) => b.source === 'chat-goal'));
    assert.equal(chatWork.length, 1, `chat work items: ${JSON.stringify(work.result.tasks)}\nlog:\n${log.slice(-3000)}`);
    // the title is the owner's words, without the runtime-clock block the webchat appends to them
    assert.equal(chatWork[0].title, 'Chat: order the tank');
    assert.deepEqual(readdirSync(path.join(dir, 'home')).filter((n) => n !== 'Library'), [], 'nothing of ours was written under HOME');
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); }); }
    await fake?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
