// tophat instance start/stop/status/health and the release pointer, against a stand-in server (no webchat build, no
// model, no network beyond loopback). Everything is written under a temp state directory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { alive, healthInstance, release, running, startInstance, statusInstance, stopInstance } from '../src/service.mjs';
import { loadInstance } from '../src/instance.mjs';

const dirs = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function instance(port) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-service-'));
  dirs.push(dir);
  const file = path.join(dir, 'tophat.instance.json');
  writeFileSync(file, JSON.stringify({ name: 'demo', owner: { label: 'Sam' }, components: ['linknotes', 'runner', 'webchat', 'deploy'], ports: { webchat: port }, paths: { state: './state', config: './config' } }));
  // a stand-in for the webchat: it answers /api/health and exits on SIGTERM
  const server = path.join(dir, 'server.mjs');
  writeFileSync(server, `import { createServer } from 'node:http';\nconst s = createServer((q, r) => { r.writeHead(q.url === '/api/health' ? 200 : 404, { 'content-type': 'application/json' }); r.end(JSON.stringify({ ok: q.url === '/api/health', product: process.env.PRODUCT_NAME ?? null })); });\ns.listen(${port}, '127.0.0.1');\n`);
  mkdirSync(path.join(dir, 'state'), { recursive: true });
  return { dir, file, spec: { bin: process.execPath, args: [server], cwd: dir, env: { PATH: process.env.PATH, PRODUCT_NAME: 'demo', TOPHAT_BUILD_DIR: path.join(dir, 'build-1') } } };
}

test('start, status, health, stop, and the record that outlives neither', async () => {
  const port = 47700 + Math.floor(Math.random() * 500);
  const { dir, file, spec } = instance(port);
  const c = loadInstance(file);
  assert.equal(running(c), null);
  assert.equal((await statusInstance({ configFile: file })).running, false);
  const started = startInstance({ configFile: file, spec });
  assert.equal(started.ok, true);
  assert.ok(alive(started.pid));
  assert.equal(started.port, port);
  try {
    const again = startInstance({ configFile: file, spec });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'already_running');

    let health = null;
    for (let i = 0; i < 60 && !health?.ok; i++) { health = await healthInstance({ configFile: file }); if (!health.ok) await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(health.ok, true, JSON.stringify(health));
    const st = await statusInstance({ configFile: file });
    assert.equal(st.running, true);
    assert.equal(st.pid, started.pid);
    assert.equal(started.build, path.join(dir, 'build-1'));
    assert.ok(existsSync(st.log), 'the background process logs into the state directory');
    assert.equal(health.status, 200);
    assert.equal(health.body.product, 'demo');
  } finally {
    const stopped = await stopInstance({ configFile: file });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.equal(alive(started.pid), false);
  }
  assert.equal((await statusInstance({ configFile: file })).running, false);
  const again = await stopInstance({ configFile: file });
  assert.deepEqual([again.ok, again.stopped], [true, false]);
  const h = await healthInstance({ configFile: file, timeoutMs: 1000 });
  assert.equal(h.ok, false);
});

test('a record whose process is gone is stale, and never blocks the next start', async () => {
  const port = 48300 + Math.floor(Math.random() * 500);
  const { file, spec } = instance(port);
  const first = startInstance({ configFile: file, spec });
  process.kill(first.pid, 'SIGKILL');
  for (let i = 0; i < 50 && alive(first.pid); i++) await new Promise((r) => setTimeout(r, 50));
  const st = await statusInstance({ configFile: file });
  assert.equal(st.running, false);
  assert.equal(st.stale_record, true);
  const second = startInstance({ configFile: file, spec });
  assert.equal(second.ok, true);
  assert.notEqual(second.pid, first.pid);
  await stopInstance({ configFile: file });
});

