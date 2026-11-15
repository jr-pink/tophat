// A long-lived runner keeps working after its own release dir is removed (src/store-repo.mjs). On 2026-11-14 an `rm -rf`
// of old release trees left ~45 live runners whose every store/cli.mjs child failed with `spawnSync .../node ENOENT`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeRepo, storeRepoCandidates } from '../src/store-repo.mjs';

const RUNNER = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(dirname(RUNNER));

test('storeRepo skips a checkout that is gone and names every candidate when none is left', () => {
  const gone = join(tmpdir(), 'tophat-gone-release-does-not-exist');
  assert.equal(storeRepo({ TOPHAT_RUNTIME_DIR: RUNNER }, gone), RUNNER);
  assert.equal(storeRepo({ TOPHAT_REPO: gone, TOPHAT_RUNNER_RUNTIME_DIR: RUNNER }, gone), RUNNER);
  assert.equal(storeRepo({ TOPHAT_REPO: RUNNER }, gone), RUNNER);
  assert.deepEqual(storeRepoCandidates({ TOPHAT_REPO: 'a', TOPHAT_RUNTIME_DIR: 'a' }, 'b'), ['a', 'b']);
  assert.throws(() => storeRepo({}, gone), (e) => e.code === 'store_repo_missing' && e.message.includes(gone));
});

test('taskRequest from a runner whose release dir was deleted while it ran still reaches the store', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tophat-store-repo-'));
  try {
    // A release tree: this runner package copied (clone-on-write), sharing the workspace node_modules.
    const release = join(tmp, 'release');
    cpSync(RUNNER, join(release, 'packages', 'runner'), { recursive: true, filter: (p) => !p.includes(`${'/'}node_modules`) });
    symlinkSync(join(ROOT, 'node_modules'), join(release, 'node_modules'));
    const goals = join(release, 'packages', 'runner', 'rev6', 'pull', 'goals.mjs');
    const db = join(tmp, 'memory.sqlite');
    // The child loads goals.mjs from the release, then the release is deleted (as the redeploy cleanup did), then it calls.
    const script = `
      const { rmSync } = await import('node:fs');
      const { taskRequest } = await import(${JSON.stringify(goals)});
      rmSync(${JSON.stringify(release)}, { recursive: true, force: true });
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TOPHAT_RUNNER_DB: ${JSON.stringify(db)}, TOPHAT_RUNTIME_DIR: ${JSON.stringify(RUNNER)} };
      try {
        taskRequest({ op: 'apply', op_id: 'gone-1', actor: 'test', tasks: [{ id: '$t', title: 'after the release vanished', status: 'todo' }] }, env);
        console.log(JSON.stringify({ ok: true, title: taskRequest({ op: 'list' }, env).tasks[0].title }));
      } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
    const out = JSON.parse(run.stdout.trim().split('\n').pop() || '{}');
    assert.deepEqual(out, { ok: true, title: 'after the release vanished' }, run.stderr);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
