// The session's own outbox (IndexedDB) keeps an action it is retrying, but a send made before the
// room had joined, a refusal, or a reload in the wrong moment left nothing behind. This is the
// second copy, keyed by the same action id, so a replay is idempotent: the server answers a
// repeated action id with `replayed` and stores the message once.

// The old key `tophat-mp-unsent-<namespace>` is imported once and kept: an entry leaves it only when it leaves the
// outbox, so a rolled-back build finds exactly the entries still owed (a replay of one is idempotent at the server
// anyway). Pinned old module: ui/__oracle__/mp/mp-outbox.v1.js; differential: ui/MpOutbox.diff.test.js.
import { localOutbox } from '../../../../runner/tools/docstore-kit/lib/engine/outbox-local.js';

const prefix = (namespace) => `tophat-mp-unsent-${namespace}`;
const valid = (e) => e && typeof e.id === 'string' && typeof e.text === 'string';

function boxOf(namespace, storage) {
  return localOutbox({
    storage, key: `qk-outbox:mp:${namespace}`,
    legacy: [{
      key: prefix(namespace),
      entries: (raw) => { const list = JSON.parse(raw); return Array.isArray(list) ? list.filter(valid).map((e) => ({ id: e.id, stream: namespace, body: e })) : []; },
      remove: (raw, ids) => { const list = JSON.parse(raw); const kept = Array.isArray(list) ? list.filter((e) => !(e && ids.has(e.id))) : []; return kept.length ? JSON.stringify(kept) : null; }
    }]
  });
}

export function readUnsent(namespace, storage = globalThis.localStorage) {
  try { return boxOf(namespace, storage).rows().map((r) => r.body).filter(valid); } catch { return []; }
}

/** The room's whole list as it should now be, in its order: entries it no longer lists leave, new ones are committed. */
export function writeUnsent(namespace, entries, storage = globalThis.localStorage) {
  try { boxOf(namespace, storage).replaceSync(entries.map((e) => ({ id: e.id, stream: namespace, body: e }))); return true; } catch { return false; }
}

/**
 * What each unsent entry is, given what the session knows:
 *   acked    the server stored it (not in the outbox, not refused, or already in the transcript): drop
 *   sending  the session's outbox holds it and is retrying
 *   failed   the server refused it for good: keep the text, say why
 *   replay   nothing holds it (never handed to the session, or a reload lost it): send it again
 *            under the same action id
 */
export function classify(entries, { outboxIds = new Set(), rejected = [], itemIds = new Set(), handedOver = new Set() } = {}) {
  const refused = new Map(rejected.map((r) => [r.id, r]));
  return entries.map((entry) => {
    // Refused and still-queued come before "already in the transcript": the optimistic row is in
    // the transcript from the moment of the press, and says nothing about the server.
    if (refused.has(entry.id)) return { entry, state: 'failed', reason: refused.get(entry.id).reason };
    if (outboxIds.has(entry.id)) return { entry, state: 'sending' };
    if (itemIds.has(entry.id)) return { entry, state: 'acked' };
    if (handedOver.has(entry.id)) return { entry, state: 'acked' };
    return { entry, state: 'replay' };
  });
}
