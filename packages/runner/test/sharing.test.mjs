// The sharing guidance a joined instance gives its model: judgment in the prompt, notes only, and it reaches the system prompt
// through the instance's instructions file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstructions } from '../rev6/pull/context.mjs';
import { SHARING_BEGIN, sharingGuidance, withSharingBlock } from '../store/sharing.mjs';

test('the guidance names the rule: bugfixes always, good customizations, built things, notes only, groups on memory_apply', () => {
  const t = sharingGuidance({ group: 'tophat-users' });
  assert.match(t, /Only memory notes travel/);
  assert.match(t, /never synced/);
  assert.match(t, /groups: \["tophat-users"\]/);
  assert.match(t, /Bugfixes, always/);
  assert.match(t, /most tophat users would want/);
  assert.match(t, /Cool things people built/);
  assert.match(t, /how to apply it, step by step/);
  assert.match(t, /never work around a screen/);
  assert.ok(!t.includes('\u2014'), 'no em dashes');
});

test('withSharingBlock appends once, replaces in place, and leaves the owner\'s own text alone', () => {
  const g = 'tophat-users', own = 'Answer briefly.\n';
  const once = withSharingBlock(own, g, 'v1');
  assert.ok(once.startsWith(own) && once.includes(SHARING_BEGIN(g)));
  const twice = withSharingBlock(`${once}\nTail rule.\n`, g, 'v2');
  assert.ok(twice.includes('v2') && !twice.includes('v1') && twice.startsWith(own) && twice.includes('Tail rule.'));
  assert.equal(twice.split(SHARING_BEGIN(g)).length, 2, 'one block');
  assert.ok(withSharingBlock('', g, 'x').startsWith(SHARING_BEGIN(g)));
});

test('through the instructions file the guidance is in the model\'s prompt', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-sharing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'ws'));
  const file = path.join(dir, 'instructions.md');
  writeFileSync(file, withSharingBlock('Be brief.\n', 'tophat-users', sharingGuidance({ group: 'tophat-users' })));
  const prompt = createInstructions({ cwd: path.join(dir, 'ws'), env: { TOPHAT_RUNNER_INSTRUCTIONS_FILE: file } }).prompt();
  assert.match(prompt, /Be brief\./);
  assert.match(prompt, /Sharing with tophat-users\./);
});
