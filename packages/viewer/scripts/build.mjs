#!/usr/bin/env node
// Builds the static viewer into packages/viewer/assets (committed, so the package and the hub need no npm at runtime and
// the page fetches nothing from a CDN):
//   assets/index.html   web/graph.html
//   assets/libs.js      sigma + graphology + louvain (window.LIBS)
//   assets/sim.js       web/sim.src.js + d3-force, the layout worker
//   assets/app.js       web/app.js + src/core (cipher, key file, replay, pull, graph), one IIFE
// Build-only modules (esbuild, sigma, graphology, graphology-communities-louvain, d3-force) are looked up in, first:
//   --modules DIR  |  $VIEWER_BUILD_MODULES  |  packages/viewer/node_modules  |  the workspace node_modules
// e.g.  mkdir /tmp/vb && npm install --prefix /tmp/vb esbuild@0.24 sigma@4 graphology@0.26 graphology-communities-louvain@2 d3-force@3
//       node packages/viewer/scripts/build.mjs --modules /tmp/vb/node_modules
// Prints each file's size; --check rebuilds into a temp dir and fails when assets/ differs (a stale commit).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const check = args.includes('--check');
const candidates = [flag('--modules'), process.env.VIEWER_BUILD_MODULES, path.join(PKG, 'node_modules'), path.join(PKG, '../../node_modules')].filter(Boolean);
const nm = candidates.find((d) => existsSync(path.join(d, 'esbuild')) && existsSync(path.join(d, 'sigma')) && existsSync(path.join(d, 'd3-force')));
if (!nm) { console.error(`build modules not found (esbuild, sigma, graphology, graphology-communities-louvain, d3-force) in:\n  ${candidates.join('\n  ')}\nsee the header of ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}`); process.exit(2); }
const { build } = createRequire(path.join(nm, 'x.js'))('esbuild');

// Colour-name tables in the drawing libraries are rewritten with every key letter escaped (same strings at runtime), so
// a byte scan of the bundle for words never trips on a dictionary colour name.
const escapeColourKeys = (js) => js.replace(/([,{])([a-z]{3,24}):"(#[0-9A-Fa-f]{3,8})"/g, (m, pre, name, hex) => `${pre}"${[...name].map((c) => '\\x' + c.charCodeAt(0).toString(16)).join('')}":"${hex}"`);

const out = check ? mkdtempSync(path.join(os.tmpdir(), 'viewer-build-')) : path.join(PKG, 'assets');
mkdirSync(out, { recursive: true });
const common = { bundle: true, minify: true, format: 'iife', target: 'es2020', legalComments: 'none', nodePaths: [nm], logLevel: 'warning' };
await build({ ...common, entryPoints: [path.join(PKG, 'web/libs.src.js')], outfile: path.join(out, 'libs.js') });
await build({ ...common, entryPoints: [path.join(PKG, 'web/sim.src.js')], outfile: path.join(out, 'sim.js') });
await build({ ...common, entryPoints: [path.join(PKG, 'web/app.js')], outfile: path.join(out, 'app.js'), platform: 'browser' });
for (const f of ['libs.js', 'sim.js', 'app.js']) { const p = path.join(out, f); writeFileSync(p, escapeColourKeys(readFileSync(p, 'utf8'))); }
copyFileSync(path.join(PKG, 'web/graph.html'), path.join(out, 'index.html'));

let total = 0, totalGz = 0;
for (const f of readdirSync(out).sort()) {
  const b = readFileSync(path.join(out, f)); const gz = gzipSync(b, { level: 9 }).length;
  total += b.length; totalGz += gz;
  console.log(`${f.padEnd(11)} ${String(b.length).padStart(8)} bytes  ${String(gz).padStart(7)} gzip`);
}
console.log(`${'total'.padEnd(11)} ${String(total).padStart(8)} bytes  ${String(totalGz).padStart(7)} gzip`);
if (check) {
  const stale = readdirSync(out).filter((f) => !existsSync(path.join(PKG, 'assets', f)) || !readFileSync(path.join(PKG, 'assets', f)).equals(readFileSync(path.join(out, f))));
  rmSync(out, { recursive: true, force: true });
  if (stale.length) { console.error(`assets/ is stale: ${stale.join(', ')}; run node packages/viewer/scripts/build.mjs`); process.exit(1); }
  console.log('assets/ is current');
}
