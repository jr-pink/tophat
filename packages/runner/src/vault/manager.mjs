import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes, createCipheriv, createDecipheriv, createHash, scryptSync} from 'node:crypto';
import {TYPES, invalid, normalizeValue, originOf, totp} from './values.mjs';
import {parseImport} from './imports.mjs';
import {read1PuxData} from './archive-import.mjs';
import {newReplicaId, REPLICA, stampChanges, validHlc} from './replica.mjs';
export {TYPES, originOf, normalizeValue, totp, generatePassword} from './values.mjs';

const ID = /^[a-z0-9][a-z0-9-]{1,100}$/;
const VALUE_FILE = /^value-[0-9a-f]{32}\.enc$/;
const RECORD_HEADER = Buffer.from('AV01'), KEY_HEADER = Buffer.from('AK01');
const KEY_AAD = Buffer.from('tophat:master-key:v1');
export const SCRYPT = {N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024};
const check = (ok, message) => {if (!ok) throw invalid(message);};
const ownedByUs = stat => !(stat.mode & 0o077) && stat.uid === os.userInfo().uid;
export const valueName = () => `value-${randomBytes(16).toString('hex')}`;
// Enough to answer "what happened to this login" years back without letting the
// catalog grow without bound; events are tens of bytes each.
export const HISTORY_LIMIT = 5000;

function secureDirectory(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(dir);
  check(stat.isDirectory() && ownedByUs(stat), 'Vault directory must be owner-only');
}

export function secureRead(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    const usable = stat.isFile() && ownedByUs(stat) && stat.size <= 32 * 1024 * 1024;
    check(usable, 'Vault file must be bounded and owner-only');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// One encrypted record: AV01 | nonce | tag | AES-256-GCM(text), with the
// record's own name as additional data. Exported so the replica sync can move
// and verify ciphertext between directories without a manager per side.
export function sealRecord(key, name, text) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`tophat:${name}`));
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([RECORD_HEADER, nonce, cipher.getAuthTag(), ciphertext]);
}

