// A name with no Latin letters must be nameable: mentionKey keeps letters, marks and numbers of every script.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mentionKey, unnameable } from '../core/vendor/rev6/push/identity.mjs';
import { mentionKey as runnerKey, unnameable as runnerUnnameable } from '../../runner/rev6/push/identity.mjs';

for (const [label, key, bad] of [['linknotes vendor', mentionKey, unnameable], ['runner', runnerKey, runnerUnnameable]]) {
  test(`${label}: a non-Latin name keeps its key and is nameable`, () => {
    assert.equal(key('张晶'), '张晶');
    assert.equal(key('张晶 (Zhang Jing)'), '张晶 zhang jing');
    assert.equal(key('Café Olé'), 'café olé');
    assert.equal(key('---'), '');
    assert.equal(bad('张晶'), null);
    assert.match(bad('---'), /carries no letters or digits/);
  });
}
