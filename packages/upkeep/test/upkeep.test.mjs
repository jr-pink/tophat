import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { world, tmp } from '@tophat-md/linknotes/testing';
import { runDue } from '../index.mjs';

let w;
after(async () => { await w?.close(); });
test('default jobs run on their intervals, write health, back up, rotate; an unconfigured job never runs; understanding is off unless configured', async () => {
  w = await world();
  const store = w.sqlite('up');
  await store.createScope('up');
  const drop = tmp('linknotes-up-drop-');
  fs.writeFileSync(path.join(drop, 'a.jsonl'), JSON.stringify({ id: '1', text: 'Dana Okafor fixed the Lab Boiler.', time: '2026-11-01T00:00:00Z' }) + '\n');
  const stateDir = tmp('linknotes-up-state-'), backupDir = path.join(stateDir, 'backups');
  const cfg = { backend: 'sqlite', push: { id: 'up-push', scopes: ['up'], stateDir: path.join(stateDir, 'push'), model: { provider: 'stub' }, sources: [{ id: 'drop', family: 'jsonl', config: { dir: drop } }] },
    upkeep: { stateDir, jobs: { heartbeat: { everySeconds: 60 }, consolidate: { everySeconds: 600 }, health: { everySeconds: 60 }, 'log-rotate': { everySeconds: 3600, maxBytes: 10, keep: 2 }, backup: { everySeconds: 86400, dir: backupDir, keep: 2 } } } };
  const t0 = Date.parse('2026-11-08T00:00:00Z');
  const r1 = await runDue(store, cfg, { now: t0 });
  assert.deepEqual(Object.keys(r1), ['heartbeat', 'consolidate', 'health', 'log-rotate', 'backup']);
  assert.equal(r1.heartbeat.derived, 1);
  assert.equal(r1.health.ok, true);
  assert.equal(fs.readdirSync(backupDir).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'health.json'), 'utf8')).pending_raw, 0);
  const r2 = await runDue(store, cfg, { now: t0 + 30_000 });
  assert.deepEqual(Object.keys(r2), [], 'nothing due after 30 s');
  const r3 = await runDue(store, cfg, { now: t0 + 61_000 });
  assert.deepEqual(Object.keys(r3), ['heartbeat', 'health']);
  assert.equal(r3.heartbeat.derived, 0);
  assert.ok(!('understanding' in r3));
  const bad = await runDue(store, { ...cfg, upkeep: { stateDir, jobs: { understanding: { everySeconds: 1 } } } }, { now: t0 + 120_000 });
  assert.match(bad.understanding.error, /command must be/);
});
