// owner.label (TOPHAT_OWNER_NAME) reaches the prompts and rules that used to name a person.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_OWNER, owner, ownerPossessive } from '../owner.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const read = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

test('the label, its default and its possessive', () => {
  assert.equal(owner({}), DEFAULT_OWNER);
  assert.equal(owner({ TOPHAT_OWNER_NAME: '  ' }), DEFAULT_OWNER);
  assert.equal(owner({ TOPHAT_OWNER_NAME: 'Sam' }), 'Sam');
  assert.equal(ownerPossessive({ TOPHAT_OWNER_NAME: 'Sam' }), "Sam's");
  assert.equal(ownerPossessive({ TOPHAT_OWNER_NAME: 'the Jones' }), "the Jones'");
  assert.equal(ownerPossessive({}), "the owner's");
});

test('the inbox rule and the goal prompts name the instance owner, not a person', async () => {
  // INBOX_RULE is built at import from process.env; a live instance's TOPHAT_OWNER_NAME must not leak into this check.
  const saved = process.env.TOPHAT_OWNER_NAME;
  delete process.env.TOPHAT_OWNER_NAME;
  const { INBOX_RULE } = await import('../rev6/base/inbox-rule.mjs?env=unset');
  if (saved !== undefined) process.env.TOPHAT_OWNER_NAME = saved;
  assert.match(INBOX_RULE, /\[Inbox rule\] the owner uses the chat sidebar/);
  for (const rel of ['rev5/goals.mjs', 'rev5/waits.mjs', 'rev6/pull/goals.mjs', 'rev6/pull/pull.mjs', 'rev6/base/inbox-rule.mjs']) {
    const text = read(rel);
    assert.match(text, /from '\.{2}\/(\.{2}\/)?owner\.mjs'/, `${rel} does not read the owner label`);
    assert.ok(/\$\{owner\(\)\}|\$\{ownerPossessive\(\)\}/.test(text), `${rel} has no owner substitution`);
  }
});

test('the webchat server strings read the same label', () => {
  for (const rel of ['../webchat/src/lib/server/mp.js', '../webchat/src/lib/server/mp-gate.js', '../webchat/src/lib/server/pace.js',
    '../webchat/src/lib/server/replies.js', '../webchat/src/lib/server/docs.js', '../webchat/src/lib/core/state-report.js']) {
    const text = read(rel);
    assert.match(text, /from '\.{2}\/\.{2}\/\.{2}\/\.{2}\/runner\/owner\.mjs'/, `${rel} does not read the owner label`);
  }
  assert.match(read('../webchat/src/lib/server/docs.js'), /export const OWNER_NAME = owner\(\);/);
});
