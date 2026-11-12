// Extensions host (docs/EXTENSIONS-V1.md in the Docstore kit): loads the instance's server extensions once per process and
// serves their slots. Everything an extension may do goes through the kit's lib/extension.js gate (manifest, provides,
// capabilities, dependency order, slot collisions) and its capability-checked dispatcher; this file only maps the core
// surface onto the chat's own action contract and serves the slots (http.route, ui.sidebar.chatMenu, ui.palette.commands,
// health.fields, reactions).
//
// Which extensions: TOPHAT_EXTENSIONS_FILE names the resolved set the deploy step wrote (`tophat ext build`), a JSON
// { extensions: [{ id, dir, manifest }] }. Without it there are no extensions and every slot is empty: an instance
// without extensions runs exactly as before.
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE_SURFACE, CORE_VERSION, createDispatcher, loadSet, runReactions } from '../../../../runner/tools/docstore-kit/lib/extension.js';
import { ACTIONS, makeAction } from '../core/contract.js';

const KEY = Symbol.for('tophat.webchat.extensions');

/** The chat action op behind each core.chat.* type, and how its payload maps (absolute actions only). */
export const CORE_CHAT_MAP = Object.freeze({
  'core.chat.archive': { op: ACTIONS.ARCHIVE, payload: (p) => ({ archived: Boolean(p.on) }) },
  'core.chat.markRead': { op: ACTIONS.READ, payload: (p) => ({ read: Boolean(p.read) }) },
  'core.chat.rename': { op: ACTIONS.RENAME, payload: (p) => ({ title: String(p.title ?? '') }) },
  'core.chat.pin': { op: ACTIONS.PIN, payload: (p) => ({ pinned: Boolean(p.on) }) },
  'core.chat.move': { op: ACTIONS.WORKSPACE, payload: (p) => ({ workspace: p.folder ?? null }) },
  'core.chat.send': { op: ACTIONS.SEND, payload: (p) => ({ text: String(p.text ?? '') }) },
});
/** core types served by this host outside the chat action contract. */
const SERVICE_TYPES = ['core.chat.inbound', 'core.voice.transcribe'];
/** core types that only a client can run (a pane, the palette); a server dispatch of one is refused. */
const CLIENT_TYPES = ['core.chat.open', 'core.nav.palette'];

/** op -> core type, for reactions observing the owner's own actions. */
const OP_TO_TYPE = Object.fromEntries(Object.entries(CORE_CHAT_MAP).map(([type, m]) => [m.op, type]));
const PAYLOAD_BACK = {
  'core.chat.archive': (p, id) => ({ id, on: Boolean(p.archived) }),
  'core.chat.markRead': (p, id) => ({ id, read: p.read !== false }),
  'core.chat.rename': (p, id) => ({ id, title: p.title }),
  'core.chat.pin': (p, id) => ({ id, on: Boolean(p.pinned) }),
  'core.chat.move': (p, id) => ({ id, folder: p.workspace ?? null }),
  'core.chat.send': (p, id) => ({ id, text: p.text }),
};

/** Every name of the kit's core surface has an implementation here (tests pin it). */
export const SERVED_CORE_TYPES = [...Object.keys(CORE_CHAT_MAP), ...SERVICE_TYPES, ...CLIENT_TYPES];

let deviceSeq = Date.now();

/** The one core dispatch path extensions reach (after the kit's capability check). `deps` is injected so tests can
 * run it without a server: { store, applyAction, inbound, transcribe }. */
