// Drift: every vendored file is byte-identical to what VENDOR.json says scripts/vendor.mjs wrote (edit upstream in
// the upstream core, then re-vendor; never in place). Upstream drift is reported by `npm run vendor:check`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
test('vendored files match VENDOR.json', { skip: !existsSync(path.join(ROOT, 'VENDOR.json')) && 'no VENDOR.json (release tree: the manifest stays in the source repository)' }, () => {
  const m = JSON.parse(readFileSync(path.join(ROOT, 'VENDOR.json'), 'utf8'));
  assert.ok(Object.keys(m.files).length >= 15);
  for (const [out, rec] of Object.entries(m.files)) assert.equal(createHash('sha256').update(readFileSync(path.join(ROOT, out))).digest('hex'), rec.out, out);
});
test('nothing deployment-specific in shipped core code paths', () => {
  const screen = readFileSync(path.join(ROOT, 'packages/linknotes/core/src/screen.mjs'), 'utf8');
  assert.match(screen, /export const SCREEN_PATTERN = \/\(\?!\)\/;/, 'the upstream screen word list is not shipped: nothing matches by default');
  assert.equal(readFileSync(path.join(ROOT, 'packages/linknotes/core/vendor/rev6/base/private-people.json'), 'utf8').trim(), '[]');
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'packages/linknotes/core/vendor/rev6/push/store.mjs'), 'utf8'), /\.local\/state\//);
});
