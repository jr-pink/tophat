#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// tophat-retrieval [--config FILE] refresh [--force] | ask QUERY...   (config.retrieval: { stateDir, corpora })
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { open } from '@tophat-md/linknotes';
import { refresh, ask } from '../index.mjs';
const argv = process.argv.slice(2), i = argv.indexOf('--config');
const cfg = JSON.parse(readFileSync((i >= 0 ? argv[i + 1] : process.env.LINKNOTES_CONFIG || '~/.config/linknotes/config.json').replace(/^~/, os.homedir()), 'utf8'));
const pos = argv.filter((a, k) => !a.startsWith('--') && argv[k - 1] !== '--config');
if (!cfg.retrieval) { console.error('config.retrieval is missing'); process.exit(2); }
const store = await open(cfg);
if (pos[0] === 'refresh') console.log(JSON.stringify(await refresh(cfg.retrieval, { force: argv.includes('--force'), store }), null, 1));
else if (pos[0] === 'ask') console.log(JSON.stringify(await ask(pos.slice(1).join(' '), cfg.retrieval, { store }), null, 1));
else { console.error('refresh | ask QUERY'); process.exit(2); }
await store.close();
