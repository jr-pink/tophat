// Shipped core defaults carry nothing deployment-specific.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
test('nothing deployment-specific in shipped core code paths', () => {
  const screen = readFileSync(path.join(ROOT, 'packages/linknotes/core/src/screen.mjs'), 'utf8');
  assert.match(screen, /export const SCREEN_PATTERN = \/\(\?!\)\/;/, 'the upstream screen word list is not shipped: nothing matches by default');
  assert.equal(readFileSync(path.join(ROOT, 'packages/linknotes/core/vendor/rev6/base/private-people.json'), 'utf8').trim(), '[]');
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'packages/linknotes/core/vendor/rev6/push/store.mjs'), 'utf8'), /\.local\/state\//);
});
