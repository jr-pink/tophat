// The reader's copy of itself on this device, so that a dead server, a dead tunnel or a plane is not
// a blank page. locally.
//
// What lives here, in IndexedDB database `tophat-reader` (separate from the chat replica's
// `tophat-webchat`, so neither can bump the other's version):
//   rows    every document's shelf row, as the server last confirmed it
//   bodies  whole documents in the offline set (past 7 days, starred, the live shelf), and
//           anything opened here while there is room: every section's HTML, links, note
//           threads, reading positions
//   assets  images inside books, served from our own origin, as blobs
//   ops     what he did here that the server has not acknowledged yet, in order
//   rejected ops the server refused for good; kept, never dropped
//   meta    the manifest etag, body sizes, when the last sync landed
//
// The screen is the confirmed state with the pending ops folded on top (core/reader-replica.js),
// so a highlight made offline is on the page at once, survives a reload, and is replayed to
// POST /api/reader/sync when the server answers again. The sync runs in the background whenever
// the server is reachable: on start, every few minutes, on `online`, and when the tab comes back.

import {
  DEFAULT_BUDGET_BYTES, absorbDocResponse, applyOpToBody, coalesceProgress, docResponse, foldBody,
  foldRow, libraryView, newClientId, opDoc, planSync, searchLocal, serverDown
} from '$lib/core/reader-replica.js';
import { liveHeaders, liveSubscribe } from '$lib/client/live.js';
import { webchatDeviceId } from '$lib/client/device-id.js';

export const DB_NAME = 'tophat-reader';
const DB_VERSION = 1;
const STORES = ['rows', 'bodies', 'assets', 'ops', 'rejected', 'meta'];
const KEYS = { rows: 'id', bodies: 'id', assets: 'key', ops: 'opId', rejected: 'opId', meta: 'key' };
const SYNC_EVERY_MS = 4 * 60_000;
// Another device changed the library: sync now, but let a burst (a reading position saved every
// few seconds, an ingest writing many rows) collapse into one sync.
export const PUSH_QUIET_MS = 1500;
const REQUEST_TIMEOUT_MS = 10_000;

