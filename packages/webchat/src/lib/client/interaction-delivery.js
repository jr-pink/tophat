import { noteCall, noteServer } from './freeze-watch.js';

const PERSIST_MS = 1000;
// Abort it instead, and tell the freeze watchdog.
const FLUSH_TIMEOUT_MS = 15000;

let database;
function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('tophat-interaction-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('events', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
async function transaction(mode, run) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('events', mode);
    const request = run(tx.objectStore('events'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
const volatile = new Map();
const unpersisted = [];
let persistTimer = null;
let busy = false;
let failure = null;
let dropped = 0;
export function enqueueObservation(row) {
  
  if (volatile.size >= 4000) { volatile.delete(volatile.keys().next().value); dropped++; }
  if (dropped) row = { ...row, transportDropped: dropped };
  volatile.set(row.id, row);
  unpersisted.push(row);
  if (!persistTimer) persistTimer = setTimeout(persist, PERSIST_MS);
}
function persist() {
  persistTimer = null;
  const rows = unpersisted.splice(0);
  if (!rows.length) return;
  const started = performance.now();
  transaction('readwrite', store => { for (const row of rows) store.put(row); })
    .then(() => { for (const row of rows) volatile.delete(row.id); noteCall('interaction.persist', performance.now() - started, { rows: rows.length }); })
    .catch(() => { failure = 'local_persistence_unavailable'; });
}
export async function flushObservations() {
  if (busy) return;
  busy = true;
  try {
    let persisted = [];
    try { persisted = await transaction('readonly', store => store.getAll(null, 500)); } catch { failure = 'local_persistence_unavailable'; }
    const rows = []; let bytes = 0;
    for (const row of new Map([...persisted, ...volatile.values()].map(r => [r.id, r])).values()) {
      const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
      if (rows.length >= 500 || bytes + size > 900000) break;
      rows.push(row); bytes += size;
    }
    if (!rows.length) return;
    const started = performance.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FLUSH_TIMEOUT_MS);
    let response;
    try { response = await fetch('/api/interaction', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows }), keepalive: false, signal: abort.signal }); }
    catch (error) { noteServer(false, performance.now() - started, { route: 'interaction', error: String(error?.name || error).slice(0, 80) }); return; }
    finally { clearTimeout(timer); }
    noteServer(response.status < 500, performance.now() - started, { route: 'interaction', status: response.status });
    noteCall('interaction.flush', performance.now() - started, { rows: rows.length, bytes, status: response.status });
    if (!response.ok) return;
    const { acknowledged } = await response.json();
    const accepted = new Set(rows.map(r => r.id));
    const ids = Array.isArray(acknowledged) ? acknowledged.filter(id => accepted.has(id)) : [];
    await transaction('readwrite', store => { for (const id of ids) store.delete(id); }).catch(() => {});
    for (const id of ids) volatile.delete(id);
    const acked = new Set(ids);
    if (acked.size) { const keep = unpersisted.filter(r => !acked.has(r.id)); unpersisted.splice(0, unpersisted.length, ...keep); }
  } catch {  }
  finally { busy = false; }
}
export function deliveryStatus() { return { failure, volatile: volatile.size, dropped }; }
