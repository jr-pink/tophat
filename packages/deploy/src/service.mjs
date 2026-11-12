// Running an instance in the background: start, stop, status, health, and the release pointer.
//
// No supervisor and no lock file. Whether the instance runs, which pid it is and which build it serves are read from the
// live process, never from a file: the process listening on the instance's loopback port, its parent chain, and its
// /api/health answer (which names its own pid and build). An instance is started by `instance start` below, by
// `tophat start` under a unit, or by hand, and only the first wrote a record; on 2026-11-09 01:13 PST status read that
// record alone and said running:false, pid null for a unit-started instance serving build.20261109-091351. The record
// (`<paths.state>/run/webchat.json`, temp+rename) is kept only so `stop` signals the process `start` spawned; a record
// whose process is gone is stale and is replaced, so a crash never blocks the next start. The release a start uses
// without --build is the webchat's `build-current` pointer, the one `instance ship` flips and serve.mjs follows.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { instanceEnv, loadInstance } from './instance.mjs';
import { WORKSPACE } from './components.mjs';
import { POINTER, componentDir, plan, pointedBuild } from './start.mjs';
import { flipPointer } from './ship.mjs';

export const runDir = (c) => path.join(c.paths.state, 'run');
const recordFile = (c) => path.join(runDir(c), 'webchat.json');
export const logFile = (c) => path.join(c.paths.state, 'logs', 'webchat.log');

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return value;
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
export function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** The pid listening on 127.0.0.1:port (lsof), or null. */
export function listenerPid(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000 });
  const pid = Number(String(r.stdout || '').trim().split('\n')[0]);
  return pid > 0 ? pid : null;
}

/** The parent chain of `pid`, nearest first, up to (not including) pid 1: [{ pid, ppid, command }]. */
export function ancestry(pid) {
  const out = [];
  for (let p = pid, i = 0; p > 1 && i < 16; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(p)], { encoding: 'utf8', timeout: 5000 });
    const m = String(r.stdout || '').trim().match(/^(\d+)\s+(.*)$/s);
    if (!m) break;
    out.push({ pid: p, ppid: Number(m[1]), command: m[2].slice(0, 300) });
    p = Number(m[1]);
  }
  return out;
}

/** The process serving this instance, from the port and the process table (no network): { pid, command } or null. A
 * listener is this instance's when it runs this instance's webchat serve.mjs, or (checked by statusInstance) when its
 * health answer names this instance and its pid. */
export function running(c) {
  const pid = listenerPid(c.ports.webchat);
  if (!pid) return null;
  return { pid, command: ancestry(pid)[0]?.command ?? null };
}

/** The release pointer: the webchat build a start without --build serves (`build-current`). `set` flips it. */
export function release(c, set = null, { root = WORKSPACE } = {}) {
  const webchat = componentDir('webchat', { root });
  if (!webchat) return null;
  if (set) flipPointer(webchat, path.resolve(set));
  const build = pointedBuild(webchat);
  return build ? { build, pointer: path.join(webchat, POINTER) } : null;
}

/**
 * Start the instance in the background. The child is detached with its own session, so it outlives this process;
 * its output goes to `<paths.state>/logs/webchat.log`. `spec` (bin, args, cwd, env) overrides what is started.
 */
