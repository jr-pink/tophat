// Traceability: nothing tracked here and nothing in a release names the deployment this code came from.
// The terms are case-insensitive regexes in scripts/traceability-deny.txt, which never ships; in a release tree the
// list is absent and these tests skip. Hits are reported as file:line.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { NEVER_SHIPPED, NOT_SCANNED, ROOT, archiveHead, exportIgnored, extract, format, isRepo, loadDeny, scanBytes, scanRelease, scanRepo, trackedFiles } from '../scripts/traceability.mjs';

const deny = loadDeny();
const skip = !deny ? 'deny list not present (release tree)' : !isRepo(ROOT) ? 'not a git checkout' : false;
const fail = (what, hits) => assert.equal(hits.length, 0, `${what}: ${hits.length} hit(s)\n${hits.slice(0, 50).map((h) => (typeof h === 'string' ? h : format(h))).join('\n')}`);

test('the deny list holds patterns', { skip }, () => { assert.ok(deny.length >= 20); });

test('tracked files (working tree) name nothing on the deny list', { skip }, () => {
  const r = scanRepo(ROOT, deny);
  assert.ok(r.files.length > 50, `scanned ${r.files.length} files`);
  fail('tracked files', r.hits);
});

test('the files exempt from the scan, and the vendoring step, are export-ignored and tracked', { skip }, () => {
  const tracked = new Set(trackedFiles(ROOT));
  for (const f of NEVER_SHIPPED) assert.ok(tracked.has(f), `${f} is tracked`);
  const ignored = exportIgnored(ROOT, NEVER_SHIPPED);
  for (const f of NEVER_SHIPPED) assert.ok(ignored.has(f), `${f} must be export-ignored (.gitattributes)`);
  for (const f of NOT_SCANNED) assert.ok(NEVER_SHIPPED.includes(f));
});

test('git archive HEAD (the release tree) names nothing and carries nothing it must not', { skip }, () => {
  const dir = archiveHead(ROOT);
  try {
    const r = scanRelease(dir, deny);
    assert.ok(r.files.length > 50, `archive has ${r.files.length} files`);
    fail('archive', r.hits);
    fail('forbidden files in archive', r.forbidden);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the newest release tarball in dist/ names nothing, in its files or its bytes', { skip: skip || (!existsSync(path.join(ROOT, 'dist')) && 'no dist/') }, (t) => {
  const tars = readdirSync(path.join(ROOT, 'dist')).filter((f) => /^tophat-.*\.tar\.gz$/.test(f)).map((f) => path.join(ROOT, 'dist', f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!tars.length) return t.skip('no tophat-*.tar.gz in dist/');
  const dir = extract(tars[0]);
  try {
    const r = scanRelease(dir, deny);
    fail(`${path.basename(tars[0])} files`, r.hits);
    fail(`${path.basename(tars[0])} forbidden files`, r.forbidden);
    fail(`${path.basename(tars[0])} bytes`, scanBytes(tars[0], deny).hits);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
