// The browser half of lag.jsonl. The server's loop-stall guard (lag-guard.js) writes lag.jsonl when the
// server's thread is held; this file is where a browser tab reports the same thing about itself, plus
// the one thing the server can never see: that the tab could not reach it.
//
// Why it exists: the owner's tab looked frozen for 96 s. lag.jsonl was clean, and the guess was
// main-thread work in the client. The interaction rows' own `at` stamps said otherwise (the tab kept
// recording every 5 s through the gap. With this file the next one names itself: `longtask`/`gap` rows
// mean the tab's thread was held (with Long Animation Frame script attribution), `unreachable` rows mean
// the network or tunnel between the tab and this server was down.
//
// One JSON line per record: { received, ...record }. Records come from /api/client-lag. Low volume by
// construction (the client sends only events over 1 s, and the server caps each batch), so a plain async
// append with a size-based rotation like lag.jsonl is enough; no queue, no lock (single process writer).
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { webchatStorePath } from './paths.js';

export const KINDS = new Set(['longtask', 'gap', 'unreachable', 'capture_slow', 'probe']);
const MAX_BATCH = 50;
const MAX_RECORD_CHARS = 16_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

export function clientLagPath() {
  return process.env.WEBCHAT_CLIENT_LAG_LOG || webchatStorePath('client-lag.jsonl');
}

/** Keep the records a browser may send: known kind, finite duration, bounded size. Throws on a bad batch. */
export function validateClientLag(records) {
  if (!Array.isArray(records)) throw new Error('expected records array');
  const kept = [];
  for (const record of records.slice(0, MAX_BATCH)) {
    if (!record || typeof record !== 'object' || !KINDS.has(record.kind)) continue;
    if (!Number.isFinite(record.durationMs) || record.durationMs < 0) continue;
    let line = JSON.stringify(record);
    if (line.length > MAX_RECORD_CHARS) line = JSON.stringify({ kind: record.kind, durationMs: record.durationMs, at: record.at, truncated: line.length });
    kept.push(JSON.parse(line));
  }
  return kept;
}

let chain = Promise.resolve();
/** Append the batch as one write, rotating to `.1` past 5 MB. Serialised so two batches never interleave. */
export function saveClientLag(records, { path = clientLagPath(), userAgent = null, now = () => new Date() } = {}) {
  const received = now().toISOString();
  const text = records.map((r) => JSON.stringify({ received, userAgent, ...r })).join('\n') + '\n';
  const run = chain.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    try { if ((await stat(path)).size > LOG_MAX_BYTES) await rename(path, `${path}.1`); } catch { /* none yet */ }
    await appendFile(path, text, { mode: 0o600 });
  });
  chain = run.catch(() => {});
  return run.then(() => records.length);
}