export function coreDispatch(deps) {
  return async function core(type, payload, meta) {
    const p = payload || {};
    const attribution = { actor: meta.actor, basis: 'extension', source: meta.actor, causedBy: meta.caused_by ?? null, authorVerified: true };
    if (type === 'core.chat.inbound') return deps.inbound({ ...p, actionId: meta.id });
    if (type === 'core.voice.transcribe') return deps.transcribe(p);
    if (CLIENT_TYPES.includes(type)) return { ok: false, code: 'CLIENT_ONLY', type };
    const map = CORE_CHAT_MAP[type];
    if (!map) return { ok: false, code: 'UNKNOWN_CORE_ACTION', type };
    if (!p.id) return { ok: false, code: 'NO_TARGET', type };
    const seen = deps.store.appliedAction(meta.id);
    if (seen) return { ok: true, duplicate: true, id: meta.id };
    const action = makeAction({ op: map.op, conversationId: String(p.id), payload: map.payload(p), deviceId: meta.actor, deviceSeq: ++deviceSeq, actionId: meta.id });
    const before = deps.store.cursor();
    deps.applyAction(action, { attribution });
    deps.store.markApplied({ actionId: meta.id, conversationId: action.conversation_id, op: action.op, cursorBefore: before, cursorAfter: deps.store.cursor() });
    return { ok: true, id: meta.id };
  };
}

/** Load (once) the extensions named by the environment. deps: as coreDispatch, plus { secretsDir, stateDir, log }. */
export async function loadExtensions({ env = process.env, deps, file = env.TOPHAT_EXTENSIONS_FILE } = {}) {
  const empty = { file: null, regs: [], refused: [], order: [], missingOptional: {}, core: null, startedAt: null };
  if (!file) return empty;
  let resolved;
  try { resolved = JSON.parse(await readFile(file, 'utf8')); }
  catch (cause) {
    // Not built yet (no `tophat ext build` has run) means no extensions; an unreadable file is reported.
    if (cause?.code === 'ENOENT') return { ...empty, file };
    return { ...empty, file, refused: [{ id: '*', code: 'RESOLVED_UNREADABLE', message: `${file}: ${cause.message}` }] };
  }
  const items = [];
  for (const e of resolved.extensions || []) {
    const item = { manifest: e.manifest, where: e.dir, dir: e.dir, register: () => {} };
    if (e.manifest?.entry) {
      try {
        const mod = await import(/* @vite-ignore */ pathToFileURL(path.join(e.dir, e.manifest.entry)).href);
        item.register = typeof mod.default === 'function' ? mod.default : () => { throw new Error('the entry has no default export (register function)'); };
      } catch (cause) { item.register = () => { throw new Error(`entry failed to import: ${cause.message}`); }; }
    }
    items.push(item);
  }
  const set = loadSet(items, { coreVersion: CORE_VERSION });
  for (const reg of set.regs) reg.dir = items.find((i) => i.manifest.id === reg.manifest.id)?.dir;
  const core = deps ? coreDispatch(deps) : null;
  for (const r of set.refused) console.error(`[extensions] refused ${r.id}: ${r.code}: ${r.message}`);
  if (set.regs.length) console.log(`[extensions] loaded ${set.order.join(', ')}`);
  return { file, ...set, core, deps, startedAt: new Date().toISOString() };
}

/** The process-wide host: loaded at most once (a hot swap that re-imports this module adopts it). */
export function extensionsHost() { return globalThis[KEY] ?? null; }
export async function startExtensions(opts) {
  if (globalThis[KEY]) return globalThis[KEY];
  const host = await loadExtensions(opts);
  globalThis[KEY] = host;
  return host;
}

/** The context an extension's handler gets. Outside a reaction, a dispatch needs opts.id (an intent id minted once). */
export function contextFor(host, reg, { trigger = null, rule = null } = {}) {
  const ext = reg.manifest.id;
  const stateDir = path.join(host.deps?.stateDir || '/tmp', 'extensions', ext);
  return {
    ext,
    version: reg.manifest.version,
    dir: reg.dir,
    dispatch: createDispatcher(reg.manifest, observingCore(host), { trigger, rule, missingOptional: host.missingOptional[ext] ?? [] }),
    secret: (name) => readSecretFile(host.deps?.secretsDir, name), // a promise of the value, or null
    stateDir: () => { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); return stateDir; },
    log: (...a) => console.log(`[ext ${ext}]`, ...a),
  };
}

async function readSecretFile(dir, name) {
  if (!dir || !/^[A-Za-z0-9._-]+$/u.test(String(name))) return null;
  try { return (await readFile(path.join(dir, name), 'utf8')).trim() || null; } catch { return null; }
}

