// tophat update against a real temp upstream and a fork clone (real git), with npm, launchctl, ship, the UI check and the fixer
// injected: the fork only moves forward by one merge per release, local work is committed never lost, and anything that fails leaves
// the live checkout untouched and reaches the fixer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixerBrief, latestTag, run, update } from '../src/update.mjs';
import { decodePng, flatness, pixelDiff } from '../src/update-ui.mjs';
import { instanceJobs, resolveInstance, serviceUnit } from '../src/instance.mjs';

// No user or system git config: signing, hooks and default branch names of the machine running the suite stay out.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
const dirs = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tophat-update-')); dirs.push(d); return d; };
const git = (cwd, ...args) => { const r = run('git', args, { cwd }); if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };

/** An upstream at v1.0.0, a fork cloned from it, and an instance file whose state lives in the temp dir. */
function world({ update: u } = {}) {
  const t = tmp(), up = path.join(t, 'upstream'), fork = path.join(t, 'fork');
  mkdirSync(up);
  git(up, 'init', '-q', '-b', 'main');
  put(up, 'package.json', '{"name":"tophat-workspace"}\n'); put(up, 'package-lock.json', '{}\n');
  put(up, 'packages/core/lib.mjs', 'export const answer = 1;\n'); put(up, 'README.md', 'tophat\n'); put(up, '.gitignore', 'node_modules/\n');
  put(up, 'packages/webchat/package.json', '{"name":"@tophat-md/webchat"}\n');
  git(up, 'add', '-A'); git(up, 'commit', '-q', '-m', 'release 1.0.0'); git(up, 'tag', 'v1.0.0');
  git(t, 'clone', '-q', up, fork);
  put(fork, 'node_modules/dep/index.js', 'module.exports = 1;\n');
  const file = path.join(t, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'demo', owner: { label: 'Sam' }, components: ['linknotes', 'runner', 'webchat', 'deploy'], ports: { webchat: 47991 }, paths: { state: './state', config: './config' }, ...(u !== undefined ? { update: u } : {}) }));
  const release = (version, rel, text) => { put(up, rel, text); git(up, 'add', '-A'); git(up, 'commit', '-q', '-m', `release ${version}`); git(up, 'tag', `v${version}`); };
  return { t, up, fork, file, release, state: path.join(t, 'state') };
}

/** Injected deps: real git, everything else recorded and answered. */
function fakes({ testStatus = 0, flaky = false, health = true, ui = { ok: true, mode: 'http', problems: [] } } = {}) {
  const calls = [], wakes = [];
  const deps = {
    run: (cmd, args, o = {}) => {
      if (cmd === 'git') return run(cmd, args, o);
      calls.push({ cmd, args, cwd: o.cwd });
      const again = cmd === process.execPath && args.includes('--test');
      const r = (cmd === 'npm' && args[0] === 'test') || again
        ? (testStatus && !(again && flaky) ? { status: 1, stdout: `ok 2 - the composer types\nnot ok 3 - the sidebar folds\n  ---\n  location: '${o.cwd}/packages/webchat/test/sidebar.test.mjs:12:3'\n  error: 'timed out'\n  ...\n# fail 1\n`, stderr: '' } : { status: 0, stdout: '# pass 9\n', stderr: '' })
        : cmd === process.execPath && args.includes('ship') ? { status: 0, stdout: '{"ok":true,"build":"build.x"}', stderr: '' } : { status: 0, stdout: '', stderr: '' };
      if (o.log) { mkdirSync(path.dirname(o.log), { recursive: true }); writeFileSync(o.log, r.stdout); }
      return r;
    },
    fetch: async () => ({ ok: health, json: async () => ({ ok: health, build: 'build.x' }) }),
    wake: async (f) => { wakes.push(f); return { posted: true, conversation: 'c1' }; },
    ui: async () => ui, build: () => null, sleep: async () => {}, healthTimeoutMs: 0, platform: 'darwin',
  };
  return { deps, calls, wakes };
}

