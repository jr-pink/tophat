#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// tophat-mcp [--config FILE]: the memory tools as an MCP stdio server over the configured MemoryStore.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { open } from '@tophat-md/linknotes';
import { serve } from '../mcp.mjs';
const i = process.argv.indexOf('--config');
const cfg = JSON.parse(readFileSync((i > 0 ? process.argv[i + 1] : process.env.LINKNOTES_CONFIG || '~/.config/linknotes/config.json').replace(/^~/, os.homedir()), 'utf8'));
serve({ store: await open(cfg) });
