// The vault's device sync: what a browser or a phone needs to keep a full encrypted copy of the
// vault, and how it replays what he did while this Mac was unreachable.
//
// So the replica that was missing is the one on his devices. Same two halves as reader-sync.js: a
// snapshot a device stores, and an op log it replays idempotently.
//
// Keys. The master key never leaves this Mac. Each enrolled device gets its own 32-byte
// AES-256-GCM key, minted at enrolment and kept in a sealed `devices.enc` beside the vault; a
// snapshot is the vault's own records re-sealed one by one under that key, same record names and
// same AAD, so the device's open path is byte-for-byte the Mac's. Revoking a device drops its key
// and every later snapshot for it is a 403. An op carries its value sealed under the device key;
// the server opens it with that key, revalidates it with the real normalizer, and re-seals it
// under the master key through storeEntry, so a device can never write a shape the Mac refuses.
//
// Merge is last-writer-wins by hybrid clock per credential, the rules in src/vault/replica.mjs:
// an op at or below the clock the vault already holds for that id is superseded, never applied,
// and a delete leaves a tombstone. Replay is idempotent because the second attempt is superseded
// by the result of the first.
//
// Nothing here prints, logs or returns a key: not the master key, not a device key beyond the one
// enrolment answer that issues it.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { classifyOp, META_FIELDS } from '../../../../runner/src/vault/replica.mjs';
import { openRecord, sealRecord, secureRead } from '../../../../runner/src/vault/manager.mjs';
import { normalizeValue, originOf } from '../../../../runner/src/vault/values.mjs';

const DEVICES = 'devices';
const MAX_OPS = 500;
const MAX_LABEL = 120;
const DEVICE_ID = /^[0-9a-f]{32}$/;
const LAST_SEEN_EVERY_MS = 60_000;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** An error the route turns into a status; `expose` means the message is safe to show. */
const fail = (status, message) => Object.assign(new Error(message), { expose: true, status });

const emptyRegistry = () => ({ version: 1, devices: {} });

function registry(manager) {
  if (!fs.existsSync(manager.file(DEVICES))) return emptyRegistry();
  let value;
  try {
    value = JSON.parse(manager.read(DEVICES));
  } catch (cause) {
    throw /locked/i.test(cause.message) ? fail(423, 'Vault is locked') : fail(503, 'Device registry unavailable');
  }
  const shaped = value && typeof value === 'object' && value.devices && typeof value.devices === 'object';
  if (!shaped) throw fail(503, 'Device registry unavailable');
  return value;
}

/** Metadata only: a label, when it enrolled, when it last synced. Never the key. */
const publicDevice = ({ deviceId, label, createdAt, lastSeen, revokedAt }) =>
  ({ deviceId, label, createdAt, lastSeen, revokedAt: revokedAt ?? null });

export const listDevices = (manager) => Object.values(registry(manager).devices).map(publicDevice);

// The device's replica id inside every clock it mints, distinct from this Mac's so the hybrid
// clock tiebreak stays deterministic. The device computes the same string; it is sent at
// enrolment so the two sides can never disagree about it.
export const deviceReplicaId = (deviceId) => `d${String(deviceId).slice(0, 8)}`;

/** The live device record, or a 403. A revoked or unknown device gets no snapshot and no write. */
function device(manager, deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw fail(403, 'Device not enrolled');
  const found = registry(manager).devices[deviceId];
  if (!found) throw fail(403, 'Device not enrolled');
  if (found.revokedAt) throw fail(403, 'Device revoked');
  return found;
}

/** The device's AES-256-GCM key as bytes. The caller zeroes it. */
function deviceKey(record) {
  const key = Buffer.from(String(record.key || ''), 'base64');
  if (key.length !== 32) throw fail(503, 'Device key unavailable');
  return key;
}

function writeRegistry(manager, next) {
  manager.write(DEVICES, JSON.stringify(next));
}

/**
 * Enrol this browser: mint a device id and a 32-byte key, record it sealed under the master key,
 * and answer with the key once. The answer is the only time the key leaves this process, and the
 * route sends it `private, no-store`.
 */
