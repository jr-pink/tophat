import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../commit-guard/tophat-commit-guard', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'commit-guard-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'reader.svelte'), 'before the swipe work\n');
  writeFileSync(join(dir, 'model.mjs'), 'ttl 5m\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  writeFileSync(join(dir, 'reader.svelte'), 'import SwipeRow\narchiveDoc()\n');
  git(dir, 'add', 'reader.svelte');
  git(dir, 'commit', '-q', '-m', 'swipe left to archive');
  return dir;
}

function guard(cwd, env = {}) {
  return spawnSync(process.execPath, [GUARD, 'check'], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

test('a staged checkout of the previous version is refused, naming the commit it would undo', () => {
  const dir = repo();
  try {
    git(dir, 'checkout', 'HEAD~1', '--', 'reader.svelte');
    writeFileSync(join(dir, 'model.mjs'), 'ttl 1h\n');
    git(dir, 'add', 'model.mjs');
    const run = guard(dir);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /reader\.svelte/);
    assert.match(run.stderr, /swipe left to archive/);
    assert.match(run.stderr, /restores the content it replaced/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('staging away a file the last commit added is the same clobber and is refused', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, 'SwipeRow.svelte'), 'new component\n');
    git(dir, 'add', 'SwipeRow.svelte');
    git(dir, 'commit', '-q', '-m', 'add the shared component');
    git(dir, 'rm', '-q', '--cached', 'SwipeRow.svelte');
    const run = guard(dir);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /deletes the file it added/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ordinary staged edits pass, including an edit on top of the newest commit', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, 'reader.svelte'), 'import SwipeRow\narchiveDoc()\nstarDoc()\n');
    writeFileSync(join(dir, 'model.mjs'), 'ttl 1h\n');
    git(dir, 'add', '.');
    assert.equal(guard(dir).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new file and an empty index both pass', () => {
  const dir = repo();
  try {
    assert.equal(guard(dir).status, 0, 'nothing staged');
    writeFileSync(join(dir, 'brand-new.mjs'), 'x\n');
    git(dir, 'add', 'brand-new.mjs');
    assert.equal(guard(dir).status, 0, 'a new file has nothing to revert');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a deliberate revert passes with TOPHAT_ALLOW_REVERT', () => {
  const dir = repo();
  try {
    git(dir, 'checkout', 'HEAD~1', '--', 'reader.svelte');
    assert.equal(guard(dir).status, 1);
    assert.equal(guard(dir, { TOPHAT_ALLOW_REVERT: '1' }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installed as a hook it stops the real commit, and --no-verify still gets through', () => {
  const dir = repo();
  try {
    const install = spawnSync(process.execPath, [GUARD, 'install'], { cwd: dir, encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    assert.equal(spawnSync(process.execPath, [GUARD, 'status'], { cwd: dir, encoding: 'utf8' }).status, 0);

    git(dir, 'checkout', 'HEAD~1', '--', 'reader.svelte');
    writeFileSync(join(dir, 'model.mjs'), 'ttl 1h\n');
    git(dir, 'add', 'model.mjs');
    const blocked = spawnSync('git', ['commit', '-q', '-m', 'cache the context for an hour'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /refusing a commit that undoes committed work/);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'swipe left to archive', 'the clobbering commit did not land');

    const forced = spawnSync('git', ['commit', '-q', '--no-verify', '-m', 'deliberate'], { cwd: dir, encoding: 'utf8' });
    assert.equal(forced.status, 0, forced.stderr);

    const removed = spawnSync(process.execPath, [GUARD, 'uninstall'], { cwd: dir, encoding: 'utf8' });
    assert.equal(removed.status, 0);
    assert.equal(spawnSync(process.execPath, [GUARD, 'status'], { cwd: dir, encoding: 'utf8' }).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unrelated existing pre-commit hook is not replaced without --force', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const run = spawnSync(process.execPath, [GUARD, 'install'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--force/);
    assert.equal(spawnSync(process.execPath, [GUARD, 'install', '--force'], { cwd: dir, encoding: 'utf8' }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
