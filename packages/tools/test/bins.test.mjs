// Every command in the bin map exists, is executable, and loads (no missing import, no syntax error) when run bare.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bins = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).bin;
const SKIP_RUN = new Set(['tophat-multiplayer', 'tophat-mcp']); // multiplayer starts a server; tophat-mcp needs a store config

test('every bin file exists and is executable', () => {
  for (const [name, rel] of Object.entries(bins)) accessSync(path.join(ROOT, rel), constants.X_OK);
  assert.ok(Object.keys(bins).length >= 12);
});
test('every bin loads when run bare', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'bins-'));
  for (const [name, rel] of Object.entries(bins)) {
    if (SKIP_RUN.has(name)) continue;
    const r = spawnSync(process.execPath, [path.join(ROOT, rel)], { encoding: 'utf8', cwd: home, timeout: 20000, env: { PATH: process.env.PATH, HOME: home } });
    assert.ok(!/ERR_MODULE_NOT_FOUND|SyntaxError|Cannot find module|ReferenceError/.test(r.stderr), `${name}: ${r.stderr.slice(0, 300)}`);
    assert.notEqual(r.status, null, `${name} timed out`);
  }
});
