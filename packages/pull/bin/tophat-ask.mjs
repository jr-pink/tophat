#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// tophat-ask [--config FILE] [--context-only] QUESTION...   (model: config.pull.model, a push provider config)
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { open } from '@tophat-md/linknotes';
import { makeProvider } from '@tophat-md/push/providers';
import { contextFor, runOnce } from '../index.mjs';
const argv = process.argv.slice(2), i = argv.indexOf('--config');
const cfg = JSON.parse(readFileSync((i >= 0 ? argv[i + 1] : process.env.LINKNOTES_CONFIG || '~/.config/linknotes/config.json').replace(/^~/, os.homedir()), 'utf8'));
const q = argv.filter((a, k) => !a.startsWith('--') && argv[k - 1] !== '--config').join(' ');
const store = await open(cfg);
if (argv.includes('--context-only') || !cfg.pull?.model) console.log((await contextFor(store, q, { retrieval: cfg.retrieval })).text);
else console.log((await runOnce(store, makeProvider(cfg.pull.model), q, { retrieval: cfg.retrieval })).answer);
await store.close();
