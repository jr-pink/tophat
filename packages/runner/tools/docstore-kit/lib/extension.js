// Docstore extensions v1, kit form (docs/EXTENSIONS-V1.md; DOCSTORE3-DESIGN.md section 22; rows #13 actor, #14 caused_by and
// derived intent ids, #40 capabilities). The manifest file is `extension.json`. Pure and dependency-free: a host (the chat server, the deploy CLI, a test) hands
// it manifests and entry functions and gets back a checked registration set, a load order and a capability-checked
// dispatcher. The kit never imports an extension and never touches I/O; loading files is the host's job.
//
// The one model: an extension is an application beside core. It registers named things (routes, commands, menu items,
// jobs, tools, reaction rules, health probes) through a recorder `x`; the manifest is a checked index of those
// registrations (`provides`) plus the hand-written permission surface (`capabilities`). A load is refused (declared
// means enforced, A10; EXTENSIONS-V1 section 10) when:
//   - the manifest has an unknown key, a bad id or version, or a capability on a core action the surface does not have;
//   - a registration is missing from `provides`, or `provides` names something never registered;
//   - a rule observes a type outside `capabilities.observe`, or a menu item names a command it may not dispatch;
//   - two registrations of one extension share a name (the old kit registry was last-wins by name);
//   - two extensions claim one single-valued slot (one route method+path, one command id, one tool name);
//   - a dependency is missing, out of range or cyclic (optional ones degrade instead);
//   - a rule dispatches a type in its own observe set without `reentry: 'guarded'` (emit-graph cycle, row #14).
// At run time every dispatch goes through `createDispatcher`: the capability check is step 2 of dispatch (section 5),
// the entry is stamped `actor: app:<id>` and `caused_by`, and a reaction's intent id is derived from its trigger
// (`<trigger id>.<ext id>.<rule>`, principle 5), so redelivery of one trigger makes one entry.

import { CapabilityViolationError, DocstoreError, ReactiveGraphCycleError } from './errors.js';

/** A load refused for a stated reason; `code` is stable (tests and the CLI switch on it). */
export class ExtensionError extends DocstoreError {
  static kind = 'boot';
  static status = 400;
}
// Fields never use `name`, `kind` or `status`: DocstoreError copies fields onto the error, and those are its own getters.
const refuse = (code, message, fields = {}) => { throw new ExtensionError({ ...fields }, { code, message }); };

/** Core's well-known surface v1 (EXTENSIONS-V1 section 6). Absolute actions only; a host maps each name onto its own
 * action contract and its test asserts every name is mapped. Extensions name these in `capabilities.dispatch|observe`. */
export const CORE_VERSION = '1.0.0';
export const CORE_SURFACE = Object.freeze({
  'core.chat.inbound': { payload: '{text, wire?, title?, conversationId?}', note: 'a message into a chat (new or named), as an automated event' },
  'core.chat.archive': { payload: '{id, on}' },
  'core.chat.markRead': { payload: '{id, read}' },
  'core.chat.rename': { payload: '{id, title}' },
  'core.chat.pin': { payload: '{id, on}' },
  'core.chat.move': { payload: '{id, folder}' },
  'core.chat.send': { payload: '{id, text}' },
  'core.chat.open': { payload: '{id}', note: 'client-side: opens a pane' },
  'core.voice.transcribe': { payload: '{bytes, mime}', note: 'a request: speech to text with the instance\'s recognizer; answers {text}' },
  'core.nav.palette': { payload: '{}', note: 'client-side' },
});

export const MANIFEST_KEYS = ['id', 'version', 'api', 'description', 'depends', 'optional', 'provides', 'capabilities', 'entry', 'runtime'];
export const PROVIDES_KEYS = ['routes', 'commands', 'menus', 'jobs', 'tools', 'rules', 'health'];
export const CAPABILITY_KEYS = ['read', 'dispatch', 'observe', 'guard'];
export const RUNTIMES = ['server'];
export const SLOTS = Object.freeze({
  'ui.sidebar.chatMenu': { multi: true },
  'ui.palette.commands': { multi: true },
  'http.route': { multi: false },
  'job.upkeep': { multi: true },
  'tool.bin': { multi: false },
  'health.fields': { multi: true },
});
const ID_RE = /^[a-z][a-z0-9-]{0,47}$/u;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/u;
const NAME_RE = /^[a-z][a-zA-Z0-9._-]{0,63}$/u;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- versions --------------------------------------------------------------------------------------------------------

