// One replica: the vendored TenantStore over a local SQLite file, with the package's configuration applied.
// Everything deployment-specific in the upstream (its content-screen word list, its private-people roster, its paths and
// group names) is configuration here: screens, people and scopes come from the config object, nothing from code.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TenantStore, StoreError, PAGE_PROMPT } from '../core/src/tenancy.mjs';
import { SCHEMA } from '../core/vendor/rev6/push/schema.mjs';
import { deviceKeys } from '../core/src/crypto.mjs';
import { normAcl } from '../core/src/policy.mjs';
import { loadPeople } from '../core/vendor/rev6/push/identity.mjs';
import { migrateLegacySupport } from '../core/vendor/rev6/push/support.mjs';

export { StoreError, PAGE_PROMPT };

/**
 * @typedef {{ groups: string[], pattern: string, flags?: string, label?: string }} Screen
 *   A content screen: a new row asked into any of `groups` (and not already in the writer's default scopes) is refused
 *   when its text matches `pattern`. Use it to keep one scope's material out of another by label alone.
 */

export class LinkNotesStore extends TenantStore {
  /** opts as TenantStore, plus opts.screens: Screen[] */
  constructor(file, opts = {}) {
    super(file, opts);
    // note support's own table moved off the name the store's citation index now holds (support.mjs migrateLegacySupport)
    if (!opts.readOnly) migrateLegacySupport(this.db);
    this.screens = (opts.screens || []).map((s) => ({ groups: normAcl(s.groups), re: new RegExp(s.pattern, s.flags ?? 'i'), label: s.label || 'screen' }));
  }
  screenAcl(acl, text, what) {
    if (!acl) return acl;
    const def = this.writeGroups ?? [];
    for (const s of this.screens) {
      const into = acl.filter((g) => s.groups.includes(g) && !def.includes(g));
      if (!into.length) continue;
      const m = String(text ?? '').match(s.re);
      if (m) throw new StoreError(`${s.label}: ${what} matches "${m[0]}", so it cannot go to ${into.join(', ')}; leave scopes unset (default ${def.join(', ') || 'none'}) or reword`);
    }
    return acl;
  }
}

/** Create an empty store file with the memory schema (idempotent: an existing store is left alone). */
export function createStoreFile(file) {
  if (existsSync(file)) {
    const db = new DatabaseSync(file);
    try { if (db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='raw_data'").get()) return false; } finally { db.close(); }
  }
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA journal_mode=WAL'); db.exec(SCHEMA); } finally { db.close(); }
  try { chmodSync(file, 0o600); } catch { /* not ours */ }
  return true;
}

/** A device key pair in a 0600 JSON file, created once (atomic temp+rename). */
export function ensureDeviceKey(file) {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const keys = deviceKeys();
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(keys) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return keys;
}

/** The private-people blocklist from config: an inline list, a roster file, or none. */
export function peopleFrom(config) {
  if (config.people) return Object.fromEntries(config.people.map((p) => [p.id, { strict: p.strict || [], exact: (p.exactLabels || []).map((l) => String(l).trim().toLowerCase().replace(/\s+/gu, ' ')) }]));
  if (config.peopleFile) return loadPeople(config.peopleFile);
  return {};
}

/** Open the replica a sqlite-backend config describes. */
export function openReplica(config) {
  for (const k of ['file', 'user', 'device']) if (typeof config[k] !== 'string' || !config[k]) throw new StoreError(`linknotes config needs ${k}`);
  if (!Array.isArray(config.writeScopes) || !config.writeScopes.length) throw new StoreError('linknotes config needs writeScopes: the scope(s) a row goes to when a write names none');
  createStoreFile(config.file);
  const keys = config.deviceKey ? { privateKey: config.deviceKey, publicKey: config.devicePublicKey } : ensureDeviceKey(config.keyFile || `${config.file}.device-key.json`);
  const store = new LinkNotesStore(config.file, { people: peopleFrom(config), now: config.now, user: config.user, device: config.device, deviceKey: keys.privateKey, writeGroups: config.writeScopes, screens: config.screens || [] });
  return { store, keys };
}
