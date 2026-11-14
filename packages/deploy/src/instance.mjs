// The instance config (tophat.instance.json): everything that makes one running tophat differ from another. A personal
// assistant, a team assistant and a group runner are the same packages with different files of this shape. Secrets are
// never values here: a credential is a reference ({ env: NAME } or { keyring: NAME } or { file: PATH }) resolved at start.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binDir, readResolved, resolvedFile, validateExtensionsBlock } from './extensions.mjs';

const TOP = ['name', 'owner', 'scope', 'hosts', 'ports', 'paths', 'devices', 'models', 'components', 'runner', 'webchat', 'deploy', 'sources', 'hub', 'intake', 'extensions', 'update', 'note'];
const REF_KEYS = ['env', 'keyring', 'file'];
const SCOPE_NAME = /^[a-z][a-z0-9-]{1,47}$/;

/** The shared hub of the tophat-users memory group (ciphertext only). Written into an instance file only by `tophat instance join`. */
export const COMMUNITY_HUB_URL = 'https://hub.tophat.md';
/** The keyring entry a hub token is read from when `hub.token` names none (it may not exist yet: the token is issued later). */
export const HUB_TOKEN_KEYRING = 'hub-token';

export const DEFAULTS = Object.freeze({
  owner: { label: 'the owner', addresses: [] },
  scope: { default: null, groups: [], join: [] },
  hosts: { public: null, bind: '127.0.0.1' },
  ports: { webchat: 4178 },
  paths: {},
  devices: [],
  models: {},
  runner: {},
  webchat: {},
  deploy: { labelPrefix: 'md.tophat' },
  sources: [],
  hub: null,
  intake: null,
  extensions: null,
});

// Keys whose value would be a secret if written inline; in a source's config they must be credential references.
const SECRETISH = /^(api_?key|token|secret|password|refresh_?token|access_?token|client_?secret)$/i;

const expand = (p, home) => String(p).replace(/^~(?=\/|$)/, home);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** The id the intake marks its raw rows with (and derives from): the runner's transcript records carry it too (TOPHAT_PUSHER_ID). */
export const pusherId = (c) => `${c.name}-intake`;

/** A credential reference: exactly one of env / keyring / file, never a literal. */
export function validateRef(ref, where) {
  if (!isObj(ref)) throw new Error(`${where}: a credential is a reference object ({ "env": NAME } | { "keyring": NAME } | { "file": PATH }), never a value`);
  const keys = Object.keys(ref).filter((k) => REF_KEYS.includes(k));
  if (keys.length !== 1 || Object.keys(ref).some((k) => !REF_KEYS.includes(k))) throw new Error(`${where}: name exactly one of env, keyring, file`);
  if (typeof ref[keys[0]] !== 'string' || !ref[keys[0]]) throw new Error(`${where}: ${keys[0]} must be a non-empty string`);
  return ref;
}

// runner.env: extra environment names (feature switches, store and tool locations) the instance hands its children, as
// { NAME: value }. Values are plain strings, numbers, booleans or JSON objects (written as JSON text); a name that reads as a
// secret (key, token, password...) is refused unless it names a FILE, DIR or PATH: a secret is a credential reference, never here.
const RUNNER_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SECRET_NAME = /(^|_)(API_?KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?)(_|$)/;
const PATH_NAME = /_(FILE|FILES|DIR|PATH|BIN)$/;
function validateRunner(r) {
  if (!isObj(r)) throw new Error('instance config: runner is { env?: { NAME: value } }');
  for (const k of Object.keys(r)) if (k !== 'env') throw new Error(`instance config: unknown key runner.${k}`);
  if (r.env === undefined) return;
  if (!isObj(r.env)) throw new Error('instance config: runner.env is an object of NAME: value');
  for (const [k, v] of Object.entries(r.env)) {
    if (!RUNNER_ENV_NAME.test(k)) throw new Error(`instance config: runner.env name "${k}" must be upper case letters, digits and underscores`);
    if (SECRET_NAME.test(k) && !PATH_NAME.test(k)) throw new Error(`instance config: runner.env.${k} reads as a secret; name a credential reference (models, hub, sources) or a *_FILE path instead`);
    if (k.startsWith('LINKNOTES_SECRET_')) throw new Error(`instance config: runner.env.${k} is reserved`);
    if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || isObj(v))) throw new Error(`instance config: runner.env.${k} is a string, number, boolean or object`);
  }
}

