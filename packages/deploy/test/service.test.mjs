// tophat instance start/stop/status/health and the release pointer, against a stand-in server (no webchat build, no
// model, no network beyond loopback). Everything is written under a temp state directory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alive, healthInstance, release, releaseFile, running, startInstance, statusInstance, stopInstance } from '../src/service.mjs';
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
  assert.equal(statusInstance({ configFile: file }).running, false);
  const started = startInstance({ configFile: file, spec });
  assert.equal(started.ok, true);
  assert.ok(alive(started.pid));
  assert.equal(started.port, port);
  try {
    const again = startInstance({ configFile: file, spec });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'already_running');

    const st = statusInstance({ configFile: file });
    assert.equal(st.running, true);
    assert.equal(st.pid, started.pid);
    assert.equal(st.release, path.join(dir, 'build-1'));
    assert.ok(existsSync(st.log), 'the background process logs into the state directory');

    let health = null;
    for (let i = 0; i < 60 && !health?.ok; i++) { health = await healthInstance({ configFile: file }); if (!health.ok) await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(health.ok, true, JSON.stringify(health));
    assert.equal(health.status, 200);
    assert.equal(health.body.product, 'demo');
  } finally {
    const stopped = await stopInstance({ configFile: file });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.equal(alive(started.pid), false);
  }
  assert.equal(statusInstance({ configFile: file }).running, false);
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
  const st = statusInstance({ configFile: file });
  assert.equal(st.running, false);
  assert.equal(st.stale_record, true);
  const second = startInstance({ configFile: file, spec });
  assert.equal(second.ok, true);
  assert.notEqual(second.pid, first.pid);
  await stopInstance({ configFile: file });
});

test('the release pointer is read, written and used when no build is named', () => {
  const port = 48900 + Math.floor(Math.random() * 500);
  const { dir, file } = instance(port);
  const c = loadInstance(file);
  assert.equal(release(c), null);
  const set = release(c, path.join(dir, 'build-7'));
  assert.equal(set.build, path.join(dir, 'build-7'));
  assert.match(set.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(JSON.parse(readFileSync(releaseFile(c), 'utf8')).build, path.join(dir, 'build-7'));
  assert.equal(statusInstance({ configFile: file }).release, path.join(dir, 'build-7'));
  // with no build of its own, starting an instance whose release points nowhere says exactly that
  assert.throws(() => startInstance({ configFile: file }), /no webchat build|packages are not installed/);
});
