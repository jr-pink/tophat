#!/usr/bin/env node
// tophat-transcribe: transcribe handwritten notebook photos with a vision model (Claude Sonnet),
// not OCR.
//
//   tophat-transcribe [--since ISO] [--batch 5] [--model claude-sonnet-5] [--out DIR]
//                    [--glossary FILE] [--key FILE] [image ...]
//
// With no image arguments, takes every image in the webchat uploads dir modified after --since.
// HEIC is converted to JPEG with sips (long edge 2000 px). Output: DIR/transcript.md (in input
// order) plus DIR/batch-N.json raw responses. Prints the transcript path.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { configDir, envGet, stateDir } from '../lib/paths.mjs';

const HOME = homedir();
const CONFIG = configDir(), STATE = stateDir();
const OWNER = envGet(process.env, 'TOPHAT_OWNER_NAME') || 'the owner';
const args = process.argv.slice(2);
const opt = { batch: 5, model: 'claude-sonnet-5', since: null, out: null,
  glossary: envGet(process.env, 'TOPHAT_TRANSCRIBE_GLOSSARY') || join(STATE, 'transcribe/glossary.txt'),
  key: envGet(process.env, 'TOPHAT_TRANSCRIBE_KEY_FILE') || join(CONFIG, 'secrets/anthropic-api-key') };
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) opt[a.slice(2)] = args[++i]; else files.push(a);
}
opt.batch = Number(opt.batch) || 5;

const UPLOADS = envGet(process.env, 'TOPHAT_TRANSCRIBE_UPLOADS') || join(STATE, 'webchat/uploads');
const IMG = /\.(heic|heif|jpe?g|png|webp)$/i;
if (!files.length) {
  if (!opt.since) { console.error('give image paths or --since ISO'); process.exit(2); }
  const since = Date.parse(opt.since);
  for (const day of readdirSync(UPLOADS)) {
    const d = join(UPLOADS, day);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (IMG.test(f) && statSync(p).mtimeMs > since) files.push(p);
    }
  }
  files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}
if (!files.length) { console.error('no images found'); process.exit(3); }

const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const out = opt.out || join(envGet(process.env, 'TOPHAT_TRANSCRIBE_OUT_DIR') || join(STATE, 'transcribe'), stamp);
mkdirSync(join(out, 'jpg'), { recursive: true });

function prepare(p, i) {
  const dest = join(out, 'jpg', `${String(i + 1).padStart(3, '0')}-${basename(p, extname(p))}.jpg`);
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '2800', p, '--out', dest], { stdio: 'ignore' });
  return dest;
}
const jpgs = files.map(prepare);
const glossary = existsSync(opt.glossary) ? readFileSync(opt.glossary, 'utf8').trim() : '';
const key = readFileSync(opt.key, 'utf8').trim();
const wsFile = envGet(process.env, 'TOPHAT_TRANSCRIBE_WORKSPACE_FILE') || join(CONFIG, 'secrets/anthropic-workspace-id');
const workspace = existsSync(wsFile) ? readFileSync(wsFile, 'utf8').trim() : '';

const SYSTEM = `You transcribe photos of ${OWNER}'s handwritten notebook pages.
Transcribe exactly what is written, in reading order, preserving line breaks, bullets, indentation, arrows (write -> ), numbering, crossed-out text (as ~~text~~) and their spelling and abbreviations. Do not summarize, correct, or add anything.
Describe drawings, diagrams and tables briefly in [square brackets]; transcribe any labels inside them. Mark an unreadable word as [?] and a guess as [word?].
When a word plausibly matches a name or term in the glossary, use the glossary spelling.
PAGE NUMBERS: ${OWNER} numbers their notebook pages, usually small, in a top or bottom corner, and a photo may show a spread of two pages. Look for them deliberately, in every corner of every page, before transcribing. Also note dates he writes (e.g. "8 Oct 2026").
Output, for each image in order, exactly this shape:
=== IMAGE n ===
PAGES: <number written on each visible page, e.g. "left 14, right 15", or "none visible" if you looked in all corners and there is none; add [?] on any digit you are not sure of>
UNSURE: <list every word, number or line you are not confident about, quoted, or "none">
TEXT:
<the transcription>
Never silently guess: anything uncertain is marked [?] in the text and listed under UNSURE. Nothing else.
${glossary ? `\nGlossary of names and terms that appear in their notes:\n${glossary}` : ''}`;

async function run(batch, bi) {
  const content = [];
  batch.forEach((j, k) => {
    content.push({ type: 'text', text: `IMAGE ${k + 1}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(j).toString('base64') } });
  });
  content.push({ type: 'text', text: `Transcribe all ${batch.length} images.` });
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(workspace ? { 'anthropic-workspace-id': workspace } : {}) },
      body: JSON.stringify({ model: opt.model, max_tokens: 16000, system: SYSTEM, messages: [{ role: 'user', content }] }),
    });
    const body = await r.json();
    if (r.ok) { writeFileSync(join(out, `batch-${bi + 1}.json`), JSON.stringify(body, null, 1)); return body.content.map(c => c.text || '').join(''); }
    if (![429, 500, 529, 503].includes(r.status)) throw new Error(`batch ${bi + 1}: HTTP ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
    await new Promise(s => setTimeout(s, 5000 * (attempt + 1)));
  }
  throw new Error(`batch ${bi + 1}: retries exhausted`);
}

const batches = [];
for (let i = 0; i < jpgs.length; i += opt.batch) batches.push(jpgs.slice(i, i + opt.batch));
const results = await Promise.allSettled(batches.map(run));
let md = `# Notebook transcription, ${jpgs.length} images, ${opt.model}\n\n`;
results.forEach((res, bi) => {
  const batch = batches[bi];
  if (res.status === 'rejected') { md += batch.map(j => `## ${basename(j)}\n\n[FAILED: ${res.reason.message}]\n\n`).join(''); return; }
  const parts = res.value.split(/^=== IMAGE (\d+) ===\s*$/m);
  const byN = {};
  for (let k = 1; k < parts.length; k += 2) byN[Number(parts[k])] = parts[k + 1].trim();
  batch.forEach((j, k) => { md += `## ${basename(j)}\n\n![page](${j})\n\n${byN[k + 1] ?? '[missing from response]'}\n\n`; });
});
writeFileSync(join(out, 'transcript.md'), md);
const failed = results.filter(r => r.status === 'rejected').length;
console.log(JSON.stringify({ transcript: join(out, 'transcript.md'), images: jpgs.length, batches: batches.length, failed }));