export function startInstance({ configFile, buildDir = null, env = process.env, root = WORKSPACE, spec = null } = {}) {
  const c = loadInstance(configFile);
  const prior = readJson(recordFile(c));
  if (prior && alive(prior.pid)) return { ok: false, reason: 'already_running', instance: c.name, ...prior };
  const holder = running(c);
  if (holder) return { ok: false, reason: 'port_in_use', instance: c.name, port: Number(c.ports.webchat), ...holder };
  const p = spec ? null : plan({ configFile, buildDir, env, root });
  if (p && !p.webchat) return { ok: false, reason: 'no_app_component', instance: c.name, components: c.components };
  // Extensions are resolved before the server starts, by the same step `tophat start` and `tophat ext build` run (a
  // child process, so this function stays synchronous); a refusal is reported in the build output and /api/health.
  let extensions = null;
  if (p && c.extensions) {
    try { extensions = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../bin/tophat-deploy.mjs', import.meta.url)), 'ext', 'build', '--config', path.resolve(configFile)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch (e) { try { extensions = JSON.parse(String(e.stdout || '')); } catch { return { ok: false, reason: 'extensions_build_failed', instance: c.name, error: String(e.stderr || e.message).slice(0, 500) }; } }
  }
  const log = logFile(c);
  mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const fd = openSync(log, 'a');
  const run = spec ?? { bin: process.execPath, args: [path.join(p.webchat, 'serve.mjs')], cwd: p.webchat, env: p.env };
  const child = spawn(run.bin, run.args, { cwd: run.cwd, env: run.env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  const build = p ? p.build : (run.env?.TOPHAT_BUILD_DIR ?? null);
  const rec = writeJson(recordFile(c), { instance: c.name, pid: child.pid, port: Number(c.ports.webchat), origin: (p ?? { env: run.env ?? {} }).env?.ORIGIN ?? null,
    build, config: path.resolve(configFile), log, startedAt: new Date().toISOString() });
  return { ok: true, ...rec, ...(extensions ? { extensions: { order: extensions.order, refused: extensions.refused } } : {}) };
}

/** Stop it: SIGTERM, then SIGKILL after `graceMs`. Idempotent; stopping what is not running is ok:true, stopped:false. */
export async function stopInstance({ configFile, graceMs = 10_000, signal = 'SIGTERM' } = {}) {
  const c = loadInstance(configFile);
  const rec = readJson(recordFile(c));
  if (!rec || !alive(rec.pid)) { rmSync(recordFile(c), { force: true }); return { ok: true, stopped: false, reason: rec ? 'not_running' : 'no_record', instance: c.name }; }
  try { process.kill(rec.pid, signal); } catch { /* raced us */ }
  const until = Date.now() + graceMs;
  while (Date.now() < until && alive(rec.pid)) await new Promise((r) => setTimeout(r, 100));
  let killed = false;
  if (alive(rec.pid)) { try { process.kill(rec.pid, 'SIGKILL'); killed = true; } catch { /* gone */ } }
  for (let i = 0; i < 50 && alive(rec.pid); i++) await new Promise((r) => setTimeout(r, 100));
  rmSync(recordFile(c), { force: true });
  return { ok: !alive(rec.pid), stopped: true, killed, pid: rec.pid, instance: c.name };
}

/**
 * What is running, from the live process: the pid listening on the port, its parent chain (the unit or `tophat start`
 * wrapper above it), and its health answer, which names its pid and the build it serves. `running` is true only when the
 * listener is this instance: its health names this instance and that pid, or (health not answering, a wedged server)
 * its command is this instance's webchat serve.mjs. Anything else on the port is `port_holder`, never running.
 */
export async function statusInstance({ configFile, timeoutMs = 3000, root = WORKSPACE } = {}) {
  const c = loadInstance(configFile);
  const rec = readJson(recordFile(c));
  const holder = running(c);
  const h = holder ? await healthInstance({ configFile, timeoutMs }) : null;
  const healthPid = Number(String(h?.body?.instance || '').split(':')[0]) || null;
  const webchat = componentDir('webchat', { root });
  const serveFile = webchat && path.join(webchat, 'serve.mjs');
  const ours = Boolean(holder) && (h?.ok
    ? (h.body?.product == null || h.body.product === c.name) && (!healthPid || healthPid === holder.pid)
    : Boolean(serveFile && holder.command?.includes(serveFile)));
  const pid = ours ? holder.pid : null;
  const rel = release(c, null, { root });
  return { instance: c.name, running: ours, pid, healthy: ours && Boolean(h?.ok),
    build: ours ? (h?.body?.build ?? null) : null, release: rel?.build ? path.basename(rel.build) : null,
    ancestry: pid ? ancestry(pid) : [], port_holder: holder && !ours ? holder : null,
    stale_record: Boolean(rec && !alive(rec.pid)), port: Number(c.ports.webchat), origin: instanceEnv(c).ORIGIN,
    log: logFile(c), state: c.paths.state };
}

/** GET /api/health on the loopback port the instance answers on. */
export async function healthInstance({ configFile, timeoutMs = 5000 } = {}) {
  const c = loadInstance(configFile);
  const url = `http://127.0.0.1:${c.ports.webchat}/api/health`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const body = await r.json().catch(() => null);
    return { ok: r.ok && body?.ok !== false, status: r.status, url, body };
  } catch (e) {
    return { ok: false, status: null, url, error: String(e?.message || e) };
  } finally { clearTimeout(timer); }
}
