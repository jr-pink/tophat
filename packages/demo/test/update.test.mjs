// The demo user's update: a stale copy of a workspace package under another package's node_modules must not survive it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { update } from '../src/release.mjs';

const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

test('update drops a real copy of a workspace package from a package\'s node_modules, keeps links and other dependencies', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'upd-'));
  const out = path.join(base, 'releases'), release = path.join(out, 'abc'), root = path.join(base, 'root');
  put(path.join(release, '.sha'), 'abc\n'); put(path.join(release, '.lock'), 'L\n');
  put(path.join(release, 'packages/runner/package.json'), '{"name":"@tophat-md/runner"}');
  put(path.join(release, 'packages/linknotes/package.json'), '{"name":"@tophat-md/linknotes"}');
  symlinkSync(release, path.join(out, 'current'));
  put(path.join(root, '.lock'), 'L\n');
  put(path.join(root, 'packages/runner/package.json'), '{"name":"@tophat-md/runner"}');
  put(path.join(root, 'packages/runner/node_modules/@tophat-md/linknotes/package.json'), '{"version":"0.1.0"}');
  put(path.join(root, 'packages/runner/node_modules/left-pad/index.js'), '');
  const r = update({ root, out, log() {} });
  assert.equal(r.installed, true);
  assert.equal(existsSync(path.join(root, 'packages/runner/node_modules/@tophat-md/linknotes')), false);
  assert.equal(existsSync(path.join(root, 'packages/runner/node_modules/left-pad/index.js')), true);
});

test('update refuses a release that does not load and leaves the running root alone', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'upd-'));
  const out = path.join(base, 'releases'), release = path.join(out, 'abc'), root = path.join(base, 'root');
  put(path.join(release, '.sha'), 'abc\n'); put(path.join(release, '.lock'), 'L\n');
  put(path.join(release, 'packages/demo/new.txt'), 'new');
  symlinkSync(release, path.join(out, 'current'));
  put(path.join(root, '.lock'), 'L\n');
  put(path.join(root, 'packages/demo/old.txt'), 'old');
  assert.throws(() => update({ root, out, log() {}, preflight: () => { throw new Error("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'katex'"); } }), /does not load.*katex/);
  assert.equal(existsSync(path.join(root, 'packages/demo/old.txt')), true);
  assert.equal(existsSync(path.join(root, 'packages/demo/new.txt')), false);
  assert.equal(existsSync(path.join(root, '.demo-sha')), false);
  assert.equal(existsSync(`${root}.incoming`), false);
});
