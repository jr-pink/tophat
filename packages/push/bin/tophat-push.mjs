#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// tophat-push [--config FILE]: one push cycle from config.push (sources -> derive -> sync), same as `tophat-linknotes push`.
// Config: --config FILE, else $LINKNOTES_CONFIG, else ~/.config/linknotes/config.json.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { open } from '@tophat-md/linknotes';
import { pollOnce } from '../index.mjs';

const argv = process.argv.slice(2), i = argv.indexOf('--config');
const expand = (p) => String(p).replace(/^~(?=\/|$)/, os.homedir());
const file = expand(i >= 0 ? argv[i + 1] : process.env.LINKNOTES_CONFIG || '~/.config/linknotes/config.json');
if (!existsSync(file)) { console.error(`no config at ${file}; run tophat-linknotes init`); process.exit(2); }
const cfg = JSON.parse(readFileSync(file, 'utf8'));
if (!cfg.push) { console.error('config.push is missing (see README: push)'); process.exit(2); }
const m = await open(cfg);
try { console.log(JSON.stringify(await pollOnce(m, { syncAfter: Boolean(cfg.hub), ...cfg.push, stateDir: expand(cfg.push.stateDir || '~/.local/state/linknotes/push') }), null, 2)); }
catch (e) { console.error(`${e.constructor.name}: ${e.message}`); process.exitCode = 1; }
finally { await m.close(); }
