// tophat instance ship and the build-current pointer: a release never rebuilds the directory a server serves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flipPointer, missingClientFiles, pruneBuilds, shipLock, shipWebchat } from '../src/ship.mjs';
import { pointedBuild } from '../src/start.mjs';

const dirs = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp() { const d = mkdtempSync(path.join(os.tmpdir(), 'tophat-ship-')); dirs.push(d); return d; }
function fakeBuild(dir) { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'handler.js'), 'export const handler = () => {};\n'); }
function root() {
  const r = tmp(), webchat = path.join(r, 'packages', 'webchat');
  mkdirSync(webchat, { recursive: true });
  writeFileSync(path.join(webchat, 'package.json'), JSON.stringify({ name: '@tophat-md/webchat' }));
  fakeBuild(path.join(webchat, 'build'));
  const file = path.join(r, 'i.json');
  writeFileSync(file, JSON.stringify({ name: 'demo', owner: { label: 'Sam' }, components: ['linknotes', 'runner', 'webchat', 'deploy'], ports: { webchat: 47999 }, paths: { state: './state', config: './config' } }));
  return { r, webchat, file };
}

test('pointer: absent, or naming nothing with a handler, is null; a real build resolves', () => {
  const { webchat } = root();
  assert.equal(pointedBuild(webchat), null);
  writeFileSync(path.join(webchat, 'build-current'), 'build.nope\n');
  assert.equal(pointedBuild(webchat), null);
  fakeBuild(path.join(webchat, 'build.20261108-2100'));
  flipPointer(webchat, path.join(webchat, 'build.20261108-2100'));
  assert.equal(readFileSync(path.join(webchat, 'build-current'), 'utf8'), 'build.20261108-2100\n');
  assert.equal(pointedBuild(webchat), path.join(webchat, 'build.20261108-2100'));
});

test('ship builds into a fresh dir, leaves the served one alone, flips the pointer and HUPs serve.mjs by its health pid', async () => {
  const { r, webchat, file } = root();
  fakeBuild(path.join(webchat, 'build.20261108-1900'));
  flipPointer(webchat, path.join(webchat, 'build.20261108-1900'));
  const served = readFileSync(path.join(webchat, 'build.20261108-1900', 'handler.js'), 'utf8');
  let serving = 'build.20261108-1900'; const signals = [];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, build: serving, instance: '4242:1' }) });
  const now = new Date('2026-11-09T05:10:00Z');
  const r1 = await shipWebchat({ configFile: file, root: r, now, fetchImpl, timeoutMs: 2000,
    build: ({ out }) => { fakeBuild(out); return { ok: true }; },
    signal: (pid, s) => { signals.push([pid, s]); serving = 'build.20261109-051000'; } });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.deepEqual(signals, [[4242, 'SIGHUP']]);
  assert.equal(r1.build, 'build.20261109-051000');
  assert.equal(r1.reloaded, true);
  assert.equal(pointedBuild(webchat), path.join(webchat, 'build.20261109-051000'));
  assert.equal(readFileSync(path.join(webchat, 'build.20261108-1900', 'handler.js'), 'utf8'), served, 'the served build is untouched');
});

test('a pinned server (health build "build") is not HUPped: needs_restart', async () => {
  const { r, file } = root();
  const signals = [];
  const res = await shipWebchat({ configFile: file, root: r, fetchImpl: async () => ({ ok: true, json: async () => ({ build: 'build', instance: '7:1' }) }),
    build: ({ out }) => { fakeBuild(out); return { ok: true }; }, signal: (...a) => signals.push(a) });
  assert.equal(res.ok, true);
  assert.equal(res.needs_restart, true);
  assert.deepEqual(signals, []);
});

test('a failed build changes nothing', async () => {
  const { r, webchat, file } = root();
  const res = await shipWebchat({ configFile: file, root: r, fetchImpl: async () => { throw new Error('down'); }, build: () => ({ ok: false, status: 1 }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'build_failed');
  assert.equal(existsSync(path.join(webchat, 'build-current')), false);
});

test('prune keeps the newest N and every protected build, never `build`', () => {
  const { webchat } = root();
  const names = ['build.20261101-0000', 'build.20261102-0000', 'build.20261103-0000', 'build.20261104-0000', 'build.20261105-0000'];
  names.forEach((n, i) => { fakeBuild(path.join(webchat, n)); const t = new Date(Date.UTC(2026, 10, 1 + i)); utimesSync(path.join(webchat, n), t, t); });
  const removed = pruneBuilds(webchat, { keep: 2, protect: [path.join(webchat, 'build.20261101-0000')] });
  assert.deepEqual(removed.sort(), ['build.20261102-0000', 'build.20261103-0000']);
  assert.ok(existsSync(path.join(webchat, 'build')));
  assert.ok(existsSync(path.join(webchat, 'build.20261101-0000')));
});

// A build whose server half came from another build (two ships sharing one .svelte-kit, 2026-11-10): the page named a
// bundle the client dir did not have, and every tab showed the reload prompt.
function halfBuild(out, named, present) {
  fakeBuild(out);
  mkdirSync(path.join(out, 'server', 'chunks'), { recursive: true });
  mkdirSync(path.join(out, 'client', '_app', 'immutable'), { recursive: true });
  writeFileSync(path.join(out, 'server', 'chunks', 'manifest.js-X.js'), `const m = { client: { start: "_app/immutable/${named}" } };\n`);
  writeFileSync(path.join(out, 'client', '_app', 'immutable', present), '');
}

test('missingClientFiles names what the server manifest wants and the client lacks', () => {
  const d = tmp();
  halfBuild(path.join(d, 'whole'), 'bundle.A.js', 'bundle.A.js');
  halfBuild(path.join(d, 'mixed'), 'bundle.A.js', 'bundle.B.js');
  assert.deepEqual(missingClientFiles(path.join(d, 'whole')), []);
  assert.deepEqual(missingClientFiles(path.join(d, 'mixed')), ['_app/immutable/bundle.A.js']);
});

test('a mixed build is never pointed at', async () => {
  const { r, webchat, file } = root();
  const res = await shipWebchat({ configFile: file, root: r, fetchImpl: async () => { throw new Error('down'); },
    build: ({ out }) => { halfBuild(out, 'bundle.A.js', 'bundle.B.js'); return { ok: true }; } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'build_incomplete');
  assert.equal(existsSync(path.join(webchat, 'build-current')), false);
});

test('ships run one at a time; a dead holder\'s lock is taken over', async () => {
  const { webchat } = root();
  const first = await shipLock(webchat);
  assert.equal(await shipLock(webchat, { waitMs: 50, pollMs: 10 }), null, 'a live holder makes the second wait, then give up');
  first();
  const again = await shipLock(webchat, { waitMs: 50, pollMs: 10 });
  assert.ok(again); again();
  writeFileSync(path.join(webchat, 'build.ship.lock'), '999999\n');
  const stale = await shipLock(webchat, { waitMs: 50, pollMs: 10 });
  assert.ok(stale, 'a lock whose pid is gone does not block'); stale();
});