export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v ?? ''));
  return m ? m.slice(1).map(Number) : null;
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/** Whether `version` is in `range`: `*`, `1.2.3` (exact), `^1.2.3`, `~1.2.3`, `>=1.2.3`. Anything else is refused. */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  const r = String(range ?? '').trim();
  if (r === '*' || r === '') return true;
  const op = /^(\^|~|>=)?/u.exec(r)[1] || '';
  // A range may name a partial version (^1, ~1.2): the missing parts are 0, as in npm.
  const partial = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(r.slice(op.length));
  if (!partial) refuse('BAD_RANGE', `version range "${range}" is not one of *, X[.Y[.Z]], ^X[.Y[.Z]], ~X[.Y[.Z]], >=X[.Y[.Z]]`);
  const base = partial.slice(1).map((n) => Number(n ?? 0));
  if (op === '') return cmp(v, base) === 0;
  if (op === '>=') return cmp(v, base) >= 0;
  if (cmp(v, base) < 0) return false;
  if (op === '~') return v[0] === base[0] && v[1] === base[1];
  return base[0] > 0 ? v[0] === base[0] : base[1] > 0 ? v[0] === 0 && v[1] === base[1] : cmp(v, base) === 0;
}

// ---- manifest --------------------------------------------------------------------------------------------------------

/** Validate and normalise one manifest (`docstore.extension.json`); throws ExtensionError. */
export function checkManifest(m, { where = 'manifest' } = {}) {
  if (!isObj(m)) refuse('BAD_MANIFEST', `${where}: not an object`);
  for (const k of Object.keys(m)) if (!MANIFEST_KEYS.includes(k)) refuse('UNKNOWN_KEY', `${where}: unknown key "${k}" (allowed: ${MANIFEST_KEYS.join(', ')})`, { key: k });
  if (!ID_RE.test(String(m.id ?? ''))) refuse('BAD_ID', `${where}: id must be lower case letters, digits and dashes`);
  if (m.id === 'core') refuse('BAD_ID', `${where}: "core" is reserved`);
  if (!parseVersion(m.version)) refuse('BAD_VERSION', `${where}: version must be X.Y.Z`);
  // `api` is the extension API version (1). Never a brand name: the public assembly renames brand words in every file,
  // and a wire key that is renamed in one build and not another is a format split.
  if (m.api !== undefined && m.api !== 1) refuse('BAD_API', `${where}: api must be 1 (this kit's extension API)`);
  const runtime = m.runtime ?? 'server';
  if (!RUNTIMES.includes(runtime)) refuse('BAD_RUNTIME', `${where}: runtime ${runtime} is not one of ${RUNTIMES.join(', ')} (device extensions are v2)`);
  for (const key of ['depends', 'optional']) {
    if (m[key] === undefined) continue;
    if (!isObj(m[key])) refuse('BAD_DEPENDS', `${where}: ${key} is { id: range }`);
    for (const [id, range] of Object.entries(m[key])) { if (id !== 'core' && !ID_RE.test(id)) refuse('BAD_DEPENDS', `${where}: ${key}.${id} is not an extension id`); satisfies('0.0.0', range); }
  }
  const provides = m.provides ?? {};
  if (!isObj(provides)) refuse('BAD_PROVIDES', `${where}: provides is an object`);
  for (const k of Object.keys(provides)) {
    if (!PROVIDES_KEYS.includes(k)) refuse('UNKNOWN_KEY', `${where}: unknown key provides.${k} (allowed: ${PROVIDES_KEYS.join(', ')})`, { key: `provides.${k}` });
    if (!Array.isArray(provides[k]) || provides[k].some((s) => typeof s !== 'string')) refuse('BAD_PROVIDES', `${where}: provides.${k} is a list of names`);
  }
  const caps = m.capabilities ?? {};
  if (!isObj(caps)) refuse('BAD_CAPABILITIES', `${where}: capabilities is an object`);
  for (const k of Object.keys(caps)) {
    if (!CAPABILITY_KEYS.includes(k)) refuse('UNKNOWN_KEY', `${where}: unknown key capabilities.${k} (allowed: ${CAPABILITY_KEYS.join(', ')})`, { key: `capabilities.${k}` });
    if (!Array.isArray(caps[k]) || caps[k].some((s) => typeof s !== 'string')) refuse('BAD_CAPABILITIES', `${where}: capabilities.${k} is a list of action types`);
    for (const t of caps[k]) if (t.startsWith('core.') && !CORE_SURFACE[t]) refuse('UNKNOWN_CORE_ACTION', `${where}: capabilities.${k} names ${t}, which core ${CORE_VERSION} does not publish`, { type: t });
  }
  if (caps.guard?.length) refuse('NOT_EXECUTED', `${where}: capabilities.guard is declared but no host executes extension guards in v1`);
  if (m.entry !== undefined && typeof m.entry !== 'string') refuse('BAD_ENTRY', `${where}: entry is a relative module path`);
  return {
    id: m.id, version: m.version, description: m.description ?? '', runtime, entry: m.entry ?? null,
    depends: { ...(m.depends ?? {}) }, optional: { ...(m.optional ?? {}) },
    provides: Object.fromEntries(PROVIDES_KEYS.map((k) => [k, [...(provides[k] ?? [])]])),
    capabilities: Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, [...(caps[k] ?? [])]])),
    declaredProvides: Object.keys(provides),
  };
}

