import { isIncognito } from '../core/incognito.js';
// Where an attachment upload stands, kept in IndexedDB so a reload, a closed tab or a phone that
// slept mid-upload resumes from the last chunk the server acknowledged instead of starting over.
// Two stores: `uploads` holds one small record per reserved path (name, size, owning chat, bytes
// acknowledged, whether the message naming it was already sent) and `files` holds the File itself,
// kept apart so a progress write never rewrites the bytes. Every call is best-effort: a browser
// with no IndexedDB, or one that refuses to store a file this large, still uploads, it just cannot
// resume across a reload.

const DB_NAME = 'tophat-uploads';
const META = 'uploads';
const FILES = 'files';
// Above this the File is not copied into IndexedDB (the copy costs as much disk as the file and
// can blow the origin quota on a phone); the record is still kept, so the server-side partial is
// found again if he re-attaches the same file.
export const MAX_STORED_FILE_BYTES = 1024 * 1024 * 1024;

export function createUploadJournal({ factory = typeof indexedDB === 'undefined' ? null : indexedDB } = {}) {
  let dbPromise = null;

  function db() {
    if (!factory) return Promise.reject(new Error('no IndexedDB'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const handle = request.result;
        if (!handle.objectStoreNames.contains(META)) handle.createObjectStore(META, { keyPath: 'path' });
        if (!handle.objectStoreNames.contains(FILES)) handle.createObjectStore(FILES);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB refused'));
    }).catch((cause) => { dbPromise = null; throw cause; });
    return dbPromise;
  }

  function tx(stores, mode, run) {
    return db().then((handle) => new Promise((resolve, reject) => {
      const transaction = handle.transaction(stores, mode);
      let result;
      Promise.resolve(run(transaction)).then((value) => { result = value; }, reject);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB aborted'));
    }));
  }

  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const quiet = (promise, fallback = null) => promise.catch(() => fallback);

  // Read-modify-write inside one transaction, the put issued from the get's own success callback:
  // awaiting between them lets the transaction commit first in some engines.
  function update(path, patch) {
    let next = null;
    return tx([META], 'readwrite', (t) => {
      const store = t.objectStore(META);
      const get = store.get(path);
      get.onsuccess = () => {
        if (!get.result) return;
        next = { ...get.result, ...patch, updatedAt: Date.now() };
        store.put(next);
      };
    }).then(() => next);
  }

  return {
    // A new upload: its record, and the File when it is small enough to keep.
    start(record, file) {
      // An incognito chat's files are never kept on the device (core/incognito.js).
      if (isIncognito(record?.owner)) return Promise.resolve();
      const entry = { received: 0, sent: false, ...record, updatedAt: Date.now() };
      const keep = file && Number(file.size) <= MAX_STORED_FILE_BYTES;
      return quiet(tx([META], 'readwrite', (t) => { t.objectStore(META).put({ ...entry, stored: false }); })
        .then(() => (keep ? tx([FILES], 'readwrite', (t) => { t.objectStore(FILES).put(file, entry.path); }) : null))
        .then(() => (keep ? update(entry.path, { stored: true }) : null)));
    },
    progress(path, received) { return quiet(update(path, { received })); },
    // The message naming these paths has gone: a resumed upload finishes the file the model was
    // pointed at, and is not attached a second time.
    markSent(paths) { return quiet(Promise.all((paths || []).filter(Boolean).map((path) => update(path, { sent: true })))); },
    done(path) {
      return quiet(tx([META, FILES], 'readwrite', (t) => {
        t.objectStore(META).delete(path);
        t.objectStore(FILES).delete(path);
      }));
    },
    list(owner = null) {
      return quiet(tx([META], 'readonly', (t) => request(t.objectStore(META).getAll()))
        .then((all) => (all || []).filter((entry) => owner === null || entry.owner === owner)), []);
    },
    file(path) { return quiet(tx([FILES], 'readonly', (t) => request(t.objectStore(FILES).get(path)))); }
  };
}

let shared = null;
export function uploadJournal() {
  shared ||= createUploadJournal();
  return shared;
}

// Paths this page is uploading right now, so a composer that mounts mid-upload (a pane re-render,
// a second pane on the same chat) does not start a second copy of the same upload.
export const activeUploads = new Set();