export function enrollDevice(manager, { label = 'Device' } = {}) {
  const clean = String(label ?? '').trim().slice(0, MAX_LABEL) || 'Device';
  const deviceId = randomBytes(16).toString('hex');
  const key = randomBytes(32);
  const createdAt = new Date().toISOString();
  try {
    // Inside the vault's own write lock, and bumping the revision, so every other device's next
    // sync sees the new devices list rather than a stale one.
    manager.mutate(() => {
      const next = registry(manager);
      next.devices[deviceId] = { deviceId, label: clean, createdAt, lastSeen: createdAt,
        revokedAt: null, key: b64(key) };
      writeRegistry(manager, next);
    }, { replicate: false });
    // keyStorage tells the device whether to keep the key as it is or wrap it under his
    // passphrase: 'passphrase-wrapped' means the Mac's vault is protected, so an enrolled device
    // must not read it without the passphrase either.
    return { deviceId, deviceKey: b64(key), replica: manager.replicaId(),
      deviceReplica: deviceReplicaId(deviceId), label: clean, createdAt,
      keyStorage: manager.status().keyStorage, devices: listDevices(manager) };
  } finally {
    key.fill(0);
  }
}

/**
 * Stop future snapshots and future writes for a device. It does not reach back into what that
 * device already synced; see docs/vault-security-review.md.
 */
export function revokeDevice(manager, deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw fail(400, 'Unknown device');
  const revokedAt = new Date().toISOString();
  manager.mutate(() => {
    const next = registry(manager);
    const found = next.devices[deviceId];
    if (!found) throw fail(400, 'Unknown device');
    found.revokedAt = found.revokedAt || revokedAt;
    // The key goes with the revocation, so a later bug cannot re-seal a snapshot for it.
    delete found.key;
    writeRegistry(manager, next);
  }, { replicate: false });
  return { deviceId, revokedAt, devices: listDevices(manager) };
}

/** Last synced, kept out of the catalog so a sync never changes the etag it just answered. */
function touch(manager, deviceId, now = Date.now()) {
  try {
    const next = registry(manager);
    const found = next.devices[deviceId];
    if (!found || found.revokedAt) return;
    if (found.lastSeen && now - Date.parse(found.lastSeen) < LAST_SEEN_EVERY_MS) return;
    found.lastSeen = new Date(now).toISOString();
    writeRegistry(manager, next);
  } catch { /* bookkeeping only; never fail a sync over it */ }
}

const etagOf = (revision, deviceId) => `r${revision}-${String(deviceId).slice(0, 8)}`;

/**
 * Everything a device stores, as ciphertext: the catalog, the passkey index and every value
 * record, each re-sealed under this device's key with its own record name as AAD. Plus the etag
 * that says whether anything moved, and the devices list the page renders.
 */
export function snapshot(manager, deviceId) {
  const record = device(manager, deviceId);
  const catalog = manager.catalog();
  const master = manager.key();
  const key = deviceKey(record);
  const reseal = (name, fallback) => {
    const file = manager.file(name);
    if (!fs.existsSync(file)) return fallback === undefined ? null : b64(sealRecord(key, name, fallback));
    const plain = openRecord(master, name, secureRead(file));
    try {
      return b64(sealRecord(key, name, plain));
    } finally {
      plain.fill(0);
    }
  };
  try {
    const values = {};
    const missing = [];
    for (const entry of Object.values(catalog.entries)) {
      const sealed = reseal(entry.keyringName);
      if (sealed) values[entry.keyringName] = sealed;
      else missing.push(entry.keyringName);
    }
    return { etag: etagOf(catalog.revision, deviceId), revision: catalog.revision,
      replica: manager.replicaId(), deviceId, deviceReplica: deviceReplicaId(deviceId),
      now: new Date().toISOString(), keyStorage: manager.status().keyStorage,
      catalog: reseal('catalog', JSON.stringify({ version: 2, revision: catalog.revision, entries: {} })),
      passkeys: reseal('passkeys-index', '[]'), values, missingValues: missing,
      devices: listDevices(manager) };
  } finally {
    master.fill(0);
    key.fill(0);
  }
}

