// test/hermetic-env.mjs (loaded by `npm test`) drops an enclosing instance's TOPHAT_* configuration and keeps the
// dependency pointers and test switches.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);

test('hermetic-env: an instance hub, scope and store never reach the suite', () => {
  const env = { ...process.env, TOPHAT_HUB_URL: 'http://127.0.0.1:9', TOPHAT_SCOPE: 'team', TOPHAT_RUNNER_DB: '/nonexistent/live.sqlite', TOPHAT_RUNNER_NODE_MODULES: '/x/node_modules', TOPHAT_TEST_FLAG: '1' };
  const r = spawnSync(process.execPath, ['--import', path.join(HERE, 'hermetic-env.mjs'), '-e', 'console.log(JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith("TOPHAT_")).sort()))'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['TOPHAT_RUNNER_NODE_MODULES', 'TOPHAT_TEST_FLAG']);
});
