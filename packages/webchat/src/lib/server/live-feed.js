// The live feed: a push to every open page that a store it shows has changed.
//
// Chats were instant because every store event goes down /api/events; notes and the reader had no
// push at all, so an edit made on the phone reached an open notes page on the laptop only on a
// reload. why not ?
//
// What goes down the wire is a signal, not the data: `{topic, cursor, origin}`. The page answers it
// by asking its store for the present again through the merge path it already has, which keeps
// every block he is typing in, so the feed never has to know the page's shape and a missed signal
// can never lose a change: the next fetch carries it.
//
// The cursor is `<boot>:<n>`. A reader that comes back names the last cursor it saw (Last-Event-ID,
// or ?after=); within this process's ring of recent events it gets exactly what it missed, and
// anything else (a restart, a gap longer than the ring) gets one `resync`, which means "refetch
// everything you show". The origin is the tab that made the write (x-tophat-client on its request,
// carried through the request by AsyncLocalStorage) so a page skips its own echoes.
//
// In-process writes are reported by the stores themselves (onNotesWrite, onReaderWrite). Writes
// from another process (scripts/state.mjs, an ingest script) never pass through those; the probe
// polls each store's PRAGMA data_version, which changes exactly when another connection commits,
// once a second and only while someone is listening.
//
// The vault is the same idea without a database: its probe stats the catalog record, so a write
// made by `tophat-pass` in a terminal or by another enrolled device pushes `vault` to every open
// /secrets page, which answers it by asking for a snapshot. The signal is an mtime and a size;
// no credential, no name and no key ever rides the feed.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { notesStore, onNotesWrite } from './notes-store.js';
import { passwordManager } from './password-manager.js';
import { readerStore, onReaderWrite } from './reader-store.js';

export const LIVE_TOPICS = ['notes', 'reader', 'vault'];
export const LIVE_RING = 1000;
export const LIVE_POLL_MS = 1000;

const origins = new AsyncLocalStorage();
/** Run `fn` with every store write inside it attributed to `origin` (a tab id, or null). */
export const withOrigin = (origin, fn) => origins.run(cleanOrigin(origin), fn);
export const currentOrigin = () => origins.getStore() ?? null;
/** Run `fn` outside any request's attribution: a timer a request scheduled is not that tab's write. */
export const withoutOrigin = (fn) => origins.exit(fn);
export function cleanOrigin(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[\w.-]{1,80}$/u.test(text) ? text : null;
}

export function parseCursor(value) {
  const match = /^([0-9a-f]+):(\d+)$/u.exec(String(value || '').trim());
  return match ? { boot: match[1], n: Number(match[2]) } : null;
}

export function createLiveFeed({
  boot = randomBytes(4).toString('hex'),
  probes = {},
  pollMs = LIVE_POLL_MS,
  ring = LIVE_RING,
  setTimer = setInterval,
  clearTimer = clearInterval,
  defer = queueMicrotask
} = {}) {
  let n = 0;
  const recent = [];
  const listeners = new Set();
  const pending = new Map();
  let scheduled = false;
  const seen = new Map();
  let poller = null;

  const cursorOf = (at) => `${boot}:${at}`;

  function emit() {
    scheduled = false;
    const batch = [...pending];
    pending.clear();
    for (const [topic, from] of batch) {
      n += 1;
      // A tick that saw writes from two tabs belongs to neither, so neither skips it.
      const event = { topic, cursor: cursorOf(n), origin: from.size === 1 ? [...from][0] : null };
      recent.push({ n, event });
      if (recent.length > ring) recent.shift();
      for (const listener of listeners) { try { listener(event); } catch { /* one bad reader */ } }
    }
  }

  /** A store changed. Writes in one tick coalesce into one event per topic. */
  function touch(topic, origin = currentOrigin()) {
    if (!pending.has(topic)) pending.set(topic, new Set());
    pending.get(topic).add(origin ?? null);
    if (!scheduled) { scheduled = true; defer(emit); }
  }

  function poll() {
    for (const [topic, probe] of Object.entries(probes)) {
      let version;
      try { version = probe(); } catch { continue; }
      if (version === undefined || version === null) continue;
      if (seen.has(topic) && seen.get(topic) !== version) touch(topic, null);
      seen.set(topic, version);
    }
  }

  function startPolling() {
    if (poller !== null || !Object.keys(probes).length) return;
    poll();
    poller = setTimer(poll, pollMs);
    poller?.unref?.();
  }
  function stopPolling() {
    if (poller === null) return;
    clearTimer(poller);
    poller = null;
    seen.clear();
  }

  /**
   * What a reader resuming from `after` missed: the events themselves, or `resync` when they are
   * gone (another boot, or older than the ring). No `after` at all is a first connection, which
   * has just loaded and needs nothing.
   */
  function since(after) {
    if (after === null || after === undefined || after === '') return { events: [], resync: false };
    const parsed = parseCursor(after);
    if (!parsed || parsed.boot !== boot || parsed.n > n) return { events: [], resync: true };
    if (parsed.n === n) return { events: [], resync: false };
    const oldest = recent.length ? recent[0].n : n + 1;
    if (parsed.n < oldest - 1) return { events: [], resync: true };
    return { events: recent.filter((entry) => entry.n > parsed.n).map((entry) => entry.event), resync: false };
  }

  function subscribe(listener) {
    listeners.add(listener);
    startPolling();
    return () => {
      listeners.delete(listener);
      if (!listeners.size) stopPolling();
    };
  }

  return { boot, touch, since, subscribe, cursor: () => cursorOf(n), poll, listening: () => listeners.size };
}