// --- a small promise face on IndexedDB ------------------------------------------------------------

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openReaderDb(idb = globalThis.indexedDB, name = DB_NAME, version = DB_VERSION) {
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
      openReaderDb(idb, name, next).then(resolve);
    };
    request.onerror = () => {
      // Already at a higher version (stepped as above): open at whatever it is.
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

const getAll = (db, store) => tx(db, [store], 'readonly', (s) => promisify(s.getAll())).then((p) => p);

// --- the replica ----------------------------------------------------------------------------------

export function createReaderReplica({
  fetchImpl = (...args) => globalThis.fetch(...args),
  indexedDB = globalThis.indexedDB,
  dbName = DB_NAME,
  now = () => Date.now(),
  device = null,
  budgetBytes = DEFAULT_BUDGET_BYTES,
  timeoutMs = REQUEST_TIMEOUT_MS,
  subscribeLive = liveSubscribe,
  pushQuietMs = PUSH_QUIET_MS
} = {}) {
  let db = null;
  const rows = new Map();          // id -> confirmed row
  const bodyMeta = new Map();      // id -> { version, bytes, complete, openedAt }
  const bodyCache = new Map();     // id -> confirmed body, the ones read this session
  const assetUrls = new Map();     // `${docId}/${path}` -> blob: url
  let ops = [];                    // pending, in order
  const inflight = new Set();      // opIds being sent right now
  let etag = null;
  const status = { online: true, syncing: false, pending: 0, lastSync: null, bytes: 0, docs: 0, error: null };
  const listeners = new Set();
  let flushing = null;
  let syncing = null;
  let timer = null;
  let retry = null;
  let seq = 0;

  const notify = () => {
    status.pending = ops.length;
    status.docs = bodyMeta.size;
    status.bytes = [...bodyMeta.values()].reduce((sum, m) => sum + Number(m.bytes || 0), 0);
    for (const fn of listeners) { try { fn({ ...status }); } catch { /* a listener's problem */ } }
  };

  const ready = (async () => {
    db = await openReaderDb(indexedDB, dbName);
    if (!db) return;
    const [storedRows, storedOps, meta] = await Promise.all([getAll(db, 'rows'), getAll(db, 'ops'), getAll(db, 'meta')]);
    for (const row of storedRows) rows.set(row.id, row);
    ops = storedOps.sort((a, b) => (a.seq - b.seq) || String(a.at).localeCompare(String(b.at)));
    seq = ops.reduce((m, op) => Math.max(m, op.seq || 0), 0);
    for (const entry of meta) {
      if (entry.key === 'etag') etag = entry.value;
      if (entry.key === 'lastSync') status.lastSync = entry.value;
      if (entry.key === 'bodies') for (const [id, m] of Object.entries(entry.value || {})) bodyMeta.set(id, m);
    }
    notify();
  })().catch(() => {});

  const putMeta = (key, value) => db && tx(db, ['meta'], 'readwrite', (s) => s.put({ key, value })).catch(() => {});
  const saveBodyMeta = () => putMeta('bodies', Object.fromEntries(bodyMeta));

  async function request(path, options = {}) {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    let response;
    try {
      // A write names this tab, so the live push it causes is skipped here and synced everywhere else.
      const write = options.method && options.method !== 'GET';
      response = await fetchImpl(path, write ? { signal, ...options, headers: liveHeaders(options.headers) } : { signal, ...options });
    } catch (cause) {
      setOnline(false);
      const error = new Error('The server is not reachable.');
      error.offline = true;
      error.cause = cause;
      throw error;
    }
    if (serverDown(response)) {
      setOnline(false);
      const error = new Error('The server is not reachable.');
      error.offline = true;
      error.status = response.status;
      throw error;
    }
    setOnline(true);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function setOnline(value) {
    if (status.online === value) return;
    status.online = value;
    notify();
    if (value) setTimeout(() => { flush().catch(() => {}); }, 0);
  }

  const pendingFor = (id) => ops.filter((op) => opDoc(op) === id || bodyHasNote(id, op));
  function bodyHasNote(id, op) {
    if (!op.kind.startsWith('note.') || opDoc(op)) return false;
    const body = bodyCache.get(id);
    const target = op.payload?.id || op.payload?.parentId;
    return Boolean(body?.highlights?.some((h) => h.id === target || (h.replies || []).some((r) => r.id === target)));
  }

  async function loadBody(id) {
    if (bodyCache.has(id)) return bodyCache.get(id);
    if (!db) return null;
    const body = await tx(db, ['bodies'], 'readonly', (s) => promisify(s.get(id))).catch(() => null);
    if (body) bodyCache.set(id, body);
    return body || null;
  }

  async function storeBody(body, { opened = false } = {}) {
    if (!body?.id) return;
    bodyCache.set(body.id, body);
    while (bodyCache.size > 32) bodyCache.delete(bodyCache.keys().next().value);
    const bytes = JSON.stringify(body).length * 2;
    const prior = bodyMeta.get(body.id) || {};
    bodyMeta.set(body.id, {
      version: body.version ?? prior.version ?? null,
      bytes: bytes + Number(prior.assetBytes || 0),
      assetBytes: Number(prior.assetBytes || 0),
      complete: Boolean(body.complete),
      openedAt: opened ? new Date(now()).toISOString() : (prior.openedAt || null)
    });
    if (db) await tx(db, ['bodies'], 'readwrite', (s) => s.put(body)).catch(() => {});
    saveBodyMeta();
  }

  async function dropBody(id) {
    bodyCache.delete(id);
    bodyMeta.delete(id);
    for (const key of [...assetUrls.keys()]) if (key.startsWith(`${id}/`)) { try { URL.revokeObjectURL(assetUrls.get(key)); } catch { /* fine */ } assetUrls.delete(key); }
    if (!db) return;
    await tx(db, ['bodies', 'assets'], 'readwrite', (bodies, assets) => {
      bodies.delete(id);
      const range = IDBKeyRange.bound(`${id}/`, `${id}/\uffff`);
      assets.delete(range);
    }).catch(() => {});
  }

  function absorbRow(row) {
    if (!row?.id) return;
    const prior = rows.get(row.id);
    const next = { ...(prior || {}), ...row, meta: row.meta ?? prior?.meta };
    rows.set(row.id, next);
    if (db) tx(db, ['rows'], 'readwrite', (s) => s.put(next)).catch(() => {});
  }

  // --- the op log ---------------------------------------------------------------------------------

  async function enqueue(kind, payload) {
    await ready;
    const at = new Date(now()).toISOString();
    let op = { opId: newClientId('op'), seq: ++seq, at, kind, payload, docId: payload.docId || null, device };
    if (kind === 'progress') {
      const prior = ops.find((o) => o.kind === 'progress' && !inflight.has(o.opId)
        && o.payload.docId === payload.docId && Number(o.payload.sectionIdx) === Number(payload.sectionIdx));
      if (prior) {
        op = coalesceProgress(prior, op);
        ops = ops.map((o) => (o.opId === prior.opId ? op : o));
      } else ops.push(op);
    } else if (kind === 'note.restore') {
      // Taking back a delete that never left this device is just forgetting the delete.
      const undone = ops.find((o) => o.kind === 'note.delete' && o.payload.id === payload.id && !inflight.has(o.opId));
      if (undone) {
        ops = ops.filter((o) => o.opId !== undone.opId);
        if (db) await tx(db, ['ops'], 'readwrite', (s) => s.delete(undone.opId)).catch(() => {});
        notify();
        return { op: null, local: true };
      }
      ops.push(op);
    } else ops.push(op);
    // On disk before anything is said to have happened.
    if (db) await tx(db, ['ops'], 'readwrite', (s) => s.put(op));
    notify();
    return { op };
  }

  async function settle(op, result) {
    ops = ops.filter((o) => o.opId !== op.opId);
    if (db) await tx(db, ['ops'], 'readwrite', (s) => s.delete(op.opId)).catch(() => {});
    const id = opDoc(op);
    if (result.doc) absorbRow({ id: result.doc.id, starred: result.doc.starred, archived: result.doc.archived, aside: result.doc.aside,
      defer_until: result.doc.defer_until, defer_condition: result.doc.defer_condition, deferred_at: result.doc.deferred_at,
      ...(result.doc.state ? { status: result.doc.state.status, percent: result.doc.state.percent } : {}) });
    if (op.kind === 'progress' && id && rows.has(id)) absorbRow({ id, percent: result.percent, status: result.status, read_at: op.at });
    // Confirmed state takes the op's effect, so the screen does not flicker back before the refresh lands.
    const body = id ? await loadBody(id) : null;
    if (body) await storeBody(applyOpToBody(body, op));
    if (op.kind === 'note.save' && !op.payload.parentId && op.payload.create && id && rows.has(id)) {
      absorbRow({ id, notes: Number(rows.get(id).notes || 0) + 1 });
    }
  }

  /** Send what is waiting, in order. Resolves true when the log is empty. */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      await ready;
      const touched = new Set();
      try {
        while (ops.length) {
          const batch = ops.slice(0, 50);
          for (const op of batch) inflight.add(op.opId);
          let answer;
          try {
            const body = JSON.stringify({ device, ops: batch.map(({ opId, at, kind, payload }) => ({ opId, at, kind, payload })) });
            answer = await request('/api/reader/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: leaving() && body.length < 60_000 });
          } finally {
            for (const op of batch) inflight.delete(op.opId);
          }
          let stuck = false;
          for (const result of answer.results || []) {
            const op = batch.find((o) => o.opId === result.opId);
            if (!op) continue;
            if (result.ok) {
              lastResults.set(op.opId, result);
              await settle(op, result);
              if (opDoc(op)) touched.add(opDoc(op));
            } else if (result.permanent) {
              lastResults.set(op.opId, result);
              ops = ops.filter((o) => o.opId !== op.opId);
              if (db) await tx(db, ['ops', 'rejected'], 'readwrite', (o, r) => { o.delete(op.opId); r.put({ ...op, error: result.error, rejectedAt: new Date(now()).toISOString() }); }).catch(() => {});
            } else stuck = true;
          }
          if (stuck) break;
        }
      } catch (cause) {
        status.error = cause.offline ? null : cause.message;
      } finally {
        flushing = null;
        notify();
      }
      if (touched.size && status.online) refreshBodies([...touched]).catch(() => {});
      return ops.length === 0;
    })();
    return flushing;
  }
  const lastResults = new Map();
  // Only a page going away needs its last ops to outlive it; keepalive has a small shared quota
  // and requests sent with it skip the page's own request handling.
  const leaving = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  /** The server's answer to an op this call enqueued, or null while it waits in the log. */
  const takeResult = (opId) => {
    const r = lastResults.get(opId);
    lastResults.delete(opId);
    // Answers to ops replayed from an earlier session have nobody waiting on them.
    while (lastResults.size > 200) lastResults.delete(lastResults.keys().next().value);
    if (r && !r.ok) throw Object.assign(new Error(r.error || 'The server refused this change.'), { rejected: true });
    return r || null;
  };

  // --- background sync ----------------------------------------------------------------------------

  async function fetchAssets(body) {
    if (!body.assets?.length || typeof Blob === 'undefined') return 0;
    let bytes = 0;
    for (const path of body.assets) {
      const key = `${body.id}/${path}`;
      try {
        const have = db && await tx(db, ['assets'], 'readonly', (s) => promisify(s.getKey(key)));
        if (have) continue;
        const url = `/api/reader/asset/${body.id}/${path.split('/').map(encodeURIComponent).join('/')}`;
        const response = await fetchImpl(url);
        if (!response.ok || serverDown(response)) continue;
        const blob = await response.blob();
        bytes += blob.size;
        if (db) await tx(db, ['assets'], 'readwrite', (s) => s.put({ key, docId: body.id, path, blob, type: blob.type }));
      } catch { /* a missing picture does not stop the words */ }
    }
    return bytes;
  }

  async function refreshBodies(ids, versions = new Map()) {
    for (let i = 0; i < ids.length; i += 8) {
      const chunk = ids.slice(i, i + 8);
      const answer = await request('/api/reader/sync/docs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: chunk })
      });
      for (const full of answer.docs || []) {
        if (full.missing) { await dropBody(full.id); continue; }
        const body = { ...full, complete: true, version: versions.get(full.id) ?? bodyMeta.get(full.id)?.version ?? null };
        const assetBytes = await fetchAssets(body);
        const prior = bodyMeta.get(full.id);
        if (assetBytes) bodyMeta.set(full.id, { ...(prior || {}), assetBytes: Number(prior?.assetBytes || 0) + assetBytes });
        await storeBody(body);
      }
    }
  }

  /** Pull the manifest, fetch what changed in the offline set, drop what fell out of it. */
  function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      await ready;
      status.syncing = true;
      notify();
      try {
        await flush();
        const manifest = await request(`/api/reader/sync${etag ? `?since=${encodeURIComponent(etag)}` : ''}`);
        if (manifest.unchanged) {
          status.lastSync = new Date(now()).toISOString();
          putMeta('lastSync', status.lastSync);
          return true;
        }
        const seen = new Set();
        for (const doc of manifest.docs || []) { seen.add(doc.id); absorbRow(doc); }
        const pinned = new Set(ops.map(opDoc).filter(Boolean));
        for (const id of [...rows.keys()]) {
          if (seen.has(id) || pinned.has(id)) continue;
          rows.delete(id);
          if (db) tx(db, ['rows'], 'readwrite', (s) => s.delete(id)).catch(() => {});
        }
        const plan = planSync(manifest.docs || [], bodyMeta, { budget: budgetBytes, pinned, now: now() });
        for (const id of plan.evict) await dropBody(id);
        const versions = new Map((manifest.docs || []).map((d) => [d.id, d.version]));
        await refreshBodies(plan.fetch, versions);
        etag = manifest.etag;
        putMeta('etag', etag);
        status.lastSync = new Date(now()).toISOString();
        putMeta('lastSync', status.lastSync);
        status.error = null;
        return true;
      } catch (cause) {
        if (!cause.offline) status.error = cause.message;
        return false;
      } finally {
        status.syncing = false;
        syncing = null;
        notify();
      }
    })();
    return syncing;
  }

  // --- what the page asks for ---------------------------------------------------------------------

  function localLibrary({ view = 'live', status: state = null } = {}) {
    if (!rows.size) return null;
    const folded = [...rows.values()].map((row) => foldRow(row, ops));
    return libraryView(folded, { view, status: state, now: now() });
  }

  async function localDoc(id, sectionIdx = null) {
    await ready;
    const body = await loadBody(id);
    if (!body) return null;
    const response = docResponse(foldBody(body, pendingFor(id)), sectionIdx);
    if (response) await withAssets(body);
    return response;
  }

  async function withAssets(body) {
    if (!db || !body?.assets?.length || typeof URL === 'undefined' || !URL.createObjectURL) return;
    for (const path of body.assets) {
      const key = `${body.id}/${path}`;
      if (assetUrls.has(key)) continue;
      const asset = await tx(db, ['assets'], 'readonly', (s) => promisify(s.get(key))).catch(() => null);
      if (asset?.blob) assetUrls.set(key, URL.createObjectURL(asset.blob));
    }
  }

  /** A picture inside a book, from this device when it is here; null means use the server route. */
  function assetUrl(docId, path) {
    return assetUrls.get(`${docId}/${path}`) || null;
  }

  function foldResponse(response) {
    if (!response?.doc) return response;
    const id = response.doc.id;
    const folded = foldBody({ ...response, id }, pendingFor(id));
    return { ...folded, highlights: (folded.highlights || []).filter((h) => !h.deletedAt) };
  }

  async function writeNote(body) {
    const parentId = body.parentId ? String(body.parentId) : null;
    const create = !body.id;
    const id = body.id || newClientId('h');
    if (parentId && !String(body.note ?? '').trim()) throw new Error('a reply needs text');
    if (!parentId && !body.docId) throw new Error('docId is required');
    if (!parentId && create && !String(body.quote || '').trim()) throw new Error('a quote is required');
    const payload = { ...body, id, parentId, create, docId: body.docId ? String(body.docId) : null };
    if (parentId && !payload.docId) payload.docId = await docOfNote(parentId);
    const { op } = await enqueue('note.save', payload);
    await flush();
    const result = takeResult(op.opId);
    if (result?.highlight) return parentId ? { highlight: result.highlight, reply: result.reply } : { highlight: result.highlight };
    // Nobody answered: the note is in the log and on the page, built by the same reducer.
    const docId = payload.docId;
    const body0 = docId ? await loadBody(docId) : null;
    const local = body0 ? foldBody(body0, pendingFor(docId)) : { highlights: [] };
    const root = (local.highlights || []).find((h) => h.id === (parentId || id))
      || (local.highlights || []).find((h) => (h.replies || []).some((r) => r.id === (parentId || id)));
    const shaped = root || applyOpToBody({ id: docId, highlights: [] }, op).highlights.find((h) => h.id === id);
    if (parentId) {
      const reply = (root?.replies || []).find((r) => r.id === id)
        || { id, note: String(body.note || ''), author: body.author === 'tophat' ? 'tophat' : 'owner', createdAt: op.at, updatedAt: op.at };
      return { highlight: root || null, reply: { ...reply, parentId, docId }, queued: true };
    }
    return { highlight: shaped, queued: true };
  }

  async function docOfNote(noteId) {
    for (const [id, body] of bodyCache) {
      if (body.highlights?.some((h) => h.id === noteId || (h.replies || []).some((r) => r.id === noteId))) return id;
    }
    return null;
  }

  async function deleteNote(id, { restore = false } = {}) {
    const docId = await docOfNote(id);
    const body = docId ? bodyCache.get(docId) : null;
    const root = body?.highlights?.find((h) => h.id === id) || null;
    const parent = root ? null : body?.highlights?.find((h) => (h.replies || []).some((r) => r.id === id)) || null;
    const seen = root?.updatedAt || parent?.replies?.find((r) => r.id === id)?.updatedAt || null;
    const { op } = await enqueue(restore ? 'note.restore' : 'note.delete', { id, docId, seenUpdatedAt: seen, root: Boolean(root) });
    if (op) await flush();
    const result = op ? takeResult(op.opId) : null;
    if (result) return result.highlight ? { ok: true, highlight: result.highlight } : { ok: true };
    if (parent && docId) {
      const folded = foldBody(await loadBody(docId), pendingFor(docId));
      return { ok: true, highlight: folded.highlights.find((h) => h.id === parent.id), queued: true };
    }
    return { ok: true, queued: true };
  }

  async function patchDoc(id, fields) {
    const { op } = await enqueue('doc.patch', { docId: id, fields });
    await flush();
    const result = takeResult(op.opId);
    if (result?.doc) return { doc: result.doc };
    const row = rows.get(id) ? foldRow(rows.get(id), ops) : null;
    const body = await loadBody(id);
    const doc = body ? foldBody(body, pendingFor(id)).doc : row;
    return { doc, queued: true };
  }

  /** Reading position: logged and coalesced; the screen takes the percent from the reducer. */
  async function progress(payload) {
    const id = String(payload.docId || '');
    const body = await loadBody(id);
    let percent = 0;
    if (body) {
      const after = applyOpToBody(foldBody(body, pendingFor(id)), { kind: 'progress', at: new Date(now()).toISOString(), docId: id, payload });
      percent = Number(after.progress?.state?.percent || 0);
    }
    const { op } = await enqueue('progress', { ...payload, docId: id, percent });
    await flush();
    const result = takeResult(op.opId);
    if (result) return result;
    return { percent, status: percent >= 0.95 ? 'finished' : 'reading', sectionIdx: payload.sectionIdx, queued: true };
  }

  /**
   * A drop-in for the reader page's fetch-and-parse: the same paths, the same answers, but reads
   * fall back to this device and writes go through the op log, so nothing he does waits on the
   * server or is lost to it.
   */
  async function api(path, options = {}) {
    await ready;
    const method = String(options.method || 'GET').toUpperCase();
    const url = new URL(path, 'http://reader.local');
    const parts = url.pathname.split('/').filter(Boolean);   // api reader <route> ...
    const route = parts[2];
    const json = () => { try { return JSON.parse(options.body || '{}'); } catch { return {}; } };

    if (route === 'notes' && method === 'POST') return writeNote(json());
    if (route === 'notes' && method === 'DELETE') {
      const body = json();
      return deleteNote(url.searchParams.get('id') || body.id, { restore: Boolean(body.restore) });
    }
    if (route === 'doc' && method === 'PATCH') return patchDoc(decodeURIComponent(parts[3]), json());
    if (route === 'progress' && method === 'POST') return progress(json());

    if (route === 'library' && method === 'GET') {
      const view = url.searchParams.get('view') || 'live';
      const q = (url.searchParams.get('q') || '').trim();
      const state = url.searchParams.get('status') || null;
      try {
        const body = await request(path, options);
        for (const row of body.docs || []) absorbRow(row);
        const folded = (body.docs || []).map((row) => foldRow(row, ops));
        return { ...body, docs: ops.length ? libraryView(folded, { view, status: state, now: now(), limit: 500 }) : folded };
      } catch (cause) {
        if (!cause.offline) throw cause;
        const docs = localLibrary({ view, status: state }) || [];
        const notes = await recentNotes();
        return { view, docs, search: q ? { query: q, ...searchLocal(docs.length ? [...rows.values()] : [], notes, q) } : null, notes: q ? [] : notes.slice(0, 30), local: true };
      }
    }

    if (route === 'doc' && method === 'GET') {
      const id = decodeURIComponent(parts[3]);
      const asked = url.searchParams.get('section');
      try {
        const response = await request(path, options);
        // Kept for the next time the server is not there; the page does not wait for the write.
        loadBody(id).then((prior) => storeBody(absorbDocResponse(prior, response), { opened: true })).catch(() => {});
        return foldResponse(response);
      } catch (cause) {
        if (!cause.offline) throw cause;
        const local = await localDoc(id, asked === null ? null : Number(asked));
        if (local) return local;
        const error = new Error('This one is not saved on this device yet, and the server is not reachable.');
        error.offline = true;
        throw error;
      }
    }

    if (route === 'read' && method === 'POST') {
      try { return await request(path, options); } catch (cause) {
        if (!cause.offline) throw cause;
        const target = String(json().url || '').trim();
        const row = [...rows.values()].find((r) => r.url === target || r.canonical_url === target);
        if (row) return { saved: true, id: row.id, local: true };
        throw cause;
      }
    }

    return request(path, options);
  }

  async function recentNotes() {
    const out = [];
    for (const [id, meta] of bodyMeta) {
      if (!meta) continue;
      const body = await loadBody(id);
      if (!body) continue;
      const folded = foldBody(body, pendingFor(id));
      for (const h of folded.highlights || []) if (!h.deletedAt) out.push({ ...h, docTitle: body.doc?.title || '', docUrl: body.doc?.url || null, docKind: body.doc?.kind || 'article' });
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  // --- lifecycle ----------------------------------------------------------------------------------

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
    // The four-minute tick stays as the backstop; the push is what makes another device's
    // highlight or save show up here within a couple of seconds.
    stopLive = subscribeLive('reader', onPush);
    timer = setInterval(() => { (ops.length && !status.online ? flush() : sync()).catch(() => {}); }, SYNC_EVERY_MS);
    // While the server is gone, try the op log more often than the full sync.
    retry = setInterval(() => { if (!status.online || ops.length) flush().then((empty) => { if (empty && status.online) sync(); }).catch(() => {}); }, 15_000);
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

  return {
    ready,
    api,
    sync,
    flush,
    start,
    stop,
    assetUrl,
    library: localLibrary,
    doc: localDoc,
    pending: () => ops.map((op) => ({ ...op })),
    state: () => ({ ...status }),
    subscribe(fn) { listeners.add(fn); fn({ ...status }); return () => listeners.delete(fn); },
    _debug: { rows, bodyMeta, get etag() { return etag; } }
  };
}

let shared = null;

/** The one replica the reader page uses in this tab. */
export function readerReplica() {
  if (!shared) {
    const device = webchatDeviceId();
    shared = createReaderReplica({ device: device === 'dev-anonymous' ? null : device });
  }
  return shared;
}
