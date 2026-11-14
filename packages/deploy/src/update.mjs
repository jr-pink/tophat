// tophat update: bring an install (a git clone of tophat, usually a fork carrying the owner's own commits) up to the newest
// upstream release without losing local work, and hand anything that breaks to the instance's own agent.
//
// The model: local changes are ideally extensions (they never collide with upstream code); anything else is a commit on the
// fork's branch. An update MERGES the release tag into that branch, so the branch only moves forward (no rebase, no force),
// one merge commit per release. The merge and every check happen in a staging worktree under <paths.state>/update, never in
// the live checkout: the live tree moves only by `git merge --ff-only` onto a staging commit that passed npm test, the
// extension gate, the webchat build and the UI check (update-ui.mjs). A failure leaves the staging tree as it is (conflict
// markers included), writes <state>/update/last.json and posts an automated event into the instance's own webchat
// (`/api/inbound`, the door the intake's wakes use) asking the agent to fix it there and run `tophat update --resume DIR`.
// The next scheduled run resumes the same staging tree, so a fixer's commits are never thrown away by a newer release:
// the newer tag is merged into it too. No lock: staging dirs are unique per run, last.json is written temp+rename, and a
// second run racing the first loses at the --ff-only step (the branch moved), which it reports.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE } from './components.mjs';
import { instanceJobs, loadInstance, resolveRef } from './instance.mjs';
import { missingClientFiles } from './ship.mjs';

export const AUTOMATED = '[Automated event from tophat update; this is not a message from the owner.]';
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
// Git needs an identity to commit; an install made by `git clone` on a fresh machine often has none.
const IDENTITY = ['-c', 'user.name=tophat update', '-c', 'user.email=update@tophat.invalid'];
// ship's build dirs and pointer are machine state, never source: an older .gitignore does not name them, so a snapshot excludes them by pathspec.
export const NOT_SOURCE = ['packages/webchat/build', 'packages/webchat/build.*', 'packages/webchat/build-current', 'packages/webchat/build.ship.lock'].map((p) => `:(exclude)${p}`);
const MIN = 60_000;

export const updateDir = (c) => path.join(c.paths.state, 'update');
export const lastFile = (c) => path.join(updateDir(c), 'last.json');
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const tail = (s, n = 4000) => { const t = String(s || '').trimEnd(); return t.length > n ? `...${t.slice(-n)}` : t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(file, v) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 1) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return v;
}

/** Run one command to completion; the whole output goes to `log` when given. Never throws. */
export function run(cmd, args, { cwd, env = process.env, timeoutMs = 10 * MIN, log } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 << 20, timeout: timeoutMs });
  const out = { status: r.status ?? -1, stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? `\n${r.error.message}` : '') + (r.signal ? `\nkilled by ${r.signal}` : '') };
  if (log) { mkdirSync(path.dirname(log), { recursive: true }); writeFileSync(log, `$ ${[cmd, ...args].join(' ')}\n(cwd ${cwd})\n\n${out.stdout}${out.stderr}`); }
  return out;
}

/** The highest vX.Y.Z of a list of tag names, or null. */
export function latestTag(names) {
  const key = (t) => t.match(TAG).slice(1).map(Number);
  return names.filter((t) => TAG.test(t)).sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).pop() ?? null;
}