/** The SSE body for one connection: the backlog or a resync, hello, then every event, with pings. */
export function liveStream({ feed, after = null, topics = null, heartbeatMs = 20_000, setTimer = setInterval, clearTimer = clearInterval }) {
  const wanted = topics && topics.length ? new Set(topics) : null;
  let unsubscribe = () => {};
  let heartbeat = null;
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    try { unsubscribe(); } catch { /* already gone */ }
    if (heartbeat !== null) clearTimer(heartbeat);
  };
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (text) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(text)); } catch { stop(); }
      };
      const frame = (payload, id = null) => send(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(payload)}\n\n`);
      // Retry quickly: a dropped stream is a phone waking up, and every second of it is a stale page.
      send('retry: 1500\n\n');
      const missed = feed.since(after);
      if (missed.resync) frame({ resync: true, cursor: feed.cursor() }, feed.cursor());
      for (const event of missed.events) if (!wanted || wanted.has(event.topic)) frame(event, event.cursor);
      frame({ hello: true, cursor: feed.cursor() }, feed.cursor());
      unsubscribe = feed.subscribe((event) => {
        // A topic this reader does not watch still moves its cursor, or its resume would replay it.
        frame(!wanted || wanted.has(event.topic) ? event : { skip: true, cursor: event.cursor }, event.cursor);
      });
      heartbeat = setTimer(() => send(`: ping ${Date.now()}\n\n`), heartbeatMs);
      heartbeat?.unref?.();
    },
    cancel() { stop(); }
  });
  return { stream, stop, closed: () => closed };
}

let shared = null;

/**
 * The vault has no sqlite connection to watch, and its writer is usually not this process at all:
 * `tophat-pass` on the command line, or another device's op replayed through the sync route. Both
 * end in one rewritten file, so the signal is a stat of the catalog record. It carries nothing but
 * an mtime and a size, which is all a device needs to know it should ask for a snapshot; a value
 * never goes down this wire, and a device with a current etag gets a 304 for its trouble.
 *
 * Throwing here is normal and harmless: no vault yet, or a directory this server cannot read. The
 * poller treats a throwing probe as "nothing to say" and keeps the last reading.
 */
export const vaultRevision = () => {
  const stats = statSync(passwordManager().file('catalog'));
  return `${stats.mtimeMs}:${stats.size}`;
};

/** The one feed of this server, wired to both stores the first time anything asks for it. */
export function liveFeed() {
  if (shared) return shared;
  const dataVersion = (open) => () => Number(open().db.prepare('PRAGMA data_version').get().data_version);
  shared = createLiveFeed({
    probes: { notes: dataVersion(notesStore), reader: dataVersion(readerStore), vault: vaultRevision }
  });
  onNotesWrite(() => shared.touch('notes'));
  onReaderWrite(() => shared.touch('reader'));
  return shared;
}
