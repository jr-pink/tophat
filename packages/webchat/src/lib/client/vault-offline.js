// The vault's copy of itself on this device, so a dead server, a dead tunnel or a plane is not a
// page that cannot tell him his own password.
//
// So the replica that was missing is this one: the browser holds the same sealed records the Mac
// holds, re-sealed under a key of its own, and /secrets boots, lists, searches, reveals and accepts
// writes with the server unreachable.
//
// IndexedDB database `tophat-vault` (its own database, so it cannot collide with `tophat-reader` or
// `tophat-webchat`):
//   meta      deviceId, enrolledAt, etag, lastSync, the server's replica id, the type list, the
//             wrapped device key when the vault is passphrase protected
//   keys      {id:'device', key} a NON-EXTRACTABLE CryptoKey; the raw bytes are zeroed at import
//             and never written anywhere
//   records   sealed records, byte for byte: `catalog`, `passkeys-index`, every `value-<32hex>`
//   ops       what he did here that the Mac has not acknowledged, each row sealed under the
//             device key, so entry names and groups are not plaintext at rest either
//   rejected  ops the Mac refused for good; kept, never dropped
//
// Nothing plaintext is ever written to the database. The decrypted catalog, the pending ops and
// whatever single value he just revealed live in page memory for the session and nowhere else.
//
// The screen is the confirmed catalog with the pending ops folded on top, by the same reducer the
// Mac runs (src/vault/replica.mjs), so a password changed offline is in the list at once, survives
// a reload, and is replayed to POST /api/password-manager/sync when the Mac answers again.

// What the /secrets page calls (createVaultReplica(...) or the shared vaultReplica()):
//   await ready                        resolves when the device store is open and read
//   api(path, options)                 drop-in for fetch+json over /api/password-manager; returns
//                                      the parsed body, throws with .offline/.signedOut/.locked/
//                                      .rejected/.notEnrolled set
//   start() / stop()                   sync triggers: mount, 4 min, 15 s retry, online, visible, push
//   state()                            {enrolled, deviceId, online, syncing, pending, rejected,
//                                      lastSync, locked, signedOut, revoked, needsPassphrase,
//                                      entries, keyStorage, error}
//   condition()                        one word for the pill: not-enrolled | passphrase | revoked |
//                                      signed-out | offline | locked | syncing | ok
//   subscribe(fn)                      every state change, called once immediately; returns unsubscribe
//   enroll(label?)                     {deviceId, enrolled:true}; forgetDevice() wipes this device
//   list({archived, group, kind, query, labels}?) / search(query, scope?)  metadata rows, or null
//                                      when this device holds no catalog yet
//   entry(id) / history({id, limit}?)  one row's metadata / the catalog's log, newest first
//   reveal(id)                         {id, kind, value, local:true}; a totp entry answers
//                                      {code, expiresAt}. code(id) is the code alone
//   save(input) / patch(id, fields) / archive(id, on) / groups(id, list) / forget(id)
//                                      apply locally, queue an op, flush; {entry|forgotten, queued}
//   sync() / flush() / pending() / devices() / unlockDevice(passphrase)
//
import { serverDown } from '$lib/core/reader-replica.js';
import { liveSubscribe } from '$lib/client/live.js';
import {
  deriveWrapKey, fromBase64, importDeviceKey, newValueName, openJson, randomBytes, sealJson,
  toBase64, toHex, totp, unwrapDeviceKey
} from '$lib/core/vault-crypto.js';
import * as replica from '../../../../runner/src/vault/replica.mjs';

export const DB_NAME = 'tophat-vault';
const DB_VERSION = 1;
const STORES = ['meta', 'keys', 'records', 'ops', 'rejected'];
const KEYS = { meta: 'key', keys: 'id', records: 'name', ops: 'opId', rejected: 'opId' };
const SYNC_PATH = '/api/password-manager/sync';
const VAULT_PATH = '/api/password-manager';
const SYNC_EVERY_MS = 4 * 60_000;
const RETRY_EVERY_MS = 15_000;
export const PUSH_QUIET_MS = 1500;
const REQUEST_TIMEOUT_MS = 10_000;
const OPS_PER_BATCH = 50;
/** What only the Mac can do: these touch the master key, the parsers or the request inbox. */
export const ONLINE_ONLY = new Set(['protect', 'unlock', 'lock', 'import', 'enroll', 'revoke']);