/** Metadata a device may patch, revalidated here rather than trusted. */
function checkMeta(patch) {
  for (const [field, value] of Object.entries(patch)) {
    if (!META_FIELDS.includes(field)) throw fail(400, 'Unknown field');
    if (field === 'name' && !(typeof value === 'string' && value.trim() && value.length <= 200))
      throw fail(400, 'Credential name required');
    if (field === 'notes' && !(typeof value === 'string' && value.length <= 100_000))
      throw fail(400, 'Invalid notes');
    if (field === 'groups' && !(Array.isArray(value) && value.length <= 100
      && value.every((group) => typeof group === 'string' && group.length <= 200)))
      throw fail(400, 'Invalid groups');
    if (field === 'origins') {
      if (!Array.isArray(value) || value.length > 100) throw fail(400, 'Invalid websites');
      for (const origin of value) originOf(origin);
    }
  }
}

/**
 * Open and revalidate one op's payload with the device's key, before anything is written. A value
 * that fails its GCM tag, its JSON or the real normalizer is rejected here, with the vault
 * untouched; only ops that survive this reach the write lock.
 */
function prepare(op, key) {
  if (op.kind !== 'put') return {};
  let plain;
  try {
    plain = openRecord(key, op.keyringName, Buffer.from(String(op.sealedValue), 'base64'));
  } catch {
    throw fail(400, 'Vault integrity check failed');
  }
  try {
    const parsed = JSON.parse(plain.toString('utf8'));
    return { kind: parsed?.kind, value: normalizeValue(parsed?.kind, parsed?.value) };
  } catch (cause) {
    throw cause?.expose ? cause : fail(400, 'Invalid credential');
  } finally {
    plain.fill(0);
  }
}

function applyOne(manager, catalog, op, ready) {
  const verdict = classifyOp(catalog, op);
  if (verdict.status !== 'applied') return verdict;
  if (op.kind === 'delete') {
    const entry = catalog.entries[op.id];
    if (entry) manager.log(catalog, { id: op.id, action: 'forgotten', name: entry.name, kind: entry.kind });
    catalog.tombstones ||= {};
    catalog.tombstones[op.id] = { hlc: op.hlc, name: entry?.name ?? op.id, kind: entry?.kind ?? 'secret' };
    delete catalog.entries[op.id];
    return { status: 'applied' };
  }
  if (op.kind === 'meta') {
    const entry = catalog.entries[op.id];
    const patch = op.patch;
    checkMeta(patch);
    for (const field of META_FIELDS) if (patch[field] !== undefined) entry[field] = patch[field];
    if (patch.name !== undefined) entry.name = patch.name.trim();
    if (patch.origins !== undefined) entry.origins = [...new Set(patch.origins.map(originOf))];
    if (patch.groups !== undefined) entry.groups = [...new Set(patch.groups)];
    entry.archived = Boolean(entry.archived);
    entry.hlc = op.hlc;
    entry.updatedAt = new Date().toISOString();
    manager.log(catalog, { id: op.id, action: 'edited', name: entry.name, fields: Object.keys(patch) });
    return { status: 'applied' };
  }
  const given = op.entry && typeof op.entry === 'object' ? op.entry : {};
  const prior = catalog.entries[op.id];
  // storeEntry seals the value under the master key in a fresh value file and logs the change, so
  // a device write is indistinguishable from one made here, clock aside.
  manager.storeEntry(catalog, { ...given, id: op.id, kind: ready.kind, value: ready.value,
    origins: given.origins ?? prior?.origins ?? [], groups: given.groups ?? prior?.groups ?? [],
    notes: given.notes ?? prior?.notes ?? '', archived: given.archived ?? prior?.archived ?? false,
    name: given.name ?? prior?.name ?? op.id }, { overwrite: true });
  catalog.entries[op.id].hlc = op.hlc;
  if (catalog.tombstones) delete catalog.tombstones[op.id];
  return { status: 'applied', created: !prior };
}

/**
 * Replay a device's op log, in clock order. Answers one result per opId: applied, superseded (a
 * newer write already won; the device drops the op without an error) or rejected with a reason (a
 * shape the vault refuses, which retrying will not fix). Idempotent: the same op twice is applied
 * then superseded, and the second pass changes nothing.
 */
