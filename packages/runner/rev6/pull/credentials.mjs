// Model credentials, resolved in one place: which key file each provider uses, the headers a request
// carries, and which providers are usable here. Values are read only to build headers; never printed.
// Order per provider: an env-named file, ~/.config/tophat/secrets, the vault (spilled 0600 under
// state/rev5/credentials so the key file path can be handed on), and for OpenAI the Codex ChatGPT login.
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { vaultRecord } from '../base/secrets.mjs';
import { MODELS, ModelError } from './wire.mjs';

const home = (env) => env.HOME || homedir();
export const secretsDir = (env = process.env) => env.TOPHAT_RUNNER_SECRETS_DIR || join(home(env), '.config', 'tophat', 'secrets');
export const vaultSpillDir = (env = process.env) => env.TOPHAT_RUNNER_CREDENTIAL_DIR || join(home(env), '.local', 'state', 'tophat', 'rev5', 'credentials');
export const chatgptAuthFile = (env = process.env) => env.TOPHAT_RUNNER_CHATGPT_AUTH_FILE || '';
const readable = (p) => { if (!p) return false; try { accessSync(p, constants.R_OK); return true; } catch { return false; } };
const vaultRead = (name, env) => vaultRecord(name, { env })?.value || null;

function spill(name, value, env) {
  const dir = vaultSpillDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), `${value}\n`, { mode: 0o600 });
  return join(dir, name);
}

/** {env, anthropic, openai, sources, tried}: env carries the key-file paths that work here. */
export function resolveCredentials(env = process.env, { read = vaultRead } = {}) {
  const out = { ...env }, tried = [], sources = { anthropic: null, anthropicWorkspace: null, openai: null };
  const dir = secretsDir(env), V = MODELS.vault;
  const note = (provider, source, path, ok, why = '') => { tried.push({ provider, source, path, ok, why }); return ok; };
  const envFile = (provider, name) => {
    if (env[name] && readable(env[name])) return note(provider, 'env', env[name], true);
    note(provider, 'env', env[name] || `(${name})`, false, env[name] ? `${name} is set but the file is not readable` : 'not set');
    return false;
  };
  const fromVault = (provider, secret, file) => {
    const value = read(secret, env);
    if (value) { const path = spill(file, value, env); note(provider, 'vault', path, true, `vault secret ${secret}`); return path; }
    note(provider, 'vault', `(vault secret ${secret})`, false, 'the vault did not serve it without an unlock');
    return null;
  };

  if (envFile('anthropic', 'TOPHAT_RUNNER_API_KEY_FILE')) sources.anthropic = 'env';
  else {
    const disk = join(dir, 'anthropic-api-key');
    if (readable(disk)) { note('anthropic', 'disk', disk, true); out.TOPHAT_RUNNER_API_KEY_FILE = disk; sources.anthropic = 'disk'; }
    else {
      note('anthropic', 'disk', disk, false, 'no readable file there');
      const path = fromVault('anthropic', V.anthropicKey, 'anthropic-api-key');
      if (path) { out.TOPHAT_RUNNER_API_KEY_FILE = path; sources.anthropic = 'vault'; }
    }
  }
  if (sources.anthropic) {
    if (env.TOPHAT_RUNNER_WORKSPACE_ID_FILE && readable(env.TOPHAT_RUNNER_WORKSPACE_ID_FILE)) sources.anthropicWorkspace = 'env';
    else {
      const disk = join(dir, 'anthropic-workspace-id');
      if (sources.anthropic !== 'env' && readable(disk)) { out.TOPHAT_RUNNER_WORKSPACE_ID_FILE = disk; sources.anthropicWorkspace = 'disk'; }
      else if (sources.anthropic === 'vault') {
        const value = read(V.anthropicWorkspace, env);
        if (value) { out.TOPHAT_RUNNER_WORKSPACE_ID_FILE = spill('anthropic-workspace-id', value, env); sources.anthropicWorkspace = 'vault'; }
      }
      if (!sources.anthropicWorkspace) delete out.TOPHAT_RUNNER_WORKSPACE_ID_FILE;
    }
  }

  const auth = chatgptAuthFile(env), asked = env.TOPHAT_RUNNER_OPENAI_AUTH;
  if (envFile('openai', 'TOPHAT_RUNNER_OPENAI_API_KEY_FILE')) sources.openai = 'api-key';
  else {
    const disk = join(dir, 'openai-api-key');
    if (readable(disk)) { note('openai', 'disk', disk, true); out.TOPHAT_RUNNER_OPENAI_API_KEY_FILE = disk; sources.openai = 'api-key'; }
    else {
      note('openai', 'disk', disk, false, 'no readable file there');
      const path = asked === 'chatgpt' ? (note('openai', 'vault', `(vault secret ${V.openaiKey})`, false, 'the vault did not serve it without an unlock'), null)
        : fromVault('openai', V.openaiKey, 'openai-api-key');
      if (path) { out.TOPHAT_RUNNER_OPENAI_API_KEY_FILE = path; sources.openai = 'api-key'; }
      else if (asked !== 'api-key' && readable(auth)) {
        note('openai', 'chatgpt', auth, true, 'Codex subscription credential');
        out.TOPHAT_RUNNER_CHATGPT_AUTH_FILE = auth; sources.openai = 'chatgpt';
      } else note('openai', 'chatgpt', auth, false, asked === 'api-key' ? 'TOPHAT_RUNNER_OPENAI_AUTH=api-key rules it out' : 'Codex is not signed in here');
    }
  }
  if (asked === 'chatgpt') { sources.openai = readable(auth) ? 'chatgpt' : null; if (sources.openai) out.TOPHAT_RUNNER_CHATGPT_AUTH_FILE = auth; }
  if (!sources.anthropic) delete out.TOPHAT_RUNNER_API_KEY_FILE;
  if (!sources.openai) delete out.TOPHAT_RUNNER_OPENAI_API_KEY_FILE;
  out.TOPHAT_RUNNER_CHATGPT_AUTH_FILE ||= auth;
  return { env: out, anthropic: Boolean(sources.anthropic), openai: Boolean(sources.openai), sources, tried };
}

