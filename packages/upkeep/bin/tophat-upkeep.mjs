#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// tophat-upkeep [--config FILE] once | forever [--tick 30]   (forever: one process, checks due jobs every tick seconds)
// tophat-upkeep run JOB                                       run one job now
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { open } from '@tophat-md/linknotes';
import { runDue } from '../index.mjs';
const argv = process.argv.slice(2), flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const file = (flag('config') || process.env.LINKNOTES_CONFIG || '~/.config/linknotes/config.json').replace(/^~/, os.homedir());
const cfg = JSON.parse(readFileSync(file, 'utf8'));
const store = await open(cfg);
const pos = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (pos[0] === 'run') console.log(JSON.stringify(await runDue(store, cfg, { only: [pos[1]] }), null, 1));
else if (pos[0] === 'forever') { const tick = Number(flag('tick') || 30) * 1000; for (;;) { await runDue(store, cfg).catch((e) => console.error(e.message)); await new Promise((r) => setTimeout(r, tick)); } }
else console.log(JSON.stringify(await runDue(store, cfg), null, 1));
