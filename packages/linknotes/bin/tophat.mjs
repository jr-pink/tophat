#!/usr/bin/env node
// tophat: one command in front of the package CLIs.
//   tophat ask | mcp | push | retrieval | sources | upkeep | verify | viewer ARGS...   runs tophat-<that> ARGS...
//   tophat components | start | instance | ext ARGS...                         runs tophat-deploy <that> ARGS...
//   tophat setup | chat | graph ARGS...                                     runs tophat-setup <that> ARGS... (in @tophat-md/deploy)
//   tophat ARGS...                                                          anything else runs tophat-linknotes ARGS...
// A sub-command whose package is not installed says which package to install.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBS = { ask: 'pull', mcp: 'tools', push: 'push', retrieval: 'retrieval', sources: 'sources', upkeep: 'upkeep', verify: 'verify', viewer: 'viewer' };
/** Sub-commands served by one package CLI that takes the sub-command as its first argument. */
const PASS = { components: 'deploy', start: 'deploy', instance: 'deploy', ext: 'deploy' };
/** First-run sub-commands of @tophat-md/deploy, served by its tophat-setup CLI. */
const SETUP = { setup: 'deploy', chat: 'deploy', graph: 'deploy' };
const here = path.dirname(fileURLToPath(import.meta.url));

/** The directory of an installed @tophat-md package: a sibling in this workspace or a node_modules entry above us. */
function packageDir(name) {
  const candidates = [path.resolve(here, '../..', name)];
  for (let d = here; ; d = path.dirname(d)) { candidates.push(path.join(d, 'node_modules/@tophat-md', name)); if (d === path.dirname(d)) break; }
  return candidates.find((d) => { try { return JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8')).name === `@tophat-md/${name}`; } catch { return false; } }) ?? null;
}

const [first, ...rest] = process.argv.slice(2);
let bin, args;
if (first && Object.hasOwn(SETUP, first)) {
  const dir = packageDir(SETUP[first]);
  if (!dir) { console.error(`tophat ${first}: install @tophat-md/${SETUP[first]}`); process.exit(2); }
  bin = path.join(dir, 'bin', 'tophat-setup.mjs'); args = [first, ...rest];
} else if (first && Object.hasOwn(PASS, first)) {
  const dir = packageDir(PASS[first]);
  if (!dir) { console.error(`tophat ${first}: install @tophat-md/${PASS[first]}`); process.exit(2); }
  bin = path.join(dir, 'bin', `tophat-${PASS[first]}.mjs`); args = [first, ...rest];
} else if (first && Object.hasOwn(SUBS, first)) {
  const dir = packageDir(SUBS[first]);
  if (!dir) { console.error(`tophat ${first}: install @tophat-md/${SUBS[first]}`); process.exit(2); }
  bin = path.join(dir, 'bin', `tophat-${first}.mjs`); args = rest;
} else { bin = path.join(here, 'tophat-linknotes.mjs'); args = process.argv.slice(2); }
if (!existsSync(bin)) { console.error(`tophat: missing ${bin}`); process.exit(2); }
const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', bin, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