// ---- dependency order ------------------------------------------------------------------------------------------------

/** Load order over `depends` (topological, ties by id). Returns { order, missingOptional, problems }; problems are
 * missing or out-of-range dependencies and cycles (each refuses the extensions involved). */
export function resolveOrder(manifests, { coreVersion = CORE_VERSION } = {}) {
  const byId = new Map();
  const problems = [];
  for (const m of manifests) {
    if (byId.has(m.id)) problems.push({ code: 'DUPLICATE_ID', id: m.id, message: `two extensions are named ${m.id}` });
    byId.set(m.id, m);
  }
  const missingOptional = {};
  const edges = new Map([...byId.keys()].map((id) => [id, []]));
  for (const m of byId.values()) {
    for (const [dep, range] of Object.entries(m.depends)) {
      const have = dep === 'core' ? coreVersion : byId.get(dep)?.version;
      if (!have) problems.push({ code: 'DEPENDENCY_MISSING', id: m.id, message: `${m.id} depends on ${dep} ${range}, which is not installed` });
      else if (!satisfies(have, range)) problems.push({ code: 'DEPENDENCY_RANGE', id: m.id, message: `${m.id} depends on ${dep} ${range}; installed ${have}` });
      else if (dep !== 'core') edges.get(m.id).push(dep);
    }
    for (const [dep, range] of Object.entries(m.optional)) {
      const have = dep === 'core' ? coreVersion : byId.get(dep)?.version;
      if (!have || !satisfies(have, range)) (missingOptional[m.id] ??= []).push(dep);
      else if (dep !== 'core') edges.get(m.id).push(dep);
    }
  }
  const cycles = findCycles(edges);
  for (const cycle of cycles) problems.push({ code: 'DEPENDENCY_CYCLE', id: cycle[0], cycle, message: `dependency cycle: ${cycle.join(' -> ')} -> ${cycle[0]}` });
  // A refused extension refuses everything that (transitively) depends on it.
  const bad = new Set(problems.map((p) => p.id));
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, deps] of edges) if (!bad.has(id) && deps.some((d) => bad.has(d))) { bad.add(id); grew = true; problems.push({ code: 'DEPENDENCY_REFUSED', id, message: `${id} depends on a refused extension` }); }
  }
  const order = [];
  const done = new Set();
  const visit = (id) => { if (done.has(id) || bad.has(id)) return; done.add(id); for (const d of [...edges.get(id)].sort()) visit(d); order.push(id); };
  for (const id of [...edges.keys()].sort()) visit(id);
  return { order, missingOptional, problems };
}

/** Tarjan's strongly connected components over `edges` (Map id -> [id]); returns every cycle (an SCC of size > 1, or a
 * self edge), each sorted. */
export function findCycles(edges) {
  let index = 0;
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = [];
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!edges.has(w)) continue;
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const scc = [];
      let w;
      do { w = stack.pop(); on.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1 || (edges.get(v) ?? []).includes(v)) out.push(scc.sort());
    }
  };
  for (const v of edges.keys()) if (!idx.has(v)) strong(v);
  return out;
}

// ---- registration ----------------------------------------------------------------------------------------------------

/** The intent id of a reaction: derived from its trigger, never random (A7, principle 5). */
export const derivedId = (triggerId, extId, rule) => `${triggerId}.${extId}.${rule}`;

