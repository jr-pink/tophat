#!/usr/bin/env node
// tophat-demo: the public read-only demo of a running instance (packages/demo/README.md).
//   tophat-demo export --repo DIR --out DIR [--since 8.days] [--deny FILE]     project docs + commit log -> records.jsonl, manifest.json (private-data gate)
//   tophat-demo seed --config demo.json                           records -> the instance replica (the group scope), then the graph snapshot
//   tophat-demo ask --config demo.json --slot NAME [--prompt TEXT] run one real turn on the instance and cache its answer for the slot
//   tophat-demo daily --config demo.json                          seed, then re-run every slot marked daily
//   tophat-demo serve --config demo.json                          the public surface: shell, cached chats, the graph (GET only)
import { readFileSync } from 'node:fs';
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
  for (const k of ['db', 'records', 'manifest', 'cache', 'snapshot', 'instance', 'viewerAssets', 'visitorDb', 'sessionSecretFile', 'visitorInstructions', 'modelKeyFile', 'modelWorkspaceFile']) out[k] = abs(c[k]);
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
} else if (cmd === 'daily') {
  const c = config();
  const { seed, snapshot } = await import('../src/seed.mjs');
  const { ask } = await import('../src/ask.mjs');
  const out = { seed: await seed(c), snapshot: await snapshot({ ...c, out: c.snapshot }), asked: [] };
  for (const s of c.slots.filter((x) => x.daily)) out.asked.push(await ask(c, s.id, null).catch((e) => ({ slot: s.id, error: e.message })));
  print(out);
  if (out.asked.some((a) => a.error)) process.exit(1);
} else if (cmd === 'serve') {
  const c = config();
  const { serve } = await import('../src/serve.mjs');
  await serve(c);
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  if (cmd && cmd !== 'help') process.exit(2);
}
