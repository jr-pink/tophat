// Groups on a hub, as explicit commands on the instance file:
//   joinGroup    `tophat instance join NAME`: opt in to a group someone else made (the shared `tophat-users` memory group on the
//                community hub, ciphertext only). Writes scope.join, a hub block and a unique replica user into the instance file and
//                prints the one thing the group's admin needs: this replica's user, device and device public key. It also writes the
//                sharing guidance (runner store/sharing.mjs) into the instance's instructions file, between markers.
//   createGroup  `tophat instance group create NAME`: make a group this instance administers (scope.groups), then one hub round.
//   addMember    `tophat instance group add NAME USER`: the admin adds a member and wraps the group key to the member's devices.
// Nothing here is automatic: setup never calls any of it, and no command mints a hub token (the hub's operator issues those).
// The instance file is edited as the user wrote it (parsed, changed, validated, replaced by temp + rename); a file that would stop
// validating is never written.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { COMMUNITY_HUB_URL, HUB_TOKEN_KEYRING, instanceEnv, loadInstance, resolveInstance } from './instance.mjs';
import { componentDir } from './start.mjs';

export const COMMUNITY_GROUP = 'tophat-users';
const NAME = /^[a-z][a-z0-9-]{1,47}$/;
const ROLES = ['read', 'write', 'admin'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const groupName = (g) => { if (!NAME.test(String(g ?? ''))) throw new Error(`group name ${JSON.stringify(g)} must be lower case letters, digits and dashes (2 to 48 characters, starting with a letter)`); return g; };

function readRaw(configFile) {
  let raw;
  try { raw = JSON.parse(readFileSync(configFile, 'utf8')); } catch (e) { throw new Error(`instance config ${configFile}: ${e.message}`); }
  if (!isObj(raw)) throw new Error(`instance config ${configFile}: not an object`);
  return raw;
}

/** Replace the instance file with `raw`, after checking that it still validates; same mode, atomic. */
function writeRaw(configFile, raw) {
  resolveInstance(raw, { dir: path.dirname(path.resolve(configFile)) });
  const mode = statSync(configFile).mode & 0o777;
  const tmp = `${configFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode });
  renameSync(tmp, configFile);
}

async function runnerStore() {
  const runner = componentDir('runner');
  if (!runner) throw new Error('the runner package is not installed (it holds the memory store)');
  return import(path.join(runner, 'store/memory.mjs'));
}

/** Put the sharing guidance in the instance's instructions file (created beside the instance file when it names none), between
 * markers, so the owner can read, edit or delete it and a second join replaces it in place. Returns the file it wrote. */
async function writeGuidance(configFile, raw, group, c) {
  const runner = componentDir('runner');
  if (!runner) throw new Error('the runner package is not installed (it holds the sharing guidance)');
  const { sharingGuidance, withSharingBlock } = await import(path.join(runner, 'store/sharing.mjs'));
  const file = c.paths.instructions ?? path.join(path.dirname(path.resolve(configFile)), 'instructions.md');
  const prior = existsSync(file) ? readFileSync(file, 'utf8') : '';
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, withSharingBlock(prior, group, sharingGuidance({ group })), { mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600 });
  renameSync(tmp, file);
  if (!c.paths.instructions) { raw.paths = { ...(isObj(raw.paths) ? raw.paths : {}), instructions: file }; writeRaw(configFile, raw); }
  return file;
}

/** The replica's device id and public key; opening the replica creates its device key once. Never reads a private key out. */
function deviceOf(mem, env) {
  const b = mem.openStore(env.TOPHAT_RUNNER_DB, env);
  const device = b.config.device;
  const row = b.store.one('SELECT public_key FROM mc_devices WHERE device=?', [device]);
  return { device, publicKey: row?.public_key ?? null, user: b.store.user };
}

/**
 * Opt in to `group`. Returns what was written and the one step left for the user. `userName` overrides the generated replica
 * user (th-<8 hex>); an instance whose replica already exists keeps the user it has (its private scope is that user's), and says
 * so when that name is not unique-looking.
 */
export async function joinGroup({ configFile, group = COMMUNITY_GROUP, hubUrl = null, userName = null, mem = null } = {}) {
  groupName(group);
  const raw = readRaw(configFile);
  const scope = isObj(raw.scope) ? { ...raw.scope } : {};
  if ((scope.groups || []).includes(group)) throw new Error(`this instance creates ${group} (scope.groups); join is for a group someone else made`);
  const before = resolveInstance(raw, { dir: path.dirname(path.resolve(configFile)) });
  const replicaExists = existsSync(instanceEnv(before).TOPHAT_RUNNER_DB);
  const notes = [];
  scope.join = [...new Set([...(scope.join || []), group])];
  if (userName) {
    if (scope.user && scope.user !== userName) throw new Error(`scope.user is already ${scope.user}; edit it by hand if you mean to rename this replica's user`);
    scope.user = groupName(userName);
  } else if (!scope.user) {
    if (replicaExists) notes.push(`this instance already has a memory replica, so its hub user stays "${before.scope.default ?? before.name}" (a different user would lose its private scope); the group's admin needs that name to be unique among members`);
    else scope.user = `th-${randomBytes(4).toString('hex')}`;
  }
  raw.scope = scope;
  if (!raw.hub) raw.hub = { url: hubUrl || COMMUNITY_HUB_URL };
  else if (hubUrl && raw.hub.url !== hubUrl) throw new Error(`the instance file already names the hub ${raw.hub.url}; edit hub.url by hand to change it`);
  writeRaw(configFile, raw);
  const guidance = await writeGuidance(configFile, raw, group, resolveInstance(raw, { dir: path.dirname(path.resolve(configFile)) }));
  const c = loadInstance(configFile);
  const env = instanceEnv(c);
  const mem2 = mem ?? await runnerStore();
  const dev = deviceOf(mem2, env);
  const tokenFile = env.TOPHAT_HUB_TOKEN_FILE;
  return {
    ok: true, group, hub: c.hub.url, user: dev.user, device: dev.device, devicePublicKey: dev.publicKey,
    tokenFile, tokenPresent: existsSync(tokenFile), guidance, notes,
    next: [`Send the group's admin this user (${dev.user}), device (${dev.device}) and device public key. They issue your hub token and add you to ${group}.`,
      `Save the token they send to ${tokenFile} (0600; keyring entry "${HUB_TOKEN_KEYRING}"), restart the instance, and \`tophat instance sync --config ${configFile}\` brings the group key in.`],
  };
}

