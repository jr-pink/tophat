// One answer to "what credential and what model can THIS process actually use".
//
// The variable was the single point of failure. The webchat has the same scar: see
// webchat/src/lib/server/app.js around line 220 and keyless-spawn.test.js, seven turns lost to a
// spawned process that did not inherit the variable.
//
// So a keyless process is normal and must still find the key. Every entry point (a launchd job, a
// CLI, a bench, the webchat runner) resolves through here and gets the identical answer, and an
// answer of "nothing" names the paths it tried instead of naming one variable.
//
// Nothing here puts key BYTES anywhere a log or an error message can reach: the result carries
// paths, booleans and source names only. `describe()` is written to be safe to print.
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readNamedSecret } from '../src/vault/named-secret.mjs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The known on-disk location, the one the owner's own machine actually uses (0600, owner only). */
export const secretsDir = (env = process.env) => env.TOPHAT_RUNNER_SECRETS_DIR
  || join(env.HOME || homedir(), '.config', 'tophat', 'secrets');

/** Where a vault-only key is materialised, because model.mjs takes a key FILE, not a key. */
export const vaultSpillDir = (env = process.env) => env.TOPHAT_RUNNER_CREDENTIAL_DIR
  || join(env.HOME || homedir(), '.local', 'state', 'tophat', 'rev5', 'credentials');

/** Codex's OAuth file: the gpt path's second credential, and the one no variable ever names. */
export const chatgptAuthPath = (env = process.env) => env.TOPHAT_RUNNER_CHATGPT_AUTH_FILE
  || join(env.HOME || homedir(), '.codex', 'auth.json');

const readable = (path) => {
  if (!path) return false;
  try { accessSync(path, constants.R_OK); return true; } catch { return false; }
};

export const VAULT_NAMES = Object.freeze({
  anthropicKey: 'anthropic-api-key',
  anthropicWorkspace: 'anthropic-workspace-id',
  openaiKey: 'openai-api-key'
});

/**
 * The vault reader, loaded only when the first two sources came up empty, and only ever used when
 * it can serve without an interactive unlock. readNamedSecret returns null rather than prompting
 * when the vault is locked or absent, so "it cannot" is a null and not an exception; a throw from
 * the import itself (no vault module in a stripped runtime) is the same answer.
 */
function defaultVaultRead(name, env) {
  const directory = env.TOPHAT_VAULT_DIR || join(env.HOME || homedir(), '.config/tophat/vault');
  try { return readNamedSecret(name, { directory, keyFile: env.TOPHAT_VAULT_KEY_FILE || join(dirname(directory), 'vault-master-key') }); }
  catch { return null; }
}

/**
 * A vault value becomes a file because the wire client reads a path (model.mjs readKey, openai.mjs
 * openaiHeaders). It is written 0600 under the owner's own state directory, never a temp directory,
 * and only when neither the variable nor the on-disk secret answered.
 */
function spill(name, value, env) {
  const dir = vaultSpillDir(env);
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return file;
}

/**
 * What this process can talk to, and how it found out.
 *
 * Anthropic, in order: TOPHAT_RUNNER_API_KEY_FILE if it is set and readable, then
 * ~/.config/tophat/secrets/anthropic-api-key (with anthropic-workspace-id beside it), then the
 * vault named secret if it serves without an unlock.
 *
 * OpenAI, in order: TOPHAT_RUNNER_OPENAI_API_KEY_FILE if set and readable, then
 * ~/.config/tophat/secrets/openai-api-key, then the vault, then Codex's ~/.codex/auth.json
 * subscription credential, which needs no variable and is why a keyless job can look healthy.
 *
 * Returns { env, anthropic, openai, sources, tried }. `env` is a COPY with the variables filled in;
 * the caller passes it on rather than mutating process.env, so two runners in one process cannot
 * fight over it.
 */
