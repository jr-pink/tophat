#!/usr/bin/env node
// tophat-fanout: see fanout/tophat-fanout.mjs
import { main } from '../fanout/tophat-fanout.mjs';

process.exitCode = await main(process.argv.slice(2));
