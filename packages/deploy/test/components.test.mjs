// The component manifest: structure, dependency order, the enabled-set check, the CLI, and agreement with each
// present package's own package.json dependencies.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACE, byId, check, closure, complete, dependents, list, loadManifest, topo, tree, validateManifest } from '../src/components.mjs';

const m = loadManifest();
const BIN = path.join(WORKSPACE, 'packages/linknotes/bin/tophat.mjs');
const cli = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8' });

test('the manifest covers every package directory and the app components', () => {
  const ids = m.components.map((c) => c.id);
  for (const id of ['linknotes', 'push', 'sources', 'retrieval', 'pull', 'tools', 'upkeep', 'verify', 'groups', 'viewer', 'hub', 'runner', 'webchat', 'deploy']) assert.ok(ids.includes(id), id);
  const listed = new Set(m.components.map((c) => c.path));
  for (const d of execFileSync('ls', [path.join(WORKSPACE, 'packages')], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
    if (existsSync(path.join(WORKSPACE, 'packages', d, 'package.json'))) assert.ok(listed.has(`packages/${d}`), `packages/${d} is in tophat.components.json`);
  }
});

test('each present package depends only on packages of its manifest dependencies (or itself)', () => {
  for (const c of m.components) {
    const pj = path.join(WORKSPACE, c.path, 'package.json');
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, 'utf8'));
    assert.equal(p.name, c.package, `${c.id}: package name`);
    const allowed = new Set(closure(m, [c.id]).map((id) => byId(m, id).package));
    for (const dep of Object.keys(p.dependencies || {}).filter((d) => d.startsWith('@tophat-md/'))) assert.ok(allowed.has(dep), `${c.id} imports ${dep} but the manifest does not list it as a dependency`);
  }
});

test('dependency order puts dependencies first; required components need nothing optional', () => {
  const order = topo(m);
  for (const c of m.components) for (const d of c.depends) assert.ok(order.indexOf(d) < order.indexOf(c.id), `${d} before ${c.id}`);
  assert.deepEqual(m.components.filter((c) => !c.optional).map((c) => c.id), ['linknotes']);
});

test('validation refuses cycles, unknown dependencies, duplicates, missing fields and removable required parts', () => {
  const base = (cs) => ({ components: cs.map((c) => ({ package: `p-${c.id}`, provides: [], optional: true, removable: true, depends: [], ...c })) });
  assert.throws(() => validateManifest(base([{ id: 'a', depends: ['b'] }, { id: 'b', depends: ['a'] }])), /cycle a -> b -> a/);
  assert.throws(() => validateManifest(base([{ id: 'a', depends: ['zz'] }])), /unknown zz/);
  assert.throws(() => validateManifest(base([{ id: 'a' }, { id: 'a' }])), /duplicate/);
  assert.throws(() => validateManifest({ components: [{ id: 'a', package: 'x', depends: [] }] }), /lacks "optional"/);
  assert.throws(() => validateManifest(base([{ id: 'a', optional: false, removable: true }])), /cannot be removable/);
  assert.throws(() => validateManifest(base([{ id: 'a', optional: false, removable: false, depends: ['b'] }, { id: 'b' }])), /required a needs optional b/);
});

test('check: every dependency of an enabled component must be enabled; required parts must be on', () => {
  assert.equal(check(m, ['linknotes']).ok, true);
  const r = check(m, ['linknotes', 'webchat']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems.map((p) => [p.kind, p.component, p.dependency]), [['missing-dependency', 'webchat', 'runner']]);
  assert.deepEqual(check(m, ['push']).problems.map((p) => p.kind).sort(), ['missing-dependency', 'missing-dependency', 'required']);
  assert.equal(check(m, ['linknotes', 'nope']).problems[0].kind, 'unknown');
  assert.deepEqual(complete(m, ['pull']), m.order.filter((id) => ['linknotes', 'sources', 'push', 'retrieval', 'pull'].includes(id)));
  assert.equal(check(m, complete(m, ['webchat', 'upkeep', 'deploy'])).ok, true);
  assert.equal(check(m, ['linknotes', 'viewer'], { root: WORKSPACE }).ok, true);
  const empty = mkdtempSync(path.join(os.tmpdir(), 'components-'));
  assert.equal(check(m, ['linknotes', 'viewer'], { root: empty }).problems.some((p) => p.kind === 'absent' && p.component === 'viewer'), true, 'an enabled component whose package is missing is absent');
});

test('removable components: removing one breaks only its dependents', () => {
  assert.deepEqual(dependents(m, 'runner'), ['webchat']);
  assert.deepEqual(dependents(m, 'webchat'), []);
  assert.ok(dependents(m, 'linknotes').length >= 8);
  for (const c of m.components.filter((x) => x.removable)) {
    const rest = m.components.map((x) => x.id).filter((id) => id !== c.id && !dependents(m, c.id).includes(id));
    assert.equal(check(m, rest).ok, true, `without ${c.id} and its dependents the rest is consistent`);
  }
});

test('list and tree', () => {
  const rows = list(m);
  assert.equal(rows.find((r) => r.id === 'viewer').present, true);
  assert.equal(list(m, { root: mkdtempSync(path.join(os.tmpdir(), 'components-')) }).find((r) => r.id === 'viewer').present, false);
  assert.equal(rows.find((r) => r.id === 'linknotes').present, true);
  const t = tree(m, ['webchat']);
  assert.equal(t, 'webchat\n  runner\n    linknotes (required)');
  assert.match(tree(m), /^pull$/m);
});

test('CLI: tophat components list / tree / check', () => {
  const l = cli('components', 'list', '--json');
  assert.equal(l.status, 0, l.stderr);
  assert.equal(JSON.parse(l.stdout).length, m.components.length);
  assert.match(cli('components', 'tree', 'pull').stdout, /pull\n {2}linknotes \(required\)\n {2}push/);
  const bad = cli('components', 'check', 'linknotes', 'webchat');
  assert.equal(bad.status, 1);
  const r = JSON.parse(bad.stdout);
  assert.equal(r.ok, false); assert.deepEqual(r.suggestion, ['linknotes', 'runner', 'webchat']);
  assert.equal(cli('components', 'check', 'linknotes', 'runner', 'webchat').status, 0);
  assert.equal(cli('components', 'nope').status, 2);
});
