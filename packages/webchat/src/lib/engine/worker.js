// The chat engine's worker entry: a SharedWorker (one per browser) or a dedicated Worker (the Web Locks leader's,
// or a tab's own as the last resort). Same module either way; kit workerMain tells them apart.
import { workerMain } from '../../../../runner/tools/quicklook-kit/lib/engine/host.js';
import { makeChatServer } from './chat-engine.js';

workerMain(() => makeChatServer());
