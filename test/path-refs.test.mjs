// Files a module loads by path (compiled, spawned, read) ship beside it. An import closure cannot see them: OCR.swift
// and containers.py were missing from the runner, so every image came back 'extraction-unavailable'.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathRefs } from '../scripts/path-refs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Known dead references, each with the reason it cannot fire. Keep this short; a new entry needs the same proof.
const DEAD = new Map([
  ['packages/linknotes/core/vendor/rev6/push/pages.mjs -> prompts/page_prompt.txt',
    'read only by writeOutline (the page writer); this workspace imports only renderBfs from pages.mjs, and the upstream core has no prompt file either'],
]);

function modules(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test' || e.name === 'build' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) modules(p, out);
    else if (/\.(m?js|svelte)$/.test(e.name) && !/\.(test|spec)\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('pathRefs finds the forms modules use to name a sibling file', () => {
  const text = [
    "const worker = path.join(import.meta.dirname, 'containers.py');",
    "const HERE = dirname(fileURLToPath(import.meta.url));",
    "const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));",
    "const a = join(HERE, 'scripts', 'relay.mjs');",
    "const b = join(REPO, 'store', 'cli.mjs');",
    "const c = JSON.parse(readFileSync(new URL('./models.json', import.meta.url), 'utf8'));",
    "const d = path.join(__dirname, 'probe.wav');",
  ].join('\n');
  assert.deepEqual(pathRefs(text), ['../../store/cli.mjs', 'containers.py', 'models.json', 'probe.wav', 'scripts/relay.mjs']);
});

test('every file a packages/* module loads by path exists', () => {
  const missing = [];
  let refs = 0;
  for (const f of modules(path.join(ROOT, 'packages'))) {
    for (const ref of pathRefs(readFileSync(f, 'utf8'))) {
      if (!/\.[A-Za-z0-9]+$/.test(ref)) continue; // a directory
      refs++;
      const target = path.join(path.dirname(f), ref);
      const key = `${path.relative(ROOT, f).split(path.sep).join('/')} -> ${ref}`;
      if ((!existsSync(target) || !statSync(target).isFile()) && !DEAD.has(key)) missing.push(key);
    }
  }
  assert.ok(refs >= 10, `found only ${refs} path references; the scanner stopped matching`);
  assert.deepEqual(missing, [], `path-loaded files missing from packages/*:\n${missing.join('\n')}`);
});

test('the dead page_prompt reference stays dead: nothing outside pages.mjs uses writeOutline or pagePrompt', () => {
  const users = modules(path.join(ROOT, 'packages')).filter((f) => !f.endsWith(path.join('rev6', 'push', 'pages.mjs')) && /\b(writeOutline|pagePrompt|PROMPT_PATH)\b/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(users.map((f) => path.relative(ROOT, f)), []);
});
