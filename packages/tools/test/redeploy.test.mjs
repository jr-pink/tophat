import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plan, settings } from '../redeploy/tophat-redeploy.mjs';

const base = { HOME: '/h', TOPHAT_INSTANCE_CONFIG: '/c/instance.json', TOPHAT_DEPLOY_BIN: '/d/tophat-deploy.mjs', TOPHAT_NODE: '/n/node' };
const names = (steps) => steps.map((s) => (s.phase ? `hook:${s.phase}` : s.argv.slice(2, 4).join(' ')));

test('ship without a hook is the deploy tool alone; with one the phases run first, in order', () => {
  assert.deepEqual(names(plan('ship', [], settings(base))), ['instance ship']);
  const withHook = settings({ ...base, TOPHAT_REDEPLOY_HOOK: '/h/hook' });
  assert.deepEqual(names(plan(undefined, [], withHook)), ['hook:vendor', 'hook:refresh', 'hook:release', 'instance ship']);
  assert.deepEqual(names(plan('refresh', [], withHook)), ['hook:refresh', 'hook:vendor', 'hook:refresh', 'hook:release', 'instance ship']);
});
test('status asks status then health; other verbs pass through with the config', () => {
  const s = settings(base);
  assert.deepEqual(names(plan('status', [], s)), ['instance status', 'instance health']);
  assert.deepEqual(plan('jobs', ['--write', '/x'], s)[0].argv, ['/n/node', '/d/tophat-deploy.mjs', 'instance', 'jobs', '--config', '/c/instance.json', '--write', '/x']);
});
test('the instance file, deploy tool and node come from the environment', () => {
  const s = settings({ HOME: '/h' });
  assert.equal(s.config, '/h/.config/tophat/instance.json');
  assert.match(s.deploy, /packages\/deploy\/bin\/tophat-deploy\.mjs$/);
  assert.equal(settings({ HOME: '/h', TOPHAT_LEGACY_ENV_PREFIX: 'OLD_', OLD_INSTANCE_CONFIG: '/old.json' }).config, '/old.json');
});
