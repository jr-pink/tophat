// Where tophat keeps config, state and data, resolved from one set of env vars.
// Every resolver that can land in live state runs it through the live-state
// guard, so a test process can never open the owner's stores.
//
//   TOPHAT_CONFIG_DIR  config dir      (default ~/.config/tophat)
//   TOPHAT_CONFIG       config.json     (default <configDir>/config.json)
//   TOPHAT_STATE_DIR   state dir       (default ~/.local/state/tophat)
//   TOPHAT_RUNNER_DB / TOPHAT_REV5_MEMORY, TOPHAT_RUNNER_RUNNER_DB, TOPHAT_RUNNER_GOALS_DIR
//   TOPHAT_VAULT_DIR, TOPHAT_VAULT_KEY_FILE
// Never: create directories implicitly, or read a file.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const homeOf = (env = process.env) => env.HOME || os.homedir();

export function expandHome(value, home = homeOf()) {
  const s = String(value);
  if (s === '~') return home;
  return s.startsWith('~/') ? path.join(home, s.slice(2)) : s;
}

// ---- live-state guard ------------------------------------------------------
// "Under test" is the node test runner (NODE_TEST_CONTEXT in children, --test in
// execArgv in-process) or a *.test.mjs entry. "Live" is judged against the
// account's real home (os.userInfo), which test isolation does not repoint.

export function underTest(env = process.env, argv = process.argv, execArgv = process.execArgv) {
  if (env.NODE_TEST_CONTEXT) return true;
  if (env.VITEST) return true;
  if ((execArgv || []).some((a) => a === '--test' || a.startsWith('--test='))) return true;
  return /\.test\.m?js$/.test(String(argv?.[1] || ''));
}

export function realHome(env = process.env) {
  try { return os.userInfo().homedir; } catch { return env.TOPHAT_TEST_REAL_HOME || os.homedir(); }
}

export function liveRoots(home = realHome()) {
  return [
    path.join(home, '.local', 'state', 'tophat'),
    path.join(home, '.local', 'share', 'tophat'),
    path.join(home, '.config', 'tophat'),
  ];
}

export function isLive(target, roots = liveRoots()) {
  if (typeof target !== 'string' || !target) return false;
  const resolved = path.resolve(target);
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/** `target` unchanged, or a throw when a test process resolves it into live state. */
export function refuseLiveUnderTest(target, what, { env = process.env, argv = process.argv, execArgv = process.execArgv, roots } = {}) {
  if (!underTest(env, argv, execArgv)) return target;
  if (!isLive(target, roots ?? liveRoots(realHome(env)))) return target;
  throw new Error(`live-state guard: ${what} resolves to ${target}, the owner's live tophat state, inside a test process. `
    + 'Give the fixture a temp home or run the suite through scripts/test.sh.');
}

// ---- resolvers ---------------------------------------------------------------

export const configDir = (env = process.env) => env.TOPHAT_CONFIG_DIR || path.join(homeOf(env), '.config', 'tophat');
export const configFile = (env = process.env) => env.TOPHAT_CONFIG || path.join(configDir(env), 'config.json');
export const retrievalConfigFile = (env = process.env) =>
  env.TOPHAT_RETRIEVAL_CONFIG ? path.resolve(env.TOPHAT_RETRIEVAL_CONFIG) : path.join(configDir(env), 'retrieval.json');

export const stateDir = (env = process.env) =>
  refuseLiveUnderTest(env.TOPHAT_STATE_DIR || path.join(homeOf(env), '.local', 'state', 'tophat'), 'stateDir', { env });
export const dataDir = (env = process.env) => refuseLiveUnderTest(path.join(homeOf(env), '.local', 'share', 'tophat'), 'dataDir', { env });
export const workspaceDir = (env = process.env) => path.join(dataDir(env), 'workspace');

const guarded = (value, what, env) => refuseLiveUnderTest(value, what, { env });
export const rev5Dir = (env = process.env) => path.join(stateDir(env), 'rev5');
export const memoryDb = (env = process.env) =>
  guarded(env.TOPHAT_RUNNER_DB || env.TOPHAT_REV5_MEMORY || path.join(rev5Dir(env), 'memory.sqlite'), 'memoryDb', env);
export const runnerDb = (env = process.env) =>
  guarded(env.TOPHAT_RUNNER_RUNNER_DB || path.join(rev5Dir(env), 'runner.sqlite'), 'runnerDb', env);
export const goalsDir = (env = process.env) => guarded(env.TOPHAT_RUNNER_GOALS_DIR || path.join(rev5Dir(env), 'goals'), 'goalsDir', env);

/** The webchat store dir; an existing store at the old config-dir location keeps being used. */
export function webchatStoreDir(env = process.env, home = homeOf(env)) {
  const base = env.TOPHAT_STATE_DIR ? path.join(env.TOPHAT_STATE_DIR, 'webchat') : path.join(home, '.local', 'state', 'tophat', 'webchat');
  const legacy = path.join(home, '.config', 'tophat', 'webchat');
  const dir = !existsSync(path.join(base, 'events.sqlite')) && existsSync(path.join(legacy, 'events.sqlite')) ? legacy : base;
  return guarded(dir, 'webchatStoreDir', env);
}

// The vault sits under the tophat config dir of the real account, not under
// TOPHAT_CONFIG_DIR: the rev5 config dir has no vault of its own.
export const vaultDir = (env = process.env) => env.TOPHAT_VAULT_DIR || path.join(homeOf(env), '.config', 'tophat', 'vault');
export const vaultKeyFile = (env = process.env, dir = vaultDir(env)) => env.TOPHAT_VAULT_KEY_FILE || path.join(path.dirname(dir), 'vault-master-key');

/** Legacy plaintext secret dirs, in lookup order. TOPHAT_SECRETS_DIR, when set, is tried first. */
export function legacySecretDirs(env = process.env) {
  const home = homeOf(env);
  const dirs = [env.TOPHAT_SECRETS_DIR, path.join(home, '.config', 'tophat', 'secrets')];
  return [...new Set(dirs.filter(Boolean))];
}
