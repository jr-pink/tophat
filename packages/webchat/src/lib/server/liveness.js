/** Proof of life for a webchat served by launchd.
 *
 * Created: 2026-09-30T02:40:00-07:00
 * Updated: 2026-10-31T03:10:00-07:00
 *
 * The fleet monitor reads a job's voice off its log files and off a
 * `<log>.heartbeat` beside them (src/health/readers.mjs, rule 4: "A job's own
 * heartbeat counts as speech").
 *
 * So the server says so itself, and says it by doing the thing it exists to
 * do: every cycle it asks its own `/api/health` over the loopback port it is
 * listening on, and the file is stamped only when that answers. A wedged event
 * loop never fires the timer, a dead listener never answers, and neither
 * writes; nothing here can report health the server does not have.
 *
 * The path is derived from this process's own stdout, so the file lands beside
 * whichever log launchd gave it and the two services need no configuration to
 * tell them apart. A process whose stdout is not a `.log` file (a terminal, a
 * test) gets null and no heartbeat.
 *
 * WHICH DIRECTORIES ARE SEARCHED IS THE WHOLE OF IT, and this is the second
 * time that has been wrong. When this was written the tophat services logged to
 * ~/Library/Logs/tophat; they no longer do. io.tophat.webchat and
 * io.tophat.heartbeat log to <stateDir>/services, and rev6/upkeep/rotate.mjs
 * already rotates that directory, naming it as the one "which neither old
 * rotator covered". This module did not list it, so `beatPath` found no log
 * with stdout's inode, returned null, and the live webchat has been writing no
 * heartbeat at all: silently back to the exact failure the module was written
 * for. The historical directory stays first so anything still logging there
 * keeps its existing path.
 */
import fs from 'node:fs';
import http from 'node:http';

/** One beat a minute: the sweep counts silence in cycles of 900s, so a minute is
 *  fifteen chances to be heard and still one write an hour that costs anything. */
export const BEAT_MS = 60_000;
/** Longer than the watchdog's 2s stall limit, short enough that a beat cannot
 *  overlap the next one. */
export const PROBE_TIMEOUT_MS = 5_000;

const RUNNING = Symbol.for('tophat.webchat.liveness');

/** Where a launchd-run tophat job's logs live, unless the environment names another.
 *  Order is search order; an inode match is unique per filesystem, so a longer list
 *  can only find a log it previously missed. */
export const LOG_DIRS = [
  process.env.TOPHAT_LOG_DIR,
  `${process.env.HOME || ''}/Library/Logs/tophat`,
  `${process.env.TOPHAT_STATE_DIR || `${process.env.HOME || ''}/.local/state/tophat`}/services`
].filter(Boolean);

/**
 * The heartbeat file beside this process's own stdout log, or null when stdout is not one.
 *
 * By inode, not by name. macOS has no /proc: `realpath('/dev/fd/1')` answers
 * `/dev/fd/1` and tells you nothing, which is how the first version of this
 * never wrote a byte. `fstat` on fd 1 gives the device and inode launchd's
 * redirect actually opened, and the one file in the log directory with that
 * pair is this process's own log, whatever the label is called.
 */
export function beatPath({fd = 1, dirs = LOG_DIRS, fstat = fs.fstatSync, stat = fs.statSync, list = fs.readdirSync} = {}) {
  let mine;
  try {
    mine = fstat(fd);
  } catch {
    return null;
  }
  if (!mine || !Number.isFinite(mine.ino) || !mine.ino) return null;
  for (const dir of dirs) {
    let names;
    try {
      names = list(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.log')) continue;
      const file = `${dir}/${name}`;
      let found;
      try {
        found = stat(file);
      } catch {
        continue;
      }
      if (found.ino === mine.ino && found.dev === mine.dev) return file.replace(/\.log$/u, '.heartbeat');
    }
  }
  return null;
}

/** Ask this server's own /api/health over the loopback. Resolves true only on a 2xx. */
export function probeHealth({ port, timeoutMs = PROBE_TIMEOUT_MS, get = http.get } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer) => { if (!settled) { settled = true; resolve(answer); } };
    let request;
    try {
      request = get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (response) => {
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        response.resume();
        response.on('end', () => done(ok));
        response.on('error', () => done(false));
      });
    } catch {
      return done(false);
    }
    request.on('timeout', () => { try { request.destroy(); } catch {  } done(false); });
    request.on('error', () => done(false));
  });
}

/**
 * Start beating. Returns `{path, stop}`, or `{path: null, stop}` when there is
 * no log to beat beside, so a caller never has to branch on the environment.
 * Starting twice stops the earlier one: a hot swap loads a second copy of this
 * module into the same process and two timers writing one file is a lie about
 * how many servers there are.
 */
export function startLiveness({
  port = process.env.PORT,
  path = beatPath(),
  everyMs = BEAT_MS,
  probe = probeHealth,
  write = (file, text) => fs.writeFileSync(file, text),
  now = () => new Date().toISOString(),
  scope = globalThis,
  timer = setInterval,
  clear = clearInterval
} = {}) {
  scope[RUNNING]?.();
  if (!path || !port) {
    scope[RUNNING] = undefined;
    return { path: null, stop: () => {} };
  }
  const beat = async () => {
    let alive = false;
    try {
      alive = await probe({ port });
    } catch {
      alive = false;
    }
    if (!alive) return false;
    try {
      write(path, `${now()}\n`);
      return true;
    } catch {
      return false;
    }
  };
  const handle = timer(() => { void beat(); }, everyMs);
  handle?.unref?.();
  const stop = () => { clear(handle); scope[RUNNING] = undefined; };
  scope[RUNNING] = stop;
  return { path, stop, beat };
}
