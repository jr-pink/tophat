// Small IndexedDB helpers shared by the engine store and the migration.

export function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/** Walk a cursor request, calling `step(cursor)`; `step` returns false to stop. */
export function walk(request, step) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      if (step(cursor) === false) return resolve();
      cursor.continue();
    };
  });
}

/**
 * Open `name` only if it already exists: an upgrade means it did not, and the upgrade is aborted so that
 * probing for a legacy database never creates an empty one. Resolves the database or null.
 */
export function openExisting(indexedDBImpl, name) {
  return new Promise((resolve) => {
    let created = false;
    let request;
    try { request = indexedDBImpl.open(name); } catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      created = true;
      try { request.transaction.abort(); } catch { /* already gone */ }
    };
    request.onsuccess = () => {
      if (created) { try { request.result.close(); } catch { /* gone */ } resolve(null); return; }
      resolve(request.result);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** A single-writer job chain: jobs run one at a time, in order; a failed job never stops the next. */
export function writerChain() {
  let tail = Promise.resolve();
  let depth = 0;
  return {
    run(job) {
      depth += 1;
      const result = tail.then(job);
      tail = result.then(() => { depth -= 1; }, () => { depth -= 1; });
      return result;
    },
    depth: () => depth,
    idle: () => tail
  };
}