test('current: nothing to do, and --check reports current, latest and behind', async () => {
  const w = world(), f = fakes();
  const r = await update({ configFile: w.file, root: w.fork, deps: f.deps });
  assert.equal(r.status, 'current'); assert.equal(r.ok, true);
  w.release('1.0.1', 'packages/core/lib.mjs', 'export const answer = 2;\n');
  const c = await update({ configFile: w.file, root: w.fork, check: true, deps: f.deps });
  assert.deepEqual([c.status, c.current, c.latest, c.behind], ['behind', 'v1.0.0', 'v1.0.1', 1]);
  assert.equal(git(w.fork, 'rev-parse', 'HEAD'), git(w.up, 'rev-parse', 'v1.0.0'), 'a check never moves the branch');
  assert.equal(f.calls.length, 0);
});

test('a new release is merged into the fork (one merge commit, local commit kept), checked in staging, then fast-forwarded, shipped and restarted', async () => {
  const w = world(), f = fakes();
  put(w.fork, 'packages/core/mine.mjs', 'export const mine = true;\n'); git(w.fork, 'add', '-A'); git(w.fork, 'commit', '-q', '-m', 'local: my change');
  const mine = git(w.fork, 'rev-parse', 'HEAD');
  w.release('1.0.1', 'packages/core/lib.mjs', 'export const answer = 2;\n');
  w.release('1.0.10', 'README.md', 'tophat 1.0.10\n');
  const r = await update({ configFile: w.file, root: w.fork, deps: f.deps });
  assert.equal(r.status, 'updated', JSON.stringify(r));
  const head = git(w.fork, 'rev-parse', 'HEAD');
  assert.deepEqual(git(w.fork, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1), [mine, git(w.up, 'rev-parse', 'v1.0.10')], 'one merge: the fork commit and the newest tag');
  assert.equal(readFileSync(path.join(w.fork, 'packages/core/lib.mjs'), 'utf8'), 'export const answer = 2;\n');
  assert.ok(existsSync(path.join(w.fork, 'packages/core/mine.mjs')));
  assert.equal(git(w.fork, 'symbolic-ref', '--short', 'HEAD'), 'main', 'the branch moved, not a detached HEAD');
  assert.equal(r.to, head); assert.equal(r.from, mine);
  const testCall = f.calls.find((c) => c.cmd === 'npm' && c.args[0] === 'test');
  assert.ok(testCall && testCall.cwd !== w.fork && testCall.cwd.startsWith(path.join(w.state, 'update', 'v1.0.10-')), 'tests run in the staging worktree');
  assert.ok(f.calls.some((c) => c.cmd === 'cp' && c.args[0] === '-c'), 'same lock: node_modules are cloned, not installed');
  assert.ok(!f.calls.some((c) => c.cmd === 'npm' && c.args[0] === 'ci'));
  assert.ok(f.calls.some((c) => c.args.includes('ship') && c.cwd === w.fork));
  assert.ok(f.calls.some((c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart' && c.args.at(-1).endsWith('/md.tophat.demo')));
  assert.equal(git(w.fork, 'worktree', 'list').split('\n').length, 1, 'the staging worktree is removed after success');
  assert.equal(JSON.parse(readFileSync(path.join(w.state, 'update', 'last.json'), 'utf8')).status, 'updated');
  assert.equal((await update({ configFile: w.file, root: w.fork, deps: f.deps })).status, 'current');
});

test('uncommitted local work is committed before the update (never stashed or lost); ship state is never committed', async () => {
  const w = world(), f = fakes();
  put(w.fork, 'README.md', 'tophat, with my notes\n'); put(w.fork, 'packages/core/new.mjs', 'export {};\n');
  put(w.fork, 'packages/webchat/build-current', 'build.20261113\n'); put(w.fork, 'packages/webchat/build.20261113/handler.js', '//\n');
  w.release('1.0.1', 'packages/core/lib.mjs', 'export const answer = 2;\n');
  const r = await update({ configFile: w.file, root: w.fork, deps: f.deps });
  assert.equal(r.status, 'updated', JSON.stringify(r));
  assert.match(git(w.fork, 'log', '--format=%s'), /local: snapshot before update to v1\.0\.1/);
  assert.equal(readFileSync(path.join(w.fork, 'README.md'), 'utf8'), 'tophat, with my notes\n');
  assert.ok(git(w.fork, 'ls-files').split('\n').includes('packages/core/new.mjs'));
  assert.ok(!git(w.fork, 'ls-files').includes('packages/webchat/build'), 'build dirs and the pointer stay untracked');
  assert.ok(existsSync(path.join(w.fork, 'packages/webchat/build.20261113/handler.js')));
});

test('a conflict leaves the live checkout untouched, the staging tree with its markers, and wakes the fixer; a resumed fix applies', async () => {
  const w = world(), f = fakes();
  put(w.fork, 'packages/core/lib.mjs', 'export const answer = 42;\n'); git(w.fork, 'commit', '-q', '-am', 'local: my answer');
  const before = git(w.fork, 'rev-parse', 'HEAD');
  w.release('1.0.1', 'packages/core/lib.mjs', 'export const answer = 2;\n');
  const r = await update({ configFile: w.file, root: w.fork, deps: f.deps });
  assert.equal(r.ok, false); assert.equal(r.step, 'merge');
  assert.deepEqual(r.files, ['packages/core/lib.mjs']);
  assert.equal(git(w.fork, 'rev-parse', 'HEAD'), before); assert.equal(git(w.fork, 'status', '--porcelain'), '');
  assert.match(readFileSync(path.join(r.staging, 'packages/core/lib.mjs'), 'utf8'), /<<<<<<<[\s\S]*>>>>>>>/);
  assert.equal(f.wakes.length, 1); assert.equal(f.wakes[0].staging, r.staging);
  const brief = fixerBrief(f.wakes[0], { configFile: w.file, root: w.fork });
  assert.match(brief, /^\[Automated event from tophat update/); assert.ok(brief.includes(`--resume ${r.staging}`)); assert.match(brief, /Conflicted files: packages\/core\/lib\.mjs/);
  assert.equal(JSON.parse(readFileSync(path.join(w.state, 'update', 'last.json'), 'utf8')).status, 'failed');
  // the daily run meanwhile: the staging tree is being fixed, so it is left alone and the fixer (already reached) is not asked again
  const busy = await update({ configFile: w.file, root: w.fork, deps: f.deps });
  assert.equal(busy.status, 'fix_in_progress'); assert.equal(f.wakes.length, 1);
  // the fixer resolves and commits in staging, then resumes
  put(r.staging, 'packages/core/lib.mjs', 'export const answer = 42; // kept, upstream said 2\n');
  git(r.staging, 'add', '-A'); git(r.staging, 'commit', '-q', '--no-edit');
  const done = await update({ configFile: w.file, root: w.fork, resume: r.staging, deps: f.deps });
  assert.equal(done.status, 'updated', JSON.stringify(done));
  assert.equal(readFileSync(path.join(w.fork, 'packages/core/lib.mjs'), 'utf8'), 'export const answer = 42; // kept, upstream said 2\n');
  assert.equal(git(w.fork, 'merge-base', '--is-ancestor', 'v1.0.1', 'HEAD'), '');
  assert.ok(!existsSync(r.staging));
});

test('a failing test leaves live untouched and hands the log tail to the fixer; update.fixer false records without waking', async () => {
  const w = world(), f = fakes({ testStatus: 1 });
  w.release('1.0.1', 'packages/core/lib.mjs', 'export const answer = 2;\n');
  const before = git(w.fork, 'rev-parse', 'HEAD');
  const r = await update({ configFile: w.file, root: w.fork, deps: f.deps });
  assert.deepEqual([r.ok, r.step], [false, 'test']);
  assert.match(r.tail, /not ok 3 - the sidebar folds\n {2}location: .*\n {2}error: 'timed out'/); assert.doesNotMatch(r.tail, /ok 2 - the composer/, 'the tail is the failures, not the end of the log');
  assert.ok(f.calls.some((c) => c.args.includes('--test') && c.args.at(-1).endsWith('packages/webchat/test/sidebar.test.mjs')), 'the failing file got one more run');
  assert.equal(git(w.fork, 'rev-parse', 'HEAD'), before);
  assert.ok(!f.calls.some((c) => c.args.includes('ship')));
  assert.equal(f.wakes.length, 1); assert.match(fixerBrief(f.wakes[0], { configFile: w.file, root: w.fork }), /failed at the test step; the live checkout is untouched/);
  const q = world({ update: { fixer: false } }), g = fakes({ testStatus: 1 });
  q.release('1.0.1', 'README.md', 'x\n');
  const s = await update({ configFile: q.file, root: q.fork, deps: g.deps });
  assert.equal(s.step, 'test'); assert.equal(g.wakes.length, 0); assert.equal(s.fixer, null);
});

test('a test that fails once and passes on its own rerun is reported as flaky, not a failure', async () => {
  const w = world(), f = fakes({ testStatus: 1, flaky: true });
  w.release('1.0.1', 'README.md', 'x\n');
  const r = await update({ configFile: w.file, root: w.fork, deps: f.deps });
  assert.equal(r.status, 'updated', JSON.stringify(r));
  assert.deepEqual(r.flaky.files, ['packages/webchat/test/sidebar.test.mjs']);
});

test('a UI problem fails the update; --accept-ui passes a pure look difference but never a blank page', async () => {
  const w = world();
  w.release('1.0.1', 'README.md', 'x\n');
  const look = fakes({ ui: { ok: false, mode: 'screenshots', problems: ['looks different: / differs from the current release in 60% of pixels'] } });
  assert.equal((await update({ configFile: w.file, root: w.fork, deps: look.deps })).step, 'ui');
  const last = JSON.parse(readFileSync(path.join(w.state, 'update', 'last.json'), 'utf8'));
  const blank = fakes({ ui: { ok: false, mode: 'screenshots', problems: ['/reader renders blank'] } });
  assert.equal((await update({ configFile: w.file, root: w.fork, resume: last.staging, acceptUi: true, deps: blank.deps })).step, 'ui');
  assert.equal((await update({ configFile: w.file, root: w.fork, resume: last.staging, acceptUi: true, deps: look.deps })).status, 'updated');
});

test('an unhealthy instance after the update is rolled back to the previous commit and reported', async () => {
  const w = world(), f = fakes({ health: false });
  w.release('1.0.1', 'packages/core/lib.mjs', 'export const answer = 2;\n');
  const before = git(w.fork, 'rev-parse', 'HEAD');
  const r = await update({ configFile: w.file, root: w.fork, deps: f.deps });
  assert.deepEqual([r.ok, r.step, r.rolledBack], [false, 'health', true]);
  assert.equal(git(w.fork, 'rev-parse', 'HEAD'), before);
  assert.equal(f.calls.filter((c) => c.args.includes('ship')).length, 2, 'shipped forward, then back');
  assert.match(fixerBrief(f.wakes[0], { configFile: w.file, root: w.fork }), /rolled back/);
});

test('update.command: an instance that deploys its own way gets the tag appended, no staging', async () => {
  const w = world({ update: { command: ['/opt/pin-tree.sh', '--push'] } }), f = fakes();
  w.release('1.0.1', 'README.md', 'x\n');
  const r = await update({ configFile: w.file, root: w.fork, deps: f.deps });
  assert.equal(r.status, 'updated'); assert.equal(r.via, 'command');
  assert.deepEqual(f.calls.map((c) => [c.cmd, ...c.args]), [['/opt/pin-tree.sh', '--push', 'v1.0.1']]);
  assert.ok(!existsSync(path.join(w.state, 'update')) || !git(w.fork, 'worktree', 'list').includes('update/'));
});

test('dry run stages and checks but commits and applies nothing', async () => {
  const w = world(), f = fakes();
  put(w.fork, 'README.md', 'dirty\n');
  w.release('1.0.1', 'packages/core/lib.mjs', 'export const answer = 2;\n');
  const before = git(w.fork, 'rev-parse', 'HEAD');
  const r = await update({ configFile: w.file, root: w.fork, dryRun: true, deps: f.deps });
  assert.equal(r.status, 'would_update', JSON.stringify(r));
  assert.equal(git(w.fork, 'rev-parse', 'HEAD'), before); assert.equal(readFileSync(path.join(w.fork, 'README.md'), 'utf8'), 'dirty\n');
  assert.equal(git(w.fork, 'worktree', 'list').split('\n').length, 1);
});

test('not a clone, or no remote: refused by name', async () => {
  const w = world();
  git(w.fork, 'remote', 'remove', 'origin');
  assert.equal((await update({ configFile: w.file, root: w.fork, deps: fakes().deps })).status, 'no_remote');
  git(w.fork, 'remote', 'add', 'upstream', w.up);
  assert.equal((await update({ configFile: w.file, root: w.fork, check: true, deps: fakes().deps })).remote, 'upstream');
  const plain = tmp();
  assert.equal((await update({ configFile: w.file, root: plain, deps: fakes().deps })).status, 'not_a_clone');
});

test('latestTag orders by semver, ignoring anything else', () => {
  assert.equal(latestTag(['v1.0.9', 'v1.0.10', 'v1.2.0-rc1', 'published/v9.9.9', 'v0.9.99', '']), 'v1.0.10');
  assert.equal(latestTag(['nope']), null);
});

test('config: update defaults to daily, false turns the job off, the block is validated; the job is an interval unit', () => {
  const home = '/home/someone', base = { name: 'demo', components: ['webchat'] };
  assert.deepEqual(resolveInstance(base, { home }).update, { everySeconds: 86400 });
  assert.equal(resolveInstance({ ...base, update: false }, { home }).update, false);
  assert.deepEqual(resolveInstance({ ...base, update: { everySeconds: 3600, command: ['~/bin/pin.sh'], fixer: false, remote: 'upstream' } }, { home }).update, { everySeconds: 3600, command: ['/home/someone/bin/pin.sh'], fixer: false, remote: 'upstream' });
  for (const [u, re] of [[{ every: 1 }, /unknown key update.every/], [{ everySeconds: 10 }, /at least 60/], [{ command: [] }, /argv list/], [{ command: 'x' }, /argv list/], [{ fixer: 'no' }, /true or false/], [{ remote: 'a b' }, /remote name/], ['daily', /false or \{/]]) {
    assert.throws(() => resolveInstance({ ...base, update: u }, { home }), re);
  }
  const jobs = instanceJobs(resolveInstance(base, { home }), { configFile: '/etc/demo.json' });
  const j = jobs.find((x) => x.job === 'update');
  assert.deepEqual([j.label, j.args, j.interval], ['md.tophat.demo.update', ['update', '--config', '/etc/demo.json'], 86400]);
  assert.ok(!instanceJobs(resolveInstance({ ...base, update: false }, { home }), { configFile: '/f' }).some((x) => x.job === 'update'));
  const unit = serviceUnit(resolveInstance(base, { home }), { configFile: '/etc/demo.json', bin: '/opt/tophat-deploy.mjs', node: '/usr/bin/node', job: 'update' });
  assert.match(unit, /<key>StartInterval<\/key><integer>86400<\/integer>/);
  assert.match(unit, /<string>update<\/string>/); assert.doesNotMatch(unit, /KeepAlive/); assert.match(unit, /logs\/update\.log/);
});

// A minimal PNG writer (filter 0) for the decoder's tests.
function png(w, h, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from([...pixel(x, y), 255]).copy(raw, y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('screenshot maths: decode, pixel diff and flatness', () => {
  const white = decodePng(png(40, 20, () => [255, 255, 255]));
  const half = decodePng(png(40, 20, (x) => (x < 20 ? [255, 255, 255] : [10, 10, 10])));
  assert.deepEqual([white.width, white.height, white.bpp], [40, 20, 4]);
  assert.equal(pixelDiff(white, white), 0);
  assert.equal(pixelDiff(white, half), 0.5);
  assert.equal(pixelDiff(white, decodePng(png(20, 20, () => [255, 255, 255]))), 1);
  assert.equal(flatness(white), 1);
  assert.ok(flatness(half) < 0.6);
});
