#!/usr/bin/env node
// tophat-viewer: serve the browser graph viewer from a hub, and make the key file the browser opens.
//   tophat-viewer hub --db hub.sqlite --secret-file hub-secret [--port 8791] [--host 127.0.0.1]
//       the ciphertext-only hub (as `tophat-linknotes hub serve`) that also answers GET /graph with the static viewer
//   tophat-viewer export-keys --config linknotes.json --out viewer.keys.json [--scopes a,b] [--with-device-key]
//       a passphrase-sealed key file with the scope keys your replica holds (0600)
//   tophat-viewer enroll --hub URL --token-file viewer.hub-token --out viewer.keys.json [--config linknotes.json]
//       register a fresh device key for a viewer device id with the hub; scope admins wrap keys to it at their next sync
//       (--config also puts the replica's current scope keys in the file)
// The passphrase comes from --passphrase-file FILE, $VIEWER_PASSPHRASE, or a prompt.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Hub } from '@tophat-md/linknotes';
import { hubView, exportKeys, enrollDevice, readKeyFile } from '../src/index.mjs';
import { tokenClaims } from '../src/core/state.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) { const a = rest[i]; if (!a.startsWith('--')) continue; const k = a.slice(2); flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
const expand = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const die = (m, code = 1) => { console.error(m); process.exit(code); };
const need = (k) => flags[k] || die(`--${k} is required (see: tophat-viewer help)`);

async function passphrase(confirm) {
  if (flags['passphrase-file']) return readFileSync(expand(flags['passphrase-file']), 'utf8').replace(/\n$/, '');
  if (process.env.VIEWER_PASSPHRASE) return process.env.VIEWER_PASSPHRASE;
  if (!process.stdin.isTTY) die('no passphrase: use --passphrase-file or $VIEWER_PASSPHRASE');
  const ask = (q) => new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(q); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); res(a); });
  });
  const a = await ask('passphrase: ');
  if (confirm && (await ask('again: ')) !== a) die('the passphrases differ');
  return a;
}
function writeSecret(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

if (cmd === 'hub') {
  const secret = readFileSync(expand(need('secret-file')), 'utf8').trim();
  const hub = new Hub(expand(need('db')), { secret, view: hubView({ hubUrl: flags['hub-url'] || null }) });
  const server = await hub.listen(Number(flags.port || 8791), flags.host || '127.0.0.1');
  const a = server.address();
  console.log(`hub on http://${a.address}:${a.port}  (viewer at /graph; ciphertext only)`);
} else if (cmd === 'export-keys') {
  const config = JSON.parse(readFileSync(expand(need('config')), 'utf8'));
  const out = expand(need('out'));
  const box = await exportKeys({ config: { ...config, file: expand(config.file), keyFile: expand(config.keyFile) }, passphrase: await passphrase(true), scopes: flags.scopes ? String(flags.scopes).split(',') : null, withDeviceKey: Boolean(flags['with-device-key']) });
  writeSecret(out, box);
  console.log(`wrote ${out} (sealed; open it in the viewer with the passphrase)`);
} else if (cmd === 'enroll') {
  const token = readFileSync(expand(need('token-file')), 'utf8').trim();
  const { user, device } = tokenClaims(token);
  const pass = await passphrase(true);
  let scopes = {};
  if (flags.config) {
    const config = JSON.parse(readFileSync(expand(flags.config), 'utf8'));
    if (config.user !== user) die(`the token is for ${user}, the replica for ${config.user}`);
    scopes = (await readKeyFile(await exportKeys({ config: { ...config, file: expand(config.file) }, passphrase: pass, iterations: 1000 }), pass)).scopes;
  }
  const box = await enrollDevice({ hubUrl: need('hub'), token, user, device, passphrase: pass, scopes });
  const out = expand(need('out'));
  writeSecret(out, box);
  console.log(`registered ${device} for ${user}; wrote ${out}. Scope admins wrap keys to it at their next sync.`);
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  if (cmd && cmd !== 'help') process.exit(2);
}
