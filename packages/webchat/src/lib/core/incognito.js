// Incognito chats. Add it to hamburger menu in nav pill.
//
// An incognito chat is an ordinary chat whose id says what it is: `incognito-<tab>-<random>`. The id is the one
// thing every layer can read, so each place that would keep something durable checks it here rather than
// carrying a flag around:
//   server  src/lib/server/incognito.js   its own `:memory:` event store and runner; the main /api/actions refuses it
//   runner  rev6/pull/incognito.mjs       `:memory:` ledger, no push, no goals, no memory or task writes
//   client  src/lib/client/incognito.js   its own session over an in-memory replica, never IndexedDB
//           core/attachments.js (drafts), client/upload-journal.js, client/interaction.js,
//           client/input-provenance-recorder.js skip it
// The <tab> part scopes a chat to the browser tab that opened it: the server streams a tab only its own chats and
// forgets them when the tab has been gone long enough.

export const INCOGNITO_PREFIX = 'incognito-';

/** The label the UI shows on an incognito chat and in the nav menu. */
export const INCOGNITO_LABEL = 'incognito';

export function isIncognito(id) {
  return typeof id === 'string' && id.startsWith(INCOGNITO_PREFIX);
}

const randomPart = () => {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** A fresh tab key: lowercase hex, no dashes, so it can be read back out of an id. */
export function newIncognitoTab() {
  return randomPart();
}

/** A fresh incognito conversation id belonging to `tab`. */
export function incognitoId(tab) {
  if (!/^[0-9a-f]{8,32}$/.test(String(tab || ''))) throw new Error('an incognito chat needs a tab key');
  return `${INCOGNITO_PREFIX}${tab}-${randomPart()}`;
}

/** The tab an incognito id belongs to, or null for any other id. */
export function tabOf(id) {
  if (!isIncognito(id)) return null;
  const match = /^incognito-([0-9a-f]{8,32})-[0-9a-f]+$/.exec(id);
  return match ? match[1] : null;
}

/** Whether an id is a well formed incognito id (the server accepts nothing else on its incognito routes). */
export function validIncognitoId(id) {
  return tabOf(id) !== null;
}
