// Heavy synchronous work (big sqlite reads, multi-megabyte JSON.parse, a pile of file reads) holds
// the server's one thread for as long as it runs, and every chat stream, tab and /api/health waits.
// This is the one way to run such work off the thread.
//
// A module declares its jobs at top level with `defineJobs(import.meta.url, { name: fn })` and
// gets back `run(name, ...args)`. `run` starts a worker thread that loads THE SAME MODULE FILE (in
// the built server that is the bundled chunk, so no loose file has to travel with the release; the
// same trick SvelteKit's own fork.js uses), the module's `defineJobs` call sees it is in a worker
// asked for that job, runs it, and posts the result back. Arguments and results are structured-
// cloned (Maps, Sets, Dates survive). app.js already treats a worker thread as "not the server", so
// loading the chunk there boots nothing.
//
// A job costs a worker start (tens of milliseconds of the worker's time, none of the main thread's),
// so this is for work that runs rarely and takes long, not for per-request micro-queries.

import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

export function defineJobs(moduleUrl, jobs) {
  if (!isMainThread && workerData?.tophatJob && workerData.tophatFile === moduleUrl && jobs[workerData.tophatJob]) {
    Promise.resolve()
      .then(() => jobs[workerData.tophatJob](...(workerData.args || [])))
      .then((result) => parentPort.postMessage({ ok: true, result }))
      .catch((error) => parentPort.postMessage({ ok: false, error: String(error?.message || error) }))
      // A job module that left a timer running is still ended, after a grace that an unref'd timer gives.
      .finally(() => { try { parentPort.close(); } catch { /* closed */ } setTimeout(() => process.exit(0), 5_000).unref(); });
  }
  return function run(name, ...args) {
    if (!jobs[name]) return Promise.reject(new Error(`no job ${name}`));
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
      let worker;
      try { worker = new Worker(fileURLToPath(moduleUrl), { workerData: { tophatJob: name, tophatFile: moduleUrl, args }, env: { ...process.env, WEBCHAT_OFFLOAD_WORKER: '1' } }); }
      catch (error) { reject(error); return; }
      worker.once('message', (message) => (message?.ok ? done(resolve, message.result) : done(reject, new Error(message?.error || 'job failed'))));
      worker.once('error', (error) => done(reject, error));
      worker.once('exit', (code) => done(reject, new Error(`job ${name} exited ${code} without a result`)));
    });
  };
}

// A long-lived worker that owns one resource (a SQLite write connection) and answers calls in order.
// defineJobs above starts a thread per job, which is right for rare long work and wrong for a write
// path hit by every tab's heartbeat. `defineService(import.meta.url, name, handlers)` gives back
// `call(op, ...args)`: one worker per service, started on the first call, loading THE SAME MODULE FILE
// (same trick as defineJobs, so the bundled chunk carries it), single-writer by construction because
// every call goes through its one thread in arrival order. Handlers may be sync or async; a sync one
// can block on the disk as long as it likes without touching the HTTP thread. The worker is unref'd
// (it never keeps a process alive) and is restarted on the next call if it dies; calls in flight when
// it dies are rejected, never left hanging.
export function defineService(moduleUrl, name, handlers) {
  if (!isMainThread && workerData?.tophatService === name && workerData.tophatFile === moduleUrl) {
    parentPort.on('message', ({ id, op, args }) => {
      Promise.resolve()
        .then(() => {
          if (typeof handlers[op] !== 'function') throw new Error(`no op ${op} in service ${name}`);
          return handlers[op](...(args || []));
        })
        .then((result) => parentPort.postMessage({ id, ok: true, result }))
        .catch((error) => parentPort.postMessage({ id, ok: false, error: String(error?.message || error), code: error?.code }));
    });
  }
  const key = Symbol.for(`tophat.service.${name}`);
  const state = (globalThis[key] ||= { worker: null, pending: new Map(), nextId: 1, starts: 0 });
  const start = () => {
    const worker = new Worker(fileURLToPath(moduleUrl), {
      workerData: { tophatService: name, tophatFile: moduleUrl },
      env: { ...process.env, WEBCHAT_OFFLOAD_WORKER: '1' }
    });
    worker.unref();
    state.starts += 1;
    worker.on('message', ({ id, ok, result, error, code }) => {
      const entry = state.pending.get(id);
      if (!entry) return;
      state.pending.delete(id);
      if (!state.pending.size) worker.unref();
      if (ok) entry.resolve(result);
      else entry.reject(Object.assign(new Error(error), code ? { code } : {}));
    });
    const fail = (why) => {
      if (state.worker === worker) state.worker = null;
      for (const entry of state.pending.values()) entry.reject(new Error(`service ${name} worker ${why}`));
      state.pending.clear();
    };
    worker.on('error', (error) => fail(`failed: ${error?.message || error}`));
    worker.on('exit', (exitCode) => fail(`exited ${exitCode}`));
    return worker;
  };
  return function call(op, ...args) {
    return new Promise((resolve, reject) => {
      try {
        if (!state.worker) state.worker = start();
        const id = state.nextId++;
        state.pending.set(id, { resolve, reject });
        // Ref'd while a call is outstanding, so an awaited call is never cut off by an idle event loop.
        state.worker.ref();
        state.worker.postMessage({ id, op, args });
      } catch (error) { reject(error); }
    });
  };
}

/** Stop a service's worker (tests, shutdown); the next call starts a fresh one. */
export async function stopService(name) {
  const state = globalThis[Symbol.for(`tophat.service.${name}`)];
  const worker = state?.worker;
  if (!worker) return;
  state.worker = null;
  await worker.terminate();
}
