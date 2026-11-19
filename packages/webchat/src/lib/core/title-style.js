// Client half of the title style (server half: server/autotitle.js, /api/title-style). Same offline-first shape as the
// host menu (core/host-notes.js): the server's answer is cached on the device, a change is written to a persisted outbox
// before any request, shows at once, and is replayed until the server takes it. The server keeps the newest change by
// `at`, so a replay is idempotent and two devices converge. A change leaves the outbox only on a 2xx.
import { DEFAULT_TITLE_STYLE, TITLE_STYLES } from './title.js';

const CACHE = 'tophat-title-style:cache';
const OUTBOX = 'tophat-title-style:outbox';

function box(storage) {
  if (storage === null) return null;
  try { return storage ?? globalThis.localStorage ?? null; } catch { return null; }
}
function read(storage, key) {
  try { return JSON.parse(box(storage)?.getItem(key) || 'null'); } catch { return null; }
}
function write(storage, key, value) {
  try { if (value === null) box(storage)?.removeItem(key); else box(storage)?.setItem(key, JSON.stringify(value)); } catch { /* storage off */ }
}

/** The style as shown: an unsent change, else the server's last answer, else the default. */
export function readStyle(storage) {
  const style = read(storage, OUTBOX)?.style ?? read(storage, CACHE)?.style;
  return TITLE_STYLES.includes(style) ? style : DEFAULT_TITLE_STYLE;
}

/** Records a change durably and returns the style as it now reads. */
export function queueStyle(style, { storage, now = () => new Date().toISOString() } = {}) {
  if (TITLE_STYLES.includes(style)) write(storage, OUTBOX, { style, at: now() });
  return readStyle(storage);
}

/** Sends a queued change, then fetches the server's style and caches it. Returns the style as it now reads. */
export async function sync({ storage, fetchImpl = globalThis.fetch } = {}) {
  const queued = read(storage, OUTBOX);
  if (queued) {
    try {
      const r = await fetchImpl('/api/title-style', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(queued) });
      // A change made while this one was in flight stays queued; one the server refuses has nowhere to go.
      if ((r.ok || r.status === 400) && read(storage, OUTBOX)?.at === queued.at) write(storage, OUTBOX, null);
    } catch { return readStyle(storage); }
  }
  try {
    const r = await fetchImpl('/api/title-style');
    if (r.ok) write(storage, CACHE, await r.json());
  } catch { /* offline: the cache stands */ }
  return readStyle(storage);
}