/** The brief the fixer agent gets: where, what failed, the log tail, and exactly how to hand back. */
export function fixerBrief(f, { configFile, root }) {
  const resume = `node ${path.join(root, 'packages/deploy/bin/tophat-deploy.mjs')} update --config ${configFile} --resume ${f.staging}`;
  return [AUTOMATED,
    `tophat update to ${f.tag} failed at the ${f.step} step${f.rolledBack ? ' after it was applied; the live checkout was rolled back and is serving the previous release' : '; the live checkout is untouched'}.`,
    f.staging ? `Staging worktree (a git worktree of the live repository, on the merge of ${f.tag}): ${f.staging}` : null,
    `Failing command: ${f.command}${f.cwd ? ` (in ${f.cwd})` : ''}`,
    f.files?.length ? `Conflicted files: ${f.files.join(', ')}` : null,
    f.log ? `Full log: ${f.log}` : null,
    f.ui?.problems?.length ? `UI check problems:\n${f.ui.problems.map((p) => `- ${p}`).join('\n')}${f.ui.shots ? `\nScreenshots (staging beside the current release): ${f.ui.shots}` : ''}` : null,
    `Last lines:\n\`\`\`\n${f.tail || '(no output)'}\n\`\`\``,
    f.staging ? `Fix it in the staging worktree only, never in the live checkout${f.files?.length ? ': resolve every conflict keeping both the local change and the upstream intent (a local change that can live in an extension should move there, so it never collides again), then `git add` and `git commit` to finish the merge' : ''}. Commit your fix there (\`git -C ${f.staging} commit\`), then run:\n  ${resume}\nIt merges anything newer, re-runs every check in that tree and applies the update only when all pass. If the UI check flags a difference upstream intended, look at the screenshots and add --accept-ui.`
      : `Fix the cause, then run: node ${path.join(root, 'packages/deploy/bin/tophat-deploy.mjs')} update --config ${configFile}`,
  ].filter(Boolean).join('\n\n');
}

/** Post the brief into the instance's own webchat as an automated event (loopback, the service token). One post per failure state. */
export async function wakeFixer(c, f, { configFile, root, fetchImpl = fetch }) {
  const token = resolveRef({ file: path.join(c.paths.secrets, 'webchat-service-token') });
  if (!token) return { posted: false, error: 'no webchat-service-token in the instance keyring (is the webchat set up?)' };
  const messageId = `${f.tag}-${createHash('sha256').update(JSON.stringify([f.staging, f.step, f.head, f.command])).digest('hex').slice(0, 20)}`;
  try {
    const r = await fetchImpl(`http://127.0.0.1:${c.ports.webchat}/api/inbound`, { method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: fixerBrief(f, { configFile, root }), source: 'update', messageId, title: `tophat update: ${f.tag} failed at ${f.step}` }) });
    const body = await r.json().catch(() => ({}));
    return r.ok ? { posted: true, conversation: body.id ?? body.conversationId ?? null, duplicate: Boolean(body.duplicate) } : { posted: false, error: `inbound ${r.status}` };
  } catch (e) { return { posted: false, error: String(e.message).slice(0, 160) }; }
}

/**
 * One update run. opts: { configFile, check, dryRun, restart, resume (a staging dir), acceptUi, root (the tophat tree, default the
 * one this module runs from), deps: { run, fetch, now, sleep, wake, ui, build, healthTimeoutMs, platform } }.
 * Returns a report; `ok` false means something failed (and was recorded in last.json, and handed to the fixer unless update.fixer is false).
 */