test('the release pointer is the webchat build-current: read, flipped, and what status names', async () => {
  const port = await freePort();
  const { dir, file } = instance(port);
  const c = loadInstance(file);
  const root = path.join(dir, 'root'), webchat = path.join(root, 'packages', 'webchat');
  mkdirSync(webchat, { recursive: true });
  writeFileSync(path.join(webchat, 'package.json'), JSON.stringify({ name: '@tophat-md/webchat' }));
  assert.equal(release(c, null, { root }), null);
  const b7 = path.join(webchat, 'build.7');
  mkdirSync(b7); writeFileSync(path.join(b7, 'handler.js'), '');
  const set = release(c, b7, { root });
  assert.equal(set.build, b7);
  assert.equal(readFileSync(path.join(webchat, 'build-current'), 'utf8').trim(), 'build.7');
  assert.equal((await statusInstance({ configFile: file, root })).release, 'build.7');
});

const freePort = () => new Promise((ok, no) => { const s = net.createServer(); s.once('error', no); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
async function waitHealth(file) { let h = null; for (let i = 0; i < 100 && !h?.ok; i++) { h = await healthInstance({ configFile: file, timeoutMs: 500 }); if (!h.ok) await new Promise((r) => setTimeout(r, 50)); } return h; }

// A server answering /api/health the way serve.mjs does: its own pid in `instance`, the build directory it serves.
function standIn(dir, port, { product = 'demo', build = 'build.20261109-091351' } = {}) {
  const server = path.join(dir, `serve-${product}.mjs`);
  writeFileSync(server, `import { createServer } from 'node:http';\nconst s = createServer((q, r) => { r.writeHead(q.url === '/api/health' ? 200 : 404, { 'content-type': 'application/json' }); r.end(JSON.stringify({ ok: true, product: ${JSON.stringify(product)}, instance: process.pid + ':' + Date.now(), build: ${JSON.stringify(build)} })); });\ns.listen(${port}, '127.0.0.1');\nprocess.on('SIGTERM', () => process.exit(0));\n`);
  return server;
}

// 2026-11-09 01:13 PST: the deploy status command said running:false, pid null while the instance answered /api/health on
// its port with build.20261109-091351. The instance runs under its unit as `tophat start` (start.mjs), which never wrote
// the record file `instance status` read. Status comes from the live process now: who listens, its ancestry, its health.
test('status reports an instance it did not start: listener, ancestry and the serving build, with no record file', async () => {
  const port = await freePort();
  const { dir, file } = instance(port);
  const server = standIn(dir, port);
  // a wrapper process that starts serve.mjs as its child, the way `tophat start` does under a unit
  const wrapper = path.join(dir, 'wrapper.mjs');
  writeFileSync(wrapper, `import { spawn } from 'node:child_process';\nconst c = spawn(process.execPath, [${JSON.stringify(server)}], { stdio: 'ignore' });\nfor (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { c.kill('SIGTERM'); process.exit(0); });\n`);
  const w = spawn(process.execPath, [wrapper], { stdio: 'ignore' });
  try {
    const h = await waitHealth(file);
    assert.equal(h.ok, true, JSON.stringify(h));
    const servePid = Number(String(h.body.instance).split(':')[0]);
    assert.ok(!existsSync(path.join(dir, 'state', 'run', 'webchat.json')), 'no record was written');
    const st = await statusInstance({ configFile: file });
    assert.equal(st.running, true, JSON.stringify(st));
    assert.equal(st.pid, servePid, 'the pid is the process listening on the port');
    assert.equal(st.build, 'build.20261109-091351', 'the build is the one health says it serves');
    assert.equal(st.healthy, true);
    assert.ok(st.ancestry.some((a) => a.pid === w.pid), `the wrapper is in the ancestry: ${JSON.stringify(st.ancestry)}`);
    assert.equal(st.stale_record, false);
  } finally { w.kill('SIGTERM'); }
});

test('a neighbour on the port is not this instance: running:false, and the holder is named', async () => {
  const port = await freePort();
  const { dir, file } = instance(port);
  const n = spawn(process.execPath, [standIn(dir, port, { product: 'someone-else' })], { stdio: 'ignore' });
  try {
    const h = await waitHealth(file);
    assert.equal(h.ok, true);
    const st = await statusInstance({ configFile: file });
    assert.equal(st.running, false);
    assert.equal(st.pid, null);
    assert.equal(st.port_holder?.pid, n.pid, JSON.stringify(st));
  } finally { n.kill('SIGTERM'); }
});
