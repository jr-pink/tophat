#!/usr/bin/env node
// tophat-cdp: drive the local Chrome over the DevTools Protocol from the shell. See cdp/README.md.
import { main } from '../cdp/tophat-cdp.mjs';

process.exitCode = await main(process.argv.slice(2));