/** Core dispatch whose successful chat actions are observed by every extension's rules (after the fold, never in replay). */
function observingCore(host) {
  return async (type, payload, meta) => {
    const r = await host.core(type, payload, meta);
    if (r?.ok && !r.duplicate && CORE_CHAT_MAP[type]) await observe(host, { id: meta.id, type, payload, actor: meta.actor, caused_by: meta.caused_by, correlation_id: meta.correlation_id });
    return r;
  };
}

/** Run the reactions to one live core action. Called by /api/actions after an owner action is applied. */
export async function observe(host, action) {
  if (!host?.regs?.length) return [];
  return runReactions(host.regs, action, observingCore(host), { missingOptional: host.missingOptional });
}

/** An owner action (the chat contract) as a core action, or null when core does not publish its op. */
export function coreActionOf(action, actor = 'user') {
  const type = OP_TO_TYPE[action.op];
  if (!type) return null;
  return { id: action.action_id, type, payload: PAYLOAD_BACK[type](action.payload || {}, action.conversation_id), actor, caused_by: null, correlation_id: action.action_id };
}

/** The route an extension serves at this method and path, or null. */
export function routeFor(host, method, pathname) {
  if (!host?.regs?.length) return null;
  for (const reg of host.regs) for (const r of reg.routes) if (r.method === method && r.path === pathname) return { reg, route: r };
  return null;
}

/** UI contributions as data (EXTENSIONS-V1 section 6): menu items and palette commands, never components. */
export function contributions(host) {
  const regs = host?.regs || [];
  const menus = regs.flatMap((reg) => reg.menus.map((m) => ({ ext: reg.manifest.id, slot: m.slot, title: m.title, command: m.command, when: m.when, priority: m.priority })))
    .sort((a, b) => (b.priority - a.priority) || a.ext.localeCompare(b.ext));
  const commands = regs.flatMap((reg) => reg.commands.filter((c) => c.palette).map((c) => ({ ext: reg.manifest.id, id: c.id, title: c.title, category: c.category, when: c.when })))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { core: CORE_VERSION, menus, commands };
}

/** Run a command by id (the palette, a menu item, an agent): its own run(), or a core action it may dispatch. */
export async function runCommand(host, { command, args = {}, id }) {
  if (!id) return { ok: false, status: 400, error: 'a command run needs an intent id' };
  for (const reg of host?.regs || []) {
    const cmd = reg.commands.find((c) => c.id === command);
    if (cmd) {
      const ctx = contextFor(host, reg);
      const intent = (suffix = '') => `${id}${suffix}`;
      const result = await cmd.run(args, { ...ctx, dispatch: (type, payload, opts = {}) => ctx.dispatch(type, payload, { id: opts.id ?? intent(`.${type}`), ...opts }) });
      return { ok: true, result: result ?? null };
    }
    const menu = reg.menus.find((m) => m.command === command && command.startsWith('core.'));
    if (menu) {
      const ctx = contextFor(host, reg);
      return { ok: true, result: await ctx.dispatch(command, args, { id }) };
    }
  }
  return { ok: false, status: 404, error: `no extension command ${command}` };
}

/** The `extensions` field of /api/health: what is loaded, at which version, what was refused, and each probe. */
export async function healthOf(host) {
  if (!host) return { loaded: [], refused: [] };
  const loaded = [];
  for (const reg of host.regs) {
    const probes = {};
    for (const h of reg.health) {
      try { probes[h.name] = await Promise.race([Promise.resolve(h.probe(contextFor(host, reg))), new Promise((r) => setTimeout(() => r({ ok: false, error: 'timeout' }), 1500))]); }
      catch (cause) { probes[h.name] = { ok: false, error: String(cause?.message ?? cause) }; }
    }
    loaded.push({ id: reg.manifest.id, version: reg.manifest.version, ...(Object.keys(probes).length ? { probes } : {}) });
  }
  return { file: host.file, core: CORE_VERSION, loaded, refused: host.refused };
}

export { CORE_SURFACE };
