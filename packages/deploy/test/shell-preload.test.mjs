// The shell asks for its bundle with its stylesheet, not after the stylesheet's round trip (webchat src/lib/core/shell-preload.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKSPACE } from '../src/components.mjs';

const { preloadBundle } = await import(pathToFileURL(path.join(WORKSPACE, 'packages/webchat/src/lib/core/shell-preload.js')).href);
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><link href="./_app/immutable/assets/bundle.A1.css" rel="stylesheet"></head><body><script>import("./_app/immutable/bundle.Zx_9-q.js").then((app) => app.start())</script></body></html>';

test('a modulepreload for the imported bundle comes first in the head, with the path as written', () => {
  const out = preloadBundle(PAGE);
  assert.ok(out.includes('<head><link rel="modulepreload" href="./_app/immutable/bundle.Zx_9-q.js"><meta charset="utf-8">'));
  assert.ok(out.indexOf('modulepreload') < out.indexOf('rel="stylesheet"'));
});
test('absolute paths and single quotes; idempotent; other chunks and non-strings untouched', () => {
  assert.ok(preloadBundle("<head></head><script>import('/_app/immutable/bundle.Q.js')</script>").includes('<link rel="modulepreload" href="/_app/immutable/bundle.Q.js">'));
  const once = preloadBundle(PAGE);
  assert.equal(preloadBundle(once), once);
  assert.equal(preloadBundle('<head></head><body>hi</body>'), '<head></head><body>hi</body>');
  assert.equal(preloadBundle(undefined), undefined);
  assert.equal(preloadBundle('import("./_app/immutable/bundle.Q.js")'), 'import("./_app/immutable/bundle.Q.js")');
});
