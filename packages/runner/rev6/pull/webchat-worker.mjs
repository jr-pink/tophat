// The webchat-transcript leg of the unified search on its own thread. Its sqlite FTS read over events.sqlite (1.7 GB)
// is synchronous: on the runner's thread it took 339 ms at the median and 1.9 s at p90 in live prefetches, during
// which the prefetch hold's deadline and every other leg's completion could not be seen. prefetch.mjs
// webchatOffThread starts this and awaits the one message: one answer per ask, in order.
import { parentPort, workerData } from 'node:worker_threads';
import { webchatSearch } from '../retrieval/webchat.mjs';

let out;
try { out = { ok: true, answers: workerData.asks.map((a) => webchatSearch(a)) }; } catch (error) { out = { ok: false, detail: String(error?.message || error).slice(0, 500) }; }
parentPort.postMessage(out);
