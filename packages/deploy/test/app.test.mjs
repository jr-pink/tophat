// The assembled app components (packages/runner, packages/webchat) as an instance runs them: the assembly record
// matches the files, the runner completes a turn against a local fake model provider, and `tophat start` boots the
// webchat on scratch state and answers /api/health. Offline: no model API is called; HOME and every state directory
// are a temporary directory.
//
// The runner and webchat need their npm dependencies. They are found in the package's own node_modules, the
// workspace's, or the directories named by TOPHAT_RUNNER_NODE_MODULES / TOPHAT_WEBCHAT_NODE_MODULES; without them
// those tests skip and say so.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACE } from '../src/components.mjs';
import { plan, start } from '../src/start.mjs';
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

/** A scratch copy of the app packages with their dependencies linked in, so nothing is written inside the workspace. */
function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-app-test-'));
  const pk = path.join(dir, 'packages');
  for (const name of ['runner', 'webchat']) {
    cpSync(path.join(WORKSPACE, 'packages', name), path.join(pk, name), { recursive: true, filter: (s) => !/\/(node_modules|build|\.svelte-kit)(\/|$)/.test(s) });
  }
  // A real node_modules directory whose entries link to the dependencies: build tools write their temp files into
  // node_modules itself, and those must land in the scratch copy, not in the directory the dependencies came from.
  const link = (from, to) => { mkdirSync(to); for (const e of readdirSync(from)) if (!e.startsWith('.')) symlinkSync(path.join(from, e), path.join(to, e)); };
  if (runnerModules) link(runnerModules, path.join(pk, 'runner/node_modules'));
  if (webchatModules) link(webchatModules, path.join(pk, 'webchat/node_modules'));
  mkdirSync(path.join(dir, 'home'));
  return dir;
}


test('runner: one turn against a local fake model provider', { skip: !runnerModules && 'runner dependencies not installed (npm install, or TOPHAT_RUNNER_NODE_MODULES)' }, async () => {
  const dir = scratch();
  try {
    const { startFakeProvider, textReply } = await import(path.join(dir, 'packages/runner/rev5/fake-provider.mjs'));
    const fake = await startFakeProvider({ reply: () => textReply('hello from the fake provider'), key: 'fake-key-123' });
    writeFileSync(path.join(dir, 'key'), 'fake-key-123\n', { mode: 0o600 });
    const state = path.join(dir, 'state');
    const env = { PATH: process.env.PATH, HOME: path.join(dir, 'home'), TOPHAT_RUNNER_API_BASE: fake.url, TOPHAT_RUNNER_API_KEY_FILE: path.join(dir, 'key'), TOPHAT_RUNNER_MODEL: 'fake-model',
      TOPHAT_STATE_DIR: state, TOPHAT_CONFIG_DIR: path.join(dir, 'config'), TOPHAT_RUNNER_DB: path.join(state, 'runner/memory.sqlite'), TOPHAT_RUNNER_RUNNER_DB: path.join(state, 'runner/runner.sqlite') };
    mkdirSync(path.join(state, 'workspace'), { recursive: true });
    const child = spawn(process.execPath, [path.join(dir, 'packages/runner/rev6/pull/pull.mjs'), '--session-id', '11111111-1111-4111-8111-111111111111', '--model', 'fake-model', '--permission-mode', 'bypassPermissions', '--cwd', path.join(state, 'workspace')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    for (let i = 0; i < 80 && !/"type":"result"/.test(out); i++) await new Promise((r) => setTimeout(r, 250));
    child.stdin.end(); child.kill();
    await fake.close?.();
    const result = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'result');
    assert.ok(result, `no result event; stderr:\n${err.slice(0, 2000)}`);
    assert.equal(result.subtype, 'success');
    assert.equal(result.result, 'hello from the fake provider');
    assert.equal(fake.requests.length, 1);
    // Only the OS's own caches may appear under HOME (a python child's bytecode cache); no config or state of ours.
    assert.deepEqual(readdirSync(path.join(dir, 'home')).filter((n) => n !== 'Library'), [], 'the runner wrote no config or state under HOME');
    assert.deepEqual(existsSync(path.join(dir, 'home/Library')) ? readdirSync(path.join(dir, 'home/Library')) : [], existsSync(path.join(dir, 'home/Library')) ? ['Caches'] : []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tophat start boots the webchat from an instance config and answers /api/health', { skip: (!webchatModules || !runnerModules) && 'webchat or runner dependencies not installed (npm install, or TOPHAT_WEBCHAT_NODE_MODULES / TOPHAT_RUNNER_NODE_MODULES)', timeout: 180_000 }, async () => {
  const dir = scratch();
  let child;
  try {
    const wc = path.join(dir, 'packages/webchat');
    const b = spawnSync(process.execPath, [path.join(wc, 'node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner', '--logLevel', 'error'], { cwd: wc, encoding: 'utf8', env: { ...process.env, HOME: path.join(dir, 'home') } });
    assert.equal(b.status, 0, `vite build failed:\n${(b.stderr || '').slice(-3000)}`);
    const port = await freePort(); // the OS picks a free one: a fixed or random range collides with other servers on a shared machine
    const cfg = path.join(dir, 'tophat.instance.json');
    writeFileSync(cfg, JSON.stringify({ name: 'demo', owner: { label: 'Sam' }, components: ['linknotes', 'runner', 'webchat', 'deploy'], ports: { webchat: port }, paths: { state: './state', config: './config' } }));
    const env = { ...process.env, HOME: path.join(dir, 'home') };
    const p = plan({ configFile: cfg, root: dir, env });
    assert.equal(p.env.PRODUCT_NAME, 'demo');
    assert.equal(p.env.TOPHAT_STATE_DIR, path.join(dir, 'state'));
    const foreign = Object.keys(p.env).filter((k) => !/^(TOPHAT_|WEBCHAT_)/.test(k) && !['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'USER', 'SHELL', 'NODE_OPTIONS', 'PRODUCT_NAME', 'HOST', 'PORT', 'ORIGIN', 'UV_THREADPOOL_SIZE'].includes(k));
    assert.deepEqual(foreign, [], 'the child environment is built from the instance config, not inherited');
    child = await start({ configFile: cfg, root: dir, env, foreground: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    let health = null;
    for (let i = 0; i < 120 && !health; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (child.exitCode !== null) break;
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); health = { status: r.status, body: await r.json() }; } catch { /* not up yet */ }
    }
    assert.ok(health, `no health answer; log:\n${log.slice(0, 3000)}`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.product, 'demo');
    assert.ok(existsSync(path.join(dir, 'state/webchat/events.sqlite')), 'the store is under the instance state directory');
    assert.ok(existsSync(path.join(dir, 'config/secrets/webchat-session-secret')));
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); }); }
    rmSync(dir, { recursive: true, force: true });
  }
});
