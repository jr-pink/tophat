// One resolver for named secrets. Order:
//   1. the process environment (an explicit `envVar`, else the ENV_SECRETS name);
//   2. the tophat vault (src/vault), by name or by its dashed vault id;
//   3. the legacy plaintext dirs, in legacySecretDirs() order.
// Rules 2 and 3 are one rule -- "the vault, unless a legacy plaintext file was
// written after the vault record" -- and src/vault/named-secret.mjs owns it as
// `namedSecretValue`. This file keeps only what is genuinely rev6's: the
// environment table above that rule, and the Docstore exception below it. The
// Docstore live names (content-key, replica-token) read their legacy file first,
// because those files are symlinks to the live Docstore config and the vault holds
// a snapshot. Values are file text trimmed, vault values as stored. Never: print,
// log or return a value from anything but readSecret/requireSecret; errors and
// secretSource name places, not contents.
import { legacySecretFile, namedSecretRecord, namedSecretValue, vaultId } from '../../src/vault/named-secret.mjs';
import { legacySecretDirs, vaultDir, vaultKeyFile } from './paths.mjs';

export { vaultId };

/** Environment variable -> secret name: the only place the two spellings meet. */
export const ENV_SECRETS = {
  ANTHROPIC_API_KEY: 'anthropic-api-key',
  BEEPER_ACCESS_TOKEN: 'beeper-token',
  BLUEBUBBLES_PASSWORD: 'bluebubbles-password',
  BLUEBUBBLES_URL: 'bluebubbles-url',
  TOPHAT_FAST_MODEL_API_KEY: 'fast-model-api-key',
  CONTEXT_DASHBOARD_TOKEN: 'context-dashboard-token',
  DISCORD_BOT_TOKEN: 'discord-bot-token',
  TOPHAT_DISCORD_WEBHOOK_URL: 'discord-webhook-url',
  PUSHOVER_API_TOKEN: 'pushover-api-token',
  PUSHOVER_USER_KEY: 'pushover-user-key',
};
const DOCSTORE_LIVE = new Set(['content-key', 'replica-token']);

const validName = (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);

function vaultOptions(env, vault = {}) {
  const directory = vault.directory || vaultDir(env);
  return { directory, keyFile: vault.keyFile || vaultKeyFile(env, directory) };
}

/** {id, name, value, updatedAt} for a `secret` entry, or null (absent, locked or unreadable). */
export function vaultRecord(name, { env = process.env, vault } = {}) {
  if (!validName(name)) return null;
  return namedSecretRecord(name, vaultOptions(env, vault));
}

/** {value, source}; source is 'env:VAR', 'vault', 'file:DIR' or null. */
export function resolveSecret(name, { env = process.env, envVar, vault, dirs = legacySecretDirs(env) } = {}) {
  const variable = envVar || Object.keys(ENV_SECRETS).find((k) => ENV_SECRETS[k] === name);
  if (variable && env[variable]) return { value: env[variable], source: `env:${variable}` };
  if (!validName(name)) return { value: null, source: null };
  if (DOCSTORE_LIVE.has(name)) {
    const file = legacySecretFile(name, dirs);
    if (file) return { value: file.value, source: `file:${file.dir}` };
  }
  const { value, source } = namedSecretValue(name, { dirs, ...vaultOptions(env, vault) });
  return { value, source };
}

export const readSecret = (name, options) => resolveSecret(name, options).value;
/** Where a name resolves from: metadata only, safe to print. */
export const secretSource = (name, options) => resolveSecret(name, options).source;

export function requireSecret(name, options = {}) {
  const value = readSecret(name, options);
  if (value) return value;
  const env = options.env || process.env;
  const places = [vaultOptions(env, options.vault).directory, ...(options.dirs || legacySecretDirs(env))];
  throw new Error(`secret "${name}" is in none of: environment, ${places.join(', ')}. Check it with: tophat-pass find ${name}`);
}

/** The environment-shaped object ENV_SECRETS describes, for a child process; real env wins. */
export function secretEnv(options = {}) {
  const env = options.env || process.env;
  const out = {};
  for (const [variable, name] of Object.entries(ENV_SECRETS)) {
    const value = env[variable] || readSecret(name, options);
    if (value) out[variable] = value;
  }
  return out;
}