/**
 * Run an extension's entry function against a recorder and check the result against its manifest.
 * `register` is the entry module's default export: `(x) => void`. Returns the registration set:
 * { manifest, routes, commands, menus, jobs, tools, rules, health }. Handlers stay as functions (a host calls them).
 */
export function recordExtension(manifest, register, { coreSurface = CORE_SURFACE } = {}) {
  const m = manifest;
  const reg = { manifest: m, routes: [], commands: [], menus: [], jobs: [], tools: [], rules: [], health: [] };
  const names = new Map();
  const claim = (kind, name) => {
    if (!['routes', 'menus'].includes(kind) && !NAME_RE.test(name)) refuse('BAD_NAME', `${m.id}: ${kind} name "${name}" must match ${NAME_RE}`);
    const key = `${kind}:${name}`;
    if (names.has(key)) refuse('DUPLICATE_NAME', `${m.id}: two ${kind} named ${name} (a registry is never last-wins)`, { registry: kind, item: name });
    names.set(key, true);
  };
  const fn = (v, what) => { if (typeof v !== 'function') refuse('BAD_REGISTRATION', `${m.id}: ${what} needs a function`); return v; };
  const x = Object.freeze({
    id: m.id,
    version: m.version,
    route(spec) {
      const method = String(spec?.method || 'GET').toUpperCase();
      const path = String(spec?.path || '');
      if (!/^\/[A-Za-z0-9/_.-]*$/u.test(path)) refuse('BAD_ROUTE', `${m.id}: route path "${path}" must be an absolute path without parameters`);
      if (!['session', 'own'].includes(spec?.auth)) refuse('BAD_ROUTE', `${m.id}: route ${method} ${path} must say auth: "session" (the owner's sign-in) or "own" (the handler checks its own credential)`);
      const name = `${method} ${path}`;
      claim('routes', name);
      reg.routes.push({ name, method, path, auth: spec.auth, handler: fn(spec.handler, `route ${name}`) });
    },
    command(id, spec = {}) {
      if (!String(id).startsWith(`ext.${m.id}.`)) refuse('BAD_NAME', `${m.id}: command ${id} must be named ext.${m.id}.<name>`);
      claim('commands', id);
      if (typeof spec.title !== 'string' || !spec.title) refuse('BAD_REGISTRATION', `${m.id}: command ${id} needs a title (it is what the palette lists)`);
      reg.commands.push({ id, title: spec.title, category: spec.category ?? null, when: spec.when ?? null, palette: spec.palette !== false, run: fn(spec.run, `command ${id}`) });
    },
    menu(slot, spec = {}) {
      if (!SLOTS[slot] || !slot.startsWith('ui.')) refuse('UNKNOWN_SLOT', `${m.id}: no UI slot ${slot} (known: ${Object.keys(SLOTS).filter((s) => s.startsWith('ui.')).join(', ')})`);
      const name = `${slot}:${spec.command}`;
      claim('menus', name);
      reg.menus.push({ name, slot, title: String(spec.title || ''), command: String(spec.command || ''), when: spec.when ?? null, priority: Number(spec.priority ?? 0) });
    },
    job(name, spec = {}) {
      claim('jobs', name);
      if (!Number.isInteger(spec.everySeconds) || spec.everySeconds < 60) refuse('BAD_JOB', `${m.id}: job ${name} needs everySeconds, a whole number >= 60`);
      reg.jobs.push({ name, everySeconds: spec.everySeconds, timeoutSeconds: spec.timeoutSeconds ?? 600, run: fn(spec.run, `job ${name}`) });
    },
    tool(name, relPath) {
      if (!/^[a-z][a-z0-9-]{1,47}$/u.test(String(name))) refuse('BAD_NAME', `${m.id}: tool name ${name}`);
      claim('tools', name);
      if (typeof relPath !== 'string' || relPath.startsWith('/') || relPath.includes('..')) refuse('BAD_TOOL', `${m.id}: tool ${name} path must be relative inside the extension`);
      reg.tools.push({ name, path: relPath });
    },
    on(rule, type, handler, opts = {}) {
      claim('rules', rule);
      if (!m.capabilities.observe.includes(type)) refuse('CAPABILITY_OBSERVE', `${m.id}: rule ${rule} observes ${type}, not in capabilities.observe`, { type });
      const emits = [...(opts.emits ?? [])];
      for (const t of emits) if (!mayDispatch(m, t)) refuse('CAPABILITY_DISPATCH', `${m.id}: rule ${rule} emits ${t}, not in capabilities.dispatch`, { type: t });
      if (emits.includes(type) && opts.reentry !== 'guarded') refuse('EMIT_CYCLE', `${m.id}: rule ${rule} observes ${type} and emits it; declare reentry: 'guarded' with a guard against re-entry`, { type });
      reg.rules.push({ name: rule, type, emits, runs: opts.runs ?? 'server', handler: fn(handler, `rule ${rule}`) });
    },
    health(name, probe) {
      claim('health', name);
      reg.health.push({ name, probe: fn(probe, `health ${name}`) });
    },
  });
  const r = register(x);
  if (r && typeof r.then === 'function') refuse('ASYNC_REGISTER', `${m.id}: the entry's register function must be synchronous (registration is a declaration, not I/O)`);
  for (const menu of reg.menus) {
    const own = reg.commands.some((c) => c.id === menu.command);
    // A menu item passes only its target ({id}); a core action whose absolute payload needs more ({id, on}) would run with
    // the value missing. Such an item names a command that states it.
    if (!own && menu.command.startsWith('core.') && CORE_SURFACE[menu.command] && CORE_SURFACE[menu.command].payload !== '{id}') refuse('MENU_PAYLOAD', `${m.id}: menu item ${menu.title} runs ${menu.command}, whose payload ${CORE_SURFACE[menu.command].payload} needs more than the chat id a menu passes; register a command that dispatches it with the value`, { type: menu.command });
    if (!own && !(menu.command.startsWith('core.') && mayDispatch(m, menu.command))) refuse('CAPABILITY_DISPATCH', `${m.id}: menu item ${menu.title} runs ${menu.command}, neither its own command nor a core action in capabilities.dispatch`, { type: menu.command });
    if (!menu.title) refuse('BAD_REGISTRATION', `${m.id}: menu item for ${menu.command} needs a title`);
  }
  for (const t of m.capabilities.dispatch) if (!t.startsWith('core.') && !t.startsWith('ext.')) refuse('BAD_CAPABILITIES', `${m.id}: capabilities.dispatch ${t} is neither core.* nor ext.*`);
  checkProvides(m, reg);
  void coreSurface;
  return reg;
}

