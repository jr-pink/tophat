

const PENDING_KEY = 'tophat.dictation.pending';
const OPEN_PREFIX = 'tophat.dictation.open.';
const TRACE_PREFIX = 'tophat.dictation.trace.';
const DB_NAME = 'tophat-dictation';
const STORE = 'clips';

export const RETRY_MS = 8_000;


export const UPLOAD_CEILING_MS = 120_000;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch { return fallback; }
}

function writeJson(key, value) {
  try {
    if (value && value.length) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {  }
}


export function pending() {
  return readJson(PENDING_KEY, []);
}

function setPending(list) {
  writeJson(PENDING_KEY, list);
}

export function openUtterances(conversationId) {
  return readJson(OPEN_PREFIX + (conversationId || 'none'), []);
}

export function setOpenUtterances(conversationId, list) {
  writeJson(OPEN_PREFIX + (conversationId || 'none'), list);
}

export function trace(conversationId) {
  return readJson(TRACE_PREFIX + (conversationId || 'none'), []);
}

export function setTrace(conversationId, steps) {
  
  
  writeJson(TRACE_PREFIX + (conversationId || 'none'), steps.slice(-200));
}

export function clearConversation(conversationId) {
  setOpenUtterances(conversationId, []);
  setTrace(conversationId, []);
}

let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      
      
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB refused'));
  }).catch((cause) => { dbPromise = null; throw cause; });
  return dbPromise;
}

function tx(mode, run) {
  return db().then((handle) => new Promise((resolve, reject) => {
    const transaction = handle.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB aborted'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB failed'));
  }));
}

export function putBytes(id, blob) { return tx('readwrite', (store) => store.put(blob, id)); }
export function getBytes(id) { return tx('readonly', (store) => store.get(id)); }
export function deleteBytes(id) { return tx('readwrite', (store) => store.delete(id)); }

export async function enqueue(entry, blob) {
  const list = pending().filter((item) => item.id !== entry.id);
  list.push({ ...entry, queuedAt: Date.now(), attempts: 0 });
  setPending(list);
  try {
    await putBytes(entry.id, blob);
    return true;
  } catch {
    
    
    
    const without = pending().map((item) => (item.id === entry.id ? { ...item, volatile: true } : item));
    setPending(without);
    return false;
  }
}


export async function settle(id) {
  setPending(pending().filter((item) => item.id !== id));
  await deleteBytes(id).catch(() => {});
}

/**
 * The transcript the live path already produced for this clip, carried with
 * the clip so the record keeps it and the server does not decode the same
 * audio a second time. Survives a reload, because the upload may.
 */
export function noteTranscript(id, asr) {
  if (!asr?.text) return;
  setPending(pending().map((item) => (item.id === id ? { ...item, asr } : item)));
}

/**
 * Forget what the preview thought it heard, so the upload asks for a decode
 * instead of carrying an answer with it. This is what a stop that never
 * reached the server needs: the preview's words stop at its last poll, and
 * telling the record they are the transcript loses the end of the sentence a
 * second time.
 */
export function forgetTranscript(id) {
  setPending(pending().map((item) => {
    if (item.id !== id || !item.asr) return item;
    const { asr, ...rest } = item;
    return rest;
  }));
}

export function noteAttempt(id, error = null) {
  setPending(pending().map((item) => (
    item.id === id
      ? { ...item, attempts: (item.attempts || 0) + 1, lastError: error ? String(error).slice(0, 200) : null }
      : item
  )));
}

export async function replayable() {
  const out = [];
  for (const item of pending()) {
    if (item.volatile) { out.push({ ...item, blob: null, lost: true }); continue; }
    const blob = await getBytes(item.id).catch(() => null);
    out.push({ ...item, blob: blob || null, lost: !blob });
  }
  return out;
}

export async function upload(entry, blob, { fetchImpl = fetch, ceilingMs = UPLOAD_CEILING_MS } = {}) {
  const meta = {
    clipId: entry.id,
    sessionId: entry.sessionId,
    conversationId: entry.conversationId,
    at: entry.at,
    inputDevice: entry.device,
    deviceId: entry.deviceId,
    trackSettings: entry.settings || null,
    engine: entry.engine || undefined,
    asr: entry.asr || undefined
  };
  const response = await fetchImpl('/api/dictation/clip', {
    method: 'POST',
    headers: {
      'content-type': 'audio/wav',
      'x-clip-meta': btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(meta))))
    },
    body: blob,
    signal: AbortSignal.timeout(ceilingMs)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `The server answered ${response.status}.`);
    error.kind = body.kind || 'http';
    
    
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
    throw error;
  }
  return body;
}
