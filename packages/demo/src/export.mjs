// The demo's memory comes from the project itself and from nothing else: the repository's own documents (README,
// COMPONENTS, docs/, package READMEs) and its commit log. `export` runs where the repository is (as its owner), splits
// the documents into blocks, and writes the records the demo instance seeds from, after a private-data gate: every
// record is scanned with the repository's traceability deny list (when present) and a fixed set of private-data
// patterns, and a record with any hit is left out whole (the manifest names it and the pattern, never the text).
//
// Output dir: records.jsonl (one record per line: {id, source, revision, time, title, text, entities}) and
// manifest.json (sources read, counts, what was dropped and why).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ENTITIES, entitiesOf } from './entities.mjs';

const sha = (s, n = 16) => createHash('sha256').update(s).digest('hex').slice(0, n);

// Private-data patterns that hold for any deployment: mail addresses, phone numbers, money, hostnames of personal
// machines, credential-shaped strings. The deny list adds the deployment's own names.
const PRIVATE = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['phone', /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/],
  ['money', /\$\s?\d|\b\d+(?:\.\d+)?\s?(?:USD|MDL)\b/],
  ['token', /\b(?:sk|pk|ghp|xox[bp])[-_][A-Za-z0-9]{12,}/],
  ['host', /\b[a-z0-9-]+\.(?:local|lan|internal)\b/i],
  ['home-path', /\/Users\/|\/home\/[a-z]/],
];

function loadDeny(repo) {
  const file = path.join(repo, 'scripts/traceability-deny.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((src) => ['deny:' + sha(src, 6), new RegExp(src, 'i')]);
}

/** Markdown -> blocks {heading, text}: paragraphs, list items and table rows, each under its nearest heading. */
export function blocks(md) {
  const out = []; let heading = '', para = [], fence = false;
  const flush = () => { const t = para.join(' ').replace(/\s+/g, ' ').trim(); para = []; if (t.length >= 60) out.push({ heading, text: t }); };
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flush(); heading = h[2].trim(); continue; }
    if (/^\s*\|/.test(line)) {
      flush();
      if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue;
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length) para.push(cells.join(': ')); flush(); continue;
    }
    if (/^\s*$/.test(line)) { flush(); continue; }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) { flush(); para.push(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')); continue; }
    if (/^\s{4}/.test(line) && !para.length) continue; // indented code
    para.push(line.trim());
  }
  flush();
  return out;
}

const clip = (t, n = 680) => (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t);

export function exportRecords({ repo, out, since = null, denyFile = null }) {
  const deny = [...loadDeny(repo), ...(denyFile ? readFileSync(denyFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((src) => ['local:' + sha(src, 6), new RegExp(src, 'i')]) : [])];
  const patterns = [...PRIVATE, ...deny];
  const scan = (text) => { for (const [name, re] of patterns) if (re.test(text)) return name; return null; };
  const records = [], dropped = [], sources = [];
  const head = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const docTime = (rel) => { try { return execFileSync('git', ['-C', repo, 'log', '-1', '--format=%aI', '--', rel], { encoding: 'utf8' }).trim() || new Date().toISOString(); } catch { return new Date().toISOString(); } };

  const docs = ['README.md', 'COMPONENTS.md', ...readdirSync(path.join(repo, 'docs')).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f),
    ...readdirSync(path.join(repo, 'packages')).map((p) => `packages/${p}/README.md`).filter((f) => existsSync(path.join(repo, f)))];
  for (const rel of docs) {
    const md = readFileSync(path.join(repo, rel), 'utf8');
    const time = docTime(rel);
    let n = 0;
    for (const b of blocks(md)) {
      const text = clip(b.text);
      const title = `${rel}${b.heading ? ' › ' + b.heading : ''}`;
      const id = `doc:${rel}#${sha(b.heading + '\0' + b.text, 12)}`;
      const hit = scan(title + '\n' + text);
      if (hit) { dropped.push({ id, title, reason: hit }); continue; }
      records.push({ id, source: 'tophat-docs', revision: sha(text, 8), time, title, text: `${title}: ${text}`, entities: entitiesOf(title + ' ' + text, [rel]) });
      n++;
    }
    sources.push({ source: rel, kind: 'document', blocks: n });
  }

  const log = execFileSync('git', ['-C', repo, 'log', '--no-merges', '--format=%x1e%H%x1f%aI%x1f%B', '--name-only', ...(since ? ['--since', since] : [])], { encoding: 'utf8', maxBuffer: 64 << 20 });
  let commits = 0;
  for (const chunk of log.split('\x1e').slice(1)) {
    const [hash, at, rest] = chunk.split('\x1f');
    const lines = rest.split('\n');
    // %B then a blank line then the file names; the body may itself hold blank lines, so files are the trailing run of path-shaped lines
    let i = lines.length; while (i > 0 && (lines[i - 1] === '' || /^[\w./@-]+$/.test(lines[i - 1]))) i--;
    const files = lines.slice(i).filter(Boolean);
    const message = lines.slice(0, i).join('\n').trim();
    const subject = message.split('\n')[0];
    const id = `commit:${hash.slice(0, 12)}`;
    const text = clip(message.replace(/\s+/g, ' '));
    const hit = scan(message + '\n' + files.join('\n'));
    if (hit) { dropped.push({ id, title: `commit ${hash.slice(0, 7)}`, reason: hit }); continue; }
    records.push({ id, source: 'tophat-git', revision: '1', time: at, title: `commit ${hash.slice(0, 7)} (${at.slice(0, 10)})`, text: `Commit ${hash.slice(0, 7)} on ${at.slice(0, 10)}: ${text}`, entities: entitiesOf(subject + ' ' + text, files), files: files.length });
    commits++;
  }
  sources.push({ source: 'git log', kind: 'commits', commits, head });

  mkdirSync(out, { recursive: true, mode: 0o755 });
  const write = (name, body) => { const tmp = path.join(out, `.${name}.${process.pid}`); writeFileSync(tmp, body, { mode: 0o644 }); renameSync(tmp, path.join(out, name)); };
  write('records.jsonl', records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const manifest = { at: new Date().toISOString(), repo_head: head, deny_list: deny.length ? `${deny.length} patterns` : 'absent', deny_file: denyFile ? 'yes' : 'no', private_patterns: PRIVATE.map(([n]) => n), sources, records: records.length, dropped, entities: ENTITIES.length };
  write('manifest.json', JSON.stringify(manifest, null, 1) + '\n');
  return manifest;
}
