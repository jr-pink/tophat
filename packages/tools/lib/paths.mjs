// Where the tophat tools keep config and state, from one set of environment variables.
//
//   TOPHAT_CONFIG_DIR   config dir   (default ~/.config/tophat)
//   TOPHAT_CONFIG       config.json  (default <config dir>/config.json)
//   TOPHAT_STATE_DIR    state dir    (default ~/.local/state/tophat)
//   TOPHAT_LEGACY_ENV_PREFIX   a second prefix an older install of these tools used (for example `OLD_`): when
//                       TOPHAT_<NAME> is unset, <prefix><NAME> is read. Empty by default.
// Never: create directories implicitly, or read a file.
import os from 'node:os';
import path from 'node:path';

export const homeOf = (env = process.env) => env.HOME || os.homedir();

export function expandHome(value, home = homeOf()) {
  const s = String(value);
  if (s === '~') return home;
  return s.startsWith('~/') ? path.join(home, s.slice(2)) : s;
}

/** First set, non-empty value among the names; a name TOPHAT_X also tries <legacy prefix>X. */
export function envGet(env, ...names) {
  const prefix = env.TOPHAT_LEGACY_ENV_PREFIX || '';
  for (const name of names) {
    if (env[name]) return env[name];
    if (prefix && name.startsWith('TOPHAT_') && env[prefix + name.slice(7)]) return env[prefix + name.slice(7)];
  }
  return undefined;
}

export const configDir = (env = process.env) => envGet(env, 'TOPHAT_CONFIG_DIR') || path.join(homeOf(env), '.config', 'tophat');
export const stateDir = (env = process.env) => envGet(env, 'TOPHAT_STATE_DIR') || path.join(homeOf(env), '.local', 'state', 'tophat');
export const configFile = (env = process.env) => envGet(env, 'TOPHAT_CONFIG') || path.join(configDir(env), 'config.json');