// --- the shared reducer -------------------------------------------------------------------------
// One reducer file for the Mac and the browser, as reader-replica.js is for the reader: these four
// are src/vault/replica.mjs's, imported, never reimplemented here, so the merge rules cannot drift
// between the device and the server.

const { tick, latestHlc, META_FIELDS } = replica;
const { applyOpToCatalog, foldCatalog, vaultList, vaultSearch } = replica;
export { applyOpToCatalog, foldCatalog, vaultList, vaultSearch };

/** Catalog bookkeeping is not the page's business: the same cut the Mac's metadata() makes. */
const metadata = (entry) => { const { keyringName, hlc, ...out } = entry || {}; return out; };

// --- a small promise face on IndexedDB ------------------------------------------------------------

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openVaultDb(idb = globalThis.indexedDB, name = DB_NAME, version = DB_VERSION) {
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try { request = idb.open(name, version); } catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: KEYS[store] });
    };
    request.onsuccess = () => {
      const db = request.result;
      // A database someone opened without a version exists at version 1 with no stores, and
      // opening it at 1 again never upgrades; step the version until the stores are there.
      if (STORES.every((s) => db.objectStoreNames.contains(s))) { resolve(db); return; }
      const next = db.version + 1;
      db.close();
      if (next > version + 4) { resolve(null); return; }
      openVaultDb(idb, name, next).then(resolve);
    };
    request.onerror = () => {
      if (request.error?.name === 'VersionError') {
        try {
          const plain = idb.open(name);
          plain.onsuccess = () => resolve(STORES.every((s) => plain.result.objectStoreNames.contains(s)) ? plain.result : null);
          plain.onerror = () => resolve(null);
        } catch { resolve(null); }
        return;
      }
      resolve(null);
    };
    request.onblocked = () => resolve(null);
  });
}

function tx(db, stores, mode, work) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
    out = work(...stores.map((s) => t.objectStore(s)));
  });
}

const getAll = (db, store) => tx(db, [store], 'readonly', (s) => promisify(s.getAll()));

// --- the replica ----------------------------------------------------------------------------------

