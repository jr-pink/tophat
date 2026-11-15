#!/usr/bin/env node
// tophat-demo: the public read-only demo of a running instance (packages/demo/README.md).
//   tophat-demo export --repo DIR --out DIR [--since 8.days] [--deny FILE]     project docs + commit log -> records.jsonl, manifest.json (private-data gate)
//   tophat-demo seed --config demo.json                           records -> the instance replica (the group scope), then the graph snapshot
//   tophat-demo ask --config demo.json --slot NAME [--prompt TEXT] run one real turn on the instance and cache its answer for the slot
//   tophat-demo pages --config demo.json [--force]                 write the model-written entity pages (at most once a day; --force overrides), then the graph snapshot
//   tophat-demo daily --config demo.json                          seed, write the day's pages (once a day), then re-run every slot marked daily
//   tophat-demo widgets|instructions --config demo.json           regenerate the memory-graph widget / the agent's standing context from their sources
//   tophat-demo release --repo DIR                    (maintainer) build main and publish it for the demo user
//   tophat-demo instance --config demo.json [--check]            write seed/instance-policy.json into the instance file (--check: report only; exit 1 on a difference or any webchat row in memory)
//   tophat-demo update --config demo.json [--root DIR]                          (demo user) install the published release into the root, restart the demo
//   tophat-demo check [--repo DIR] [--port 4472]              exit 1 when the live demo is not on the repository's main
//   tophat-demo serve --config demo.json                          the public surface: shell, cached chats, the graph (GET only)
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) { const a = rest[i]; if (!a.startsWith('--')) continue; const k = a.slice(2); flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
const expand = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const die = (m, code = 2) => { console.error(m); process.exit(code); };
const config = () => {
  const file = expand(flags.config || die('--config is required'));
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const dir = path.dirname(file);
  const abs = (p) => (p ? path.resolve(dir, expand(p)) : p);
  const out = { ...c, file };
  for (const k of ['db', 'records', 'manifest', 'cache', 'snapshot', 'instance', 'viewerAssets', 'visitorDb', 'sessionSecretFile', 'visitorInstructions', 'modelKeyFile', 'modelWorkspaceFile', 'edgeSecretFile']) out[k] = abs(c[k]);
  if (c.turnstile) out.turnstile = { ...c.turnstile, secretFile: abs(c.turnstile.secretFile) };
  return out;
};
const print = (x) => console.log(JSON.stringify(x, null, 1));

if (cmd === 'export') {
  const { exportRecords } = await import('../src/export.mjs');
  print(exportRecords({ repo: expand(flags.repo || die('--repo')), out: expand(flags.out || die('--out')), since: flags.since || null, denyFile: expand(flags.deny) || null }));
} else if (cmd === 'seed') {
  const c = config();
  const { seed, snapshot } = await import('../src/seed.mjs');
  print({ seed: await seed(c), snapshot: await snapshot({ ...c, out: c.snapshot }) });
} else if (cmd === 'ask') {
  const c = config();
  const { ask } = await import('../src/ask.mjs');
  print(await ask(c, flags.slot || die('--slot'), flags.prompt || null));
} else if (cmd === 'pages') {
  const c = config();
  const { snapshot } = await import('../src/seed.mjs');
  const { buildPagesFromConfig } = await import('../src/pages.mjs');
  const pages = await buildPagesFromConfig(c, { force: Boolean(flags.force) });
  print({ pages, snapshot: await snapshot({ ...c, out: c.snapshot }) });
} else if (cmd === 'daily') {
  const c = config();
  const { seed, snapshot } = await import('../src/seed.mjs');
  const { ask } = await import('../src/ask.mjs');
  const { buildPagesFromConfig } = await import('../src/pages.mjs');
  const out = { seed: await seed(c) };
  // the day's model-written pages come after the seed (they read its notes) and before the snapshot (which prefers them); a pages problem is reported and the rest still runs
  out.pages = await buildPagesFromConfig(c).catch((e) => ({ error: e.message }));
  out.snapshot = await snapshot({ ...c, out: c.snapshot });
  out.asked = [];
  for (const s of c.slots.filter((x) => x.daily)) out.asked.push(await ask(c, s.id, null).catch((e) => ({ slot: s.id, error: e.message })));
  print(out);
  if (out.pages.error || out.asked.some((a) => a.error)) process.exit(1);
} else if (cmd === 'widgets') {
  const c = config();
  // the builder is source-only in the public archive; the demo host's release carries it (release.mjs). A tree without it keeps the widget it has.
  const mod = await import('../widgets/build-graph.mjs').catch((e) => { if (e && e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; });
  print(mod ? mod.buildGraph({ snapshot: c.snapshot }) : { skipped: 'no widget builder in this tree' });
} else if (cmd === 'instructions') {
  const c = config();
  const { writeInstructions } = await import('../src/instructions.mjs');
  print(writeInstructions(c));
} else if (cmd === 'instance') {
  const c = config();
  const { applyInstancePolicy, checkInstance } = await import('../src/instance-config.mjs');
  const applied = flags.check ? null : applyInstancePolicy(c.instance);
  const r = await checkInstance(c.instance, c.db);
  print({ ...(applied ? { applied } : {}), ...r });
  if (flags.check ? !r.ok : r.policy.length) process.exit(1); // an update only applies; webchat rows are the check's finding
} else if (cmd === 'release') {
  const { release } = await import('../src/release.mjs');
  print(release({ repo: expand(flags.repo || die('--repo')), out: flags.out ? expand(flags.out) : undefined, node: flags.node ? expand(flags.node) : undefined, npm: flags.npm ? expand(flags.npm) : null }));
} else if (cmd === 'update') {
  const c = config();
  const { update } = await import('../src/release.mjs');
  const { execFileSync } = await import('node:child_process');
  const root = flags.root ? expand(flags.root) : path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
  const node = process.execPath;
  const run = (args) => execFileSync(node, [path.join(root, 'packages/demo/bin/tophat-demo.mjs'), ...args, '--config', c.file], { encoding: 'utf8' });
  // the new release's server and the webchat's markdown must import with the dependencies the root already has (its own node_modules is linked in for the check)
  const preflight = (staging) => {
    const link = path.join(staging, 'node_modules');
    const hasRoot = existsSync(path.join(root, 'node_modules'));
    if (hasRoot && !existsSync(link)) symlinkSync(path.join(root, 'node_modules'), link);
    // The webchat's built server is checked by resolving every package its entry files import (importing it would boot the app): on
    // 2026-11-10 an install in the root pruned @sveltejs/kit, this check only covered serve.mjs, and the webchat 502'd every returning guest.
    const probe = path.join(staging, 'packages/webchat/build/__preflight.mjs');
    const webchatCheck = `const fs = await import('node:fs'); const dir = new URL('.', import.meta.url); const missing = [];
      for (const f of ['index.js', 'handler.js', 'shims.js', 'env.js']) { let src; try { src = fs.readFileSync(new URL(f, dir), 'utf8'); } catch { continue; }
        for (const m of src.matchAll(/(?:^|\\n)\\s*import\\s+(?:[^'"]*?from\\s+)?['"]([^'"./][^'"]*)['"]/g)) { if (m[1].startsWith('node:')) continue; try { import.meta.resolve(m[1]); } catch { missing.push(m[1]); } } }
      if (missing.length) { console.error("Error [ERR_MODULE_NOT_FOUND]: webchat build cannot resolve " + [...new Set(missing)].join(', ')); process.exit(1); }`;
    try {
      execFileSync(node, ['--input-type=module', '-e', `await import(${JSON.stringify(path.join(staging, 'packages/demo/src/serve.mjs'))})`], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000 });
      if (existsSync(path.dirname(probe))) { writeFileSync(probe, webchatCheck); execFileSync(node, [probe], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000 }); }
    }
    catch (e) { throw new Error(String(e.stderr || e.message)); }
    finally { try { unlinkSync(probe); } catch { /* none */ } if (hasRoot) { try { unlinkSync(link); } catch { /* gone */ } } }
  };
  const r = update({ root, out: flags.out ? expand(flags.out) : undefined, preflight, derive: () => { run(['instance']); run(['widgets']); run(['instructions']); }, restart: () => {
    // our own processes only; launchd starts them again from the new root
    const pids = execFileSync('pgrep', ['-u', String(process.getuid()), '-f', `${root}/packages/(deploy/bin/tophat-deploy.mjs start|webchat/serve.mjs|demo/bin/tophat-demo.mjs serve)`], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).filter((n) => n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  }, after: async (sha) => {
    // how long the demo was away: wait for the new build to answer, and say so in the log
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      const h = await fetch(`http://127.0.0.1:${c.port || 4472}/healthz`, { signal: AbortSignal.timeout(1500) }).then((x) => x.json()).catch(() => null);
      if (h?.build === sha) { console.log(`back on ${sha.slice(0, 12)} after ${((Date.now() - t0) / 1000).toFixed(1)} s`); return; }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.error(`NOT back on ${sha.slice(0, 12)} after 60 s`);
  } });
  const { waiting, ...shown } = r;
  print(shown);
  await waiting;
} else if (cmd === 'check') {
  const { headOf, currentOf } = await import('../src/release.mjs');
  const live = await fetch(`http://127.0.0.1:${flags.port || 4472}/healthz`).then((r) => r.json()).catch(() => null);
  const head = flags.repo ? headOf(expand(flags.repo)) : null, published = currentOf();
  const rows = { repoMain: head, published, live: live?.build || null };
  print(rows);
  const behind = (head && published !== head) || !live || (published && live.build !== published);
  if (behind) { console.error('the demo is behind main (or down)'); process.exit(1); }
} else if (cmd === 'serve') {
  const c = config();
  const { serve } = await import('../src/serve.mjs');
  await serve(c);
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  if (cmd && cmd !== 'help') process.exit(2);
}
