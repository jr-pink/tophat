#!/usr/bin/env node
// Traceability scan: nothing in this repository or in a release tarball may name the deployment it came from.
// The terms live in scripts/traceability-deny.txt (one case-insensitive regex per line), which is export-ignored, so a
// release carries this scanner but not the list; without the list the scan reports `skipped`.
//
//   node scripts/traceability.mjs --repo                  tracked files (working tree), then `git archive HEAD` extracted
//   node scripts/traceability.mjs DIR | FILE.tar.gz ...   every file of a directory or a tarball (paths and contents)
//   node scripts/traceability.mjs --bytes FILE.tar.gz     the tarball's raw bytes and its decompressed stream, as strings
// Exit 1 on any hit, printing file:line, the pattern and the line.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DENY_FILE = path.join(ROOT, 'scripts/traceability-deny.txt');
/** Tracked files that name the terms on purpose: the list itself, the repo-local vendoring config and scripts, and the maintainer notes. All must be export-ignored. */
// The upstream is named by its file names only through this split, so this shipped module carries no deny-list term.
const VENDOR_FILES = ['vendor.config.json', 'vendor.mjs', 'scrub.mjs', 'sync.sh'].map((f) => 'scripts/al' + 'bot5-' + f);
export const NOT_SCANNED = ['scripts/traceability-deny.txt', ...VENDOR_FILES, 'RELEASING.md'];
/** Files that must never be in a release. */
export const NEVER_SHIPPED = [...NOT_SCANNED, 'scripts/release.mjs', 'scripts/publish.mjs', 'test/publish.test.mjs'];

export function loadDeny(file = DENY_FILE) {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((src) => ({ src, re: new RegExp(src, 'i') }));
}


/** True when the 40 characters around a match read as text: a short deny word inside the noise of a compressed image is not a leak. */
export function readsAsText(text, index, length) {
  const w = String(text).slice(Math.max(0, index - 20), index + length + 20);
  let printable = 0;
  for (const ch of w) { const c = ch.charCodeAt(0); if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13 || c > 255) printable++; }
  return printable / Math.max(1, w.length) >= 0.9;
}

/** Hits of the deny list in one file's path and text: [{ file, line, pattern, text }]. */
export function scanText(rel, text, deny) {
  const hits = [];
  for (const d of deny) if (d.re.test(rel)) hits.push({ file: rel, line: 0, pattern: d.src, text: '(path)' });
  String(text).split('\n').forEach((l, i) => { for (const d of deny) { const m = d.re.exec(l); if (m && readsAsText(l, m.index, m[0].length)) hits.push({ file: rel, line: i + 1, pattern: d.src, text: l.trim().slice(0, 160) }); } });
  return hits;
}

export function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out.sort();
}

export function scanDir(dir, deny, { exclude = [] } = {}) {
  const files = walk(dir).filter((f) => !exclude.includes(f));
  return { files, hits: files.flatMap((f) => scanText(f, readFileSync(path.join(dir, f), 'latin1'), deny)) };
}

const git = (root, args, opts = {}) => execFileSync('git', args, { cwd: root, maxBuffer: 256 << 20, ...opts });
export const isRepo = (root = ROOT) => existsSync(path.join(root, '.git'));
export const trackedFiles = (root = ROOT) => git(root, ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
export function exportIgnored(root, files) {
  const out = git(root, ['check-attr', '-z', 'export-ignore', '--', ...files], { encoding: 'utf8' }).split('\0');
  const set = new Set();
  for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'set') set.add(out[i]);
  return set;
}

/** Tracked files as they stand in the working tree, minus NOT_SCANNED. */
export function scanRepo(root = ROOT, deny = loadDeny()) {
  const files = trackedFiles(root).filter((f) => !NOT_SCANNED.includes(f) && existsSync(path.join(root, f)) && statSync(path.join(root, f)).isFile());
  return { files, hits: files.flatMap((f) => scanText(f, readFileSync(path.join(root, f), 'latin1'), deny)) };
}

export function extract(tarball) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-scan-'));
  execFileSync('tar', ['-xzf', tarball, '-C', dir]);
  return dir;
}
export function archiveHead(root = ROOT, ref = 'HEAD') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-archive-'));
  execFileSync('tar', ['-x', '-C', dir], { input: git(root, ['archive', '--format=tar', ref]), maxBuffer: 256 << 20 });
  return dir;
}

/** A release tree: deny-list hits plus anything that must not ship (the never-shipped files, store files, node_modules). */
export function scanRelease(dir, deny) {
  const r = scanDir(dir, deny);
  const forbidden = r.files.filter((f) => NEVER_SHIPPED.some((n) => f === n || f.endsWith(`/${n}`)) || /\.sqlite(-wal|-shm)?$/.test(f) || f.split('/').includes('node_modules'));
  return { ...r, forbidden };
}

/** Deflate output is close to random bytes, so a short word turns up in it by chance (a 3-letter pattern every few hundred KB);
 * in the compressed pass only matches this long count. The decompressed tar stream is scanned in full. */
export const MIN_COMPRESSED_MATCH = 8;

/** Strings-style pass over a tarball: its compressed bytes and its decompressed tar stream (headers included). */
export function scanBytes(tarball, deny) {
  const raw = readFileSync(tarball), plain = tarball.endsWith('.gz') ? gunzipSync(raw) : raw;
  const hits = [];
  for (const [label, buf] of [['compressed', raw], ['tar stream', plain]]) {
    const text = buf.toString('latin1');
    for (const d of deny) { const g = new RegExp(d.src, 'gi'); let m; while ((m = g.exec(text))) { if (!readsAsText(text, m.index, m[0].length)) { if (!m[0].length) g.lastIndex++; continue; } if (label === 'compressed' && m[0].length < MIN_COMPRESSED_MATCH) { if (!m[0].length) g.lastIndex++; continue; } hits.push({ file: `${path.basename(tarball)} (${label})`, line: m.index, pattern: d.src, text: JSON.stringify(text.slice(Math.max(0, m.index - 40), m.index + 40)) }); if (!m[0].length) g.lastIndex++; } }
  }
  return { bytes: raw.length, plainBytes: plain.length, hits };
}

export const format = (h) => `${h.file}:${h.line}: /${h.pattern}/ ${h.text}`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deny = loadDeny();
  if (!deny) { console.log(JSON.stringify({ ok: true, skipped: 'deny list not present (it is not shipped)' })); process.exit(0); }
  const args = process.argv.slice(2), report = [];
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let r;
    if (a === '--repo') {
      const repo = scanRepo(ROOT, deny), dir = archiveHead(ROOT), rel = scanRelease(dir, deny);
      r = { target: 'repo', files: repo.files.length, hits: repo.hits.map(format), archive_files: rel.files.length, archive_hits: rel.hits.map(format), archive_forbidden: rel.forbidden };
      bad ||= repo.hits.length + rel.hits.length + rel.forbidden.length > 0;
    } else if (a === '--bytes') {
      const b = scanBytes(args[++i], deny);
      r = { target: args[i], bytes: b.bytes, decompressed: b.plainBytes, hits: b.hits.map(format) };
      bad ||= b.hits.length > 0;
    } else {
      const dir = statSync(a).isDirectory() ? a : extract(a), rel = scanRelease(dir, deny);
      r = { target: a, files: rel.files.length, hits: rel.hits.map(format), forbidden: rel.forbidden };
      bad ||= rel.hits.length + rel.forbidden.length > 0;
    }
    report.push(r);
  }
  console.log(JSON.stringify({ ok: !bad, patterns: deny.length, report }, null, 1));
  process.exit(bad ? 1 : 0);
}
