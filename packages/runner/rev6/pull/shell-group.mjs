// The agent shell's foreground command runs as its own process group, and a timeout or an owner
// interrupt kills the whole group. Until then `execFile(..., {timeout})` SIGTERMed bash alone, so
// whatever bash had started was reparented to launchd and kept running: an 11-minute-old `find
// /Users/example-user /Volumes...` doing 47k disk ops per 5 s while the webchat froze.
import { spawn } from 'node:child_process';

/** Kill a process group, falling back to the leader alone. */
export function killGroup(child, signal = 'SIGKILL') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

/**
 * bash -c COMMAND as its own process group, with execFile's callback shape (error, stdout, stderr). On timeout the whole group is
 * SIGKILLed and the callback's error carries `killed: true`, the shape execFile's own timeout gave, so
 * callers read it unchanged. An interrupt sets `child.interrupted` and calls killGroup(child).
 * A command that finishes on its own keeps whatever it deliberately left running (nohup, restart
 * scripts), as before.
 */
export function runForeground(command, { cwd, env, timeout, maxBuffer = 8 * 1024 * 1024 }, callback) {
  // spawn, not execFile: execFile drops `detached`, so its child never leads a group of its own.
  let timedOut = false, settled = false, size = 0, over = false;
  const out = [], err = [];
  const child = spawn('/bin/bash', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const take = (into) => (chunk) => {
    size += chunk.length;
    if (size > maxBuffer) { if (!over) { over = true; killGroup(child); } return; }
    into.push(chunk);
  };
  child.stdout.on('data', take(out));
  child.stderr.on('data', take(err));
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (timedOut || child.interrupted || over) killGroup(child);
    if (timedOut) error = Object.assign(error || new Error(`killed after ${timeout}ms`), { killed: true });
    else if (over) error = Object.assign(error || new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    callback(error, Buffer.concat(out).toString('utf8'), Buffer.concat(err).toString('utf8'));
  };
  child.once('error', (error) => finish(error));
  child.once('close', (code, signal) => finish(code === 0 ? null : Object.assign(new Error(`Command failed: ${command}`), { code, signal, killed: false })));
  const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeout);
  timer.unref?.();
  return child;
}
