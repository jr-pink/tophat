#!/usr/bin/env node
// tophat-pass: read a tophat credential vault from the command line. See pass/tophat-pass.mjs.
import { main } from '../pass/tophat-pass.mjs';

main(process.argv.slice(2)).then((code) => { process.exitCode = code ?? 0; }, (error) => {
  process.stderr.write(`tophat-pass: ${error.message}\n`);
  process.exitCode = error.code ?? 1;
});
