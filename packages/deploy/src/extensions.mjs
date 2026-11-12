// Extensions on an instance (extensions v1, docs/extensions.md): the instance file's `extensions` block names directories of extension
// packages (each a directory with extension.json and an entry module); `tophat ext build` checks the set with the
// kit's gate (runner/tools/docstore-kit/lib/extension.js: manifest, provides <-> registrations, capabilities, dependency
// order, slot collisions) and writes the resolved set the webchat loads (<state>/extensions/resolved.json, named to it by
// TOPHAT_EXTENSIONS_FILE) plus the tools the set provides (<state>/extensions/bin, first on the children's PATH).
// Extension code runs in-process and is trusted (v1); the capability check is at dispatch, not a sandbox.
//
//   "extensions": { "dirs": ["~/projects/me/extensions"], "disable": ["some-id"] }
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { componentDir } from './start.mjs';

export const MANIFEST = 'extension.json';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate the instance file's extensions block (called by resolveInstance); paths are already expanded. */
export function validateExtensionsBlock(x) {
  if (x === null || x === undefined) return null;
  if (!isObj(x)) throw new Error('instance config: extensions is { dirs: [PATH], disable?: [ID] }');
  for (const k of Object.keys(x)) if (!['dirs', 'disable'].includes(k)) throw new Error(`instance config: unknown key extensions.${k}`);
  if (!Array.isArray(x.dirs) || !x.dirs.length || x.dirs.some((d) => typeof d !== 'string' || !d)) throw new Error('instance config: extensions.dirs is a non-empty list of directories');
  if (x.disable !== undefined && (!Array.isArray(x.disable) || x.disable.some((d) => typeof d !== 'string'))) throw new Error('instance config: extensions.disable is a list of extension ids');
  return { dirs: [...x.dirs], disable: [...(x.disable || [])] };
}

export const extensionsDir = (c) => path.join(c.paths.state, 'extensions');
export const resolvedFile = (c) => path.join(extensionsDir(c), 'resolved.json');
export const binDir = (c) => path.join(extensionsDir(c), 'bin');

/** Every extension package under the configured dirs: a dir holding a manifest is one; otherwise each child that does. */
export function discover(c) {
  const out = [];
  for (const d of c.extensions?.dirs || []) {
    const dir = path.resolve(d);
    if (!existsSync(dir)) throw new Error(`extensions.dirs: ${dir} does not exist`);
    const one = (p) => { const f = path.join(p, MANIFEST); if (existsSync(f)) out.push({ dir: p, manifestFile: f }); };
    if (existsSync(path.join(dir, MANIFEST))) one(dir);
    else for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) if (e.isDirectory() && !e.name.startsWith('.')) one(path.join(dir, e.name));
  }
  return out;
}

/** The kit's extension module, from the installed runner package (one implementation of the gate). */
export async function kitExtension({ root } = {}) {
  const runner = componentDir('runner', root ? { root } : {});
  if (!runner) throw new Error('extensions need the runner package (it carries the docstore kit)');
  const file = path.join(runner, 'tools', 'docstore-kit', 'lib', 'extension.js');
  if (!existsSync(file)) throw new Error(`this tophat release has no extension gate (${file} is missing): update tophat`);
  return import(pathToFileURL(file).href);
}

/** Load and check the set without writing anything: { order, regs, refused, disabled, items }. */
export async function checkExtensions(c, { root } = {}) {
  const kit = await kitExtension({ root });
  const disabled = new Set(c.extensions?.disable || []);
  const items = [];
  for (const { dir, manifestFile } of discover(c)) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); } catch (e) { items.push({ manifest: { id: path.basename(dir) }, where: manifestFile, dir, register: () => { throw new Error(`${MANIFEST}: ${e.message}`); } }); continue; }
    if (disabled.has(manifest?.id)) continue;
    let register = () => {};
    if (typeof manifest?.entry === 'string') {
      try {
        const mod = await import(pathToFileURL(path.join(dir, manifest.entry)).href);
        register = typeof mod.default === 'function' ? mod.default : () => { throw new Error('the entry has no default export'); };
      } catch (e) { register = () => { throw new Error(`entry failed to import: ${e.message}`); }; }
    }
    items.push({ manifest, where: manifestFile, dir, register });
  }
  const set = kit.loadSet(items);
  // A tool the manifest provides must exist on disk (a dangling link is a provides that lies): the extension is refused.
  for (const reg of [...set.regs]) {
    const it = items.find((i) => i.manifest.id === reg.manifest.id);
    const missing = reg.tools.filter((t) => !existsSync(path.join(it.dir, t.path)));
    if (missing.length) {
      set.regs = set.regs.filter((r) => r !== reg);
      set.order = set.order.filter((id) => id !== reg.manifest.id);
      set.refused.push({ id: reg.manifest.id, code: 'TOOL_MISSING', message: `${reg.manifest.id}: tool ${missing.map((t) => `${t.name} (${path.join(it.dir, t.path)})`).join(', ')} does not exist` });
    }
  }
  return { ...set, disabled: [...disabled], items, kit };
}

