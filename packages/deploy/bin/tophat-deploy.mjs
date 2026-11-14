#!/usr/bin/env node
// tophat-deploy: the instance side of tophat.
//   tophat components list [--json]                 every component, its package, dependencies and whether it is present
//   tophat components tree [ID...]                  dependency tree
//   tophat components check [--config FILE | ID...] every dependency of an enabled component is enabled (exit 1 if not)
//   tophat start --config FILE [--build DIR]         boot the instance's enabled app components (webchat) in the foreground
//   tophat instance env --config FILE                the environment an instance hands its components (no secret values)
//   tophat instance start|stop|status|health --config FILE   run the instance in the background, and ask after it
//   tophat instance release --config FILE [--set DIR]         the webchat build-current pointer (printed, or flipped)
//   tophat instance ship --config FILE [--keep N]     build the webchat into a fresh build.<stamp>, flip build-current and
//                                                    SIGHUP the running server (same process, children untouched); never
//                                                    rebuild the directory a server is serving
//   tophat instance unit --config FILE [--kind launchd|systemd] [--job NAME]   a service unit that keeps one job running (printed;
//                                                    default the webchat; `instance jobs` names every job the instance needs)
//   tophat instance jobs --config FILE [--write DIR]  every job the enabled components imply (webchat, intake, fast-proxy): listed, or with
//                                                    --write their launchd units written as DIR/<label>.plist (never loaded)
//   tophat instance fast-proxy --config FILE          the loopback header proxy for a fast model behind a workspace-scoped key (foreground)
//   tophat instance sync --config FILE [--forever [--every S]]   one hub round for the runner's replica (the instance file's hub
//                                                    block); --forever keeps one round every S seconds (default 60)
//   tophat instance join [NAME] --config FILE [--hub URL] [--user NAME]   opt in to a group someone else made (default tophat-users,
//                                                    on https://hub.tophat.md): writes scope.join, the hub block and a unique replica
//                                                    user into the instance file; prints the device public key for the group's admin
//   tophat instance group create NAME --config FILE   make a group this instance administers (scope.groups), then sync
//   tophat instance group add NAME USER [--role read|write|admin] --config FILE   admin: add a member, wrap the key to their devices
//   tophat ext list|check|build --config FILE          the instance's extensions: found, gate-checked (exit 1 on a refusal),
//                                                    or resolved for the server (<state>/extensions/resolved.json + bin/)
//   tophat ext run-job --config FILE ID JOB           run one extension job once (what its interval unit runs)
//   tophat instance intake --config FILE [--force] [--forever [--tick S]]   the intake (sources -> replica -> derive) when
//                                                    due on the instance file's intake.everySeconds; --force runs it now
//   tophat update --config FILE [--check] [--dry-run] [--no-restart] [--resume DIR] [--accept-ui]   bring this clone up to the newest
//                                                    upstream release tag: merge it into the branch in a staging worktree under
//                                                    <paths.state>/update, run npm test, the extension gate, the webchat build and a UI
//                                                    check there, then fast-forward, ship and restart; a failure is handed to the
//                                                    instance's own agent (an automated event) to fix in that worktree and --resume.
//                                                    --check only reports { current, latest, behind }. The `update` job runs it daily
//                                                    by default (update.everySeconds; update: false turns the job off)
import path from 'node:path';
import { WORKSPACE, check, complete, list, loadManifest, tree } from '../src/components.mjs';
import { instanceEnv, instanceJobs, loadInstance, serviceUnit } from '../src/instance.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
const die = (msg, code = 2) => { console.error(`tophat: ${msg}`); process.exit(code); };