// update: the daily `tophat update` job (update.mjs). Absent is on, once a day; false is off (a run by hand still works).
export const UPDATE_EVERY_SECONDS = 86400;
function validateUpdate(u, home) {
  if (u === false) return false;
  if (u === undefined || u === true) return { everySeconds: UPDATE_EVERY_SECONDS };
  if (!isObj(u)) throw new Error('instance config: update is false or { everySeconds?, command?, fixer?, remote? }');
  for (const k of Object.keys(u)) if (!['everySeconds', 'command', 'fixer', 'remote'].includes(k)) throw new Error(`instance config: unknown key update.${k}`);
  if (u.everySeconds !== undefined && (!Number.isInteger(u.everySeconds) || u.everySeconds < 60)) throw new Error('instance config: update.everySeconds is a whole number of seconds, at least 60');
  if (u.command !== undefined && (!Array.isArray(u.command) || !u.command.length || u.command.some((a) => typeof a !== 'string' || !a))) throw new Error('instance config: update.command is an argv list (the release tag is appended)');
  if (u.fixer !== undefined && typeof u.fixer !== 'boolean') throw new Error('instance config: update.fixer is true or false');
  if (u.remote !== undefined && (typeof u.remote !== 'string' || !/^[A-Za-z0-9._-]+$/.test(u.remote))) throw new Error('instance config: update.remote is a git remote name');
  return { ...u, everySeconds: u.everySeconds ?? UPDATE_EVERY_SECONDS, ...(u.command ? { command: u.command.map((a) => expand(a, home)) } : {}) };
}