function mayDispatch(m, type) {
  return type.startsWith(`ext.${m.id}.`) || m.capabilities.dispatch.includes(type);
}

/** provides <-> registrations, both ways, for every kind the manifest lists (a kind it omits must have no registration). */
function checkProvides(m, reg) {
  for (const kind of PROVIDES_KEYS) {
    const got = reg[kind].map((r) => r.name ?? r.id);
    const want = m.provides[kind];
    for (const n of got) if (!want.includes(n)) refuse('UNDECLARED_REGISTRATION', `${m.id}: registers ${kind} ${n}, missing from provides.${kind} (run the build step that writes provides, or add it)`, { registry: kind, item: n });
    for (const n of want) if (!got.includes(n)) refuse('UNREGISTERED_PROVIDES', `${m.id}: provides.${kind} names ${n}, which the entry never registers`, { registry: kind, item: n });
  }
}

/** The provides block a registration set implies (for `ext build --write-provides`). */
export function providesOf(reg) {
  const out = {};
  for (const kind of PROVIDES_KEYS) { const names = reg[kind].map((r) => r.name ?? r.id); if (names.length) out[kind] = names.sort(); }
  return out;
}

/** Collisions on single-valued slots across extensions: one route method+path, one command id, one tool name. */
export function slotCollisions(regs) {
  const problems = [];
  for (const [kind, label] of [['routes', 'route'], ['commands', 'command'], ['tools', 'tool']]) {
    const owner = new Map();
    for (const reg of regs) for (const r of reg[kind]) {
      const n = r.name ?? r.id;
      if (owner.has(n)) problems.push({ code: 'SLOT_COLLISION', id: reg.manifest.id, message: `${label} ${n} is claimed by ${owner.get(n)} and ${reg.manifest.id}` });
      else owner.set(n, reg.manifest.id);
    }
  }
  return problems;
}

/** A whole set: manifests + entry functions -> { order, regs (in order), refused: [{id, code, message}] }. A refused
 * extension (bad manifest, dependency, gate, collision) is left out with its reason; the rest load. */
