// The Python cdp tool's own suite (pure cases and parse errors; the browser half needs a live Chrome and is run by hand).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pythonCmd, pythonEnv } from './cdp/twin.mjs';

test('guard.py --no-browser passes', () => {
  const [cmd, ...lead] = pythonCmd();
  const r = spawnSync(cmd, [...lead, path.join(path.dirname(fileURLToPath(import.meta.url)), 'cdp/guard.py'), '--no-browser'], { encoding: 'utf8', env: pythonEnv() });
  assert.equal(r.status, 0, r.stdout.slice(-800) + r.stderr.slice(-400));
  assert.match(r.stdout, /\d+ passed, 0 failed/);
});