// Returns the plaintext bytes; the caller zeroes them when done.
export function openRecord(key, name, bytes) {
  try {
    check(bytes.length >= 32 && bytes.subarray(0, 4).equals(RECORD_HEADER), 'Invalid vault record');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
    decipher.setAAD(Buffer.from(`tophat:${name}`));
    decipher.setAuthTag(bytes.subarray(16, 32));
    return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
  } catch {
    throw new Error('Vault integrity check failed');
  }
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function atomic(file, bytes) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const defaultDirectory = () =>
  process.env.TOPHAT_VAULT_DIR || path.join(os.homedir(), '.config/tophat/vault');

// How many recovery codes are left is not a secret, so it lives in the catalog
// beside the entry. Deriving it on list() would mean decrypting every stored
// value just to count one kind of them.
function countOf(kind, value) {
  if (kind === 'recovery-codes') return {remaining: value.length};
  // Carried in the catalog so "which grants expire this week" and "does this one
  // have the scope we need" are answerable from metadata alone, with the tokens
  // themselves still encrypted in their own value file.
  if (kind === 'oauth') return {issuer: value.issuer, account: value.account,
    scopes: value.scopes, expiresAt: value.expiresAt, hasRefreshToken: Boolean(value.refreshToken)};
  // Every identity an account answers to is searchable without decrypting.
  if (kind === 'login') return {usernames: value.usernames, emails: value.emails, phones: value.phones,
    hasTotp: Boolean(value.totp)};
  return {};
}

export class PasswordManager {
  constructor({directory = defaultDirectory(), keyFile} = {}) {
    this.directory = directory;
    this.keyFile = keyFile || process.env.TOPHAT_VAULT_KEY_FILE
      || path.join(path.dirname(directory), 'vault-master-key');
    this.unlockExpires = 0;
    // Hidden from enumeration so an inspect dump, a JSON.stringify or a crash
    // report of a live manager cannot carry the master key.
    Object.defineProperty(this, 'unlockedKey', {value: null, writable: true, enumerable: false});
    Object.defineProperty(this, 'unlockTimer', {value: null, writable: true, enumerable: false});
  }

  initialize() {
    secureDirectory(this.directory);
    secureDirectory(path.dirname(this.keyFile));
    if (!fs.existsSync(this.keyFile)) {
      check(!fs.existsSync(path.join(this.directory, 'catalog.enc')),
        'Vault key missing; restore its key before opening');
      try {
        fs.writeFileSync(this.keyFile, randomBytes(32), {flag: 'wx', mode: 0o600});
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    return this.status();
  }

  status() {
    const initialized = fs.existsSync(this.keyFile);
    const bytes = initialized ? secureRead(this.keyFile) : null;
    const protectedKey = bytes?.subarray(0, 4).equals(KEY_HEADER) ?? false;
    if (this.unlockedKey && Date.now() >= this.unlockExpires) this.lock();
    return {initialized, locked: !initialized || (protectedKey && !this.unlockedKey), encrypted: true,
      keyStorage: protectedKey ? 'passphrase-wrapped' : 'owner-only-local-file',
      passkeys: 'optional-local-authenticator'};
  }

  key() {
    const key = secureRead(this.keyFile);
    if (key.subarray(0, 4).equals(KEY_HEADER)) {
      if (Date.now() >= this.unlockExpires) this.lock();
      check(this.unlockedKey, 'Vault is locked');
      return Buffer.from(this.unlockedKey);
    }
    check(key.length === 32, 'Invalid vault key');
    return key;
  }

  lock() {
    clearTimeout(this.unlockTimer);
    this.unlockTimer = null;
    this.unlockedKey?.fill(0);
    this.unlockedKey = null;
    this.unlockExpires = 0;
    return {locked: true};
  }

  protect(passphrase) {
    const usable = typeof passphrase === 'string' && passphrase.length >= 12 && passphrase.length <= 4096;
    check(usable, 'Use a passphrase of 12 to 4096 characters');
    this.initialize();
    const key = this.key(), salt = randomBytes(16), nonce = randomBytes(12);
    const derived = scryptSync(passphrase, salt, 32, SCRYPT);
    try {
      const cipher = createCipheriv('aes-256-gcm', derived, nonce);
      cipher.setAAD(KEY_AAD);
      const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
      atomic(this.keyFile, Buffer.concat([KEY_HEADER, salt, nonce, cipher.getAuthTag(), ciphertext]));
    } finally {
      key.fill(0);
      derived.fill(0);
      this.lock();
    }
    return this.status();
  }

  unlock(passphrase, {ttlMs = 15 * 60 * 1000} = {}) {
    check(typeof passphrase === 'string' && passphrase.length <= 4096, 'Invalid passphrase');
    const bounded = Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 60 * 60 * 1000;
    check(bounded, 'Invalid unlock duration');
    this.lock();
    const bytes = secureRead(this.keyFile);
    check(bytes.length === 80 && bytes.subarray(0, 4).equals(KEY_HEADER), 'Vault has no wrapped master key');
    const derived = scryptSync(passphrase, bytes.subarray(4, 20), 32, SCRYPT);
    try {
      const decipher = createDecipheriv('aes-256-gcm', derived, bytes.subarray(20, 32));
      decipher.setAAD(KEY_AAD);
      decipher.setAuthTag(bytes.subarray(32, 48));
      this.unlockedKey = Buffer.concat([decipher.update(bytes.subarray(48)), decipher.final()]);
      this.unlockExpires = Date.now() + ttlMs;
      // Expiring lazily leaves the key in memory until something next asks for
      // it, which on an idle machine is until the process exits. The timer is
      // unref'd so holding it never keeps a command alive.
      this.unlockTimer = setTimeout(() => this.lock(), ttlMs);
      this.unlockTimer.unref();
    } catch {
      this.lock();
      throw new Error('Vault unlock failed');
    } finally {
      derived.fill(0);
    }
    return this.status();
  }

  file(name) {
    check(ID.test(name), 'Invalid vault record ID');
    return path.join(this.directory, `${name}.enc`);
  }

  // Every record is bound to its own name through the AAD, so a value file cannot
  // be swapped for another record's ciphertext.
  read(name) {
    secureDirectory(this.directory);
    const bytes = secureRead(this.file(name)), key = this.key();
    try {
      const plain = openRecord(key, name, bytes);
      try {
        return plain.toString('utf8');
      } finally {
        plain.fill(0);
      }
    } finally {
      key.fill(0);
    }
  }

  write(name, text) {
    this.initialize();
    const key = this.key();
    try {
      atomic(this.file(name), sealRecord(key, name, text));
    } finally {
      key.fill(0);
    }
  }

  catalog() {
    if (!fs.existsSync(this.file('catalog'))) return {version: 2, revision: 0, entries: {}};
    let value;
    try {
      value = JSON.parse(this.read('catalog'));
    } catch (error) {
      throw /locked/i.test(error.message) ? error : new Error('Vault catalog unavailable');
    }
    const shaped = value.version === 2 && Number.isSafeInteger(value.revision)
      && value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries)
      && (value.history === undefined || Array.isArray(value.history));
    check(shaped, 'Invalid vault catalog');
    const map = field => value[field] === undefined
      || (value[field] && typeof value[field] === 'object' && !Array.isArray(value[field]));
    check(map('tombstones') && map('passkeyClocks') && map('passkeyTombstones') && map('sync'),
      'Invalid vault catalog');
    for (const [id, tomb] of Object.entries(value.tombstones || {}))
      check(ID.test(id) && validHlc(tomb?.hlc), 'Invalid vault tombstone');
    for (const [id, entry] of Object.entries(value.entries)) {
      const valid = ID.test(id) && entry.id === id && TYPES.includes(entry.kind)
        && /^value-[a-f0-9]{32}$/.test(entry.keyringName)
        && Array.isArray(entry.origins) && Array.isArray(entry.groups);
      check(valid, 'Invalid vault entry');
      check(entry.hlc === undefined || validHlc(entry.hlc), 'Invalid vault entry clock');
    }
    return value;
  }

  // The lock records the writer's pid, so a crashed run is recoverable rather than
  // permanent, and a live one is reported as busy instead of being overwritten.
  #claimLock(lock) {
    try {
      fs.writeFileSync(lock, String(process.pid), {flag: 'wx', mode: 0o600});
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const pid = Number(secureRead(lock).toString());
    check(Number.isSafeInteger(pid) && pid > 0, 'Vault lock requires recovery');
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      fs.unlinkSync(lock);
      return false;
    }
    throw new Error('Vault is busy');
  }

  // This replica's id: not a secret, one per vault directory, minted once.
  // It is the tiebreak inside every clock this replica writes.
  replicaId() {
    const file = path.join(this.directory, 'replica-id');
    if (!fs.existsSync(file)) {
      secureDirectory(this.directory);
      try {
        fs.writeFileSync(file, newReplicaId(), {flag: 'wx', mode: 0o600});
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const id = secureRead(file).toString('utf8').trim();
    check(REPLICA.test(id), 'Invalid vault replica id');
    return id;
  }

  passkeyIndex() {
    return fs.existsSync(this.file('passkeys-index')) ? JSON.parse(this.read('passkeys-index')) : [];
  }

  // Every mutation is diffed against the catalog it started from, so each
  // created, changed or deleted credential and passkey gets a clock (and a
  // deletion a tombstone) whatever code path made it; callers do not stamp.
  // {replicate: false} is the sync's own write of an already merged state,
  // which must keep the clocks it merged rather than re-stamp them as local.
  mutate(fn, {replicate = true} = {}) {
    this.initialize();
    const lock = path.join(this.directory, 'write.lock');
    if (!this.#claimLock(lock)) return this.mutate(fn, {replicate});
    try {
      const catalog = this.catalog();
      const before = replicate
        ? {entries: structuredClone(catalog.entries), passkeys: this.passkeyIndex()} : null;
      const result = fn(catalog);
      if (replicate) {
        catalog.crdt = 1;
        stampChanges(catalog, before, this.passkeyIndex(), this.replicaId());
      }
      catalog.revision++;
      this.write('catalog', JSON.stringify(catalog));
      this.sweep(catalog);
      return result;
    } finally {
      fs.unlinkSync(lock);
    }
  }

  // A replaced password or a spent recovery code stays decryptable until its own
  // ciphertext is gone, so unreferenced value files go once the catalog naming
  // their successor is durable. A crash in between leaves an orphan that the
  // next mutation collects.
  sweep(catalog) {
    const live = new Set(Object.values(catalog.entries).map(entry => `${entry.keyringName}.enc`));
    for (const name of fs.readdirSync(this.directory))
      if (VALUE_FILE.test(name) && !live.has(name)) fs.unlinkSync(path.join(this.directory, name));
  }

  // The log lives in the catalog, so it is encrypted by the same key as the
  // entries it describes and lands in the same atomic write; a change and its
  // record cannot disagree. An event names what changed, never what it became:
  // no password, token or code is ever written here.
  log(catalog, event) {
    if (!Array.isArray(catalog.history)) catalog.history = [];
    catalog.history.push({at: new Date().toISOString(), revision: catalog.revision + 1, ...event});
    if (catalog.history.length > HISTORY_LIMIT)
      catalog.history.splice(0, catalog.history.length - HISTORY_LIMIT);
    return event;
  }

  history({id = null, limit = 50} = {}) {
    check(id === null || (typeof id === 'string' && ID.test(id)), 'Invalid credential ID');
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= HISTORY_LIMIT, 'Invalid history limit');
    const all = Array.isArray(this.catalog().history) ? this.catalog().history : [];
    return (id ? all.filter(event => event.id === id) : all).slice(-limit).reverse();
  }

  forget(id) {
    return this.mutate(catalog => {
      const entry = this.entry(catalog, id);
      this.log(catalog, {id, action: 'forgotten', name: entry.name, kind: entry.kind});
      delete catalog.entries[id];
      return {id, forgotten: true};
    });
  }

  // Autofill asks by website rather than by id. An archived entry is out of the
  // ordinary answer and stays readable through archived:true.
  lookup(destination, {archived = false} = {}) {
    const origin = originOf(destination);
    return this.list({archived}).filter(entry => entry.origins.includes(origin));
  }

  metadata(entry) {
    // The clock is replication bookkeeping, like the value file name: callers
    // see what the credential is, not how it merges.
    const {keyringName, hlc, ...out} = entry;
    return out;
  }

  list({archived = false, group = null} = {}) {
    return Object.values(this.catalog().entries)
      .filter(entry => (archived || !entry.archived) && (!group || entry.groups.includes(group)))
      .map(entry => this.metadata(entry));
  }

  normalize({id, name, kind, origins = [], value, groups = [], archived = false, notes = ''}) {
    // ID.test coerces, so a missing id passes as the string 'undefined' and writes
    // an entry whose id field is undefined: a catalog its own reader then rejects.
    const named = typeof id === 'string' && ID.test(id)
      && typeof name === 'string' && name.trim() && name.length <= 200;
    check(named, 'Credential ID and name required');
    const labelled = Array.isArray(origins) && origins.length <= 100
      && Array.isArray(groups) && groups.length <= 100
      && groups.every(group => typeof group === 'string' && group.length <= 200);
    check(labelled, 'Invalid groups or websites');
    check(typeof notes === 'string' && notes.length <= 100000, 'Invalid notes');
    const normalized = normalizeValue(kind, value), allowed = [...new Set(origins.map(originOf))];
    // A website is optional. Autofill stays safe: use() refuses any destination
    // whose origin is not listed, so an entry with no websites is never
    // autofilled.
    check(Buffer.byteLength(JSON.stringify(normalized)) <= 1024 * 1024, 'Credential too large');
    return {id, name: name.trim(), kind, origins: allowed, value: normalized,
      groups: [...new Set(groups)], archived: Boolean(archived), notes};
  }

  storeEntry(catalog, input, {overwrite = false} = {}) {
    const {value, ...metadata} = this.normalize(input);
    check(!Object.hasOwn(catalog.entries, metadata.id) || overwrite,
      'Credential exists; explicit replacement required');
    const existing = catalog.entries[metadata.id];
    const keyringName = valueName();
    this.write(keyringName, JSON.stringify({kind: metadata.kind, value}));
    catalog.entries[metadata.id] = {...metadata, keyringName, ...countOf(metadata.kind, value),
      updatedAt: new Date().toISOString()};
    this.log(catalog, {id: metadata.id, action: existing ? 'replaced' : 'created',
      name: metadata.name, kind: metadata.kind});
    return this.metadata(catalog.entries[metadata.id]);
  }

  save(input, options) {
    this.normalize(input);
    return this.mutate(catalog => this.storeEntry(catalog, input, options));
  }

  entry(catalog, id) {
    const known = typeof id === 'string' && ID.test(id) && Object.hasOwn(catalog.entries, id);
    check(known, 'Unknown credential');
    return catalog.entries[id];
  }

  value(entry) {
    const parsed = JSON.parse(this.read(entry.keyringName));
    check(parsed.kind === entry.kind, 'Credential type mismatch');
    if (entry.kind === 'recovery-codes' && parsed.value.length === 0) return [];
    return normalizeValue(entry.kind, parsed.value);
  }

  archive(id, archived = true) {
    return this.mutate(catalog => {
      const entry = this.entry(catalog, id);
      entry.archived = Boolean(archived);
      entry.updatedAt = new Date().toISOString();
      this.log(catalog, {id, action: entry.archived ? 'archived' : 'unarchived', name: entry.name});
      return this.metadata(entry);
    });
  }

  groups(id, groups) {
    const labelled = Array.isArray(groups) && groups.length <= 100
      && groups.every(group => typeof group === 'string' && group.length <= 200);
    check(labelled, 'Invalid groups');
    return this.mutate(catalog => {
      const entry = this.entry(catalog, id);
      const before = entry.groups;
      entry.groups = [...new Set(groups)];
      entry.updatedAt = new Date().toISOString();
      this.log(catalog, {id, action: 'grouped', name: entry.name, from: before, to: entry.groups});
      return this.metadata(entry);
    });
  }

  // The caller receives the secret inside its own callback rather than as a return
  // value, so nothing holds a decrypted credential after the use it was asked for.
  async use(id, destination, consume) {
    const entry = this.entry(this.catalog(), id);
    check(!entry.archived, 'Credential archived');
    check(entry.origins.includes(originOf(destination)), 'Credential not authorized for destination');
    check(['login', 'totp', 'secret'].includes(entry.kind), 'Use dedicated credential operation');
    return consume(entry.kind === 'totp' ? totp(this.value(entry)) : this.value(entry));
  }

  takeRecoveryCode(id) {
    return this.mutate(catalog => {
      const entry = this.entry(catalog, id);
      check(!entry.archived && entry.kind === 'recovery-codes', 'Not an active recovery-code entry');
      const [code, ...remaining] = this.value(entry);
      check(code, 'No unused recovery codes');
      const keyringName = valueName();
      this.write(keyringName, JSON.stringify({kind: entry.kind, value: remaining}));
      entry.keyringName = keyringName;
      entry.remaining = remaining.length;
      entry.updatedAt = new Date().toISOString();
      // The code itself is the return value; the caller needs the factor, and
      // how many are left is read off the entry afterwards.
      return code;
    });
  }

  passkey(id) {
    const entry = this.entry(this.catalog(), id);
    check(!entry.archived && entry.kind === 'passkey-reference', 'Not an active passkey reference');
    return {...this.value(entry), requiresPlatformAuthenticator: true};
  }

  import(format, input, {overwrite = false} = {}) {
    const parsed = parseImport(format, input);
    const entries = parsed.entries.map(entry => this.normalize(entry));
    const result = this.mutate(catalog => {
      let imported = 0, skipped = 0;
      for (const entry of entries) {
        if (catalog.entries[entry.id] && !overwrite) {
          skipped++;
          continue;
        }
        this.storeEntry(catalog, entry, {overwrite});
        imported++;
      }
      return {imported, skipped};
    });
    return {...result, warnings: parsed.warnings};
  }

  importArchive(bytes, options) {
    return this.import('1pux', read1PuxData(bytes), options);
  }

  // ssh wants a file, so the key exists on disk only inside an owner-only
  // temporary directory that is removed whether or not the consumer throws.
  async withSshKey(id, consume) {
    const entry = this.entry(this.catalog(), id);
    check(!entry.archived && entry.kind === 'ssh-key', 'Not an active SSH key');
    const value = this.value(entry);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-ssh-'));
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'identity');
    try {
      fs.writeFileSync(file, value.privateKey, {mode: 0o600});
      return await consume({path: file, passphrase: value.passphrase});
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }
}
