// A restart hands a running chat over; it never ends it. Real processes end to end: `tophat start` on scratch state, a
// chat whose model asks for a long shell command, SIGTERM to the server while that command runs, a second server on the
// same state, and the same runner child (under packages/webchat/scripts/relay.mjs) finishing the turn: the command's
// output lands in the chat and the model is asked exactly once more. Until 2026-11-08 the assembled direct provider
// lacked `handover: true`, so runner.js spawned its children as the server's own and every restart ended them.
// TOPHAT_HANDOVER_SLEEP_S sets how long the command runs (default 6). Offline: packages/runner/rev5/fake-provider.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACE } from '../src/components.mjs';
import { start } from '../src/start.mjs';

const RUNNER = path.join(WORKSPACE, 'packages/runner'), WEBCHAT = path.join(WORKSPACE, 'packages/webchat');
const has = (dir, dep) => existsSync(path.join(dir, dep, 'package.json'));
function modulesFor(pkg, deps, envName) {
  for (const d of [process.env[envName], path.join(pkg, 'node_modules'), path.join(WORKSPACE, 'node_modules')]) if (d && deps.every((x) => has(d, x))) return d;
  return null;
}
const runnerModules = existsSync(RUNNER) ? modulesFor(RUNNER, ['linkedom', '@mozilla/readability'], 'TOPHAT_RUNNER_NODE_MODULES') : null;
const webchatModules = existsSync(WEBCHAT) ? modulesFor(WEBCHAT, ['@sveltejs/kit', 'svelte', 'vite', '@sveltejs/adapter-node', '@tailwindcss/vite'], 'TOPHAT_WEBCHAT_NODE_MODULES') : null;
const SLEEP_S = Number(process.env.TOPHAT_HANDOVER_SLEEP_S || 6);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-handover-'));
  const pk = path.join(dir, 'packages');
  for (const name of ['runner', 'webchat']) cpSync(path.join(WORKSPACE, 'packages', name), path.join(pk, name), { recursive: true, filter: (s) => !/\/(node_modules|build[^/]*|\.svelte-kit)(\/|$)/.test(s) });
  const link = (from, to) => { mkdirSync(to, { recursive: true }); for (const e of readdirSync(from)) if (!e.startsWith('.')) { try { symlinkSync(path.join(from, e), path.join(to, e)); } catch { /* exists */ } } };
  if (runnerModules) link(runnerModules, path.join(pk, 'runner/node_modules'));
  if (webchatModules) link(webchatModules, path.join(pk, 'webchat/node_modules'));
  const scope = path.join(pk, 'runner/node_modules/@tophat-md');
  mkdirSync(scope, { recursive: true });
  try { symlinkSync(path.join(WORKSPACE, 'packages', 'linknotes'), path.join(scope, 'linknotes')); } catch { /* exists */ }
  mkdirSync(path.join(dir, 'home'));
  return dir;
}

