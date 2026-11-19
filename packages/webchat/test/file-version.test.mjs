// A local image embedded in a reply is addressed by its path, which is the same string after the file is
// rewritten. These tests rewrite a real file at one path and check every link that keeps the old picture
// from being shown: the version the server reports, the image URL a reply draws, and the cache headers.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileVersion, rawPathsIn, stampImages } from '../src/lib/core/file-version.js';
import { notModified, rawCacheHeaders } from '../src/lib/server/file-cache.js';

const lookup = (path) => { const s = statSync(path); return { path, size: s.size, mtime: s.mtime.toISOString() }; };
const embed = (path) => `<img src="/api/file?path=${encodeURIComponent(path)}&amp;raw=1" alt="x" />`;

test('a file overwritten at the same path gets a new version, a new image URL and no immutable copy of the old one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-version-'));
  const path = join(dir, 'render.png');
  try {
    writeFileSync(path, Buffer.from('first render'));
    const v1 = fileVersion(lookup(path));
    const html = embed(path);
    const url1 = stampImages(html, { [path]: v1 });

    // Same size, later mtime: the case a size-only version misses.
    writeFileSync(path, Buffer.from('other render'));
    utimesSync(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const v2 = fileVersion(lookup(path));
    const url2 = stampImages(html, { [path]: v2 });
    assert.notEqual(v1, v2);
    assert.notEqual(url1, url2);
    assert.match(url2, new RegExp(`&amp;v=${v2}"`, 'u'));

    // Different size, same mtime: the case an mtime-only version misses.
    const mtime = statSync(path).mtime;
    writeFileSync(path, Buffer.from('a longer third render'));
    utimesSync(path, mtime, mtime);
    const v3 = fileVersion(lookup(path));
    assert.notEqual(v3, v2);

    // The old URL asked for after the rewrite is revalidated, never kept for good; the new one is.
    assert.equal(rawCacheHeaders({ version: v3, requestedVersion: v1, mime: 'image/png' })['cache-control'], 'private, no-cache');
    assert.equal(rawCacheHeaders({ version: v3, requestedVersion: v3, mime: 'image/png' })['cache-control'], 'private, max-age=31536000, immutable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a drawn image never fetches the unversioned URL: no src until the version is known', () => {
  const html = embed('/tmp/a.png');
  assert.deepEqual(rawPathsIn(html), ['/tmp/a.png']);
  assert.ok(!stampImages(html, {}).includes('src='));
  assert.ok(stampImages(html, { '/tmp/a.png': '1-2' }).includes('&amp;v=1-2"'));
});

test('cache headers: pinned v is immutable, anything else revalidates by etag, a 304 only on a matching etag without a Range', () => {
  const stale = rawCacheHeaders({ version: '2-9', requestedVersion: null, mime: 'image/png' });
  assert.deepEqual(stale, { etag: '"2-9"', 'cache-control': 'private, no-cache' });
  assert.equal(notModified({ headers: stale, ifNoneMatch: '"2-9"', range: null }), true);
  assert.equal(notModified({ headers: stale, ifNoneMatch: '"1-9"', range: null }), false);
  assert.equal(notModified({ headers: stale, ifNoneMatch: '"2-9"', range: 'bytes=0-9' }), false);
  // A non-image with no matching v keeps the route's short default; a file with no readable version has no etag.
  assert.equal(rawCacheHeaders({ version: '2-9', requestedVersion: '1-9', mime: 'application/pdf' })['cache-control'], undefined);
  assert.deepEqual(rawCacheHeaders({ version: null, requestedVersion: 'x', mime: 'image/png' }), { 'cache-control': 'private, no-cache' });
});