export function createVaultReplica({
  fetchImpl = (...args) => globalThis.fetch(...args),
  indexedDB = globalThis.indexedDB,
  dbName = DB_NAME,
  now = () => Date.now(),
  label = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
  subscribeLive = liveSubscribe,
  pushQuietMs = PUSH_QUIET_MS,
  crypto = globalThis.crypto
} = {}) {
  let db = null;
  let deviceId = null;
  let deviceKey = null;            // non-extractable CryptoKey, or null when not enrolled
  let replicaId = null;            // d<first 8 hex of deviceId>, distinct from the Mac's
  let catalog = null;              // decrypted, in memory, this session only
  let passkeys = [];
  let devices = [];
  let types = null;
  let ops = [];                    // pending, decrypted, in order
  let rejectedCount = 0;
  let etag = null;
  let seq = 0;
  let latest = null;               // the newest clock this device has seen or minted
  let keyWrap = null;              // {salt, wrapped} while the vault is passphrase protected
  const inflight = new Set();
  const lastResults = new Map();
  const listeners = new Set();
  const status = {
    enrolled: false, deviceId: null, online: true, syncing: false, pending: 0, rejected: 0,
    lastSync: null, locked: false, signedOut: false, revoked: false, needsPassphrase: false,
    entries: 0, keyStorage: null, error: null
  };
  let flushing = null;
  let syncing = null;
  let timer = null;
  let retry = null;

  const notify = () => {
    status.pending = ops.length;
    status.rejected = rejectedCount;
    status.enrolled = Boolean(deviceId && deviceKey);
    status.deviceId = deviceId;
    status.entries = Object.keys(folded()?.entries || {}).length;
    for (const fn of listeners) { try { fn({ ...status }); } catch { /* a listener's problem */ } }
  };

  const putMeta = (key, value) => (db ? tx(db, ['meta'], 'readwrite', (s) => s.put({ key, value })).catch(() => {}) : Promise.resolve());

  const ready = (async () => {
    db = await openVaultDb(indexedDB, dbName);
    if (!db) return;
    const [meta, keyRows, opRows, rejectedRows] = await Promise.all([
      getAll(db, 'meta'), getAll(db, 'keys'), getAll(db, 'ops'), getAll(db, 'rejected')]);
    for (const row of meta) {
      if (row.key === 'deviceId') deviceId = row.value;
      if (row.key === 'etag') etag = row.value;
      if (row.key === 'lastSync') status.lastSync = row.value;
      if (row.key === 'devices') devices = row.value || [];
      if (row.key === 'types') types = row.value || null;
      if (row.key === 'keyWrap') keyWrap = row.value || null;
      if (row.key === 'deviceReplica') replicaId = row.value || replicaId;
      if (row.key === 'keyStorage') status.keyStorage = row.value || null;
    }
    deviceKey = keyRows.find((row) => row.id === 'device')?.key || null;
    rejectedCount = rejectedRows.length;
    if (deviceId) replicaId = `d${String(deviceId).slice(0, 8)}`;
    status.needsPassphrase = Boolean(deviceId && !deviceKey && keyWrap);
    if (deviceKey) {
      await loadCatalog();
      ops = (await Promise.all(opRows.map((row) => openOp(row)))).filter(Boolean)
        .sort((a, b) => (a.seq - b.seq) || String(a.at).localeCompare(String(b.at)));
      seq = ops.reduce((m, op) => Math.max(m, op.seq || 0), 0);
    }
    notify();
  })().catch(() => {});

  async function loadCatalog() {
    const bytes = await recordBytes('catalog');
    if (bytes) catalog = await openJson(deviceKey, 'catalog', bytes).catch(() => catalog);
    const keys = await recordBytes('passkeys-index');
    if (keys) passkeys = await openJson(deviceKey, 'passkeys-index', keys).catch(() => passkeys);
    latest = latestHlc(catalog || { entries: {} }) || latest;
  }

  const recordBytes = (name) => (db ? tx(db, ['records'], 'readonly', (s) => promisify(s.get(name)))
    .then((row) => (row ? new Uint8Array(row.bytes) : null)).catch(() => null) : Promise.resolve(null));

  const openOp = (row) => openJson(deviceKey, `op-${row.opId}`, new Uint8Array(row.sealed))
    .then((op) => ({ ...op, opId: row.opId, seq: row.seq })).catch(() => null);

  // --- talking to the Mac -------------------------------------------------------------------------

  function setOnline(value) {
    if (status.online === value) return;
    status.online = value;
    notify();
    if (value) setTimeout(() => { flush().catch(() => {}); }, 0);
  }

  const offlineError = (cause, response) => {
    const error = new Error('The vault server is not reachable.');
    error.offline = true;
    if (cause) error.cause = cause;
    if (response) error.status = response.status;
    return error;
  };

  /**
   * One request, classified the way the three conditions actually differ: a 5xx or a Cloudflare
   * HTML page is offline and never signed out, a real 401 is signed out, a 423 is the vault locked
   * on the Mac, a 403 is this device revoked or unknown.
   */
  async function request(path, options = {}) {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const headers = { ...(options.headers || {}) };
    if (deviceId) headers['x-tophat-device'] = deviceId;
    let response;
    try {
      response = await fetchImpl(path, { signal, ...options, headers });
    } catch (cause) {
      setOnline(false);
      throw offlineError(cause);
    }
    if (serverDown(response)) {
      setOnline(false);
      throw offlineError(null, response);
    }
    setOnline(true);
    // Anything the Mac answered properly clears the three conditions, the 304 included: a current
    // device syncs by 304 for hours, and a stale "signed out" would outlive the thing it described.
    if (response.ok || response.status === 304) {
      if (status.signedOut || status.locked || status.revoked) {
        status.signedOut = false;
        status.locked = false;
        status.revoked = false;
        notify();
      }
      if (response.status === 304) return { unchanged: true };
      return response.json().catch(() => ({}));
    }
    const body = await response.json().catch(() => ({}));
    const fail = (message, flag) => {
      status[flag] = true;
      notify();
      const error = new Error(body.error || message);
      error.status = response.status;
      error[flag] = true;
      return error;
    };
    if (response.status === 401) throw fail('Signed out; sign in again.', 'signedOut');
    if (response.status === 423) throw fail('The vault is locked on the Mac.', 'locked');
    if (response.status === 403 && deviceId) throw fail('This device is no longer enrolled.', 'revoked');
    const error = new Error(body.error || `${response.status}`);
    error.status = response.status;
    throw error;
  }

  const postSync = (payload) => request(SYNC_PATH, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

  // --- enrolment ----------------------------------------------------------------------------------

  /** Keep a copy on this device: one click on a signed-in page. The raw key dies at import. */
  async function enroll(deviceLabel = label) {
    await ready;
    const answer = await postSync({ action: 'enroll', label: deviceLabel || defaultLabel() });
    const raw = fromBase64(answer.deviceKey || answer.key || '');
    if (raw.length !== 32) throw new Error('The vault did not return a device key.');
    deviceKey = await importDeviceKey(raw, { crypto });   // zeroes raw; non-extractable from here on
    deviceId = String(answer.deviceId || answer.device || '');
    // The Mac mints the device's replica id (d + the first 8 hex of the device id) so the clock
    // tiebreak is the same string on both sides; derive it only if an older route omits it.
    replicaId = answer.deviceReplica || `d${deviceId.slice(0, 8)}`;
    status.keyStorage = answer.keyStorage ?? status.keyStorage;
    if (Array.isArray(answer.devices)) devices = answer.devices;
    const storage = status.keyStorage;
    if (db) await tx(db, ['keys', 'meta'], 'readwrite', (keys, meta) => {
      keys.put({ id: 'device', key: deviceKey });
      meta.put({ key: 'deviceId', value: deviceId });
      meta.put({ key: 'deviceReplica', value: replicaId });
      meta.put({ key: 'enrolledAt', value: new Date(now()).toISOString() });
      if (answer.replica) meta.put({ key: 'replica', value: answer.replica });
      if (storage) meta.put({ key: 'keyStorage', value: storage });
    });
    status.revoked = false;
    notify();
    await sync();
    return { deviceId, enrolled: true };
  }

  const defaultLabel = () => {
    const agent = globalThis.navigator?.userAgent || '';
    const which = /iphone|ipad/iu.test(agent) ? 'iPhone' : /android/iu.test(agent) ? 'Android'
      : /macintosh/iu.test(agent) ? 'Mac' : 'browser';
    return `${which} browser`;
  };

  /** Drop this device's copy locally. The Mac still lists it until he revokes it there. */
  async function forgetDevice() {
    await ready;
    if (db) await tx(db, STORES, 'readwrite', (...stores) => { for (const s of stores) s.clear(); }).catch(() => {});
    deviceId = null; deviceKey = null; replicaId = null; catalog = null; passkeys = []; devices = [];
    ops = []; rejectedCount = 0; etag = null; seq = 0; latest = null; keyWrap = null;
    status.needsPassphrase = false; status.revoked = false;
    notify();
    return { forgotten: true };
  }

  // --- the op log ---------------------------------------------------------------------------------

  const newOpId = () => `vop_${toHex(randomBytes(8, crypto))}`;

  function nextHlc() {
    latest = tick(latest, replicaId, now());
    return latest;
  }

  async function enqueue(op) {
    ops.push(op);
    if (db) {
      const sealed = await sealJson(deviceKey, `op-${op.opId}`, op, { crypto });
      await tx(db, ['ops'], 'readwrite', (s) => s.put({ opId: op.opId, seq: op.seq, at: op.at, sealed }));
    }
    notify();
    return op;
  }

  function mint(kind, id, fields) {
    return { opId: newOpId(), seq: ++seq, at: new Date(now()).toISOString(), hlc: nextHlc(), kind, id, ...fields };
  }

  async function settle(op, result = {}) {
    ops = ops.filter((o) => o.opId !== op.opId);
    // The confirmed catalog takes the op's effect now, so the row does not flicker back to its old
    // value between the acknowledgement and the next snapshot. A superseded op lost the merge, so
    // it is dropped without being applied and the pull that follows carries the winner.
    if (result.status !== 'superseded' && catalog) catalog = applyOpToCatalog(catalog, op);
    if (db) await tx(db, ['ops'], 'readwrite', (s) => s.delete(op.opId)).catch(() => {});
  }

  async function reject(op, reason) {
    ops = ops.filter((o) => o.opId !== op.opId);
    rejectedCount += 1;
    // Sealed before the transaction opens: an IndexedDB transaction that awaits anything but its
    // own requests has already committed by the time the await returns.
    const sealed = db ? await sealJson(deviceKey, `op-${op.opId}`, op, { crypto }) : null;
    const row = { opId: op.opId, at: new Date(now()).toISOString(), reason: String(reason || ''), seq: op.seq, sealed };
    if (db) await tx(db, ['ops', 'rejected'], 'readwrite', (o, r) => { o.delete(op.opId); r.put(row); }).catch(() => {});
  }

  /** The Mac answers per op; accept either a map keyed by opId or a list, and either vocabulary. */
  function resultsOf(answer) {
    const out = new Map();
    const raw = answer?.results;
    const add = (opId, result) => { if (opId) out.set(opId, result || {}); };
    if (Array.isArray(raw)) for (const result of raw) add(result?.opId, result);
    else if (raw && typeof raw === 'object') for (const [opId, result] of Object.entries(raw)) add(opId, result);
    return out;
  }

  const applied = (result) => result.status === 'applied' || result.status === 'superseded' || result.ok === true;
  const permanent = (result) => result.status === 'rejected' || result.permanent === true;

  /** Send what is waiting, in order. Resolves true when the log is empty. */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      await ready;
      let sent = false;
      try {
        while (ops.length && deviceKey) {
          const batch = ops.slice(0, OPS_PER_BATCH);
          for (const op of batch) inflight.add(op.opId);
          let answer;
          try {
            answer = await postSync({ action: 'ops', deviceId, ops: batch.map(wire) });
          } finally {
            for (const op of batch) inflight.delete(op.opId);
          }
          const results = resultsOf(answer);
          let stuck = true;
          for (const op of batch) {
            const result = results.get(op.opId);
            if (!result) continue;
            lastResults.set(op.opId, result);
            if (applied(result)) { await settle(op, result); stuck = false; sent = true; }
            else if (permanent(result)) {
              await reject(op, result.reason || result.error || 'The Mac refused this change.');
              stuck = false;
            }
          }
          if (stuck) break;
        }
        if (ops.length === 0) status.error = null;
      } catch (cause) {
        status.error = cause.offline ? null : cause.message;
      } finally {
        flushing = null;
        while (lastResults.size > 200) lastResults.delete(lastResults.keys().next().value);
        notify();
      }
      if (sent && status.online) sync().catch(() => {});
      return ops.length === 0;
    })();
    return flushing;
  }

  const wire = (op) => {
    const out = { opId: op.opId, seq: op.seq, at: op.at, hlc: op.hlc, kind: op.kind, id: op.id };
    for (const field of ['entry', 'keyringName', 'sealedValue', 'patch']) if (op[field] !== undefined) out[field] = op[field];
    return out;
  };

  /** The Mac's answer to an op this call queued, or null while it waits. A refusal throws. */
  const takeResult = (opId) => {
    const result = lastResults.get(opId);
    lastResults.delete(opId);
    if (result && permanent(result)) {
      throw Object.assign(new Error(result.reason || result.error || 'The vault refused this change.'), { rejected: true });
    }
    return result || null;
  };

  // --- the snapshot ---------------------------------------------------------------------------------

  async function absorb(body) {
    const pinned = new Set(ops.map((op) => op.keyringName).filter(Boolean));
    const rows = [];
    if (body.catalog) rows.push({ name: 'catalog', bytes: fromBase64(body.catalog) });
    if (body.passkeys) rows.push({ name: 'passkeys-index', bytes: fromBase64(body.passkeys) });
    for (const [name, value] of Object.entries(body.values || {})) {
      if (typeof value === 'string') rows.push({ name, bytes: fromBase64(value) });
    }
    const keep = new Set(rows.map((row) => row.name));
    const have = db ? await tx(db, ['records'], 'readonly', (s) => promisify(s.getAllKeys())).catch(() => []) : [];
    if (db) await tx(db, ['records'], 'readwrite', (store) => {
      for (const row of rows) store.put(row);
      for (const name of have) if (!keep.has(name) && !pinned.has(name)) store.delete(name);
    });
    if (body.catalog) catalog = await openJson(deviceKey, 'catalog', fromBase64(body.catalog));
    if (body.passkeys) passkeys = await openJson(deviceKey, 'passkeys-index', fromBase64(body.passkeys)).catch(() => passkeys);
    latest = latestHlc(catalog || { entries: {} }) || latest;
    if (Array.isArray(body.devices)) { devices = body.devices; putMeta('devices', devices); }
    if (body.deviceReplica) { replicaId = body.deviceReplica; putMeta('deviceReplica', replicaId); }
    if (body.keyStorage && body.keyStorage !== status.keyStorage) {
      status.keyStorage = body.keyStorage;
      putMeta('keyStorage', status.keyStorage);
    }
    etag = body.etag ?? etag;
    putMeta('etag', etag);
  }

  /** Flush, then pull. The etag makes a current device's sync a 304 with nothing to decrypt. */
  function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      await ready;
      // Not enrolled yet: nothing to sync, and the latch must not stay set or every later sync
      // in this tab would return this same settled promise.
      if (!deviceKey) { syncing = null; return false; }
      status.syncing = true;
      notify();
      try {
        await flush();
        const headers = etag ? { 'if-none-match': etag } : {};
        const path = etag ? `${SYNC_PATH}?since=${encodeURIComponent(etag)}` : SYNC_PATH;
        const body = await request(path, { headers, cache: 'no-store' });
        if (!body.unchanged) await absorb(body);
        status.lastSync = new Date(now()).toISOString();
        putMeta('lastSync', status.lastSync);
        status.error = null;
        return true;
      } catch (cause) {
        if (!cause.offline && !cause.locked && !cause.signedOut) status.error = cause.message;
        return false;
      } finally {
        status.syncing = false;
        syncing = null;
        notify();
      }
    })();
    return syncing;
  }

  // --- what the page reads --------------------------------------------------------------------------

  let foldCache = null;
  /** The confirmed catalog with the pending ops folded on top; memoised, ops being immutable. */
  function folded() {
    if (!catalog) return null;
    const signature = ops.map((op) => op.opId).join(',');
    if (foldCache?.catalog === catalog && foldCache.signature === signature) return foldCache.state;
    const state = ops.length ? foldCatalog(catalog, ops) : catalog;
    foldCache = { catalog, signature, state };
    return state;
  }

  /** The list the page draws, pending changes folded in; metadata only, never a value. */
  function list(options = {}) {
    const state = folded();
    if (!state) return null;
    const { query = '', ...rest } = options;
    const rows = String(query || '').trim() ? vaultSearch(state, query, rest) : vaultList(state, rest);
    return rows.map(metadata);
  }

  const search = (query, options = {}) => list({ ...options, query });

  /** One entry with its record name, for a reveal; null when this device has never seen it. */
  const entryOf = (id) => folded()?.entries?.[id] || null;
  const entry = (id) => { const found = entryOf(id); return found ? metadata(found) : null; };

  const history = ({ id = null, limit = 200 } = {}) => {
    const events = (catalog?.history || []).filter((event) => !id || event.id === id);
    return events.slice(-limit).reverse();
  };

  /**
   * The one read that returns a value, one entry at a time, decrypted in memory. The answer has
   * the same shape as the Mac's reveal, so the page renders it without knowing where it came from.
   */
  async function reveal(id) {
    await ready;
    const found = entryOf(id);
    if (!found) throw notHere();
    if (!found.keyringName || !deviceKey) throw notHere();
    const bytes = await recordBytes(found.keyringName);
    if (!bytes) throw notHere();
    const record = await openJson(deviceKey, found.keyringName, bytes);
    if (record.kind === 'totp') {
      const code = await totp(record.value, now(), { crypto });
      return { id, kind: record.kind, value: { code: code.code, expiresAt: new Date(code.expiresAt).toISOString() }, local: true };
    }
    return { id, kind: record.kind ?? found.kind, value: record.value, notes: found.notes || '', local: true };
  }

  function notHere() {
    const error = new Error('That one is not on this device yet, and the vault server is not reachable.');
    error.offline = true;
    error.missing = true;
    return error;
  }

  /** A verification code for a login that carries one, computed here so a plane is not a blocker. */
  async function code(id) {
    const record = await revealRecord(id);
    const secret = record.kind === 'totp' ? record.value : record.value?.totp;
    if (!secret) throw new Error('That credential has no verification code.');
    const answer = await totp(secret, now(), { crypto });
    return { id, code: answer.code, expiresAt: new Date(answer.expiresAt).toISOString(), local: true };
  }

  async function revealRecord(id) {
    const found = entryOf(id);
    if (!found?.keyringName || !deviceKey) throw notHere();
    const bytes = await recordBytes(found.keyringName);
    if (!bytes) throw notHere();
    return openJson(deviceKey, found.keyringName, bytes);
  }

  // --- what the page writes -------------------------------------------------------------------------

  /** Create or replace a credential: sealed here, queued here, replayed when the Mac answers. */
  async function save(input, { overwrite = true } = {}) {
    await ready;
    if (!deviceKey) throw notEnrolled();
    const { id, name, kind, origins = [], groups = [], notes = '', archived = false, value } = input || {};
    if (!id || !name || !kind) throw new Error('Credential ID, name and type are required');
    const keyringName = newValueName(crypto);
    const sealed = await sealJson(deviceKey, keyringName, { kind, value }, { crypto });
    if (db) await tx(db, ['records'], 'readwrite', (s) => s.put({ name: keyringName, bytes: sealed }));
    const op = await enqueue(mint('put', id, {
      entry: { name, kind, origins, groups, notes, archived: Boolean(archived) },
      keyringName, sealedValue: toBase64(sealed)
    }));
    await flush();
    const result = takeResult(op.opId);
    return { entry: entry(id), queued: !result, ...(result?.entry ? { entry: result.entry } : {}) };
  }

  /** Rename, regroup, re-site, note or archive: metadata only, no value moves. */
  async function patch(id, fields) {
    await ready;
    if (!deviceKey) throw notEnrolled();
    const clean = {};
    for (const field of META_FIELDS) if (fields?.[field] !== undefined) clean[field] = fields[field];
    if (!Object.keys(clean).length) return { entry: entry(id) };
    const op = await enqueue(mint('meta', id, { patch: clean }));
    await flush();
    const result = takeResult(op.opId);
    return { entry: entry(id), queued: !result };
  }

  const archive = (id, archived = true) => patch(id, { archived: Boolean(archived) });
  const groups = (id, list_) => patch(id, { groups: list_ });

  /** Forget: a tombstone here, a tombstone on the Mac, and the value record goes with it. */
  async function forget(id) {
    await ready;
    if (!deviceKey) throw notEnrolled();
    const found = entryOf(id);
    const op = await enqueue(mint('delete', id, {}));
    if (found?.keyringName && db) await tx(db, ['records'], 'readwrite', (s) => s.delete(found.keyringName)).catch(() => {});
    await flush();
    const result = takeResult(op.opId);
    return { forgotten: true, queued: !result };
  }

  function notEnrolled() {
    const error = new Error('This device does not keep a copy of the vault yet.');
    error.notEnrolled = true;
    return error;
  }

  // --- the drop-in ------------------------------------------------------------------------------------

  const localStatus = () => ({ locked: status.locked, keyStorage: 'device-replica', entries: status.entries, local: true });

  /** Pending puts and deletes folded onto the list the Mac just sent, so nothing flickers back. */
  function overlay(entries) {
    if (!ops.length || !catalog) return entries;
    const state = folded();
    const live = new Map(vaultList(state, { archived: true }).map((row) => [row.id, metadata(row)]));
    const out = entries.filter((row) => live.has(row.id)).map((row) => ({ ...row, ...live.get(row.id) }));
    const seen = new Set(out.map((row) => row.id));
    for (const [id, row] of live) if (!seen.has(id)) out.push(row);
    return out;
  }

  /**
   * A drop-in for the /secrets page's fetch-and-parse: the same paths and the same answers, but
   * reads fall back to this device and writes go through the op log, so nothing he does waits on
   * the Mac or is lost to it. Returns the parsed body; it throws instead of handing back a
   * Response, with `.offline`, `.signedOut`, `.locked` or `.rejected` set on the error.
   */
  async function api(path, options = {}) {
    await ready;
    const method = String(options.method || 'GET').toUpperCase();
    const url = new URL(path, 'http://vault.local');
    const body = () => { try { return JSON.parse(options.body || '{}'); } catch { return {}; } };

    if (!deviceKey) return request(path, options);

    if (url.pathname === VAULT_PATH && method === 'GET') {
      const archived = url.searchParams.get('archived') === '1';
      try {
        const answer = await request(path, options);
        if (answer.types) { types = answer.types; putMeta('types', types); }
        return { ...answer, entries: overlay(answer.entries || []) };
      } catch (cause) {
        if (!cause.offline && !cause.locked) throw cause;
        const rows = list({ archived });
        if (!rows) throw cause;
        return { entries: rows, history: history({ limit: 200 }), types, status: localStatus(), local: true };
      }
    }

    if (url.pathname === VAULT_PATH && method === 'POST') {
      const payload = body();
      if (ONLINE_ONLY.has(payload.action)) return request(path, options);
      if (payload.action === 'save') return save(payload.entry || payload, { overwrite: payload.overwrite === true });
      if (payload.action === 'archive') return archive(payload.id, payload.archived !== false);
      if (payload.action === 'groups') return groups(payload.id, payload.groups);
      if (payload.action === 'forget') return forget(payload.id);
      if (payload.action === 'history') return { history: history({ id: payload.id || null }) };
      if (payload.action === 'reveal') {
        try { return await request(path, options); } catch (cause) {
          if (!cause.offline && !cause.locked) throw cause;
          return reveal(payload.id);
        }
      }
      return request(path, options);
    }

    return request(path, options);
  }

  // --- lifecycle ------------------------------------------------------------------------------------

  const onOnline = () => { sync().catch(() => {}); };
  const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden) sync().catch(() => {}); };

  let pushTimer = null;
  let stopLive = () => {};
  const onPush = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; sync().catch(() => {}); }, pushQuietMs);
  };

  function start() {
    if (timer) return;
    sync().catch(() => {});
    // The four-minute tick is the backstop; the push is what makes an tophat-pass write on the
    // command line show up on his phone a couple of seconds later.
    stopLive = subscribeLive('vault', onPush);
    timer = setInterval(() => { (ops.length && !status.online ? flush() : sync()).catch(() => {}); }, SYNC_EVERY_MS);
    retry = setInterval(() => {
      if (!status.online || ops.length) flush().then((empty) => { if (empty && status.online) sync(); }).catch(() => {});
    }, RETRY_EVERY_MS);
    globalThis.addEventListener?.('online', onOnline);
    globalThis.document?.addEventListener?.('visibilitychange', onVisible);
  }

  function stop() {
    stopLive();
    stopLive = () => {};
    clearTimeout(pushTimer);
    pushTimer = null;
    clearInterval(timer);
    clearInterval(retry);
    timer = null;
    retry = null;
    globalThis.removeEventListener?.('online', onOnline);
    globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
  }

  /** The one word the pill shows. Four different things, never collapsed into "error". */
  function condition() {
    if (!status.enrolled) return status.needsPassphrase ? 'passphrase' : 'not-enrolled';
    if (status.revoked) return 'revoked';
    if (status.signedOut) return 'signed-out';
    if (!status.online) return 'offline';
    if (status.locked) return 'locked';
    if (status.syncing) return 'syncing';
    return 'ok';
  }

  /** The passphrase branch: unwrap the device key he deliberately locked behind his passphrase. */
  async function unlockDevice(passphrase) {
    await ready;
    if (!keyWrap) return { unlocked: Boolean(deviceKey) };
    const wrapKey = await deriveWrapKey(passphrase, fromBase64(keyWrap.salt), { crypto });
    deviceKey = await unwrapDeviceKey(fromBase64(keyWrap.wrapped), wrapKey, { crypto });
    status.needsPassphrase = false;
    await loadCatalog();
    notify();
    return { unlocked: true };
  }

  return {
    ready,
    api,
    start,
    stop,
    sync,
    flush,
    enroll,
    forgetDevice,
    unlockDevice,
    list,
    search,
    entry,
    history,
    reveal,
    code,
    save,
    patch,
    archive,
    groups,
    forget,
    condition,
    enrolled: () => Boolean(deviceId && deviceKey),
    devices: () => devices.map((device) => ({ ...device })),
    pending: () => ops.map(({ sealedValue, ...op }) => ({ ...op })),
    state: () => ({ ...status }),
    subscribe(fn) { listeners.add(fn); fn({ ...status }); return () => listeners.delete(fn); },
    _debug: { get catalog() { return catalog; }, get folded() { return folded(); }, get etag() { return etag; },
      get passkeys() { return passkeys; }, get db() { return db; }, get deviceKey() { return deviceKey; } }
  };
}

let shared = null;

/** The one replica the /secrets page uses in this tab. */
export function vaultReplica() {
  if (!shared) shared = createVaultReplica();
  return shared;
}