function session(secretFile) {
  const secret = readFileSync(secretFile, 'utf8').trim();
  const payload = `${Date.now() + 3_600_000}.${randomBytes(9).toString('base64url')}`;
  return `tophat_webchat_session=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

/** Relay manifests (scripts/relay.mjs writes <id>.json beside its socket). */
const relays = (dir) => {
  const rdir = path.join(dir, 'state/webchat/relays');
  return (existsSync(rdir) ? readdirSync(rdir) : []).filter((n) => n.endsWith('.json'))
    .map((n) => { try { return JSON.parse(readFileSync(path.join(rdir, n), 'utf8')); } catch { return null; } }).filter(Boolean);
};

test('a restart hands a running chat child to the next server, which finishes its turn', { skip: (!webchatModules || !runnerModules) && 'webchat or runner dependencies not installed (TOPHAT_WEBCHAT_NODE_MODULES / TOPHAT_RUNNER_NODE_MODULES)', timeout: 300_000 + SLEEP_S * 1000 }, async () => {
  const dir = scratch();
  const servers = [];
  let fake = null;
  try {
    const wc = path.join(dir, 'packages/webchat');
    const b = spawnSync(process.execPath, [path.join(wc, 'node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner', '--logLevel', 'error'], { cwd: wc, encoding: 'utf8', env: { ...process.env, HOME: path.join(dir, 'home') } });
    assert.equal(b.status, 0, `vite build failed:\n${(b.stderr || '').slice(-3000)}`);

    const { startFakeProvider, textReply, toolReply, toolResultsOf } = await import(path.join(dir, 'packages/runner/rev5/fake-provider.mjs'));
    const marker = `woke-${randomBytes(4).toString('hex')}`;
    fake = await startFakeProvider({ key: 'fake-key-123', reply: (body) => {
      const results = toolResultsOf(body);
      if (!results.length) return toolReply('shell', { command: `sleep ${SLEEP_S}; echo ${marker}` });
      return textReply(`the command said: ${JSON.stringify(results.map((r) => r.content))}`);
    } });
    writeFileSync(path.join(dir, 'model-key'), 'fake-key-123\n', { mode: 0o600 });
    const port = 47700 + Math.floor(Math.random() * 500);
    const cfg = path.join(dir, 'tophat.instance.json');
    writeFileSync(cfg, JSON.stringify({ name: 'handover', owner: { label: 'Sam' }, scope: { default: 'sam', groups: [] },
      components: ['linknotes', 'runner', 'webchat', 'deploy'], ports: { webchat: port }, paths: { state: './state', config: './config' },
      models: { chat: { model: 'fake-model', baseUrl: fake.url, credential: { file: path.join(dir, 'model-key') } } } }));
    const env = { ...process.env, HOME: path.join(dir, 'home') };
    const base = `http://127.0.0.1:${port}`;

    async function boot() {
      const child = await start({ configFile: cfg, root: dir, env, foreground: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const s = { child, log: '' };
      child.stdout.on('data', (d) => { s.log += d; }); child.stderr.on('data', (d) => { s.log += d; });
      servers.push(s);
      for (let i = 0; i < 160; i++) {
        await wait(250);
        if (child.exitCode !== null) break;
        try { if ((await (await fetch(`${base}/api/health`)).json())?.ok) return s; } catch { /* not up yet */ }
      }
      throw new Error(`server did not come up; log:\n${s.log.slice(-3000)}`);
    }
    const stop = (s) => new Promise((r) => { if (s.child.exitCode !== null) return r(); s.child.once('exit', r); s.child.kill('SIGTERM'); });

    const a = await boot();
    const cookie = session(path.join(dir, 'config/secrets/webchat-session-secret'));
    const { CONTRACT_VERSION, SCHEMA_HASH } = await import(path.join(dir, 'packages/webchat/src/lib/core/contract.js'));
    const conversation = '33333333-3333-4333-8333-333333333333';
    let seq = 0;
    const action = (op, payload) => ({ contract_version: CONTRACT_VERSION, schema_hash: SCHEMA_HASH, op, conversation_id: conversation,
      payload, action_id: randomBytes(8).toString('hex'), device_id: 'test-device', device_seq: ++seq, at: new Date().toISOString() });
    const post = (body) => fetch(`${base}/api/actions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(action('conversation.create', { title: 'long command' }))).status, 200);
    assert.equal((await post(action('message.send', { text: 'run the long command' }))).status, 200);

    // the model has asked for the command and the child is running it, under a relay
    let relay = null;
    for (let i = 0; i < 200 && !(relay && fake.requests.length >= 1); i++) { await wait(100); relay = relays(dir).find((m) => m.conversationId === conversation) || null; }
    assert.ok(relay?.childPid, `the child runs under a relay; relays ${JSON.stringify(relays(dir))}\nlog:\n${a.log.slice(-3000)}`);
    assert.equal(fake.requests.length, 1);
    await wait(1000);
    const pid = relay.childPid;

    await stop(a);
    assert.match(a.log, /handed 1 running child/, `A handed the child over on SIGTERM; log:\n${a.log.slice(-3000)}`);
    assert.ok(alive(pid), 'the child outlived the server that started it');

    const bsrv = await boot();
    await wait(500);
    assert.match(bsrv.log, /adopted 1 running child/, `B adopted it; log:\n${bsrv.log.slice(-3000)}`);
    assert.ok(alive(pid), 'B kept the same child');

    let events = [];
    for (let i = 0; i < 40 * (SLEEP_S + 30); i++) {
      const r = await fetch(`${base}/api/conversation/${conversation}`, { headers: { cookie } });
      if (r.status === 200) events = (await r.json()).events || [];
      if (events.some((e) => e.kind === 'assistant.message' && JSON.stringify(e.content).includes('the command said'))) break;
      await wait(25);
    }
    const reply = events.find((e) => e.kind === 'assistant.message' && JSON.stringify(e.content).includes('the command said'));
    assert.ok(reply, `the turn finished on B; kinds ${events.map((e) => e.kind).join(', ')}\nlog:\n${bsrv.log.slice(-3000)}`);
    assert.ok(JSON.stringify(reply.content).includes(marker), `the command's own output reached the model: ${JSON.stringify(reply.content).slice(0, 400)}`);
    assert.equal(fake.requests.length, 2, 'the model was asked once more, by the same child: nothing was re-run from the transcript');
    assert.equal(events.filter((e) => e.kind === 'message.user').length, 1, 'no "carry on" nudge was injected');
    await stop(bsrv);
  } finally {
    for (const s of servers) { try { s.child.kill('SIGKILL'); } catch { /* gone */ } }
    for (const m of relays(dir)) { try { process.kill(-m.childPid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(m.relayPid, 'SIGKILL'); } catch { /* gone */ } }
    try {
      for (const line of execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/u.exec(line);
        if (m && Number(m[1]) !== process.pid && m[2].includes(dir)) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch { /* gone */ } }
      }
    } catch { /* ps unavailable */ }
    await fake?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