/** Validate and default a parsed instance config. `dir` is where relative paths resolve (the config file's directory). */
export function resolveInstance(raw, { dir = process.cwd(), home = os.homedir() } = {}) {
  if (!isObj(raw)) throw new Error('instance config: not an object');
  for (const k of Object.keys(raw)) if (!TOP.includes(k)) throw new Error(`instance config: unknown key "${k}"`);
  if (typeof raw.name !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(raw.name)) throw new Error('instance config: "name" is required: lower case letters, digits and dashes');
  if (!Array.isArray(raw.components) || !raw.components.every((c) => typeof c === 'string')) throw new Error('instance config: "components" is the list of enabled component ids');
  const c = { ...structuredClone(DEFAULTS), ...structuredClone(raw) };
  for (const k of Object.keys(DEFAULTS)) if (isObj(DEFAULTS[k])) c[k] = { ...DEFAULTS[k], ...(raw[k] || {}) };
  if (c.scope.user !== undefined && (typeof c.scope.user !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(c.scope.user))) throw new Error('instance config: scope.user is the replica user name (lower case letters, digits, dashes)');
  if (!Array.isArray(c.sources)) throw new Error('instance config: sources is a list of { id, family, config }');
  const seen = new Set();
  for (const [i, src] of c.sources.entries()) {
    if (!isObj(src) || typeof src.id !== 'string' || !src.id || typeof src.family !== 'string' || !src.family) throw new Error(`instance config: sources[${i}] needs id and family`);
    if (seen.has(src.id)) throw new Error(`instance config: sources[${i}]: duplicate id ${src.id}`);
    seen.add(src.id);
    if (src.config !== undefined && !isObj(src.config)) throw new Error(`instance config: sources[${i}].config must be an object`);
    for (const [k, v] of Object.entries(src.config || {})) if (SECRETISH.test(k)) validateRef(v, `sources[${i}].config.${k}`);
  }
  validateRunner(c.runner);
  if (c.runner.env) c.runner.env = Object.fromEntries(Object.entries(c.runner.env).map(([k, v]) => [k, typeof v === 'string' ? expand(v, home) : v]));
  if (c.hub !== null) {
    if (!isObj(c.hub) || typeof c.hub.url !== 'string' || !/^https?:\/\//.test(c.hub.url)) throw new Error('instance config: hub needs url (http or https)');
    for (const k of Object.keys(c.hub)) if (!['url', 'token', 'device', 'deviceKey', 'timeoutMs'].includes(k)) throw new Error(`instance config: unknown key hub.${k}`);
    // The token is issued by the hub's operator, so it may not exist yet: without a reference it is the keyring entry `hub-token`,
    // and a sync before the file exists is refused by name, never an error here.
    if (c.hub.token === undefined) c.hub.token = { keyring: HUB_TOKEN_KEYRING };
    validateRef(c.hub.token, 'hub.token');
    if (c.hub.token.env) throw new Error('hub.token: the store reads its hub token from a file; use { "file": PATH } or { "keyring": NAME }');
    if (c.hub.deviceKey !== undefined) { validateRef(c.hub.deviceKey, 'hub.deviceKey'); if (c.hub.deviceKey.env) throw new Error('hub.deviceKey: a device key is a file or a keyring entry'); }
    if (c.hub.device !== undefined && (typeof c.hub.device !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(c.hub.device))) throw new Error('instance config: hub.device is a device id');
  }
  if (c.intake !== null) {
    const k = c.intake;
    if (!isObj(k)) throw new Error('instance config: intake is { everySeconds, model, maxSteps?, batch?, budget?, wake? }');
    for (const key of Object.keys(k)) if (!['everySeconds', 'model', 'maxSteps', 'batch', 'budget', 'wake'].includes(key)) throw new Error(`instance config: unknown key intake.${key}`);
    if (!Number.isInteger(k.everySeconds) || k.everySeconds < 1) throw new Error('instance config: intake.everySeconds is the interval between intake runs, in whole seconds');
    if (typeof k.model === 'string') { if (!isObj(raw.models?.[k.model])) throw new Error(`instance config: intake.model "${k.model}" names no entry of models`); }
    else if (!isObj(k.model) || typeof k.model.provider !== 'string' || !k.model.provider) throw new Error('instance config: intake.model is the name of a models entry or { provider, model?, baseUrl?, credential?, command? }');
    else if ('apiKey' in k.model || 'apiKeyEnv' in k.model) throw new Error('instance config: intake.model takes a credential reference ({ env | keyring | file }), never a key or a variable name');
    else {
      if (k.model.credential !== undefined) validateRef(k.model.credential, 'intake.model.credential');
      if (k.model.workspace !== undefined) validateRef(k.model.workspace, 'intake.model.workspace');
    }
    if (k.maxSteps !== undefined && (!Number.isInteger(k.maxSteps) || k.maxSteps < 1)) throw new Error('instance config: intake.maxSteps is a positive integer');
    if (k.wake !== undefined && k.wake !== true && k.wake !== false) {
      if (!isObj(k.wake)) throw new Error('instance config: intake.wake is true or { maxAgeHours?, batch? }');
      for (const key of Object.keys(k.wake)) if (!['maxAgeHours', 'batch'].includes(key)) throw new Error(`instance config: unknown key intake.wake.${key}`);
      for (const key of ['maxAgeHours', 'batch']) if (k.wake[key] !== undefined && (!Number.isInteger(k.wake[key]) || k.wake[key] < 1)) throw new Error(`instance config: intake.wake.${key} is a positive integer`);
    }
  }
  if (typeof c.owner.label !== 'string' || !c.owner.label) throw new Error('instance config: owner.label must be a non-empty string');
  if (!Array.isArray(c.owner.addresses)) throw new Error('instance config: owner.addresses is a list');
  if (!Array.isArray(c.scope.groups)) throw new Error('instance config: scope.groups is a list');
  for (const key of ['groups', 'join']) {
    if (!Array.isArray(c.scope[key]) || c.scope[key].some((g) => typeof g !== 'string' || !SCOPE_NAME.test(g))) throw new Error(`instance config: scope.${key} is a list of group names (lower case letters, digits, dashes)`);
  }
  const both = c.scope.join.filter((g) => c.scope.groups.includes(g));
  if (both.length) throw new Error(`instance config: scope.groups creates a group and scope.join joins one made elsewhere; ${both.join(', ')} is in both`);
  if (c.scope.screens !== undefined) {
    if (!Array.isArray(c.scope.screens)) throw new Error('instance config: scope.screens is a list of { pattern, flags?, label?, groups? }');
    for (const [i, x] of c.scope.screens.entries()) {
      if (!isObj(x) || typeof x.pattern !== 'string') throw new Error(`instance config: scope.screens[${i}] needs a pattern`);
      try { new RegExp(x.pattern, x.flags ?? 'i'); } catch (e) { throw new Error(`instance config: scope.screens[${i}].pattern: ${e.message}`); }
      if (x.groups !== undefined && (!Array.isArray(x.groups) || x.groups.some((g) => typeof g !== 'string'))) throw new Error(`instance config: scope.screens[${i}].groups is a list of group names`);
    }
  }
  if (c.scope.peopleFile !== undefined && (typeof c.scope.peopleFile !== 'string' || !c.scope.peopleFile)) throw new Error('instance config: scope.peopleFile is the path of a private-people roster');
  for (const [k, v] of Object.entries(c.ports)) if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error(`instance config: ports.${k} must be a port number`);
  for (const [name, m] of Object.entries(c.models)) {
    if (!isObj(m)) throw new Error(`instance config: models.${name} must be an object`);
    if ('apiKey' in m) throw new Error(`instance config: models.${name}.apiKey is not allowed; use models.${name}.credential: { env | keyring | file }`);
    if (m.credential !== undefined) validateRef(m.credential, `models.${name}.credential`);
    if (m.workspace !== undefined) { validateRef(m.workspace, `models.${name}.workspace`); if (m.workspace.env) throw new Error(`models.${name}.workspace: the runner reads the workspace id from a file; use { "file": PATH } or { "keyring": NAME }`); }
  }
  if (c.models.fast?.workspace && !c.ports.fastProxy) throw new Error('instance config: models.fast.workspace needs ports.fastProxy (the loopback port of the header proxy: `tophat instance fast-proxy`)');
  const base = c.paths.state ? expand(c.paths.state, home) : path.join(home, '.local/state/tophat', c.name);
  const abs = (p) => path.resolve(dir, expand(p, home));
  c.paths = {
    state: abs(base),
    config: abs(c.paths.config ?? path.join(home, '.config/tophat', c.name)),
    workspace: abs(c.paths.workspace ?? path.join(base, 'workspace')),
    secrets: abs(c.paths.secrets ?? path.join(c.paths.config ? expand(c.paths.config, home) : path.join(home, '.config/tophat', c.name), 'secrets')),
    instructions: c.paths.instructions ? abs(c.paths.instructions) : null,
    fileRoots: (c.paths.fileRoots || []).map(abs),
  };
  if (c.scope.peopleFile) c.scope.peopleFile = abs(c.scope.peopleFile);
  // File references and home-relative source paths are absolute from here on (the processes reading them do not expand ~).
  const absRef = (ref) => (ref?.file ? { file: abs(ref.file) } : ref);
  for (const m of Object.values(c.models)) { if (m.credential) m.credential = absRef(m.credential); if (m.workspace) m.workspace = absRef(m.workspace); }
  if (c.hub) { c.hub.token = absRef(c.hub.token); if (c.hub.deviceKey) c.hub.deviceKey = absRef(c.hub.deviceKey); }
  if (isObj(c.intake?.model)) for (const k of ['credential', 'workspace']) if (c.intake.model[k]) c.intake.model[k] = absRef(c.intake.model[k]);
  // Extension packages (extensions.mjs): directories resolve like every other path of the file.
  c.extensions = validateExtensionsBlock(c.extensions);
  c.update = validateUpdate(raw.update, home);
  if (c.extensions) c.extensions.dirs = c.extensions.dirs.map(abs);
  c.sources = c.sources.map((src) => ({ ...src, config: Object.fromEntries(Object.entries(src.config || {}).map(([k, v]) => [k, isObj(v) ? absRef(v) : typeof v === 'string' && /^~\//.test(v) ? expand(v, home) : v])) }));
  return c;
}

export function loadInstance(file, opts = {}) {
  if (!file || !existsSync(file)) throw new Error(`instance config ${file ?? '(none)'} not found`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`instance config ${file}: ${e.message}`); }
  return resolveInstance(raw, { dir: path.dirname(path.resolve(file)), ...opts });
}

/** Resolve a credential reference to its value at start; null when absent. Values are never logged. */
export function resolveRef(ref, { env = process.env, keyringDir = null } = {}) {
  if (!ref) return null;
  if (ref.env) return env[ref.env] ?? null;
  if (ref.file) return existsSync(ref.file) ? readFileSync(ref.file, 'utf8').trim() : null;
  if (ref.keyring) {
    if (!/^[A-Za-z0-9._-]+$/.test(ref.keyring)) throw new Error('keyring names are file-safe');
    const f = keyringDir && path.join(keyringDir, ref.keyring);
    return f && existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
  }
  return null;
}

/**
 * The process environment the assembled webchat and runner read (their env names after the vendoring rename), from the
 * instance config. Only paths, names and ports; a model credential reaches the runner as a key FILE path, never a value.
 */
export function instanceEnv(c, { buildDir = null } = {}) {
  const p = c.paths, port = String(c.ports.webchat);
  const origin = c.hosts.public ? `https://${c.hosts.public}` : `http://localhost:${port}`;
  const env = {
    TOPHAT_INSTANCE: c.name,
    TOPHAT_OWNER_NAME: c.owner.label,
    TOPHAT_OWNER_ADDRESSES: c.owner.addresses.join(','),
    TOPHAT_SCOPE: c.scope.default ?? c.name,
    TOPHAT_SCOPE_GROUPS: c.scope.groups.join(','),
    ...(c.scope.join.length ? { TOPHAT_SCOPE_JOIN: c.scope.join.join(',') } : {}),
    ...(c.scope.screens?.length ? { TOPHAT_SCOPE_SCREENS: JSON.stringify(c.scope.screens) } : {}),
    ...(c.scope.peopleFile ? { TOPHAT_PRIVATE_PEOPLE_FILE: c.scope.peopleFile } : {}),
    ...(c.scope.user ? { TOPHAT_SCOPE_USER: c.scope.user } : {}),
    TOPHAT_PUBLIC_BASE: c.hosts.public ? origin : '',
    PRODUCT_NAME: c.name,
    HOST: c.hosts.bind,
    PORT: port,
    ORIGIN: origin,
    WEBCHAT_ORIGIN: origin,
    TOPHAT_CONFIG_DIR: p.config,
    TOPHAT_STATE_DIR: p.state,
    TOPHAT_WORKSPACE: p.workspace,
    TOPHAT_SECRETS_DIR: p.secrets,
    WEBCHAT_CWD: p.workspace,
    WEBCHAT_ROOTS: [p.workspace, ...p.fileRoots].join(':'),
    WEBCHAT_DB: path.join(p.state, 'webchat', 'events.sqlite'),
    WEBCHAT_UPLOADS: path.join(p.state, 'webchat', 'uploads'),
    TOPHAT_WEBCHAT_STORE_DIR: path.join(p.state, 'webchat'),
    TOPHAT_RUNNER_DB: path.join(p.state, 'runner', 'memory.sqlite'),
    TOPHAT_RUNNER_RUNNER_DB: path.join(p.state, 'runner', 'runner.sqlite'),
  };
  if (p.instructions) env.TOPHAT_RUNNER_INSTRUCTIONS_FILE = p.instructions;
  if (buildDir) env.WEBCHAT_BUILD_OUT = buildDir;
  const chat = c.models.chat;
  if (chat?.model) env.TOPHAT_RUNNER_MODEL = chat.model;
  if (chat?.baseUrl) env.TOPHAT_RUNNER_API_BASE = chat.baseUrl;
  // The runner reads its key from a file (never from its environment): a chat credential is a file or a keyring entry.
  if (chat?.credential?.env) throw new Error('models.chat.credential: the runner reads its key from a file; use { "file": PATH } or { "keyring": NAME }');
  if (chat?.credential?.file) env.TOPHAT_RUNNER_API_KEY_FILE = chat.credential.file;
  if (chat?.credential?.keyring) env.TOPHAT_RUNNER_API_KEY_FILE = path.join(p.secrets, chat.credential.keyring);
  // A key scoped to an organisation rather than a workspace needs the workspace id beside it (also a file, never a value).
  if (chat?.workspace?.file) env.TOPHAT_RUNNER_WORKSPACE_ID_FILE = chat.workspace.file;
  if (chat?.workspace?.keyring) env.TOPHAT_RUNNER_WORKSPACE_ID_FILE = path.join(p.secrets, chat.workspace.keyring);
  // Message stores the runner's tools read: the first enabled source of each family that names its database.
  const first = (family, key) => c.sources.find((s) => s.family === family && s.enabled !== false && typeof s.config?.[key] === 'string')?.config[key];
  const imessage = first('imessage', 'database'), beeper = first('beeper', 'index');
  if (imessage) env.TOPHAT_RUNNER_IMESSAGE_DB = path.resolve(p.config, imessage);
  if (beeper) env.TOPHAT_RUNNER_BEEPER_INDEX = path.resolve(p.config, beeper);
  // Hub sync of the runner's replica: the token and the device key reach the store as file paths, never values.
  const keyFile = (ref) => ref?.file ?? (ref?.keyring ? path.join(p.secrets, ref.keyring) : null);
  if (c.hub) {
    env.TOPHAT_HUB_URL = c.hub.url;
    env.TOPHAT_HUB_TOKEN_FILE = keyFile(c.hub.token);
    if (c.hub.device) env.TOPHAT_DEVICE = c.hub.device;
    if (c.hub.deviceKey) env.TOPHAT_DEVICE_KEY_FILE = keyFile(c.hub.deviceKey);
    if (c.hub.timeoutMs) env.TOPHAT_HUB_TIMEOUT_MS = String(c.hub.timeoutMs);
  }
  const fast = c.models.fast;
  // A fast model behind a key scoped to an organisation needs the workspace header, which the webchat's title and folder calls do
  // not send: they go to the loopback header proxy (fast-proxy.mjs), which adds it and forwards to models.fast.baseUrl.
  if (fast?.workspace) env.TOPHAT_FAST_MODEL_ENDPOINT = `http://127.0.0.1:${c.ports.fastProxy}/chat/completions`;
  else if (fast?.baseUrl) env.TOPHAT_FAST_MODEL_ENDPOINT = `${fast.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  // The name of the fast model for the webchat's titles and folder routing (it defaults to the one the upstream app names).
  if (fast?.model) { env.WEBCHAT_TITLE_MODEL = fast.model; env.WEBCHAT_ROUTE_MODEL = fast.model; }
  // The runner marks the chat transcript records it ingests with the intake's pusher id, so the intake derives them like any source's.
  if (c.intake) env.TOPHAT_PUSHER_ID = pusherId(c);
  // The runner's own chat tools (hand-off, rename) reach the webchat on loopback at THIS instance's port; without it they
  // would read a port from a config file and could land on another instance on the same machine.
  env.TOPHAT_WEBCHAT_URL = `http://127.0.0.1:${port}`;
  for (const [k, v] of Object.entries(c.runner?.env || {})) {
    if (k in env) throw new Error(`instance config: runner.env.${k} is already set by the instance file (${k === 'TOPHAT_WEBCHAT_URL' ? 'ports.webchat' : 'its own key'})`);
    env[k] = isObj(v) ? JSON.stringify(v) : String(v);
  }
  // Extensions: the resolved set the webchat loads, and the tools they provide first on the children's PATH.
  if (c.extensions) {
    env.TOPHAT_EXTENSIONS_FILE = resolvedFile(c);
    env.PATH = [binDir(c), env.PATH ?? process.env.PATH ?? ''].filter(Boolean).join(':');
  }
  return env;
}

/** Credentials an instance hands its children through their environment (values: never printed, never written). */
export function credentialEnv(c, { env = process.env } = {}) {
  const out = {};
  const fast = c.models.fast?.credential;
  if (fast) { const v = resolveRef(fast, { env, keyringDir: c.paths.secrets }); if (v) out.TOPHAT_FAST_MODEL_API_KEY = v; }
  return out;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The background jobs an instance's components imply, each one `tophat <args> --config FILE` kept up by the service manager:
 *   webchat     the chat app (`start`), when `webchat` is a component
 *   intake      the push plane (`instance intake --forever`): sources and chat transcripts into the replica, derive, wake, hub sync;
 *               when `push` and `upkeep` are components and the instance file has an intake block
 *   sync        one hub round every minute (`instance sync --forever`) when the instance file has a hub block and no intake job, which
 *               syncs after each of its own passes: two processes syncing one replica reseal an action twice and the hub refuses the second
 *   fast-proxy  the loopback header proxy for a fast model behind a workspace-scoped key, when models.fast.workspace is set
 *   update      `tophat update` on an interval (update.everySeconds, daily by default) unless the instance file says update: false
 * `label` is `<deploy.labelPrefix>.<name>` for the webchat and `<that>.<job>` for the others.
 */
export function instanceJobs(c, { configFile } = {}) {
  const base = `${c.deploy.labelPrefix}.${c.name}`;
  const has = (id) => c.components.includes(id);
  const jobs = [];
  if (has('webchat')) jobs.push({ job: 'webchat', label: base, args: ['start', '--config', configFile], log: 'webchat' });
  if (has('push') && has('upkeep') && c.intake) jobs.push({ job: 'intake', label: `${base}.intake`, args: ['instance', 'intake', '--config', configFile, '--forever', '--tick', '30'], log: 'intake' });
  if (c.hub && !jobs.some((j) => j.job === 'intake')) jobs.push({ job: 'sync', label: `${base}.sync`, args: ['instance', 'sync', '--config', configFile, '--forever', '--every', '60'], log: 'sync' });
  if (c.models.fast?.workspace) jobs.push({ job: 'fast-proxy', label: `${base}.fast-proxy`, args: ['instance', 'fast-proxy', '--config', configFile], log: 'fast-proxy' });
  // The daily update (update.mjs): fetch the newest release, merge it into this checkout in a staging worktree, test, apply.
  if (c.update !== false) jobs.push({ job: 'update', label: `${base}.update`, args: ['update', '--config', configFile], log: 'update', interval: c.update?.everySeconds ?? UPDATE_EVERY_SECONDS });
  // Extension jobs (slot job.upkeep): one interval unit each, from the set `tophat ext build` resolved last.
  for (const e of (c.extensions && readResolved(c)?.extensions) || []) {
    for (const j of e.jobs || []) jobs.push({ job: `ext-${e.id}-${j.name}`, label: `${base}.ext.${e.id}.${j.name}`, args: ['ext', 'run-job', '--config', configFile, e.id, j.name], log: `ext-${e.id}-${j.name}`, interval: j.everySeconds });
  }
  return jobs;
}

/**
 * A service unit that runs one of the instance's jobs at login and keeps it up (default: the webchat, `tophat start --config
 * FILE`): a launchd agent or a systemd user unit. Printed, never installed; `instanceJobs` lists what an instance needs.
 */
export function serviceUnit(c, { configFile, kind = 'launchd', node = process.execPath, bin, job = 'webchat' } = {}) {
  const spec = job === 'webchat' ? { label: `${c.deploy.labelPrefix}.${c.name}`, args: ['start', '--config', configFile], log: 'webchat' }
    : instanceJobs(c, { configFile }).find((j) => j.job === job);
  if (!spec) throw new Error(`instance ${c.name} has no job "${job}" (its components and instance file imply: ${instanceJobs(c, { configFile }).map((j) => j.job).join(', ') || 'none'})`);
  const { label, log: logName } = spec;
  const log = path.join(c.paths.state, 'logs');
  if (kind === 'systemd') {
    if (spec.interval) throw new Error(`job ${job} runs every ${spec.interval}s: a systemd timer unit is not generated yet (launchd only)`);
    return `[Unit]\nDescription=tophat instance ${c.name} ${job}\n\n[Service]\nExecStart=${[node, bin, ...spec.args].join(' ')}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
  }
  if (kind !== 'launchd') throw new Error(`unknown unit kind ${kind} (launchd | systemd)`);
  const args = [node, bin, ...spec.args].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  // launchd hands a job a bare PATH: name the PATH the instance's tools need (runner.env.PATH, else the printing shell's) and HOME.
  const unitEnv = { PATH: c.runner?.env?.PATH ?? process.env.PATH, HOME: process.env.HOME || os.homedir() };
  const envBlock = Object.entries(unitEnv).filter(([, v]) => v).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key><dict>${envBlock}</dict>
${spec.interval ? `  <key>StartInterval</key><integer>${Number(spec.interval)}</integer>` : `  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>`}
  <key>StandardOutPath</key><string>${xml(path.join(log, `${logName}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(log, `${logName}.err.log`))}</string>
</dict>
</plist>
`;
}
