// Process-level guards for a runner spawned as a child (rev6/pull/pull.mjs, and rev5/pull.mjs as the rollback).
//
// Why: two test-suite runners spawned with a fake model outlived their dead test parent and spun at ~95% CPU for two
// days, ignoring SIGTERM. The uncaught-exception handler wrote to stderr; stderr was a pipe whose reader was gone, so
// the write raised EPIPE; on macOS a pipe write is asynchronous, the stream reports the failure as an 'error' event on
// the next tick, nobody listened on process.stderr, so it became another uncaught exception, whose handler wrote to
// stderr again. The loop lives entirely in the next-tick queue, which never drains, so timers and signal handlers
// never ran either: SIGTERM was queued for ever.
//
// What this does, and what it leaves alone:
// - process.stdout / process.stderr get 'error' listeners. A broken stdio pipe (EPIPE and friends) means whoever
//   reads the runner is gone: it calls `leave(reason)` once, and never writes to the broken stream again.
// - The uncaught-exception / unhandled-rejection handlers keep the runner alive exactly as before, but their report
//   is re-entrancy safe (a throw while reporting is swallowed, not reported), skips a stdio known to be broken, and a
//   storm of them (STORM_LIMIT inside STORM_WINDOW_MS) is treated as a loop and leaves.
// - The parent is watched: if the process was spawned by a real parent (ppid != 1) and that parent dies, the process
//   is reparented and process.ppid changes; that calls `leave`. The live runner's parent is webchat/scripts/relay.mjs,
//   which by design outlives its child (it exits only once the child has exited), so in normal operation this never
//   fires there; when it does, the relay is gone, so stdout has no reader anyway.
// - An IPC channel that disconnects also calls `leave` (only where one exists).
// The caller's `leave` is the runner's own bounded restart path (the same as SIGTERM), so a push already queued is
// handed off or stays pending for the next start, exactly as a signal would leave it.

export const STORM_LIMIT = 200;
export const STORM_WINDOW_MS = 1000;
export const PARENT_POLL_MS = 1000;

const BROKEN_CODES = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'EBADF']);

/** True when an error says the stream's other end is gone (its reader died or the descriptor was closed). */
export function isBrokenPipe(error) {
  return Boolean(error && typeof error === 'object' && BROKEN_CODES.has(error.code));
}

/**
 * Install the guards. `leave(reason)` is called at most once, for a broken stdio, a dead parent, a closed IPC
 * channel or an exception storm; it must not rely on stdout/stderr working. Returns `{ log, stop, state }`.
 */
export function installProcessGuards({
  label,
  leave,
  proc = process,
  stdout = proc.stdout,
  stderr = proc.stderr,
  watchParent = true,
  pollMs = PARENT_POLL_MS,
  stormLimit = STORM_LIMIT,
  stormWindowMs = STORM_WINDOW_MS,
  clock = () => Date.now(),
} = {}) {
  const state = { broken: new Set(), left: null, reporting: false, storm: [] };
  const fire = (reason) => {
    if (state.left) return;
    state.left = reason;
    try { leave(reason); } catch { try { proc.exit(1); } catch { /* nothing left to do */ } }
  };
  const usable = (stream) => stream && !state.broken.has(stream) && !stream.destroyed && stream.writable !== false;

  /** Write one line to stderr if that can still work; never throws, never re-enters itself. */
  const log = (text) => {
    if (state.reporting || !usable(stderr)) return false;
    state.reporting = true;
    try { stderr.write(text.endsWith('\n') ? text : `${text}\n`); return true; } catch (error) {
      if (isBrokenPipe(error)) state.broken.add(stderr);
      return false;
    } finally { state.reporting = false; }
  };

  const onStdioError = (name, stream) => (error) => {
    state.broken.add(stream);
    // Only a broken pipe means the reader is gone; any other stream error is reported (on the other stream, if it
    // still works) and the runner stays up, as it did before.
    if (isBrokenPipe(error)) return fire(`${name} closed (${error.code})`);
    if (name === 'stdout') log(`[${label}] stdout error: ${error?.message || error}`);
    return undefined;
  };
  const stdoutError = onStdioError('stdout', stdout), stderrError = onStdioError('stderr', stderr);
  stdout?.on?.('error', stdoutError);
  stderr?.on?.('error', stderrError);

  const onFault = (kind) => (error) => {
    const at = clock();
    state.storm.push(at);
    while (state.storm.length && at - state.storm[0] > stormWindowMs) state.storm.shift();
    if (state.storm.length >= stormLimit) return fire(`${state.storm.length} ${kind}s in ${stormWindowMs} ms`);
    if (state.reporting) return undefined;
    let said;
    try { said = error instanceof Error ? (error.stack || error.message) : JSON.stringify(error ?? null); } catch { said = String(error); }
    log(`[${label}] ${kind} kept the runner alive: ${String(said).split('\n').slice(0, 6).join(' | ')}`);
    return undefined;
  };
  const uncaught = onFault('uncaught exception'), unhandled = onFault('unhandled rejection');
  proc.on('uncaughtException', uncaught);
  proc.on('unhandledRejection', unhandled);

  let parentTimer = null;
  const firstParent = proc.ppid;
  if (watchParent && firstParent && firstParent !== 1) {
    parentTimer = setInterval(() => { if (proc.ppid !== firstParent) fire(`parent ${firstParent} died`); }, pollMs);
    parentTimer.unref?.();
  }
  const disconnected = () => fire('ipc channel closed');
  if (typeof proc.send === 'function') proc.on('disconnect', disconnected);

  const stop = () => {
    clearInterval(parentTimer);
    stdout?.off?.('error', stdoutError);
    stderr?.off?.('error', stderrError);
    proc.off('uncaughtException', uncaught);
    proc.off('unhandledRejection', unhandled);
    proc.off('disconnect', disconnected);
  };
  return { log, stop, state };
}
