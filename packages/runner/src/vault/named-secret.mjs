// Named secrets, read out of the tophat vault, and the one rule for which copy wins.
//
// Vault record IDs are [a-z0-9-] only, so a name carrying a dot
// (mercury-mcp-oauth.json) is stored under mercury-mcp-oauth-json with the exact
// keyring name kept as the entry's name. Both resolve here, and the value is
// byte-identical to what readSecret() returned: the file's text, trimmed.
//
// WHICH COPY WINS IS ONE RULE AND THIS FILE OWNS IT. A name can exist twice over: as a
// vault entry, and as a plaintext file some legacy writer still updates.
// `namedSecretValue` is the rule; `preferLegacyFile` is the comparison alone, so the
// branch that decides a live credential can be exercised without a vault.
// tests/secret-precedence-one-owner.test.mjs pins the callers to it.
//
// Nothing here prints or logs a value: a return is the only way one leaves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PasswordManager} from './manager.mjs';

export const vaultId = name => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 101);

function open({directory, keyFile} = {}) {
  const dir = directory || process.env.TOPHAT_VAULT_DIR || path.join(os.homedir(), '.config/tophat/vault');
  const key = keyFile || process.env.TOPHAT_VAULT_KEY_FILE || path.join(path.dirname(dir), 'vault-master-key');
  return new PasswordManager({directory: dir, keyFile: key});
}

/**
 * The stored record behind a name: its id, its value and when the vault last
 * wrote it. The timestamp is what lets a caller tell a vault copy from a newer
 * value some legacy writer dropped on disk beside it, so it is returned rather
 * than hidden. Null when the name is not a secret in this vault.
 */
export function namedSecretRecord(name, options = {}) {
  if (typeof name !== 'string' || !name) return null;
  const manager = open(options);
  try {
    if (!fs.existsSync(manager.directory)) return null;
    const entries = manager.catalog().entries;
    const found = entries[vaultId(name)] || Object.values(entries).find(entry => entry.name === name);
    if (!found || found.kind !== 'secret') return null;
    const value = manager.value(found);
    if (typeof value !== 'string') return null;
    return {id: found.id, name: found.name, value, updatedAt: found.updatedAt || null};
  } catch {
    return null;
  } finally {
    manager.lock();
  }
}

/**
 * The first of `dirs` holding a non-empty plaintext copy of `name`, as
 * `{dir, file, value, writtenAt}`, or null. First rather than newest, because
 * the directory order is itself a precedence the caller chose.
 */
export function legacySecretFile(name, dirs = []) {
  if (typeof name !== 'string' || !name) return null;
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      const writtenAt = fs.statSync(file).mtimeMs;
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return {dir, file, value, writtenAt};
    } catch { /* not in this dir */ }
  }
  return null;
}

/**
 * True when a legacy plaintext copy was written after the vault record and so
 * wins. A record with no timestamp cannot lose: it is the vault's own value and
 * there is nothing to compare it against.
 */
export function preferLegacyFile(record, file) {
  if (!record?.value || !file || !record.updatedAt) return false;
  const storedAt = Date.parse(record.updatedAt);
  return Number.isFinite(storedAt) && file.writtenAt > storedAt;
}

/**
 * One named secret and where it came from: `{value, source}` with source
 * `'vault'`, `` `file:${dir}` `` or null. `dirs` are the legacy plaintext
 * directories to consider, in precedence order; everything else is passed
 * through to the vault reader. An empty vault value is treated as absent, so a
 * blanked entry falls through to a legacy file rather than resolving to ''.
 */
export function namedSecretValue(name, {dirs = [], ...options} = {}) {
  const file = legacySecretFile(name, dirs);
  const record = namedSecretRecord(name, options);
  if (preferLegacyFile(record, file)) return {value: file.value, source: `file:${file.dir}`};
  if (record?.value) return {value: record.value, source: 'vault', id: record.id, updatedAt: record.updatedAt};
  return file ? {value: file.value, source: `file:${file.dir}`} : {value: null, source: null};
}

/** One named secret from the tophat vault. Null when it is not there. */
export function readNamedSecret(name, options = {}) {
  const record = namedSecretRecord(name, options);
  return record ? record.value : null;
}

/** One named secret, or a failure that says which name and which vault. */
export function requireNamedSecret(name, options = {}) {
  const value = readNamedSecret(name, options);
  if (value) return value;
  const manager = open(options);
  throw new Error(`Vault secret "${name}" is missing from ${manager.directory}. ` +
    'Check it with: tophat-pass find ' + name);
}