export function loadSet(items, { coreVersion = CORE_VERSION } = {}) {
  const refused = [];
  const manifests = [];
  for (const it of items) {
    try { manifests.push(checkManifest(it.manifest, { where: it.where ?? it.manifest?.id })); }
    catch (e) { refused.push({ id: it.manifest?.id ?? '?', code: e.code, message: e.message }); }
  }
  const { order, problems, missingOptional } = resolveOrder(manifests, { coreVersion });
  for (const p of problems) refused.push({ id: p.id, code: p.code, message: p.message });
  const regs = [];
  for (const id of order) {
    const m = manifests.find((x) => x.id === id);
    const it = items.find((x) => x.manifest?.id === id);
    if (refused.some((r) => r.id === id)) continue;
    try { regs.push(recordExtension(m, it.register ?? (() => {}))); }
    catch (e) { refused.push({ id, code: e.code ?? 'REGISTER_THREW', message: e.message }); }
  }
  // Something depending on an extension refused at registration is refused too.
  const out = [];
  for (const reg of regs) {
    const deps = Object.keys(reg.manifest.depends).filter((d) => d !== 'core');
    if (deps.some((d) => refused.some((r) => r.id === d))) refused.push({ id: reg.manifest.id, code: 'DEPENDENCY_REFUSED', message: `${reg.manifest.id} depends on a refused extension` });
    else out.push(reg);
  }
  const collisions = slotCollisions(out);
  for (const c of collisions) refused.push({ id: c.id, code: c.code, message: c.message });
  const final = out.filter((r) => !collisions.some((c) => c.id === r.manifest.id));
  return { order: final.map((r) => r.manifest.id), regs: final, refused, missingOptional };
}

// ---- dispatch --------------------------------------------------------------------------------------------------------

/**
 * The capability-checked dispatch an extension's code receives as ctx.dispatch. `core(type, payload, meta)` is the host's
 * one dispatch path; meta = { id, actor, caused_by, correlation_id }. A type outside the manifest's dispatch capability
 * (and not the extension's own ext.<id>.*) throws CapabilityViolationError before anything is dispatched. An optional
 * dependency that is absent answers DEPENDENCY_MISSING instead of throwing (section 3).
 */
export function createDispatcher(manifest, core, { trigger = null, rule = null, missingOptional = [], mint = null } = {}) {
  const allowed = [...manifest.capabilities.dispatch];
  return async function dispatch(type, payload = {}, opts = {}) {
    const t = String(type);
    if (!mayDispatch(manifest, t)) throw new CapabilityViolationError({ app: `app:${manifest.id}`, attempted: t, allowed });
    const owner = t.startsWith('ext.') ? t.split('.')[1] : null;
    if (owner && owner !== manifest.id && missingOptional.includes(owner)) return { ok: false, code: 'DEPENDENCY_MISSING', type: t };
    const id = opts.id ?? (trigger ? derivedId(trigger.id, manifest.id, rule) : (mint ? mint() : null));
    if (!id) throw new ExtensionError({ app: manifest.id, type: t }, { code: 'NO_INTENT_ID', message: `${manifest.id}: dispatch ${t} outside a reaction needs opts.id (an intent id minted once, A7)` });
    const meta = { id, actor: `app:${manifest.id}`, caused_by: trigger?.id ?? opts.causedBy ?? null, correlation_id: trigger?.correlation_id ?? trigger?.id ?? id };
    return core(t, payload, meta);
  };
}

/** Run the rules observing one core action, after it was applied (never during replay; the host only calls this for
 * live actions). Each rule gets a dispatcher whose intent ids derive from the trigger. Errors are collected, not thrown:
 * one extension's failure never fails core's action. */
export async function runReactions(regs, action, core, { missingOptional = {} } = {}) {
  const results = [];
  for (const reg of regs) for (const rule of reg.rules) {
    if (rule.type !== action.type) continue;
    const dispatch = createDispatcher(reg.manifest, core, { trigger: action, rule: rule.name, missingOptional: missingOptional[reg.manifest.id] ?? [] });
    try { await rule.handler(action, { dispatch, ext: reg.manifest.id }); results.push({ ext: reg.manifest.id, rule: rule.name, ok: true }); }
    catch (e) { results.push({ ext: reg.manifest.id, rule: rule.name, ok: false, error: String(e?.message ?? e) }); }
  }
  return results;
}

export { CapabilityViolationError, ReactiveGraphCycleError };
