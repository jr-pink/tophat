// tophat instance ship: release a new webchat build to a running instance without ending anything.
//
// Never rebuild the directory a server is serving: a vite build empties its out dir first, and the live process
// lazily imports server chunks by hashed name, so every route it had not loaded yet 500s (a live instance, 2026-11-08 21:10 PST,
// `_server.js-Cu5ykVkb.js` gone under a server started 19:46). So a release builds into a fresh `build.<stamp>` beside
// the package, checks it, flips the `build-current` pointer (temp+rename), and SIGHUPs serve.mjs, which re-imports the
// handler from the new directory in the same process: runner children are untouched. Older builds stay on disk (the
// newest `keep`, plus whatever the server was serving before the flip) so a client or process holding old chunk names
// still finds them. A server whose build is pinned (WEBCHAT_BUILD_OUT, from an older `tophat start`) cannot follow the
// pointer; that is reported as needs_restart, and its next start follows the pointer.
//
// Two ships at once used to share the package's `.svelte-kit` output dir, so one build's server half was copied out
// beside the other's client half: the page named `bundle.DQzcrZBv.js`, the client dir held `bundle.DRc_OfiE.js`, and
// every tab showed the "older version" prompt however often it reloaded (2026-11-10 15:25 PST). So each build gets its
// own kit dir, ships take a lock and run one at a time, and a build whose server names a client file it lacks is
// never pointed at.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE } from './components.mjs';
import { loadInstance } from './instance.mjs';
import { POINTER, componentDir, pointedBuild } from './start.mjs';

const stamp = (d = new Date()) => `build.${d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;

/** Run vite into `out`, through a kit dir of its own (`<out>.kit`, removed after). Returns { ok, status, stderr }. */
export function viteBuild({ webchat, out, env = process.env }) {
  const vite = path.join(webchat, 'node_modules', 'vite', 'bin', 'vite.js');
  const kit = `${out}.kit`;
  try {
    const r = spawnSync(process.execPath, [vite, 'build', '--configLoader', 'runner'],
      { cwd: webchat, env: { ...env, WEBCHAT_BUILD_OUT: out, WEBCHAT_KIT_OUT: path.relative(webchat, kit) }, encoding: 'utf8', maxBuffer: 64 << 20 });
    return { ok: r.status === 0, status: r.status, stderr: (r.stderr || '').slice(-4000) };
  } finally { rmSync(kit, { recursive: true, force: true }); }
}

/** Client files the server manifest names that `out/client` lacks. Empty for a whole build (or one with no manifest). */
export function missingClientFiles(out) {
  const chunks = path.join(out, 'server', 'chunks');
  if (!existsSync(chunks)) return [];
  const missing = new Set();
  for (const n of readdirSync(chunks).filter((n) => /^manifest.*\.js$/.test(n))) {
    for (const [, f] of readFileSync(path.join(chunks, n), 'utf8').matchAll(/"(_app\/immutable\/[^"]+)"/g)) {
      if (!existsSync(path.join(out, 'client', f))) missing.add(f);
    }
  }
  return [...missing];
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** One ship at a time per package: wait for a live holder, take over a dead one's lock. Returns a release function. */
export async function shipLock(webchat, { waitMs = 20 * 60_000, pollMs = 1000 } = {}) {
  const file = path.join(webchat, 'build.ship.lock'), until = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return () => { try { if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = Number(readFileSync(file, 'utf8').trim());
      if (!holder || !alive(holder)) { try { unlinkSync(file); } catch {} continue; }
      if (Date.now() > until) return null;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

/** Write `build-current` atomically, naming `dir` relative to the package. */
export function flipPointer(webchat, dir) {
  const file = path.join(webchat, POINTER), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, path.relative(webchat, dir) + '\n');
  renameSync(tmp, file);
}

/** Delete build.* directories past the newest `keep`, never one in `protect`, never `build` itself. */
export function pruneBuilds(webchat, { keep = 3, protect = [] } = {}) {
  const guard = new Set(protect.filter(Boolean).map((d) => path.resolve(d)));
  const dirs = readdirSync(webchat).filter((n) => /^build\.\d/.test(n)).map((n) => path.join(webchat, n))
    .map((d) => ({ d, t: statSync(d).mtimeMs })).sort((a, b) => b.t - a.t).map((e) => e.d);
  const removed = [];
  for (const d of dirs.slice(keep)) if (!guard.has(path.resolve(d))) { rmSync(d, { recursive: true, force: true }); removed.push(path.basename(d)); }
  return removed;
}

async function health(port, fetchImpl) {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function shipWebchat(opts = {}) {
  const c = loadInstance(opts.configFile);
  if (c.webchat?.build) return { ok: false, reason: 'pinned_in_config', build: c.webchat.build };
  const webchat = componentDir('webchat', { root: opts.root ?? WORKSPACE });
  if (!webchat) return { ok: false, reason: 'no_webchat_package' };
  const release = await shipLock(webchat, opts.lock);
  if (!release) return { ok: false, reason: 'another_ship_running' };
  try { return await shipLocked(c, webchat, opts); } finally { release(); }
}

async function shipLocked(c, webchat, { keep = 3, env = process.env, build = viteBuild,
  signal = (pid, s) => process.kill(pid, s), fetchImpl = fetch, timeoutMs = 30_000, now = new Date() } = {}) {
  const out = path.join(webchat, stamp(now));
  if (existsSync(out)) return { ok: false, reason: 'exists', build: out };
  const b = build({ webchat, out, env });
  if (!b.ok || !existsSync(path.join(out, 'handler.js'))) { rmSync(out, { recursive: true, force: true }); return { ok: false, reason: 'build_failed', ...b }; }
  const missing = missingClientFiles(out);
  if (missing.length) { rmSync(out, { recursive: true, force: true }); return { ok: false, reason: 'build_incomplete', missing: missing.slice(0, 20) }; }
  const previous = pointedBuild(webchat);
  const before = await health(c.ports.webchat, fetchImpl);
  flipPointer(webchat, out);
  const result = { ok: true, build: path.basename(out), previous: previous ? path.basename(previous) : null, reloaded: false, needs_restart: false };
  if (before) {
    const pid = Number(String(before.instance || '').split(':')[0]);
    if (before.build === 'build' || !pid) result.needs_restart = true; // pinned (or unknown) server: HUP would be a no-op
    else {
      signal(pid, 'SIGHUP'); // serve.mjs itself (health names its pid), never the `tophat start` wrapper, which HUP kills
      const until = Date.now() + timeoutMs;
      for (;;) {
        const h = await health(c.ports.webchat, fetchImpl);
        if (h?.build === result.build && String(h.instance).startsWith(`${pid}:`)) { result.reloaded = true; break; }
        if (Date.now() > until) { result.ok = false; result.reason = 'reload_not_observed'; result.serving = h?.build ?? null; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  result.pruned = pruneBuilds(webchat, { keep, protect: [out, previous, before?.build && path.join(webchat, before.build)] });
  return result;
}