export async function update(opts = {}) {
  const { configFile, check = false, dryRun = false, restart = true, acceptUi = false, root = WORKSPACE, deps = {} } = opts;
  const c = loadInstance(configFile);
  const u = c.update || {}; // a run by hand works with `update: false` too; that only drops the daily job
  const d = { run, fetch, now: () => new Date(), sleep, healthTimeoutMs: 2 * MIN, platform: process.platform, ...deps };
  const git = (cwd, args, o) => d.run('git', args, { cwd, ...o });
  const ok = (r) => r.status === 0;
  const out = (r) => r.stdout.trim();
  const at = () => d.now().toISOString();
  const report = { instance: c.name, root };
  const record = (extra) => writeJson(lastFile(c), { at: at(), ...report, ...extra });
  const last = readJson(lastFile(c));
  // A transient failure (the network) never overwrites the record of a failed update: that record is how the next run finds its staging tree.
  const note = (extra) => (last?.status === 'failed' ? { at: at(), ...report, ...extra } : record(extra));
  const wake = (f) => (d.wake ?? ((x) => wakeFixer(c, x, { configFile, root, fetchImpl: d.fetch })))(f);

  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (!ok(top) || realpathSync(out(top)) !== realpathSync(root)) return { ok: false, status: 'not_a_clone', ...report, error: `${root} is not a git clone of the tophat repository; install with git clone, README "Install"` };
  const remotes = out(git(root, ['remote'])).split('\n').filter(Boolean);
  const remote = u.remote ?? (remotes.includes('upstream') ? 'upstream' : remotes.includes('origin') ? 'origin' : null);
  if (!remote || !remotes.includes(remote)) return { ok: false, status: 'no_remote', ...report, error: `no git remote ${u.remote ?? 'upstream or origin'} in ${root}` };
  report.remote = remote;
  const fetched = git(root, ['fetch', '--tags', '--quiet', remote], { timeoutMs: 5 * MIN });
  if (!ok(fetched)) return note({ ok: false, status: 'fetch_failed', error: tail(fetched.stderr, 600) });
  const latest = latestTag(out(git(root, ['tag', '-l', 'v*'])).split('\n'));
  if (!latest) return note({ ok: false, status: 'no_release', error: `${remote} has no vX.Y.Z tag` });
  const isAncestor = (a, b, cwd = root) => ok(git(cwd, ['merge-base', '--is-ancestor', a, b]));
  const described = git(root, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD']);
  Object.assign(report, { current: ok(described) ? out(described) : null, latest, behind: Number(out(git(root, ['rev-list', '--count', `HEAD..${latest}`]))) || 0 });
  const upToDate = isAncestor(latest, 'HEAD');
  if (check) return { ok: true, status: upToDate ? 'current' : 'behind', ...report };

  // A failed run's staging tree is resumed by the next run (a fixer may have committed there), unless someone is editing it now.
  let staging = opts.resume ? path.resolve(opts.resume) : null, auto = false;
  if (!staging && last?.status === 'failed' && last.staging && existsSync(last.staging)) {
    if (out(git(last.staging, ['status', '--porcelain', '--', '.', ...NOT_SOURCE]))) {
      // Edits (or conflict markers) in the staging tree are a fix underway: never committed from here. A fixer that was never reached is asked again.
      let fixer = last.fixer;
      if (!fixer?.posted && u.fixer !== false && !dryRun) writeJson(lastFile(c), { ...last, fixer: fixer = await wake(last) });
      return { ok: true, status: 'fix_in_progress', staging: last.staging, fixer, ...report };
    }
    staging = last.staging; auto = true;
  }
  if (!staging && upToDate) return record({ ok: true, status: 'current' });
  report.staging = staging; report.resumed = staging ? (auto ? 'auto' : 'asked') : null;

  // update.command: an instance that deploys releases its own way (a pinned tree, another host) runs that instead of staging here.
  if (u.command) {
    if (dryRun) return { ok: true, status: 'would_run_command', command: [...u.command, latest], ...report };
    const log = path.join(updateDir(c), 'logs', `${latest}-${stamp(d.now())}.command.log`);
    const r = d.run(u.command[0], [...u.command.slice(1), latest], { cwd: root, timeoutMs: 60 * MIN, log });
    if (ok(r)) return record({ ok: true, status: 'updated', via: 'command' });
    return fail({ step: 'command', command: [...u.command, latest].join(' '), cwd: root, log, tail: tail(r.stdout + r.stderr) });
  }

  async function fail(f) {
    const failure = { tag: latest, staging, head: staging && existsSync(staging) ? out(git(staging, ['rev-parse', 'HEAD'])) : null, ...f };
    const fixer = u.fixer === false || dryRun ? null : await wake(failure);
    const rec = { ok: false, status: 'failed', ...failure, fixer };
    return dryRun ? { ...report, ...rec } : record(rec);
  }

  // b. Local work is committed on the live branch first: never stashed, never discarded, and the merge below carries it.
  const snapshot = () => {
    if (!out(git(root, ['status', '--porcelain', '--untracked-files=all', '--', '.', ...NOT_SOURCE]))) return null;
    if (dryRun) return 'uncommitted (a dry run stages HEAD without it)';
    const add = git(root, ['add', '-A', '--', '.', ...NOT_SOURCE]);
    const commit = ok(add) ? git(root, [...IDENTITY, 'commit', '-q', '-m', `local: snapshot before update to ${latest}`]) : add;
    if (!ok(commit)) throw new Error(`could not commit the local changes before updating: ${tail(commit.stderr, 400)}`);
    return out(git(root, ['rev-parse', 'HEAD']));
  };
  try { report.snapshot = snapshot(); } catch (e) { return record({ ok: false, status: 'failed', step: 'snapshot', error: e.message }); }
  const base = out(git(root, ['rev-parse', 'HEAD']));

  // c. Stage: a worktree on HEAD (or the resumed one), then merge the live branch and the release into it.
  const logs = () => `${staging}.logs`;
  if (!staging) {
    staging = report.staging = path.join(updateDir(c), `${latest}-${stamp(d.now())}`);
    mkdirSync(updateDir(c), { recursive: true, mode: 0o700 });
    const w = git(root, ['worktree', 'add', '--detach', staging, 'HEAD']);
    if (!ok(w)) return record({ ok: false, status: 'failed', step: 'stage', error: tail(w.stderr, 600) });
  } else {
    const common = (dir) => { const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']); return ok(r) ? realpathSync(out(r)) : null; };
    if (!existsSync(staging) || common(staging) !== common(root)) return { ok: false, status: 'bad_resume', ...report, error: `${staging} is not a worktree of ${root}` };
    if (ok(git(staging, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) || out(git(staging, ['diff', '--name-only', '--diff-filter=U']))) {
      const files = out(git(staging, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      return fail({ step: 'merge', command: 'git merge (still unfinished: resolve and commit)', cwd: staging, files, tail: out(git(staging, ['status', '--short'])) });
    }
    // An explicit resume commits what the fixer left uncommitted; an automatic one never got here with a dirty tree.
    if (!dryRun && out(git(staging, ['status', '--porcelain', '--', '.', ...NOT_SOURCE]))) {
      git(staging, ['add', '-A', '--', '.', ...NOT_SOURCE]);
      git(staging, [...IDENTITY, 'commit', '-q', '-m', `update: fixes for ${latest}`]);
    }
  }
  for (const ref of [base, latest]) {
    if (isAncestor(ref, 'HEAD', staging)) continue;
    const m = git(staging, [...IDENTITY, 'merge', '--no-edit', '-q', ref], { log: path.join(logs(), 'merge.log') });
    if (!ok(m)) return fail({ step: 'merge', command: `git merge --no-edit ${ref === base ? 'the live branch' : ref}`, cwd: staging, log: path.join(logs(), 'merge.log'),
      files: out(git(staging, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean), tail: tail(m.stdout + m.stderr) });
  }
  const head = out(git(staging, ['rev-parse', 'HEAD']));
  if (head === base) { cleanup(); return record({ ok: true, status: 'current' }); }
  const lockChanged = (a, b) => !ok(git(root, ['diff', '--quiet', a, b, '--', 'package-lock.json']));

  // d. Checks, all in the staging tree.
  const step = (name, cmd, args, o = {}) => { const log = path.join(logs(), `${name}.log`); const r = d.run(cmd, args, { cwd: staging, log, ...o }); return ok(r) ? null : { step: name, command: [cmd, ...args].join(' '), cwd: staging, log, tail: failures(r.stdout + r.stderr) || tail(r.stdout + r.stderr) }; };
  let bad = null;
  if (lockChanged(base, head)) bad = step('install', 'npm', ['ci', '--no-audit', '--no-fund'], { timeoutMs: 30 * MIN });
  else for (const rel of ['node_modules', ...readdirSync(path.join(root, 'packages')).map((p) => path.join('packages', p, 'node_modules'))]) {
    // Same lock: clone the live dependencies (copy-on-write on APFS, reflink where the file system has it) instead of a network install.
    if (bad || !existsSync(path.join(root, rel)) || existsSync(path.join(staging, rel))) continue;
    bad = step('install', 'cp', d.platform === 'darwin' ? ['-c', '-R', '-p', path.join(root, rel), path.join(staging, rel)] : ['-a', '--reflink=auto', path.join(root, rel), path.join(staging, rel)]);
  }
  if (!bad) {
    bad = step('test', 'npm', ['test'], { timeoutMs: 60 * MIN });
    // A timing test can fail once under load (the suite boots real servers and a browser): the failing files get one more run on their
    // own, and only a second failure counts. The first is reported either way.
    const files = bad && [...new Set([...readLog(bad.log, Infinity).matchAll(/^\s*location: '([^']+\.test\.mjs):\d+:\d+'/gm)].map((m) => m[1]))];
    if (files?.length) {
      report.flaky = { files: files.map((f) => [staging, realpathSync(staging)].reduce((x, dir) => (x.startsWith(`${dir}/`) ? x.slice(dir.length + 1) : x), f)), first: bad.tail };
      const again = step('test-again', process.execPath, ['--import', './test/hermetic-env.mjs', '--test', '--test-concurrency=1', ...files], { timeoutMs: 30 * MIN });
      bad = again && { ...again, step: 'test', first: bad.log };
    }
  }
  if (!bad && c.extensions) bad = step('extensions', process.execPath, [path.join(staging, 'packages/deploy/bin/tophat-deploy.mjs'), 'ext', 'check', '--config', configFile]);
  const webchat = c.components.includes('webchat') && existsSync(path.join(staging, 'packages/webchat/package.json'));
  if (!bad && webchat) {
    bad = d.build ? d.build(staging) : step('build', 'npm', ['run', 'build', '-w', '@tophat-md/webchat'], { timeoutMs: 20 * MIN, env: { ...process.env, WEBCHAT_BUILD_OUT: 'build' } });
    const missing = bad ? [] : missingClientFiles(path.join(staging, 'packages/webchat/build'));
    if (missing.length) bad = { step: 'build', command: 'npm run build -w @tophat-md/webchat', cwd: staging, tail: `the server names client files the build lacks: ${missing.slice(0, 10).join(', ')}` };
  }
  if (!bad && webchat) {
    const ui = await (d.ui ?? (async (x) => (await import('./update-ui.mjs')).uiCheck(x)))({ c, staging, root, dir: path.join(logs(), 'ui') });
    report.ui = ui;
    if (!ui.ok && !(acceptUi && ui.problems.every((p) => p.startsWith('looks different')))) bad = { step: 'ui', command: `UI check (${ui.mode})`, cwd: staging, ui, log: ui.log, tail: ui.problems.join('\n') };
  }
  if (bad) return fail(bad);
  if (dryRun) { if (!report.resumed) cleanup(); return { ok: true, status: 'would_update', ...report, head }; }

  // f. Apply: the live branch fast-forwards onto the tested merge, then the instance is shipped, restarted and must answer healthy.
  if (out(git(root, ['rev-parse', 'HEAD'])) !== base || out(git(root, ['status', '--porcelain', '--', '.', ...NOT_SOURCE]))) return fail({ step: 'apply', command: 'git merge --ff-only', cwd: root, tail: 'the live checkout changed while the update was checking; the next run merges it' });
  const ff = git(root, ['merge', '--ff-only', '-q', head]);
  if (!ok(ff)) return fail({ step: 'apply', command: `git merge --ff-only ${head}`, cwd: root, tail: tail(ff.stderr) });
  const healthy = async () => { try { const h = await d.fetch(`http://127.0.0.1:${c.ports.webchat}/api/health`, { signal: AbortSignal.timeout(5000) }); const b = await h.json().catch(() => null); return h.ok && b?.ok !== false ? (b ?? {}) : null; } catch { return null; } };
  const deploy = async (from, to) => {
    const r = {};
    if (lockChanged(from, to)) { const i = d.run('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, timeoutMs: 30 * MIN, log: path.join(logs(), 'live-install.log') }); if (!ok(i)) return { ...r, ok: false, why: 'npm install', tail: tail(i.stderr) }; }
    if (!c.components.includes('webchat') || !restart) return { ...r, ok: true, needs_restart: true };
    const s = d.run(process.execPath, [path.join(root, 'packages/deploy/bin/tophat-deploy.mjs'), 'instance', 'ship', '--config', configFile], { cwd: root, timeoutMs: 20 * MIN, log: path.join(logs(), 'ship.log') });
    try { r.ship = JSON.parse(s.stdout); } catch { r.ship = null; }
    if (!ok(s)) return { ...r, ok: false, why: 'instance ship', tail: tail(s.stdout + s.stderr) };
    r.restarted = []; r.needs_restart = false;
    for (const j of instanceJobs(c, { configFile }).filter((x) => !x.interval && x.job !== 'update')) {
      const target = `gui/${process.getuid?.() ?? 0}/${j.label}`;
      if (d.platform === 'darwin' && ok(d.run('launchctl', ['print', target], { timeoutMs: 10_000 }))) { d.run('launchctl', ['kickstart', '-k', target], { timeoutMs: 30_000 }); r.restarted.push(j.job); }
      else if (j.job === 'webchat') r.needs_restart = true; // not under launchd here: the build is live (ship reloaded it), the server code waits for its next start
    }
    // An instance that was not serving before the update is not expected to serve after it (nothing to compare; nothing restarted it).
    if (!wasHealthy && !r.restarted.includes('webchat')) return { ...r, ok: true, health: { ok: null, why: 'the webchat was not running before the update' } };
    const until = Date.now() + d.healthTimeoutMs;
    for (;;) {
      const h = await healthy();
      if (h) { r.health = { ok: true, build: h.build ?? null }; break; }
      if (Date.now() > until) return { ...r, ok: false, why: 'health', tail: tail(readLog(path.join(c.paths.state, 'logs', 'webchat.err.log'))) || 'no healthy /api/health answer' };
      await d.sleep(2000);
    }
    return { ...r, ok: true };
  };
  const wasHealthy = Boolean(c.components.includes('webchat') && await healthy());
  const live = await deploy(base, head);
  if (!live.ok) {
    // Roll back only what this run did: the branch goes back to the commit it fast-forwarded from, unless someone committed since.
    const rolled = out(git(root, ['rev-parse', 'HEAD'])) === head && ok(git(root, ['reset', '--keep', base]));
    report.rollback = rolled ? await deploy(head, base) : { ok: false, why: 'the branch moved since the fast-forward; not rolled back' };
    return fail({ step: live.why === 'health' ? 'health' : 'deploy', command: live.why, cwd: root, tail: live.tail, rolledBack: rolled, log: path.join(logs(), 'ship.log') });
  }
  cleanup();
  return record({ ok: true, status: 'updated', from: base, to: head, deploy: live });

  function cleanup() {
    git(root, ['worktree', 'remove', '--force', staging]);
    rmSync(staging, { recursive: true, force: true }); rmSync(`${staging}.logs`, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
  }
}
const readLog = (f, n = 6000) => { try { return readFileSync(f, 'utf8').slice(-n); } catch { return ''; } };
/** The failing tests of a node:test (TAP) run, each with the lines that say why; '' when there are none. */
export function failures(text, max = 4000) {
  const lines = String(text).split('\n'), out = [];
  lines.forEach((l, i) => { if (/^\s*not ok \d+/.test(l)) out.push(lines.slice(i, i + 12).filter((x) => !/^\s*(---|\.\.\.|type:|duration_ms:)/.test(x)).join('\n')); });
  const sum = lines.filter((l) => /^# (tests|pass|fail) /.test(l)).join('\n');
  return out.length ? tail(`${out.join('\n')}\n${sum}`, max) : '';
}
