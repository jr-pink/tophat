#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// tophat-sources build-apple-helper DIR [--bundle-id ID]   compile and ad-hoc sign the Apple helper app (macOS, Xcode CLT)
// tophat-sources webhook --spool DIR --tokens FILE [--port 8796]   run the webhook receiver (tokens: [{sha256, source}])
// tophat-sources token-digest < token                         sha256 of a token read from stdin, for the tokens file
import { readFileSync } from 'node:fs';
import path from 'node:path';
const [cmd, arg] = process.argv.slice(2);
const flag = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
if (cmd === 'build-apple-helper') {
  const { buildHelper } = await import('../adapters/apple.mjs');
  console.log(JSON.stringify(await buildHelper({ directory: path.resolve(arg), ...(flag('bundle-id') ? { bundleId: flag('bundle-id') } : {}) })));
} else if (cmd === 'webhook') {
  const { listen } = await import('../webhook.mjs');
  const port = Number(flag('port') || 8796);
  await listen({ spool: path.resolve(flag('spool')), tokens: JSON.parse(readFileSync(flag('tokens'), 'utf8')), port });
  console.log(`webhook receiver on 127.0.0.1:${port}`);
} else if (cmd === 'token-digest') {
  const { tokenDigest } = await import('../webhook.mjs');
  console.log(tokenDigest(readFileSync(0, 'utf8').trim()));
} else { console.error('build-apple-helper DIR | webhook --spool DIR --tokens FILE | token-digest'); process.exit(2); }
