// How the public demo stays on main. Two halves, one mechanism:
//
//   release  (the maintainer's machine, run by the post-commit hook and a safety timer): when the repository's main has moved,
//            export the committed tree, build the chat app from it, and publish the result as /Users/Shared/tophat-demo/releases/<sha>
//            with `current` pointing at it. Only committed work is ever published.
//   update   (the demo user, a LaunchDaemon every minute): when `current` is not what the demo root holds, copy it into the root
//            (the root's node_modules and the instance's state stay), regenerate the things derived from the sources (the memory
//            graph widget, the agent's standing context), and restart the demo's own processes. launchd brings them back.
//
// `check` fails (exit 1) when the live demo is not on the repository's main, which is what the timer's log and `tophat-demo check`
// in any shell report. Nothing here touches any other service on the machine.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs';
import path from 'node:path';

export const RELEASES = '/Users/Shared/tophat-demo/releases';
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

export const headOf = (repo) => sh('git', ['-C', repo, 'rev-parse', 'HEAD']).trim();
export const currentOf = (dir = RELEASES) => { try { return readFileSync(path.join(dir, 'current', '.sha'), 'utf8').trim(); } catch { return null; } };

/** Build and publish a release of the repository's committed HEAD. Returns { sha, built } (built false when `current` already is it). */
export function release({ repo, out = RELEASES, node = process.execPath, npm = null, log = console.log }) {
  const sha = headOf(repo);
  if (currentOf(out) === sha) return { sha, built: false };
  mkdirSync(out, { recursive: true, mode: 0o755 });
  // one build at a time (the commit hook and the timer can both fire): a directory is the atomic claim, a dead owner's is taken over
  const claim = path.join(out, '.releasing');
  try { mkdirSync(claim); } catch {
    let owner = 0; try { owner = Number(readFileSync(path.join(claim, 'pid'), 'utf8')); } catch { /* no owner file yet */ }
    let alive = false; try { process.kill(owner, 0); alive = owner > 0; } catch { /* dead */ }
    if (alive) return { sha, built: false, busy: true };
    rmSync(claim, { recursive: true, force: true }); mkdirSync(claim);
  }
  writeFileSync(path.join(claim, 'pid'), String(process.pid));
  try { return build(); } finally { rmSync(claim, { recursive: true, force: true }); }
  function build() {
  const tmp = path.join(out, `.build-${sha.slice(0, 12)}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  sh('sh', ['-c', `git -C '${repo}' archive HEAD | tar -x -C '${tmp}'`]);
  // the build needs the repository's installed dependencies; link them rather than installing again
  symlinkSync(path.join(repo, 'node_modules'), path.join(tmp, 'node_modules'));
  log(`building ${sha.slice(0, 12)}`);
  sh(npm || 'npm', ['run', 'build', '-w', '@tophat-md/webchat'], { cwd: tmp, env: { ...process.env, PATH: `${path.dirname(node)}:${process.env.PATH}` }, maxBuffer: 64 * 1024 * 1024 });
  unlinkSync(path.join(tmp, 'node_modules'));
  rmSync(path.join(tmp, 'packages/webchat/.svelte-kit'), { recursive: true, force: true });
  writeFileSync(path.join(tmp, '.sha'), sha + '\n');
  writeFileSync(path.join(tmp, '.lock'), sh('shasum', ['-a', '256', path.join(tmp, 'package-lock.json')]).split(' ')[0] + '\n');
  const final = path.join(out, sha);
  rmSync(final, { recursive: true, force: true });
  renameSync(tmp, final);
  sh('chmod', ['-R', 'a+rX', final]);
  const link = path.join(out, `.current-${process.pid}`);
  symlinkSync(sha, link);
  renameSync(link, path.join(out, 'current')); // atomic: the demo side never sees a half-published release
  for (const d of readdirSync(out).filter((n) => /^[0-9a-f]{40}$/.test(n) && n !== sha).sort((a, b) => lstatSync(path.join(out, b)).mtimeMs - lstatSync(path.join(out, a)).mtimeMs).slice(2)) rmSync(path.join(out, d), { recursive: true, force: true });
  return { sha, built: true };
  }
}

/** A copy of a workspace package installed under another package's node_modules shadows the workspace link at the root, so
 *  the package keeps resolving to the old copy: runner/node_modules/@tophat-md/linknotes at 0.1.0 lacked the `./hybrid` export the
 *  runner imports, and every memory search failed. Only real directories go; links are left. */
export function dropShadowedWorkspacePackages(tree) {
  const packages = path.join(tree, 'packages');
  if (!existsSync(packages)) return [];
  const names = [];
  for (const dir of readdirSync(packages)) { try { names.push(JSON.parse(readFileSync(path.join(packages, dir, 'package.json'), 'utf8')).name); } catch { /* not a package */ } }
  const dropped = [];
  for (const dir of readdirSync(packages)) for (const name of names.filter(Boolean)) {
    const copy = path.join(packages, dir, 'node_modules', name);
    if (existsSync(copy) && !lstatSync(copy).isSymbolicLink()) { rmSync(copy, { recursive: true, force: true }); dropped.push(path.relative(tree, copy)); }
  }
  return dropped;
}

/** The demo user's side: install `current` into the root when it differs. Returns { installed, sha }. */
export function update({ root, out = RELEASES, stateFile = path.join(root, '.demo-sha'), log = console.log, derive = () => {}, restart = () => {}, preflight = () => {}, after = null }) {
  const want = currentOf(out);
  if (!want) throw new Error(`no published release in ${out}`);
  const have = existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : null;
  if (have === want) return { installed: false, sha: want };
  const src = path.join(out, 'current');
  const lockNew = readFileSync(path.join(src, '.lock'), 'utf8').trim();
  const lockFile = path.join(root, '.lock');
  const lockOld = existsSync(lockFile) ? readFileSync(lockFile, 'utf8').trim() : null;
  if (lockOld && lockOld !== lockNew) throw new Error('package-lock.json changed: the demo root needs its dependencies refreshed (npm ci) before this release can be installed');
  log(`installing ${want.slice(0, 12)} (was ${have ? have.slice(0, 12) : 'none'})`);
  const staging = `${root}.incoming`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(src, staging, { recursive: true, dereference: true });
  // each package keeps its own installed dependencies; the release brings none
  if (existsSync(path.join(root, 'packages'))) for (const pkg of readdirSync(path.join(root, 'packages'))) {
    const old = path.join(root, 'packages', pkg, 'node_modules');
    if (existsSync(old) && existsSync(path.join(staging, 'packages', pkg))) { rmSync(path.join(staging, 'packages', pkg, 'node_modules'), { recursive: true, force: true }); renameSync(old, path.join(staging, 'packages', pkg, 'node_modules')); }
  }
  dropShadowedWorkspacePackages(staging);
  // Before anything of the running demo is touched: does the new release load at all, with the dependencies the root has? A release that cannot
  // (a package it imports is not installed) is refused here and the running one keeps serving; installing it first once cost 71 s of 502s.
  try { preflight(staging); } catch (e) { rmSync(staging, { recursive: true, force: true }); throw new Error(`release ${want.slice(0, 12)} does not load, not installed: ${String(e.message || e).split('\n').find((l) => /Error/.test(l)) || e}`); }
  // swap the release's files in over the root, keeping what is the root's own
  for (const name of readdirSync(staging)) {
    if (name === 'node_modules') continue;
    const dest = path.join(root, name);
    rmSync(dest, { recursive: true, force: true });
    renameSync(path.join(staging, name), dest);
  }
  rmSync(staging, { recursive: true, force: true });
  writeFileSync(lockFile, lockNew + '\n');
  derive();
  writeFileSync(stateFile, want + '\n');
  restart();
  const waiting = after ? after(want) : null; // async: the caller may await it
  return { installed: true, sha: want, waiting };
}
