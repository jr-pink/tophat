// Running an instance in the background: start, stop, status, health, and the release pointer.
//
// No supervisor and no lock file. One instance owns one directory, `<paths.state>/run`, holding the record of the
// process it started (`webchat.json`, written temp+rename) and the release pointer (`release.json`). Liveness is the
// kernel's answer to `kill(pid, 0)`, never a claim in the file; a record whose process is gone is stale and is
// replaced, so a crash never blocks the next start. `tophat instance unit` is still how an instance survives a reboot;
// this is what a person (or a deploy script) uses by hand.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadInstance } from './instance.mjs';
import { WORKSPACE } from './components.mjs';
import { plan } from './start.mjs';

export const runDir = (c) => path.join(c.paths.state, 'run');
const recordFile = (c) => path.join(runDir(c), 'webchat.json');
export const releaseFile = (c) => path.join(runDir(c), 'release.json');
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

/** The record of the process this instance started, or null when there is none or it has gone. */
export function running(c) {
  const rec = readJson(recordFile(c));
  if (!rec || !alive(rec.pid)) return null;
  return rec;
}

/** The release pointer: which build this instance serves. `set` writes it. */
export function release(c, set = null) {
  if (set) return writeJson(releaseFile(c), { build: path.resolve(set), at: new Date().toISOString() });
  return readJson(releaseFile(c));
}

/**
 * Start the instance in the background. The child is detached with its own session, so it outlives this process;
 * its output goes to `<paths.state>/logs/webchat.log`. `spec` (bin, args, cwd, env) overrides what is started.
 */
export function startInstance({ configFile, buildDir = null, env = process.env, root = WORKSPACE, spec = null } = {}) {
  const c = loadInstance(configFile);
  const already = running(c);
  if (already) return { ok: false, reason: 'already_running', instance: c.name, ...already };
  const pointer = buildDir ? null : release(c);
  const p = spec ? null : plan({ configFile, buildDir: buildDir || pointer?.build || null, env, root });
  if (p && !p.webchat) return { ok: false, reason: 'no_app_component', instance: c.name, components: c.components };
  const log = logFile(c);
  mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const fd = openSync(log, 'a');
  const run = spec ?? { bin: process.execPath, args: [path.join(p.webchat, 'serve.mjs')], cwd: p.webchat, env: p.env };
  const child = spawn(run.bin, run.args, { cwd: run.cwd, env: run.env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  const build = p ? p.build : (run.env?.TOPHAT_BUILD_DIR ?? null);
  if (build) release(c, build);
  const rec = writeJson(recordFile(c), { instance: c.name, pid: child.pid, port: Number(c.ports.webchat), origin: (p ?? { env: run.env ?? {} }).env?.ORIGIN ?? null,
    build, config: path.resolve(configFile), log, startedAt: new Date().toISOString() });
  return { ok: true, ...rec };
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

/** What is running, what release it serves, where its log is. */
export function statusInstance({ configFile } = {}) {
  const c = loadInstance(configFile);
  const rec = readJson(recordFile(c)), live = rec ? alive(rec.pid) : false;
  const rel = release(c);
  return { instance: c.name, running: live, pid: live ? rec.pid : null, since: live ? rec.startedAt : null,
    stale_record: Boolean(rec && !live), port: Number(c.ports.webchat), origin: rec?.origin ?? null,
    release: rel?.build ?? null, release_at: rel?.at ?? null, log: logFile(c), state: c.paths.state };
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
