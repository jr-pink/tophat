// tophat start: boot an instance's app components from its tophat.instance.json. Today that is the webchat (which starts
// runner children per conversation). Foreground; SIGINT/SIGTERM are forwarded, then SIGKILL after a grace.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE, check, loadManifest } from './components.mjs';
import { credentialEnv, instanceEnv, loadInstance } from './instance.mjs';

/** Where an installed component package lives: the workspace sibling, else node_modules above this file. */
export function componentDir(name, { root = WORKSPACE } = {}) {
  const candidates = [path.join(root, 'packages', name)];
  for (let d = path.dirname(new URL(import.meta.url).pathname); ; d = path.dirname(d)) { candidates.push(path.join(d, 'node_modules/@tophat-md', name)); if (d === path.dirname(d)) break; }
  return candidates.find((d) => { try { return JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8')).name === `@tophat-md/${name}`; } catch { return false; } }) ?? null;
}

/** The pointer serve.mjs follows when no build is pinned: the file `build-current` in the webchat package names a build
 * directory (relative to the package); null when it is absent or names nothing with a handler.js. Same rule as serve.mjs. */
export const POINTER = 'build-current';
export function pointedBuild(webchat) {
  try {
    const named = readFileSync(path.join(webchat, POINTER), 'utf8').trim();
    const dir = named && path.resolve(webchat, named);
    return dir && existsSync(path.join(dir, 'handler.js')) ? dir : null;
  } catch { return null; }
}

/** The session secret, enrolment token and service token the webchat reads; made once per instance, 0600. */
export function ensureSecrets(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = {};
  for (const name of ['webchat-bootstrap-token', 'webchat-session-secret', 'webchat-service-token']) {
    const f = path.join(dir, name);
    if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    out[name] = readFileSync(f, 'utf8').trim();
  }
  return out;
}

const PASS_THROUGH = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'USER', 'SHELL', 'NODE_OPTIONS'];

/** Everything needed to run the webchat for an instance, without starting it. */
export function plan({ configFile, buildDir = null, env = process.env, root = WORKSPACE } = {}) {
  const c = loadInstance(configFile);
  const m = loadManifest();
  const r = check(m, c.components);
  if (!r.ok) throw new Error(`instance ${c.name}: ${r.problems.map((p) => p.message).join('; ')}`);
  if (!c.components.includes('webchat')) return { instance: c, webchat: null };
  const webchat = componentDir('webchat', { root }), runner = componentDir('runner', { root });
  if (!webchat || !runner) throw new Error('webchat and runner are enabled but their packages are not installed');
  // An explicit build (--build, webchat.build) is pinned: serve.mjs gets WEBCHAT_BUILD_OUT and serves only it. Otherwise
  // serve.mjs follows the package's `build-current` pointer, so a release builds into a fresh build.<stamp>, flips the
  // pointer and SIGHUPs the server (ship.mjs): the running process never has its chunks rebuilt under it. On 2026-11-08
  // 21:10 PST a vite build into the pinned `build` deleted chunks a live server still imported; every page 500'd.
  const pinned = buildDir || c.webchat.build || null;
  const build = pinned ? path.resolve(pinned) : (pointedBuild(webchat) ?? path.join(webchat, 'build'));
  if (!existsSync(path.join(build, 'handler.js'))) throw new Error(`no webchat build at ${build}: run \`npm run build -w @tophat-md/webchat\` (or pass --build DIR)`);
  for (const d of [c.paths.state, c.paths.config, c.paths.workspace, path.join(c.paths.state, 'webchat'), path.join(c.paths.state, 'runner')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const secrets = ensureSecrets(c.paths.secrets);
  const base = Object.fromEntries(PASS_THROUGH.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  const childEnv = {
    ...base,
    // The claude provider's SessionStart/UserPromptSubmit hooks run this script; the webchat package ships it.
    TOPHAT_CONTEXT_HOOK: path.join(webchat, 'scripts', 'context-hook.mjs'),
    ...instanceEnv(c, { buildDir: pinned ? build : null }),
    ...credentialEnv(c, { env }),
    TOPHAT_RUNTIME_DIR: runner,
    TOPHAT_RUNNER_RUNTIME_DIR: runner,
    TOPHAT_SECRET_REQUESTS: path.join(c.paths.config, 'secret-requests.json'),
    WEBCHAT_REPO: c.paths.workspace,
    WEBCHAT_RP_ID: c.hosts.public || 'localhost',
    WEBCHAT_SESSION_SECRET: secrets['webchat-session-secret'],
    WEBCHAT_BOOTSTRAP_TOKEN: secrets['webchat-bootstrap-token'],
    UV_THREADPOOL_SIZE: env.UV_THREADPOOL_SIZE || '16',
    WEBCHAT_KEEP_WITHOUT_PARENT: '1',
  };
  return { instance: c, webchat, runner, build, env: childEnv, enrol: path.join(c.paths.secrets, 'webchat-bootstrap-token') };
}

/** Start the instance. With foreground (the CLI) the process follows the child; otherwise the child is returned. */
export async function start({ configFile, buildDir = null, foreground = true, stdio = 'inherit', env = process.env, root = WORKSPACE } = {}) {
  const p = plan({ configFile, buildDir, env, root });
  // Extensions are checked and resolved on every start, so the server loads exactly the set on disk now; a refused one is
  // reported here and in /api/health, and never stops the instance.
  if (p.instance.extensions) {
    const { buildExtensions } = await import('./extensions.mjs');
    const r = await buildExtensions(p.instance, { root });
    console.log(`instance ${p.instance.name}: extensions ${r.order.join(', ') || 'none'}${r.refused.length ? `; refused ${r.refused.map((x) => `${x.id} (${x.code})`).join(', ')}` : ''}`);
  }
  if (!p.webchat) { console.log(`instance ${p.instance.name}: no app component enabled (${p.instance.components.join(', ')}); nothing to start`); return null; }
  if (foreground) console.log(`instance ${p.instance.name}: webchat on ${p.env.ORIGIN}; enrol with the token in ${p.enrol}`);
  const child = spawn(process.execPath, [path.join(p.webchat, 'serve.mjs')], { cwd: p.webchat, env: { ...p.env, WEBCHAT_PARENT_PID: String(process.pid) }, stdio });
  if (!foreground) return child;
  let stopping = false;
  const stop = (signal) => {
    if (stopping) { child.kill('SIGKILL'); return; }
    stopping = true;
    child.kill(signal);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 40_000).unref();
  };
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => stop(s));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return child;
}
