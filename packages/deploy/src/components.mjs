// The component manifest (tophat.components.json at the workspace root): load, validate, list, tree and check an
// enabled set against it. Pure functions over the parsed manifest; the CLI in bin/tophat-deploy.mjs prints them.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const MANIFEST_FILE = path.join(WORKSPACE, 'tophat.components.json');
const FIELDS = ['id', 'package', 'depends', 'optional', 'provides', 'removable'];

/** Parse and validate a manifest object; throws on the first structural problem. */
export function validateManifest(m) {
  if (!m || !Array.isArray(m.components)) throw new Error('manifest: "components" must be an array');
  const ids = new Set();
  for (const c of m.components) {
    for (const f of FIELDS) if (!(f in c)) throw new Error(`manifest: component ${c.id ?? '?'} lacks "${f}"`);
    if (!/^[a-z][a-z0-9-]*$/.test(c.id)) throw new Error(`manifest: bad id ${JSON.stringify(c.id)}`);
    if (ids.has(c.id)) throw new Error(`manifest: duplicate id ${c.id}`);
    ids.add(c.id);
    if (!Array.isArray(c.depends) || !Array.isArray(c.provides)) throw new Error(`manifest: ${c.id}: depends and provides are arrays`);
    if (typeof c.optional !== 'boolean' || typeof c.removable !== 'boolean') throw new Error(`manifest: ${c.id}: optional and removable are booleans`);
    if (!c.optional && c.removable) throw new Error(`manifest: ${c.id}: a required component cannot be removable`);
  }
  for (const c of m.components) for (const d of c.depends) {
    if (!ids.has(d)) throw new Error(`manifest: ${c.id} depends on unknown ${d}`);
    if (d === c.id) throw new Error(`manifest: ${c.id} depends on itself`);
  }
  const order = topo(m);
  for (const c of m.components) if (!c.optional) for (const d of closure(m, [c.id])) if (byId(m, d).optional) throw new Error(`manifest: required ${c.id} needs optional ${d}`);
  return { ...m, order };
}

export function loadManifest(file = MANIFEST_FILE) {
  if (!existsSync(file)) throw new Error(`no component manifest at ${file}`);
  return validateManifest(JSON.parse(readFileSync(file, 'utf8')));
}

export const byId = (m, id) => {
  const c = m.components.find((x) => x.id === id);
  if (!c) throw new Error(`unknown component ${id}`);
  return c;
};

/** Dependency order (dependencies first); throws naming a cycle. */
export function topo(m) {
  const out = [], state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') throw new Error(`manifest: dependency cycle ${[...trail, id].join(' -> ')}`);
    state.set(id, 'open');
    for (const d of byId(m, id).depends) visit(d, [...trail, id]);
    state.set(id, 'done');
    out.push(id);
  };
  for (const c of m.components) visit(c.id, []);
  return out;
}

/** Every component the given ids need, themselves included. */
export function closure(m, ids) {
  const seen = new Set();
  const go = (id) => { if (seen.has(id)) return; seen.add(id); for (const d of byId(m, id).depends) go(d); };
  ids.forEach(go);
  return [...seen];
}

/** Components that (transitively) depend on id. */
export function dependents(m, id) {
  return m.components.filter((c) => c.id !== id && closure(m, [c.id]).includes(id)).map((c) => c.id);
}

/**
 * Check an enabled set: every dependency of an enabled component is enabled, every required component is enabled,
 * every id is known, and (with `root`) every enabled component's package directory is present.
 */
export function check(m, enabled, { root = null } = {}) {
  const problems = [];
  const on = new Set(enabled);
  for (const id of on) if (!m.components.some((c) => c.id === id)) problems.push({ kind: 'unknown', component: id, message: `${id} is not a component` });
  for (const c of m.components) {
    if (!c.optional && !on.has(c.id)) problems.push({ kind: 'required', component: c.id, message: `${c.id} is required and not enabled` });
    if (!on.has(c.id)) continue;
    for (const d of c.depends) if (!on.has(d)) problems.push({ kind: 'missing-dependency', component: c.id, dependency: d, message: `${c.id} needs ${d}, which is not enabled` });
    if (root && (c.present === false || !existsSync(path.join(root, c.path, 'package.json')))) problems.push({ kind: 'absent', component: c.id, message: `${c.id} is enabled but ${c.path} is not in this workspace` });
  }
  return { ok: problems.length === 0, problems };
}

/** The smallest valid enabled set containing ids: their closure plus every required component. */
export function complete(m, ids) {
  const want = closure(m, [...ids, ...m.components.filter((c) => !c.optional).map((c) => c.id)]);
  return m.order.filter((id) => want.includes(id));
}

export function list(m, { root = WORKSPACE } = {}) {
  return m.order.map((id) => {
    const c = byId(m, id);
    return { id, package: c.package, depends: c.depends, optional: c.optional, removable: c.removable, present: c.present !== false && existsSync(path.join(root, c.path, 'package.json')), provides: c.provides };
  });
}

/** An indented dependency tree, one line per edge, from the components nothing depends on. */
export function tree(m, ids = null) {
  const roots = ids ?? m.order.filter((id) => !m.components.some((c) => c.depends.includes(id))).reverse();
  const lines = [];
  const go = (id, depth, trail) => {
    lines.push(`${'  '.repeat(depth)}${id}${byId(m, id).optional ? '' : ' (required)'}`);
    for (const d of byId(m, id).depends) if (!trail.includes(d)) go(d, depth + 1, [...trail, d]);
  };
  for (const r of roots) go(r, 0, [r]);
  return lines.join('\n');
}
