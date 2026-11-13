// The host list every surface reads (the chat header's dropdown, the sidebar's host menu): the peers on the hub, this host first.
// One reactive copy per tab, offline first (core/host-notes.js caches it on the device and queues edits), refreshed from /api/hosts.
import { queueEdit, readCached, sync } from './host-notes.js';

export const hostState = $state({ list: readCached(), loaded: false });

let inFlight = null;

/** Replays queued edits, fetches the server's list, and updates the shared copy. Concurrent calls share one round trip. */
export function refreshHosts(options = {}) {
  if (inFlight) return inFlight;
  inFlight = sync(options)
    .then((list) => { hostState.list = list; hostState.loaded = true; })
    .catch(() => { hostState.loaded = true; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** A host-menu edit: shown at once, persisted, then sent. */
export function editHost(id, fields, options = {}) {
  hostState.list = queueEdit(id, fields, options);
  // An edit made while a round trip is in flight is sent by the next one, not left for the next poll.
  return (inFlight || Promise.resolve()).then(() => refreshHosts(options));
}

/** Whether there is any host besides this host, so the surfaces that offer a choice stay out of the way of a single-host install. */
export const hasPeers = () => hostState.list.some((h) => !h.local);
