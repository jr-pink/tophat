// Keeps the repository's vendored webchat (packages/webchat, packages/runner, ASSEMBLY.json) on its upstream, so the public demo follows the main app.
// Run by `tophat-demo release --revendor` (the LaunchAgent md.tophat.demo-release, every 5 minutes) just before it publishes; the commit made here
// fires the post-commit hook, which publishes it.
//
// One run, in order:
//   1. a scratch directory holds clean checkouts of the upstream's HEAD and of this repository's HEAD: only committed upstream work is vendored,
//      whatever any agent has half-edited in the working trees, and a failed run leaves this working tree exactly as it was;
//   2. `scripts/vendor-app.mjs --check` in the scratch copy: any problem, or no drift, ends the run;
//   3. debounce: the newest upstream commit touching the app's entry directories must be at least `quietMs` old;
//   4. `scripts/vendor-app.mjs` in the scratch copy, then the webchat build there: a build that fails ends the run;
//   5. only the files the assembly changed (ASSEMBLY.json, packages/webchat, packages/runner) are written into this working tree, each by
//      temp file + rename, provided none of them has uncommitted edits, then committed with an explicit pathspec so no other dirty file goes in.
// Single writer by construction: only the timer job passes --revendor; launchd never overlaps a job with itself.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts });
const git = (dir, ...args) => sh('git', ['-C', dir, ...args]).trim();
const lastLines = (e) => String(e.stderr || e.stdout || e.message || e).trim().split('\n').slice(-6).join(' | ');
const OWNED = (p) => p === 'ASSEMBLY.json' || p.startsWith('packages/webchat/') || p.startsWith('packages/runner/');

/** Where the upstream app lives, from the repo-local assembly config (never hard-coded here); TOPHAT_UPSTREAM_APP overrides it as vendor-app does. */
export function upstreamOf(repo, env = process.env) {
  const config = JSON.parse(readFileSync(path.join(repo, 'scripts/vendor-app.upstream.json'), 'utf8'));
  const app = realpathSync(env[config.root.env] || String(config.root.path).replace(/^~(?=\/|$)/, os.homedir()));
  const top = git(app, 'rev-parse', '--show-toplevel');
  const sub = path.relative(top, app).split(path.sep).join('/');
  // the quiet window counts commits to what the assembly reads: the top two path segments of every assembled source (rev6/pull yes, rev6/push no), plus the entry directories
  let sources = [];
  try { sources = Object.values(JSON.parse(readFileSync(path.join(repo, 'ASSEMBLY.json'), 'utf8')).files || {}).map((r) => r.source).filter(Boolean); } catch { /* no manifest yet: entries only */ }
  const names = [...config.entries.map((e) => e.replace(/\/?\*.*$/, '').split('/').slice(0, 2).join('/')), ...sources.map((f) => f.split('/').slice(0, 2).join('/'))];
  const dirs = [...new Set(names)].filter(Boolean).map((d) => (sub ? `${sub}/${d}` : d));
  return { app, top, sub, dirs, envName: config.root.env };
}

