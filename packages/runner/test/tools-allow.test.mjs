// TOPHAT_RUNNER_TOOLS_ALLOW: an instance that serves strangers names the only tools the runner offers and runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTools } from '../rev6/pull/tools.mjs';
import { openLedger } from '../rev6/pull/ledger.mjs';

const stubs = { cua: () => ({ specs: [], ready: async () => {}, prompt: () => null, run: async () => ({ content: '', isError: true }), close() {} }), tabs: () => ({ around: (f) => f() }) };
function tools(env) {
  const dir = mkdtempSync(join(tmpdir(), 'allow-'));
  return { dir, t: createTools({ db: openLedger(':memory:').db, sessionId: 's1', cwd: dir, roots: [dir], env: { HOME: dir, TOPHAT_STATE_DIR: dir, PATH: process.env.PATH, ...env }, factories: stubs, mail: false }) };
}

test('unset: the whole tool surface, shell included', () => {
  const names = tools({}).t.specs.map((s) => s.name);
  assert.ok(names.includes('shell') && names.includes('write_file') && names.includes('memory_read'));
});

test('set: only the named tools are offered, and any other is refused by name', async () => {
  const { t, dir } = tools({ TOPHAT_RUNNER_TOOLS_ALLOW: 'memory_search, memory_read' });
  assert.deepEqual(t.specs.map((s) => s.name).sort(), ['memory_read', 'memory_search']);
  const r = await t.run('shell', { command: 'echo hi' });
  assert.equal(r.isError, true);
  assert.match(String(r.content), /not available in this instance/);
  const w = await t.run('write_file', { path: join(dir, 'x'), content: 'x' });
  assert.equal(w.isError, true);
});