export function applyOps(manager, deviceId, ops) {
  const record = device(manager, deviceId);
  if (!Array.isArray(ops)) throw fail(400, 'ops must be an array');
  if (ops.length > MAX_OPS) throw fail(400, 'Too many ops');
  const key = deviceKey(record);
  const results = {};
  const ready = new Map();
  try {
    // Phase one, outside the write lock: shape, clock, ciphertext and value validation. A tampered
    // or malformed op dies here, so the vault's bytes are never touched on its account.
    const seen = manager.catalog();
    for (const op of ops) {
      const id = typeof op?.opId === 'string' ? op.opId : null;
      if (!id) continue;
      const verdict = classifyOp(seen, op);
      // Superseded and rejected both stop here, so a log that has nothing new in it (the common
      // replay) never takes the write lock and never rewrites a byte of the vault.
      if (verdict.status !== 'applied') { results[id] = verdict; continue; }
      try {
        ready.set(id, prepare(op, key));
      } catch (cause) {
        results[id] = { status: 'rejected', reason: cause?.expose ? cause.message : 'invalid credential' };
      }
    }
    const live = ops.filter((op) => ready.has(op.opId));
    if (live.length) {
      const order = (a, b) => (a.hlc === b.hlc ? (a.opId < b.opId ? -1 : 1) : a.hlc < b.hlc ? -1 : 1);
      manager.mutate((catalog) => {
        for (const op of [...live].sort(order)) {
          try {
            results[op.opId] = applyOne(manager, catalog, op, ready.get(op.opId));
          } catch (cause) {
            results[op.opId] = { status: 'rejected', reason: cause?.expose ? cause.message : 'write failed' };
          }
        }
      }, { replicate: false });
    }
  } finally {
    key.fill(0);
  }
  touch(manager, deviceId);
  return { results, etag: etagOf(manager.catalog().revision, deviceId),
    applied: Object.values(results).filter((result) => result.status === 'applied').length };
}

const HEADERS = { 'cache-control': 'private, no-store', pragma: 'no-cache' };
const answer = (status, body, headers = {}) => ({ status, headers: { ...HEADERS, ...headers }, body });

function refused(cause) {
  const status = Number.isInteger(cause?.status) ? cause.status : 500;
  // A vault error carries nothing of the vault in it unless it was marked safe to show.
  return answer(status, { error: cause?.expose ? cause.message : 'Vault sync failed' });
}

/** The locked check both verbs share: the Mac's vault is protected and nobody has unlocked it. */
function requireUnlocked(manager) {
  if (manager.status().locked) throw fail(423, 'Vault is locked');
}

/**
 * GET: the device's snapshot, or 304 when its etag still holds, 403 when it is unknown or
 * revoked, 423 when the Mac's vault is locked. The route only turns this into a Response.
 */
export function handleSyncGet({ manager, deviceId, ifNoneMatch = null }) {
  try {
    requireUnlocked(manager);
    const record = device(manager, deviceId);
    const etag = etagOf(manager.catalog().revision, record.deviceId);
    if (ifNoneMatch && ifNoneMatch === etag) {
      touch(manager, record.deviceId);
      return answer(304, null, { etag });
    }
    const body = snapshot(manager, record.deviceId);
    touch(manager, record.deviceId);
    return answer(200, body, { etag: body.etag });
  } catch (cause) {
    return refused(cause);
  }
}

/**
 * POST: `enroll` mints a device, `ops` replays a log, `revoke` ends a device, `devices` lists
 * them. Same-origin only, and every one of them refused with 423 while the vault is locked.
 */
export function handleSyncPost({ manager, deviceId, body, sameOrigin = true }) {
  try {
    if (!sameOrigin) throw fail(403, 'Same-origin request required');
    requireUnlocked(manager);
    const action = body?.action || (Array.isArray(body?.ops) ? 'ops' : null);
    if (action === 'enroll') return answer(200, enrollDevice(manager, { label: body.label }));
    if (action === 'devices') return answer(200, { devices: listDevices(manager) });
    if (action === 'revoke') return answer(200, revokeDevice(manager, body.deviceId));
    if (action === 'ops') return answer(200, applyOps(manager, deviceId, body.ops));
    throw fail(400, 'Unknown sync action');
  } catch (cause) {
    return refused(cause);
  }
}