export function resolveCredentials(env = process.env, { vaultRead = defaultVaultRead } = {}) {
  const out = { ...env };
  const tried = [];
  const sources = { anthropic: null, anthropicWorkspace: null, openai: null };
  const dir = secretsDir(env);
  const note = (provider, source, path, ok, why = '') => { tried.push({ provider, source, path, ok, why }); return ok; };

  // Anthropic.
  if (env.TOPHAT_RUNNER_API_KEY_FILE && readable(env.TOPHAT_RUNNER_API_KEY_FILE)) {
    note('anthropic', 'env', env.TOPHAT_RUNNER_API_KEY_FILE, true);
    sources.anthropic = 'env';
  } else {
    if (env.TOPHAT_RUNNER_API_KEY_FILE) note('anthropic', 'env', env.TOPHAT_RUNNER_API_KEY_FILE, false, 'TOPHAT_RUNNER_API_KEY_FILE is set but the file is not readable');
    else note('anthropic', 'env', '(TOPHAT_RUNNER_API_KEY_FILE)', false, 'not set');
    const onDisk = join(dir, 'anthropic-api-key');
    if (readable(onDisk)) {
      note('anthropic', 'disk', onDisk, true);
      out.TOPHAT_RUNNER_API_KEY_FILE = onDisk;
      sources.anthropic = 'disk';
    } else {
      note('anthropic', 'disk', onDisk, false, 'no readable file there');
      const value = vaultRead(VAULT_NAMES.anthropicKey, env);
      if (value) {
        const file = spill('anthropic-api-key', value, env);
        note('anthropic', 'vault', file, true, `vault secret ${VAULT_NAMES.anthropicKey}`);
        out.TOPHAT_RUNNER_API_KEY_FILE = file;
        sources.anthropic = 'vault';
      } else {
        note('anthropic', 'vault', `(vault secret ${VAULT_NAMES.anthropicKey})`, false, 'the vault did not serve it without an unlock');
      }
    }
  }

  // The workspace id rides beside the key: a key scoped to a workspace is refused without it.
  if (sources.anthropic) {
    if (env.TOPHAT_RUNNER_WORKSPACE_ID_FILE && readable(env.TOPHAT_RUNNER_WORKSPACE_ID_FILE)) sources.anthropicWorkspace = 'env';
    else {
      const onDisk = join(dir, 'anthropic-workspace-id');
      // Only beside an on-disk or vault key: a key the caller named explicitly keeps its own pairing.
      if (sources.anthropic !== 'env' && readable(onDisk)) { out.TOPHAT_RUNNER_WORKSPACE_ID_FILE = onDisk; sources.anthropicWorkspace = 'disk'; }
      else if (sources.anthropic === 'vault') {
        const value = vaultRead(VAULT_NAMES.anthropicWorkspace, env);
        if (value) { out.TOPHAT_RUNNER_WORKSPACE_ID_FILE = spill('anthropic-workspace-id', value, env); sources.anthropicWorkspace = 'vault'; }
      }
      if (!sources.anthropicWorkspace) delete out.TOPHAT_RUNNER_WORKSPACE_ID_FILE;
    }
  }

  // OpenAI.
  if (env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE && readable(env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE)) {
    note('openai', 'env', env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE, true);
    sources.openai = 'api-key';
  } else {
    if (env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE) note('openai', 'env', env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE, false, 'TOPHAT_RUNNER_OPENAI_API_KEY_FILE is set but the file is not readable');
    else note('openai', 'env', '(TOPHAT_RUNNER_OPENAI_API_KEY_FILE)', false, 'not set');
    const onDisk = join(dir, 'openai-api-key');
    const auth = chatgptAuthPath(env);
    if (readable(onDisk)) {
      note('openai', 'disk', onDisk, true);
      out.TOPHAT_RUNNER_OPENAI_API_KEY_FILE = onDisk;
      sources.openai = 'api-key';
    } else {
      note('openai', 'disk', onDisk, false, 'no readable file there');
      const value = env.TOPHAT_RUNNER_OPENAI_AUTH === 'chatgpt' ? null : vaultRead(VAULT_NAMES.openaiKey, env);
      if (value) {
        const file = spill('openai-api-key', value, env);
        note('openai', 'vault', file, true, `vault secret ${VAULT_NAMES.openaiKey}`);
        out.TOPHAT_RUNNER_OPENAI_API_KEY_FILE = file;
        sources.openai = 'api-key';
      } else {
        note('openai', 'vault', `(vault secret ${VAULT_NAMES.openaiKey})`, false, 'the vault did not serve it without an unlock');
        if (env.TOPHAT_RUNNER_OPENAI_AUTH !== 'api-key' && readable(auth)) {
          note('openai', 'chatgpt', auth, true, 'Codex subscription credential');
          out.TOPHAT_RUNNER_CHATGPT_AUTH_FILE = auth;
          sources.openai = 'chatgpt';
        } else {
          note('openai', 'chatgpt', auth, false, env.TOPHAT_RUNNER_OPENAI_AUTH === 'api-key' ? 'TOPHAT_RUNNER_OPENAI_AUTH=api-key rules it out' : 'Codex is not signed in here');
        }
      }
    }
  }

  // TOPHAT_RUNNER_OPENAI_AUTH=api-key with no key file must not let openaiAuthMode fall through to the
  // subscription, and the reverse: the explicit choice is honoured as a filter, never as a claim.
  if (env.TOPHAT_RUNNER_OPENAI_AUTH === 'chatgpt') {
    const auth = chatgptAuthPath(env);
    sources.openai = readable(auth) ? 'chatgpt' : null;
    if (sources.openai) out.TOPHAT_RUNNER_CHATGPT_AUTH_FILE = auth;
  }
  if (!sources.anthropic) delete out.TOPHAT_RUNNER_API_KEY_FILE;
  if (!sources.openai) delete out.TOPHAT_RUNNER_OPENAI_API_KEY_FILE;
  // Pin the missing path too: openaiAuthMode otherwise consults the host HOME instead of this env.
  out.TOPHAT_RUNNER_CHATGPT_AUTH_FILE ||= chatgptAuthPath(env);

  return { env: out, anthropic: Boolean(sources.anthropic), openai: Boolean(sources.openai), sources, tried };
}

/**
 * The sentence an operator can act on: every place that was looked at, whether it answered, and
 * nothing else. Paths and booleans only; no value from any of these files is ever in this string.
 */
export function describe(resolution) {
  const lines = [];
  for (const provider of ['anthropic', 'openai']) {
    const rows = resolution.tried.filter((t) => t.provider === provider);
    const verdict = resolution[provider] ? `available via ${resolution.sources[provider]}` : 'NO credential';
    lines.push(`${provider}: ${verdict}`);
    for (const row of rows) lines.push(`  ${row.ok ? 'found' : 'no   '} ${row.source.padEnd(7)} ${row.path}${row.why ? ` (${row.why})` : ''}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('model-credentials.mjs')) {
  const resolution = await resolveCredentials();
  process.stdout.write(`${describe(resolution)}\n`);
  process.exit(resolution.anthropic || resolution.openai ? 0 : 1);
}
