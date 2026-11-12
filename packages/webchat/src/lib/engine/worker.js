// The chat engine's worker entry: a SharedWorker (one per browser) or a dedicated Worker (the Web Locks leader's,
// or a tab's own as the last resort). Same module either way; kit workerMain tells them apart.
import { workerMain } from '../../../../runner/tools/docstore-kit/lib/engine/host.js';
import { makeChatServer } from './chat-engine.js';

// A worker a page named with a per-load suffix (globalThis.__chatEngineWorker = '<base>-<suffix>', the public demo) keeps its cache in its own
// IndexedDB database, so a page that wipes the shared one never waits on (or reads) a database another tab's engine still holds open.
const own = /^(?:tophat|tophat)-chat-engine-([a-z0-9]+)$/.exec(globalThis.name || '');
workerMain(() => makeChatServer(own ? { dbName: `tophat-engine-${own[1]}` } : {}));