export function revendor({ repo, quietMs = 120_000, now = Date.now, node = process.execPath, npm = null, log = console.log, upstream = null, build = true }) {
  const say = (status, reason, extra = {}) => { if (reason) log(`revendor ${status}: ${reason}`); return { status, ...(reason ? { reason } : {}), ...extra }; };
  let branch;
  try { branch = git(repo, 'symbolic-ref', '--short', 'HEAD'); } catch { branch = null; }
  if (branch !== 'main') return say('skipped', `${repo} is not on main (${branch || 'detached'})`);
  let up;
  try { up = upstream || upstreamOf(repo); } catch (e) { return say('skipped', `upstream not readable: ${lastLines(e)}`); }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'tophat-revendor-'));
  try {
    const upClone = path.join(scratch, 'upstream'), repoClone = path.join(scratch, 'repo');
    try {
      sh('git', ['clone', '-q', '--shared', up.top, upClone]);
      sh('git', ['clone', '-q', '--shared', repo, repoClone]);
    } catch (e) { return say('skipped', `could not make the scratch checkouts: ${lastLines(e)}`); }
    const upApp = path.join(upClone, up.sub);
    const env = { ...process.env, PATH: `${path.dirname(node)}:${process.env.PATH}`, [up.envName]: upApp };
    const vendor = (...args) => sh(node, ['scripts/vendor-app.mjs', ...args], { cwd: repoClone, env });

    let check;
    try { check = JSON.parse(vendor('--check')); } catch (e) { return say('skipped', `vendor-app --check failed: ${lastLines(e)}`); }
    if (!check.ok || check.problems?.length) return say('skipped', `vendor-app --check reports problems: ${(check.problems || []).slice(0, 3).join('; ')}`);
    if (!check.upstream_drift) return { status: 'in-sync' };

    const newest = Number(git(upClone, 'log', '-1', '--format=%ct', '--', ...up.dirs.map((d) => d))) * 1000;
    const quietFor = now() - newest;
    if (newest && quietFor < quietMs) return say('waiting', `upstream committed ${Math.round(quietFor / 1000)} s ago, vendoring after ${Math.round(quietMs / 1000)} s of quiet`, { drift: check.upstream_drift });

    // cheap early refusal: someone's uncommitted edits in a file the assembly owns (the late check below covers files it newly creates)
    const owned = ['ASSEMBLY.json', ...Object.keys(JSON.parse(readFileSync(path.join(repo, 'ASSEMBLY.json'), 'utf8')).files || {})];
    const edited = sh('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all', '--', ...owned]).split('\n').filter(Boolean);
    if (edited.length) return say('skipped', `uncommitted edits in assembled files: ${edited.slice(0, 3).join('; ')}`);

    try { vendor(); } catch (e) { return say('skipped', `vendor-app failed: ${lastLines(e)}`); }
    const changed = sh('git', ['-C', repoClone, 'status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean)
      .map((l) => ({ code: l.slice(0, 2), file: l.slice(3) }));
    if (!changed.length) return say('skipped', 'drift reported but the assembly produced no change');
    const stray = changed.filter((c) => !OWNED(c.file));
    if (stray.length) return say('skipped', `the assembly changed files outside ASSEMBLY.json, packages/webchat and packages/runner: ${stray.slice(0, 3).map((c) => c.file).join(', ')}`);

    if (build) {
      symlinkSync(path.join(repo, 'node_modules'), path.join(repoClone, 'node_modules'));
      try { sh(npm || 'npm', ['run', 'build', '-w', '@tophat-md/webchat'], { cwd: repoClone, env }); }
      catch (e) { return say('skipped', `the webchat build failed on the new assembly: ${lastLines(e)}`); }
    }

    // apply to the real working tree: HEAD unmoved, and none of the files carrying someone's uncommitted edits
    const files = changed.map((c) => c.file);
    if (git(repo, 'rev-parse', 'HEAD') !== git(repoClone, 'rev-parse', 'HEAD')) return say('skipped', 'the repository moved during the run; the next run starts again');
    const dirty = sh('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all', '--', ...files]).split('\n').filter(Boolean);
    if (dirty.length) return say('skipped', `uncommitted edits in files the re-vendor writes: ${dirty.slice(0, 3).join('; ')}`);
    for (const c of changed) {
      const dest = path.join(repo, c.file);
      if (c.code.includes('D')) { rmSync(dest, { force: true }); continue; }
      const src = path.join(repoClone, c.file);
      mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.revendor-${process.pid}`;
      writeFileSync(tmp, readFileSync(src), { mode: statSync(src).mode & 0o777 });
      renameSync(tmp, dest);
    }
    const sha = git(up.top, 'rev-parse', '--short=12', 'HEAD');
    const shown = files.filter((f) => f !== 'ASSEMBLY.json');
    const msg = `webchat: re-vendor from the main app at ${sha} (${shown.length} file${shown.length === 1 ? '' : 's'}: ${shown.slice(0, 6).map((f) => path.basename(f)).join(', ')}${shown.length > 6 ? ', ...' : ''})\n\nautomatic: tophat-demo release --revendor. The webchat build passed on this assembly.`;
    try {
      sh('git', ['-C', repo, 'add', '-A', '--', ...files]);
      sh('git', ['-C', repo, 'commit', '-q', '-m', msg, '--', ...files]);
    } catch (e) {
      // put the files back as committed so the next run is not blocked by half a commit
      try { sh('git', ['-C', repo, 'reset', '-q', '--', ...files]); sh('git', ['-C', repo, 'restore', '--', ...files.filter((f) => changed.find((c) => c.file === f && !c.code.includes('?')))]); } catch { /* reported below */ }
      for (const c of changed.filter((x) => x.code.includes('?'))) rmSync(path.join(repo, c.file), { force: true });
      return say('skipped', `commit failed: ${lastLines(e)}`);
    }
    const commit = git(repo, 'rev-parse', 'HEAD');
    log(`revendor committed ${commit.slice(0, 12)} from upstream ${sha}: ${files.length} files`);
    return { status: 'committed', commit, upstream: sha, files: files.length };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
