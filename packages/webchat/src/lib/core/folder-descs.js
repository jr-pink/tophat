// Client half of folder descriptions (server half: server/folder-descriptions.js). Offline first:
// the last server copy is cached on the device, and an edit is written to a persisted outbox
// before any request, applies locally at once, and is replayed until the server takes it. The
// server keeps the newest edit per folder (last write wins by `at`), so a replay is idempotent
// and two devices converge. A saved edit is source "manual": authoritative for the router and
// never rewritten by the daily generator. Empty text hands the folder back to the generator.

const CACHE = 'tophat-folder-descs:cache';
const OUTBOX = 'tophat-folder-descs:outbox';

const keyOf = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();

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

/** Descriptions as shown: the cached server copy with every unsent edit laid over it. */
export function overlay(server, outbox) {
  const out = { ...(server || {}) };
  for (const [k, e] of Object.entries(outbox || {})) {
    // A place edit ("p:<key>"): where the folder sits in the shared tree ('' = top level).
    if (k.startsWith('p:')) {
      const key = k.slice(2);
      out[key] = { ...(out[key] || { name: e.name }), parent: e.parent, parentAt: e.at, pending: true };
      continue;
    }
    // An archive edit ("a:<key>"): the folder's archive flag, orthogonal to its place and text.
    if (k.startsWith('a:')) {
      const key = k.slice(2);
      out[key] = { ...(out[key] || { name: e.name }), archived: e.archived === true, archivedAt: e.at, pending: true };
      continue;
    }
    const o = out[k];
    const placed = typeof o?.parentAt === 'string', archivedSet = typeof o?.archivedAt === 'string';
    const keep = o && (placed || archivedSet) ? { name: o.name, ...(placed ? { parent: o.parent, parentAt: o.parentAt } : {}), ...(archivedSet ? { archived: o.archived, archivedAt: o.archivedAt } : {}) } : null;
    if (e.text) out[k] = { ...(keep || {}), name: e.name, text: e.text, source: 'manual', at: e.at, pending: true };
    else if (keep) out[k] = keep;
    else delete out[k];
  }
  return out;
}

export const readCached = (storage) => overlay(read(storage, CACHE, {}), read(storage, OUTBOX, {}));
export const readOutbox = (storage) => read(storage, OUTBOX, {});

/** Records an edit durably and returns the descriptions as they now read. */
export function queueEdit(name, text, { storage, now = () => new Date().toISOString() } = {}) {
  const k = keyOf(name);
  if (!k) return readCached(storage);
  const outbox = read(storage, OUTBOX, {});
  outbox[k] = { name: String(name).replace(/\s+/g, ' ').trim(), text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), at: now() };
  write(storage, OUTBOX, outbox);
  return readCached(storage);
}

/** Records where a folder sits (its parent's name or key; '' or null = top level; the Inbox's key = inside Inbox), durably,
 * and returns the descriptions as they now read.
 */
export function queueParent(name, parent, { storage, now = () => new Date().toISOString() } = {}) {
  const k = keyOf(name);
  if (!k) return readCached(storage);
  const outbox = read(storage, OUTBOX, {});
  const p = parent == null ? '' : (String(parent).startsWith('\u0000') ? String(parent) : keyOf(parent));
  outbox[`p:${k}`] = { name: String(name).replace(/\s+/g, ' ').trim(), parent: p, at: now() };
  write(storage, OUTBOX, outbox);
  return readCached(storage);
}

/** Records a folder's archive flag (true = archived), durably; orthogonal to where the folder sits. Returns the descriptions as they now read. */
export function queueArchive(name, archived, { storage, now = () => new Date().toISOString() } = {}) {
  const k = keyOf(name);
  if (!k) return readCached(storage);
  const outbox = read(storage, OUTBOX, {});
  outbox[`a:${k}`] = { name: String(name).replace(/\s+/g, ' ').trim(), archived: archived === true, at: now() };
  write(storage, OUTBOX, outbox);
  return readCached(storage);
}

/**
 * Sends every queued edit, then fetches the server's copy and caches it. An edit leaves the outbox
 * only when the server answered 2xx; a network error or a 5xx leaves it for the next try.
 * Returns the descriptions as they now read.
 */
export async function sync({ storage, fetchImpl = globalThis.fetch } = {}) {
  let outbox = read(storage, OUTBOX, {});
  for (const [k, e] of Object.entries(outbox)) {
    try {
      const r = await fetchImpl('/api/folder-descriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(k.startsWith('p:') ? { name: e.name, parent: e.parent, at: e.at } : k.startsWith('a:') ? { name: e.name, archived: e.archived === true, at: e.at } : { name: e.name, text: e.text, at: e.at }) });
      if (!r.ok) continue;
      outbox = read(storage, OUTBOX, {});
      // An edit made while this one was in flight stays queued.
      if (outbox[k]?.at === e.at) { delete outbox[k]; write(storage, OUTBOX, outbox); }
    } catch { break; }
  }
  try {
    const r = await fetchImpl('/api/folder-descriptions');
    if (r.ok) write(storage, CACHE, await r.json());
  } catch { /* offline: the cache stands */ }
  return readCached(storage);
}
