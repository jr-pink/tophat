// @tophat-md/sources: source adapters behind one plugin interface.
//
// An adapter is a module exporting
//   poll(source, ctx) -> Promise<{ records: AdapterRecord[], cursor: any, complete: boolean, health: object }>
// where source = { id, family, account?, config } (config is the adapter's own: paths, account, credential refs) and
// ctx = { cursor (what the last successful poll returned), now, stateDir, ownerAddresses?, ... }.
//   AdapterRecord = { id, text, occurredAt (ISO), revision?, sender?, participants?, threadId?, metadata?: { direction?, ... } }
// The runner (./run.mjs) owns cursors and deadlines; toRawRecord turns an AdapterRecord into the MemoryStore RawRecord.
// Register your own: registerAdapter('my-family', () => import('./my-adapter.mjs')).
const BUILTIN = {
  jsonl: () => import('./adapters/jsonl.mjs'),
  gmail: () => import('./adapters/gmail.mjs'),
  imessage: () => import('./adapters/imessage.mjs'),
  beeper: () => import('./adapters/beeper.mjs'),
  imap: () => import('./adapters/imap.mjs'),
  apple: () => import('./adapters/apple.mjs'),
  'http-pulls': () => import('./adapters/http-pulls.mjs'),
};
const REGISTRY = new Map(Object.entries(BUILTIN));
export function registerAdapter(family, loader) { REGISTRY.set(family, typeof loader === 'function' ? loader : () => loader); }
export function families() { return [...REGISTRY.keys()]; }
export async function adapterFor(family) {
  const load = REGISTRY.get(family);
  if (!load) throw Object.assign(new Error(`no adapter family ${family}`), { code: 'unknown-adapter' });
  return load();
}

/** metadata.direction values written by the owner (gmail sent/draft, imessage/beeper outgoing). */
export const OWNER_DIRECTIONS = ['sent', 'outgoing', 'draft'];

/** AdapterRecord -> MemoryStore RawRecord. */
export function toRawRecord(source, r) {
  const meta = r.metadata || {};
  return { id: String(meta.nativeMessageId || r.id), source: source.id, account: meta.accountId || source.account || '', text: r.text, time: r.occurredAt,
    revision: r.revision != null ? String(r.revision) : undefined, role: OWNER_DIRECTIONS.includes(meta.direction) ? 'owner' : 'human',
    author: r.sender || meta.sender || null, participants: r.participants || [], thread: r.threadId ?? null,
    locator: { family: source.family, record_id: r.id, ...(meta.direction ? { direction: meta.direction } : {}), ...(meta.type ? { type: meta.type } : {}) } };
}
export { runSources } from './run.mjs';
