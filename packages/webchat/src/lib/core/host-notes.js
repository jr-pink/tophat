// Client half of the host menu (server half: server/hosts.js, /api/hosts). Same offline-first shape as folder descriptions: the last
// server list is cached on the device, and an edit (the auto-routing checkbox, the description of what to send to a host) is written to
// a persisted outbox before any request, applies locally at once, and is replayed until the server takes it. The server keeps the newest
// edit per host (by `at`), so a replay is idempotent and two devices converge. An edit leaves the outbox only on a 2xx.

const CACHE = 'tophat-host-list:cache';
const OUTBOX = 'tophat-host-list:outbox';

function box(storage) {
  if (storage === null) return null;
  try { return storage ?? globalThis.localStorage ?? null; } catch { return null; }
}
function read(storage, key, fallback) {
  try { const v = JSON.parse(box(storage)?.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
}
function write(storage, key, value) {
  try { box(storage)?.setItem(key, JSON.stringify(value)); } catch { /* storage off: edits stay in memory */ }
}

/** The hosts as shown: the cached server list with every unsent edit laid over it. */
export function overlay(hosts, outbox) {
  return (hosts || []).map((h) => {
    const e = outbox?.[h.id];
    if (!e) return h;
    return { ...h, ...(typeof e.description === 'string' ? { description: e.description } : {}), ...(typeof e.auto === 'boolean' ? { auto: e.auto } : {}), pending: true };
  });
}

export const readCached = (storage) => overlay(read(storage, CACHE, []), read(storage, OUTBOX, {}));
export const readOutbox = (storage) => read(storage, OUTBOX, {});

/** Records an edit durably (a later field replaces an earlier one for the same host) and returns the hosts as they now read. */
export function queueEdit(id, fields, { storage, now = () => new Date().toISOString() } = {}) {
  if (typeof id !== 'string') return readCached(storage);
  const outbox = read(storage, OUTBOX, {});
  const next = { ...(outbox[id] || {}), at: now() };
  if (typeof fields.description === 'string') next.description = fields.description.replace(/\s+/gu, ' ').trim().slice(0, 300);
  if (typeof fields.auto === 'boolean') next.auto = fields.auto;
  outbox[id] = next;
  write(storage, OUTBOX, outbox);
  return readCached(storage);
}

/** Sends every queued edit, then fetches the server's list and caches it. Returns the hosts as they now read. */
export async function sync({ storage, fetchImpl = globalThis.fetch } = {}) {
  let outbox = read(storage, OUTBOX, {});
  for (const [id, e] of Object.entries(outbox)) {
    try {
      const r = await fetchImpl('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, description: e.description, auto: e.auto, at: e.at }) });
      if (r.status === 400) { outbox = read(storage, OUTBOX, {}); delete outbox[id]; write(storage, OUTBOX, outbox); continue; } // a host the server no longer lists: the edit has nowhere to go
      if (!r.ok) continue;
      outbox = read(storage, OUTBOX, {});
      // An edit made while this one was in flight stays queued.
      if (outbox[id]?.at === e.at) { delete outbox[id]; write(storage, OUTBOX, outbox); }
    } catch { break; }
  }
  try {
    const r = await fetchImpl('/api/hosts');
    if (r.ok) write(storage, CACHE, (await r.json()).hosts || []);
  } catch { /* offline: the cache stands */ }
  return readCached(storage);
}

/** The label of a host id in these hosts ('' is this machine). */
export const hostLabel = (hosts, id) => (hosts || []).find((h) => h.id === (id || ''))?.label || id || '';
