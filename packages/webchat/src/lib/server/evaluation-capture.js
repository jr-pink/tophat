import { readFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Worker } from 'node:worker_threads';

const CONTROL = /^\s*(?:<\/?(?:hook_prompt|system-reminder|tophat-fanout|side-threads)\b|Stop hook feedback:|This session is being continued from a previous conversation)/i;
export function captureEligibility(attribution, text) {
  if (CONTROL.test(String(text))) return 'harness-content';
  if (attribution?.actor !== 'human' || !['interactive-owner-channel', 'verified-connector'].includes(attribution?.basis)) return 'unattributed';
  return null;
}
// The configured adapter runs on a worker thread, off the server's event loop. The adapter now records a rowid frontier of
// the append-only events table (about 0.5s of index reads in a WAL read transaction, no lock) instead of a copy; see
// src/evaluation/runtime-capture.mjs. The worker stays so that whatever an adapter does can never freeze the server, and it
// is capped well below the old 4GB so a runaway adapter dies alone instead of taking the server's memory with it.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const controller = new AbortController();
parentPort.on('message', (m) => { if (m === 'abort') controller.abort(); });
(async () => {
  let message;
  try {
    const loaded = await import(pathToFileURL(workerData.modulePath).href);
    if (typeof loaded.captureEvaluation !== 'function') throw new Error('Missing capture export');
    message = { ok: true, result: await loaded.captureEvaluation(workerData.envelope, { signal: controller.signal }) };
  } catch { message = { ok: false }; }
  parentPort.postMessage(message);
  parentPort.close();
})();`;
// The adapter takes the heartbeat lock (state dir, heartbeat.lock) as pid = this server's pid, because a worker thread shares it.
// A worker that dies without its finally leaves that file behind. Once no worker is alive, a lock that names this very pid is
// that leak and is removed. A lock a live worker holds is left alone.
const liveWorkers = new Set();
export function releaseLeakedLock(stateDir = process.env.TOPHAT_STATE_DIR) {
  if (!stateDir || liveWorkers.size) return false;
  const file = join(stateDir, 'heartbeat.lock');
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const pid = /^\d+$/.test(raw) ? Number(raw) : JSON.parse(raw).pid;
    if (pid !== process.pid) return false;
    unlinkSync(file); return true;
  } catch { return false; }
}
function captureOnWorker(modulePath) {
  return (envelope, { signal } = {}) => new Promise((resolve, reject) => {
    if (!isAbsolute(modulePath)) { reject(new Error('Configured module path must be absolute')); return; }
    let worker;
    try { worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { modulePath, envelope }, resourceLimits: { maxOldGenerationSizeMb: 1024 } }); }
    catch (error) { reject(error); return; }
    liveWorkers.add(worker);
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; signal?.removeEventListener?.('abort', relay); fn(value); };
    const relay = () => { try { worker.postMessage('abort'); } catch { /* worker already gone */ } };
    signal?.addEventListener?.('abort', relay, { once: true });
    worker.once('message', (m) => (m?.ok ? finish(resolve, m.result) : finish(reject, new Error('adapter-failed'))));
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', () => { liveWorkers.delete(worker); finish(reject, new Error('adapter exited without a result')); releaseLeakedLock(); });
  });
}

export function createEvaluationCapture({ store, capture = null,
  modulePath = process.env.WEBCHAT_EVALUATION_MODULE,
  timeoutMs = Number(process.env.WEBCHAT_EVALUATION_TIMEOUT_MS || 30000),
  now = () => new Date().toISOString() } = {}) {
  if (!capture && !modulePath) return null;
  // Dispatch no longer waits on this ceiling (runner.send starts the provider beside the capture), so it only bounds how
  // long the message shows evaluationCapture 'pending' before 'missing/timeout'; the adapter can take several seconds.
  const ceiling = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30000) : 30000;
  const resolveAdapter = async () => capture || captureOnWorker(modulePath);
  function status(envelope, detail) {
    try { store.append(envelope.conversationId, 'evaluation.snapshot', { messageId: envelope.messageId, ...detail }, { at: now() }); }
    catch { /* The durable message retains pending: a capture was never confirmed. */ }
  }
  return async function beforeDispatch(envelope) {
    if (envelope.recovery) { status(envelope, { state: 'missing', reason: 'process-interrupted' }); return; }
    if (envelope.contextAvailable === false) { status(envelope, { state: 'missing', reason: 'context-unavailable' }); return; }
    const skipped = captureEligibility(envelope.attribution, envelope.text);
    if (skipped) { status(envelope, { state: 'skipped', reason: skipped }); return; }
    const controller = new AbortController();
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ state: 'missing', reason: 'timeout' }); }, ceiling); });
    const attempt = Promise.resolve().then(resolveAdapter).then(fn => fn(envelope, { signal: controller.signal })).then(result => {
      if (result?.status === 'missing') return { state: 'missing',
        reason: ['memory-busy', 'capture-aborted'].includes(result.reason) ? result.reason : 'adapter-declined' };
      if (typeof result?.snapshotId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.snapshotId)) return { state: 'missing', reason: 'invalid-adapter-result' };
      return { state: 'captured', snapshotId: result.snapshotId,
        consistency: ['runtime-memory-only', 'independent-artifacts', 'caller-barrier'].includes(result.consistency) ? result.consistency : 'independent-artifacts',
        barrierVerifiedByWebchat: false,
        missingScopes: Array.isArray(result.missingScopes) ? result.missingScopes.filter(x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x)).slice(0,32) : [] };
    }).catch(() => ({ state: 'missing', reason: 'adapter-failed' }));
    try { status(envelope, await Promise.race([attempt, timeout])); }
    finally { clearTimeout(timer); }
  };
}
