#!/usr/bin/env node
// tophat-redeploy: ship an instance. See redeploy/tophat-redeploy.mjs.
import { main } from '../redeploy/tophat-redeploy.mjs';

process.exitCode = main(process.argv.slice(2));
