// The app assembly reads a working tree; a file git ignores upstream is in the tree but not in a clean checkout, so an
// assembly from a clean checkout dropped it (the /api/mp state routes, 2026-11-09). ignoredSources names such files.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ignoredSources } from '../scripts/ignored-sources.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
function repo() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ignored-sources-'));
  git(d, 'init', '-q');
  mkdirSync(path.join(d, 'app/routes/mp/state'), { recursive: true });
  mkdirSync(path.join(d, 'app/routes/mp/say'), { recursive: true });
  writeFileSync(path.join(d, 'app/routes/mp/state/+server.js'), 'export const GET = 1;\n');
  writeFileSync(path.join(d, 'app/routes/mp/say/+server.js'), 'export const GET = 2;\n');
  writeFileSync(path.join(d, '.gitignore'), 'state/\n');
  return d;
}

test('an untracked file under an ignore rule is named; tracked and unignored files are not', () => {
  const d = repo();
  try {
    assert.deepEqual(ignoredSources(d, ['app/routes/mp/state/+server.js', 'app/routes/mp/say/+server.js']), ['app/routes/mp/state/+server.js']);
    writeFileSync(path.join(d, '.gitignore'), 'state/\n!app/routes/**/state/\n!app/routes/**/state/**\n');
    assert.deepEqual(ignoredSources(d, ['app/routes/mp/state/+server.js']), [], 'the exemption clears it');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('paths are relative to the directory given, which may be a subdirectory of the repo', () => {
  const d = repo();
  try { assert.deepEqual(ignoredSources(path.join(d, 'app'), ['routes/mp/state/+server.js']), ['routes/mp/state/+server.js']); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('a directory that is not a git checkout reports nothing', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ignored-sources-'));
  try { assert.deepEqual(ignoredSources(d, ['x.js']), []); } finally { rmSync(d, { recursive: true, force: true }); }
});

import { withoutLineComments } from '../scripts/source-text.mjs';

test('a comment that quotes an import is not scanned; real imports, strings and urls are untouched', () => {
  const text = [
    '// loads import("./_app/immutable/bundle.<hash>.js") at the end',
    '/* also import("./gone.js")',
    '   across lines */',
    "import { a } from './a.js';",
    "const url = 'http://x/y'; // trailing comment stays",
    "const glob = '/*'; import('./b.js');",
  ].join('\n');
  const out = withoutLineComments(text);
  assert.equal(out.split('\n').length, text.split('\n').length);
  assert.doesNotMatch(out, /bundle|gone/);
  assert.match(out, /from '\.\/a\.js'/);
  assert.match(out, /http:\/\/x\/y/);
  assert.match(out, /import\('\.\/b\.js'\)/);
});