/** Where each provider's credential was looked for: places, never values. */
export function describe(resolution) {
  const lines = [];
  for (const provider of ['anthropic', 'openai']) {
    lines.push(`${provider}: ${resolution[provider] ? `available via ${resolution.sources[provider]}` : 'NO credential'}`);
    for (const r of resolution.tried.filter((t) => t.provider === provider)) lines.push(`  ${r.ok ? 'found' : 'no   '} ${r.source.padEnd(7)} ${r.path}${r.why ? ` (${r.why})` : ''}`);
  }
  return lines.join('\n');
}

const keyFile = (env) => Boolean(env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE) && existsSync(env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE);
export function openaiAuthMode(env = process.env) {
  const asked = env.TOPHAT_RUNNER_OPENAI_AUTH;
  if (asked === 'api-key') return keyFile(env) ? 'api-key' : null;
  if (asked === 'chatgpt') return existsSync(chatgptAuthFile(env)) ? 'chatgpt' : null;
  return keyFile(env) ? 'api-key' : existsSync(chatgptAuthFile(env)) ? 'chatgpt' : null;
}

export function providersAvailable(env = process.env) {
  return { anthropic: Boolean(env.TOPHAT_RUNNER_API_KEY_FILE) && existsSync(env.TOPHAT_RUNNER_API_KEY_FILE), openai: Boolean(openaiAuthMode(env)) };
}

export const callerOf = (caller, env = process.env) => {
  const named = caller || env.TOPHAT_RUNNER_CALLER || 'direct-chat';
  return MODELS.callers.includes(named) ? named : 'direct-chat';
};

/** A caller's own key file (`<key file>-<caller>`) when present and non-empty, else the shared one. */
export function keyRoute(caller, env = process.env) {
  const base = env.TOPHAT_RUNNER_API_KEY_FILE, who = callerOf(caller, env);
  const own = base ? `${base}-${who}` : null;
  let routed = false;
  if (own) { try { routed = readFileSync(own, 'utf8').trim().length > 0; } catch { routed = false; } }
  return { caller: who, file: routed ? own : base, routed };
}

function readKey(file, what = 'key file') {
  if (!file) throw new ModelError('auth', 'TOPHAT_RUNNER_API_KEY_FILE is not set');
  let key = '';
  try { key = readFileSync(file, 'utf8').trim(); } catch (error) { throw new ModelError('auth', `${what} unreadable (${error.code || 'error'})`); }
  if (!key) throw new ModelError('auth', `${what} is empty`);
  return key;
}

export function anthropicHeaders(env = process.env, caller = null) {
  const headers = { 'x-api-key': readKey(keyRoute(caller, env).file), 'anthropic-version': '2023-06-01' };
  const file = env.TOPHAT_RUNNER_WORKSPACE_ID_FILE;
  if (file) {
    try { const id = readFileSync(file, 'utf8').trim(); if (id) headers['anthropic-workspace-id'] = id; }
    catch (error) { throw new ModelError('auth', `workspace id file unreadable (${error.code || 'error'})`); }
  }
  return headers;
}

export const CHATGPT_RESPONSES = 'https://chatgpt.com/backend-api/codex/responses';
export const openaiRequestUrl = (env = process.env) => (openaiAuthMode(env) === 'chatgpt' ? CHATGPT_RESPONSES
  : `${(env.TOPHAT_RUNNER_OPENAI_API_BASE || 'https://api.openai.com').replace(/\/+$/, '')}/v1/responses`);

export function openaiHeaders(env = process.env) {
  if (openaiAuthMode(env) === 'chatgpt') {
    let auth;
    try { auth = JSON.parse(readFileSync(chatgptAuthFile(env), 'utf8')); } catch (error) { throw new ModelError('auth', `ChatGPT auth file unreadable (${error.code || 'error'})`); }
    const token = auth?.tokens?.access_token, account = auth?.tokens?.account_id;
    if (!token || !account) throw new ModelError('auth', 'ChatGPT auth file has no access token and account id; run `codex login`');
    return { authorization: `Bearer ${token}`, 'chatgpt-account-id': account, 'openai-beta': 'responses=experimental', originator: 'codex_cli_rs', session_id: randomUUID() };
  }
  if (!env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE) throw new ModelError('auth', 'no OpenAI credential here: set TOPHAT_RUNNER_OPENAI_API_KEY_FILE, or sign Codex in so its ChatGPT auth file exists');
  return { authorization: `Bearer ${readKey(env.TOPHAT_RUNNER_OPENAI_API_KEY_FILE, 'OpenAI key file')}` };
}