/** Write the resolved set and the tool links. Atomic (temp + rename); tools no longer provided are unlinked. */
export async function buildExtensions(c, { root } = {}) {
  const r = await checkExtensions(c, { root });
  const dir = extensionsDir(c), bin = binDir(c);
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const extensions = r.regs.map((reg) => {
    const it = r.items.find((i) => i.manifest.id === reg.manifest.id);
    return {
      id: reg.manifest.id, version: reg.manifest.version, dir: it.dir, manifest: JSON.parse(readFileSync(it.where, 'utf8')),
      jobs: reg.jobs.map((j) => ({ name: j.name, everySeconds: j.everySeconds, timeoutSeconds: j.timeoutSeconds })),
      tools: reg.tools.map((t) => ({ name: t.name, path: path.join(it.dir, t.path) })),
    };
  });
  const body = { built: new Date().toISOString(), order: r.order, extensions, refused: r.refused };
  const tmp = `${resolvedFile(c)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, resolvedFile(c));
  const want = new Map(extensions.flatMap((e) => e.tools.map((t) => [t.name, t.path])));
  for (const name of readdirSync(bin)) {
    const f = path.join(bin, name);
    if (!want.has(name) && lstatSync(f).isSymbolicLink()) rmSync(f);
  }
  for (const [name, target] of want) {
    const f = path.join(bin, name);
    try { rmSync(f, { force: true }); } catch { /* none */ }
    symlinkSync(target, f);
  }
  return { file: resolvedFile(c), bin, order: r.order, refused: r.refused, disabled: r.disabled, tools: [...want.keys()], jobs: extensions.flatMap((e) => e.jobs.map((j) => `${e.id}/${j.name}`)) };
}

/** The resolved set as last built (sync; for instanceJobs), or null. */
export function readResolved(c) {
  try { return JSON.parse(readFileSync(resolvedFile(c), 'utf8')); } catch { return null; }
}

/** Run one extension job once (the job unit's command). ctx.dispatch posts to the running instance's loopback
 * /api/ext/dispatch with the service token, so the capability check and core's one dispatch path stay in the server. */
export async function runJob(c, { id, job, root, fetcher = fetch, secrets = null }) {
  const r = await checkExtensions(c, { root });
  const reg = r.regs.find((x) => x.manifest.id === id);
  if (!reg) throw new Error(`extension ${id} is not loaded${r.refused.some((x) => x.id === id) ? `: ${r.refused.find((x) => x.id === id).message}` : ''}`);
  const j = reg.jobs.find((x) => x.name === job);
  if (!j) throw new Error(`extension ${id} has no job ${job}`);
  const token = secrets ?? (() => { try { return readFileSync(path.join(c.paths.secrets, 'webchat-service-token'), 'utf8').trim(); } catch { return null; } })();
  const it = r.items.find((i) => i.manifest.id === id);
  const stateDir = path.join(extensionsDir(c), 'state', id);
  const ctx = {
    ext: id, version: reg.manifest.version, dir: it.dir,
    stateDir: () => { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); return stateDir; },
    secret: (name) => { if (!/^[A-Za-z0-9._-]+$/u.test(String(name))) return null; try { return readFileSync(path.join(c.paths.secrets, name), 'utf8').trim() || null; } catch { return null; } },
    log: (...a) => console.log(`[ext ${id}/${job}]`, ...a),
    dispatch: async (type, payload = {}, opts = {}) => {
      if (!opts.id) throw new Error(`${id}: a job's dispatch needs opts.id (an intent id minted once, e.g. from the scheduled slot)`);
      const res = await fetcher(`http://127.0.0.1:${c.ports.webchat}/api/ext/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ ext: id, type, payload, id: opts.id }) });
      return res.json().catch(() => ({ ok: false, status: res.status }));
    },
  };
  const started = Date.now();
  const result = await Promise.race([Promise.resolve(j.run(ctx)), new Promise((_, no) => setTimeout(() => no(new Error(`job ${id}/${job} passed its ${j.timeoutSeconds}s deadline`)), j.timeoutSeconds * 1000).unref())]);
  return { ok: true, id, job, ms: Date.now() - started, result: result ?? null };
}
