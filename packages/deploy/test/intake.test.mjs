// The instance intake: the instance file's sources, model and schedule drive the upkeep job `intake`, which polls the
// sources and ingests and derives into the runner's own replica. Scratch state only; the source is a jsonl drop
// directory (the fake source) and the model is the push plane's deterministic stub, so nothing leaves the machine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInstance } from '../src/instance.mjs';
import { intakeConfig, runIntake, INTAKE_KEY_ENV } from '../src/intake.mjs';
import { componentDir } from '../src/start.mjs';

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tophat-intake-')); dirs.push(d); return d; };
test.after(async () => {
  const runner = componentDir('runner');
  if (runner) (await import(path.join(runner, 'store/memory.mjs'))).closeAll();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('intake block: validated, unknown keys and inline keys refused, a model entry by name', () => {
  const base = { name: 'lab', components: ['linknotes'] };
  assert.equal(resolveInstance(base).intake, null);
  assert.throws(() => resolveInstance({ ...base, intake: { everySeconds: 60, model: { provider: 'stub' }, colour: 1 } }), /unknown key intake.colour/);
  assert.throws(() => resolveInstance({ ...base, intake: { model: { provider: 'stub' } } }), /everySeconds/);
  assert.throws(() => resolveInstance({ ...base, intake: { everySeconds: 60, model: { provider: 'openai', apiKey: 'sk-x' } } }), /never a key/);
  assert.throws(() => resolveInstance({ ...base, intake: { everySeconds: 60, model: 'fast' } }), /names no entry of models/);
  const c = resolveInstance({ ...base, scope: { default: 'lab' }, models: { fast: { model: 'small', baseUrl: 'https://fast.example/v1', credential: { keyring: 'fast-key' } } },
    sources: [{ id: 'drop', family: 'jsonl', config: { dir: '/tmp/drop', token: { keyring: 'drop-token' } } }], intake: { everySeconds: 300, model: 'fast', maxSteps: 3 } }, { home: '/home/x', dir: '/etc' });
  const plan = intakeConfig(c);
  assert.deepEqual(plan.cfg.upkeep.jobs, { intake: { everySeconds: 300 } });
  assert.equal(plan.cfg.upkeep.stateDir, '/home/x/.local/state/tophat/lab/upkeep');
  assert.deepEqual(plan.cfg.intake.scopes, ['lab']);
  assert.equal(plan.cfg.intake.maxSteps, 3);
  assert.deepEqual(plan.cfg.intake.model, { provider: 'openai', model: 'small', baseUrl: 'https://fast.example/v1', apiKeyEnv: INTAKE_KEY_ENV });
  assert.deepEqual(plan.credential, { keyring: 'fast-key' });
  // a source secret reaches the adapter as a path to the keyring file, never as its value
  assert.equal(plan.cfg.intake.sources[0].config.token, '/home/x/.config/tophat/lab/secrets/drop-token');
  assert.ok(!JSON.stringify(plan).includes('sk-'));
});

test('intake runs on the instance schedule: a fake source lands in the runner replica as raw records and derived notes', { skip: (!componentDir('runner') || !componentDir('upkeep')) && 'runner or upkeep package not installed' }, async () => {
  const dir = tmp(), drop = path.join(dir, 'drop');
  mkdirSync(drop);
  writeFileSync(path.join(drop, 'a.jsonl'), `${JSON.stringify({ id: 'm1', text: 'Dana Okafor fixed the Lab Boiler on Tuesday.', time: '2026-11-01T10:00:00Z', author: 'dana' })}\n`);
  const c = resolveInstance({ name: 'lab', components: ['linknotes', 'runner'], scope: { default: 'lab' }, paths: { state: './state', config: './config' },
    sources: [{ id: 'drop', family: 'jsonl', config: { dir: drop } }], intake: { everySeconds: 600, model: { provider: 'stub' } } }, { dir, home: path.join(dir, 'home') });
  const t0 = Date.parse('2026-11-08T00:00:00Z');
  const first = await runIntake(c, { now: t0 });
  assert.deepEqual(Object.keys(first), ['intake']);
  assert.equal(first.intake.polled, 1);
  assert.equal(first.intake.stored, 1);
  assert.equal(first.intake.derived, 1);
  assert.ok(first.intake.notes >= 1, JSON.stringify(first));
  assert.deepEqual(first.intake.errors, []);
  // not due again before everySeconds; due after it, and it picks up only what is new
  assert.deepEqual(await runIntake(c, { now: t0 + 60_000 }), {});
  appendFileSync(path.join(drop, 'a.jsonl'), `${JSON.stringify({ id: 'm2', text: 'Sam Rivera ordered a second Lab Boiler.', time: '2026-11-02T10:00:00Z' })}\n`);
  const again = await runIntake(c, { now: t0 + 601_000 });
  assert.equal(again.intake.stored, 1);
  assert.equal(again.intake.derived, 1);
  // --force runs it now whatever the schedule; nothing new is nothing stored
  const forced = await runIntake(c, { now: t0 + 602_000, force: true });
  assert.equal(forced.intake.stored, 0);
  // everything went into the runner's replica, as the instance scope, where the runner's own tools read it
  const { answer } = await import(path.join(componentDir('runner'), 'store/memory.mjs'));
  const db = path.join(dir, 'state/runner/memory.sqlite'), env = { TOPHAT_SCOPE: 'lab' };
  const hits = answer('search', { query: 'Boiler', limit: 20 }, { db, env });
  assert.equal(hits.code, 0, JSON.stringify(hits.result));
  assert.ok(hits.result.hits.some((h) => h.kind === 'raw'), JSON.stringify(hits.result.hits));
  assert.ok(hits.result.hits.some((h) => h.kind === 'note'), JSON.stringify(hits.result.hits));
  const state = JSON.parse(readFileSync(path.join(dir, 'state/upkeep/upkeep-state.json'), 'utf8'));
  assert.equal(state.jobs.intake.error, null);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'state/intake/sources-state.json'), 'utf8')).sources.drop.error, null);
});
