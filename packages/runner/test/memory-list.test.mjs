// memory_list in the assembled runner: rev6/base/memory-list.mjs names a CLI by path, and that path must exist in this tree and
// answer `list` (a release once shipped the tool without the command's file: "Cannot find module .../rev6/push/cli.mjs").
// Scratch files only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answer, closeAll } from '../store/memory.mjs';
import { listCall } from '../rev6/base/memory-list.mjs';
import { memoryStore } from '../rev6/pull/tools.mjs';

const dirs = [];
const CLEAN = { PATH: process.env.PATH }; // no hub, scope or device settings from the machine running the test
test.after(() => { closeAll(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tophat-list-')); dirs.push(d); return path.join(d, 'memory.sqlite'); };
const at = (d) => new Date(Date.UTC(2026, 9, d, 15)).toISOString();
const seed = (file) => {
  const records = Array.from({ length: 6 }, (_, i) => ({ source: i < 4 ? 'lifts' : 'chat', native_id: `r${i}`, author: 'owner', role: 'owner', text: `atlas session ${i}`, occurred_at: at(1 + i) }));
  const r = answer('ingest', { records }, { db: file, env: {} });
  assert.equal(r.code, 0, JSON.stringify(r.result));
};

test('memory_list: the CLI path listCall spawns exists in the assembled runner', () => {
  const store = memoryStore({ TOPHAT_RUNNER_DB: scratch() });
  const [, argv] = listCall(store, { term: 'atlas' });
  assert.ok(existsSync(argv[0]), `${argv[0]} is not in this tree`);
});

test('memory_list: spawned the way the runner spawns it, the CLI lists every match with totals, months and sources', () => {
  const file = scratch(); seed(file);
  const store = memoryStore({ TOPHAT_RUNNER_DB: file });
  const [bin, argv, req] = listCall(store, { term: 'atlas', limit: 3 }, { TOPHAT_TIMEZONE: 'America/Los_Angeles' });
  const out = JSON.parse(execFileSync(bin, argv, { cwd: store.cwd, input: JSON.stringify(req), encoding: 'utf8', env: CLEAN }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.total.raw, 6, 'every match is counted, not just the page');
  assert.equal(out.items.length, 3);
  assert.equal(out.next_offset, 3);
  assert.deepEqual(out.by_source, { lifts: 4, chat: 2 });
  assert.equal(out.by_month['2026-10'].raw, 6);
  const byWord = JSON.parse(execFileSync(bin, argv, { cwd: store.cwd, input: JSON.stringify({ source: 'lifts' }), encoding: 'utf8', env: CLEAN }));
  assert.equal(byWord.total.raw, 4);
});

test('memory_list: a filterless call is refused, not an internal error', () => {
  const file = scratch(); seed(file);
  const r = answer('list', {}, { db: file, env: {} });
  assert.equal(r.code, 2); assert.equal(r.result.reason, 'refused');
});