const [cmd, sub] = [args.shift(), args[0]];
try {
  if (cmd === 'components') {
    args.shift();
    const m = loadManifest();
    if (sub === 'list' || !sub) {
      const rows = list(m);
      if (has('--json')) out(rows);
      else out(rows.map((r) => `${r.present ? ' ' : '-'} ${r.id.padEnd(10)} ${r.package.padEnd(22)} ${r.optional ? 'optional' : 'required'} ${r.removable ? 'removable' : '         '} needs: ${r.depends.join(', ') || '-'}`).join('\n'));
    } else if (sub === 'tree') out(tree(m, args.length ? args : null));
    else if (sub === 'check') {
      const file = flag('--config');
      const enabled = file ? loadInstance(file).components : args;
      if (!enabled.length) die('components check: pass --config FILE or component ids');
      const r = check(m, enabled, { root: has('--present') ? WORKSPACE : null });
      out({ ...r, enabled, suggestion: r.ok ? undefined : complete(m, enabled.filter((id) => m.components.some((c) => c.id === id))) });
      process.exit(r.ok ? 0 : 1);
    } else die(`components: unknown sub-command ${sub}`);
  } else if (cmd === 'instance' && sub === 'env') {
    args.shift();
    const c = loadInstance(flag('--config'));
    out(instanceEnv(c));
  } else if (cmd === 'instance' && ['start', 'stop', 'status', 'health', 'release'].includes(sub)) {
    args.shift();
    const file = path.resolve(flag('--config') || die(`instance ${sub}: --config FILE is required`));
    const { healthInstance, release, startInstance, statusInstance, stopInstance } = await import('../src/service.mjs');
    if (sub === 'start') { const r = startInstance({ configFile: file, buildDir: flag('--build') }); out(r); process.exit(r.ok ? 0 : 1); }
    if (sub === 'stop') { const r = await stopInstance({ configFile: file }); out(r); process.exit(r.ok ? 0 : 1); }
    if (sub === 'status') { const r = await statusInstance({ configFile: file }); out(r); process.exit(r.running ? 0 : 1); }
    if (sub === 'health') { const r = await healthInstance({ configFile: file }); out(r); process.exit(r.ok ? 0 : 1); }
    const { loadInstance: li } = await import('../src/instance.mjs');
    const set = flag('--set');
    out(release(li(file), set ? path.resolve(set) : null) ?? { build: null });
  } else if (cmd === 'instance' && sub === 'ship') {
    args.shift();
    const file = path.resolve(flag('--config') || die('instance ship: --config FILE is required'));
    const { shipWebchat } = await import('../src/ship.mjs');
    const r = await shipWebchat({ configFile: file, keep: Number(flag('--keep') || 3) });
    out(r); process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'instance' && sub === 'sync') {
    args.shift();
    const c = loadInstance(path.resolve(flag('--config') || die('instance sync: --config FILE is required')));
    const { componentDir } = await import('../src/start.mjs');
    const runner = componentDir('runner') || die('instance sync: the runner package is not installed');
    const { syncStore } = await import(path.join(runner, 'store/memory.mjs'));
    const env = instanceEnv(c);
    const forever = has('--forever'), every = Number(flag('--every') || 60) * 1000;
    if (!forever) { const r = await syncStore(env.TOPHAT_RUNNER_DB, env); out(r.result); process.exit(r.code); }
    // A refused round (no token yet, hub down) is retried: the token arrives later, and a pending group key arrives with a sync.
    for (let last = ''; ;) {
      try { const r = await syncStore(env.TOPHAT_RUNNER_DB, env); const line = JSON.stringify(r.result); if (line !== last && (!r.result.ok || r.result.pushed || r.result.pulled || r.result.keys_wrapped)) out(r.result); last = r.result.ok ? '' : line; } catch (e) { console.error(`tophat: sync: ${e.message}`); }
      await new Promise((r) => setTimeout(r, every));
    }
  } else if (cmd === 'instance' && sub === 'join') {
    args.shift();
    const file = path.resolve(flag('--config') || die('instance join: --config FILE is required'));
    const hubUrl = flag('--hub'), userName = flag('--user');
    const { COMMUNITY_GROUP, joinGroup } = await import('../src/join.mjs');
    out(await joinGroup({ configFile: file, group: args.shift() || COMMUNITY_GROUP, hubUrl, userName }));
  } else if (cmd === 'instance' && sub === 'group') {
    args.shift();
    const op = args.shift();
    const file = path.resolve(flag('--config') || die(`instance group ${op ?? ''}: --config FILE is required`));
    const role = flag('--role') || 'write';
    const { addMember, createGroup } = await import('../src/join.mjs');
    if (op === 'create') { const r = await createGroup({ configFile: file, group: args.shift() || die('instance group create: NAME is required') }); out(r); process.exit(r.ok ? 0 : 1); }
    else if (op === 'add') { const group = args.shift(), user = args.shift(); if (!group || !user) die('instance group add: NAME and USER are required'); const r = await addMember({ configFile: file, group, user, role }); out(r); process.exit(r.ok ? 0 : 1); }
    else die('usage: tophat instance group create NAME | add NAME USER [--role read|write|admin] --config FILE');
  } else if (cmd === 'instance' && sub === 'intake') {
    args.shift();
    const c = loadInstance(path.resolve(flag('--config') || die('instance intake: --config FILE is required')));
    if (!c.intake) die('instance intake: the instance file has no intake block ({ everySeconds, model })');
    const { runIntake } = await import('../src/intake.mjs');
    const force = has('--force'), forever = has('--forever'), tick = Number(flag('--tick') || 30) * 1000;
    if (!forever) { out(await runIntake(c, { force })); process.exit(0); }
    for (;;) {
      try { const r = await runIntake(c); if (Object.keys(r).length) out(r); } catch (e) { console.error(`tophat: intake: ${e.message}`); }
      await new Promise((r) => setTimeout(r, tick));
    }
  } else if (cmd === 'instance' && sub === 'unit') {
    args.shift();
    const file = path.resolve(flag('--config') || die('instance unit: --config FILE is required'));
    out(serviceUnit(loadInstance(file), { configFile: file, kind: flag('--kind') || 'launchd', bin: fileURLToPath(import.meta.url), job: flag('--job') || 'webchat' }));
  } else if (cmd === 'instance' && sub === 'jobs') {
    args.shift();
    const file = path.resolve(flag('--config') || die('instance jobs: --config FILE is required'));
    const dir = flag('--write'), c = loadInstance(file), bin = fileURLToPath(import.meta.url);
    const jobs = instanceJobs(c, { configFile: file });
    if (dir) { mkdirSync(dir, { recursive: true }); for (const j of jobs) writeFileSync(path.join(dir, `${j.label}.plist`), serviceUnit(c, { configFile: file, bin, job: j.job })); }
    out(jobs.map((j) => ({ job: j.job, label: j.label, ...(dir ? { unit: path.join(dir, `${j.label}.plist`) } : {}) })));
  } else if (cmd === 'instance' && sub === 'fast-proxy') {
    args.shift();
    const { runFastProxy } = await import('../src/fast-proxy.mjs');
    runFastProxy(path.resolve(flag('--config') || die('instance fast-proxy: --config FILE is required')));
  } else if (cmd === 'ext') {
    args.shift();
    const file = path.resolve(flag('--config') || die(`ext ${sub ?? ''}: --config FILE is required`));
    const c = loadInstance(file);
    if (!c.extensions) die('ext: the instance file has no extensions block ({ dirs: [PATH] })');
    const ext = await import('../src/extensions.mjs');
    if (sub === 'list') { out(ext.discover(c).map((d) => { const m = JSON.parse(readFileSync(d.manifestFile, 'utf8')); return { id: m.id, version: m.version, dir: d.dir, disabled: c.extensions.disable.includes(m.id) }; })); }
    else if (sub === 'check') { const r = await ext.checkExtensions(c); out({ ok: !r.refused.length, order: r.order, refused: r.refused, disabled: r.disabled, provides: Object.fromEntries(r.regs.map((g) => [g.manifest.id, r.kit.providesOf(g)])) }); process.exit(r.refused.length ? 1 : 0); }
    else if (sub === 'build') { const r = await ext.buildExtensions(c); out(r); process.exit(r.refused.length ? 1 : 0); }
    else if (sub === 'run-job') { const [id, job] = args; if (!id || !job) die('ext run-job: ID and JOB are required'); out(await ext.runJob(c, { id, job })); }
    else die(`ext: unknown sub-command ${sub} (list | check | build | run-job)`);
  } else if (cmd === 'update') {
    const file = path.resolve(flag('--config') || die('update: --config FILE is required'));
    const resume = flag('--resume');
    const { update } = await import('../src/update.mjs');
    const r = await update({ configFile: file, check: has('--check'), dryRun: has('--dry-run'), restart: !has('--no-restart'), acceptUi: has('--accept-ui'), resume });
    out(r); process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'start') {
    const file = flag('--config');
    if (!file) die('start: --config FILE is required');
    const { start } = await import('../src/start.mjs');
    await start({ configFile: path.resolve(file), buildDir: flag('--build') });
  } else die('usage: tophat components list|tree|check, tophat ext list|check|build|run-job --config FILE, tophat start --config FILE, tophat update --config FILE [--check], tophat instance env|unit|jobs|fast-proxy|start|stop|status|health|release|ship|sync|join|group|intake --config FILE');
} catch (e) { die(e.message, 1); }