/** Make `group` an administered group of this instance (scope.groups) and run one hub round when a hub and its token are there. */
export async function createGroup({ configFile, group, mem = null } = {}) {
  groupName(group);
  const raw = readRaw(configFile);
  const scope = isObj(raw.scope) ? { ...raw.scope } : {};
  if ((scope.join || []).includes(group)) throw new Error(`this instance joins ${group} (scope.join); creating it here would fork it`);
  const mem2 = mem ?? await runnerStore();
  const beforeEnv = instanceEnv(loadInstance(configFile));
  const existed = Boolean(mem2.openStore(beforeEnv.TOPHAT_RUNNER_DB, beforeEnv).store.one('SELECT 1 AS ok FROM mc_groups WHERE grp=?', [group]));
  scope.groups = [...new Set([...(scope.groups || []), group])];
  raw.scope = scope;
  writeRaw(configFile, raw);
  const env = instanceEnv(loadInstance(configFile));
  const store = mem2.openStore(env.TOPHAT_RUNNER_DB, env).store; // opening creates the group, this replica's user its admin
  const made = Boolean(store.one('SELECT 1 AS ok FROM mc_groups WHERE grp=?', [group]));
  const sync = env.TOPHAT_HUB_URL ? (await mem2.syncStore(env.TOPHAT_RUNNER_DB, env)).result : { ok: false, detail: 'no hub block in the instance file: the group exists on this replica only' };
  return { ok: made, group, created: made && !existed, admin: store.user, hub: env.TOPHAT_HUB_URL ?? null, sync };
}

/** Add `user` to `group` as `role` and wrap the group key to their devices; the hub must already know the member's device. */
export async function addMember({ configFile, group, user, role = 'write', mem = null } = {}) {
  groupName(group); groupName(user);
  if (!ROLES.includes(role)) throw new Error(`role is one of ${ROLES.join(', ')}`);
  const mem2 = mem ?? await runnerStore();
  const env = instanceEnv(loadInstance(configFile));
  const hub = Boolean(env.TOPHAT_HUB_URL);
  // pull first: the member's device registers at the hub on their first sync, and the key can only be wrapped to a device this replica knows
  if (hub) await mem2.syncStore(env.TOPHAT_RUNNER_DB, env);
  const store = mem2.openStore(env.TOPHAT_RUNNER_DB, env).store;
  if (store.roleOf(store.user, group) !== 'admin') throw new Error(`${store.user} is not an admin of ${group} on this replica`);
  const devices = store.all('SELECT device FROM mc_devices WHERE user=?', [user]).map((r) => r.device);
  store.setMember(group, user, role);
  const sync = hub ? (await mem2.syncStore(env.TOPHAT_RUNNER_DB, env)).result : { ok: false, detail: 'no hub block in the instance file' };
  return { ok: true, group, user, role, devices, sync, ...(devices.length ? {} : { note: `no device of ${user} has reached the hub yet: the key is wrapped when they have synced once and an admin sync runs again` }) };
}
