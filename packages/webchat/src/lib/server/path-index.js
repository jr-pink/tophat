// A file-name index of the places a reply's relative path may point into, for the last resort of
// shorthand lookup: "recent-communications.md", "relays/", "THEMES.md" written from a folder that no
// repository tracks and no conversation named an absolute path in. Walking those trees on a click is
// minutes; a list refreshed in the background is a grep.
//
// One text file, `name<TAB>absolute path` per line (folders with a trailing slash), sorted bytewise so a
// lookup is a binary search on the name, rebuilt by `find | awk | sort` at low priority at most every
// REFRESH_MS and swapped in by rename, so a reader never sees half a list. It holds names only. What a hit may be opened as is still decided by the caller: openablePath and the credential
// guard run on every candidate, so listing a file here never serves it.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { webchatStorePath } from './paths.js';

const REFRESH_MS = 30 * 60_000;
const BUILD_LIMIT_MS = 15 * 60_000;
const home = () => process.env.WEBCHAT_HOME || homedir();

// Where relative names usually point: state, config, projects and the folders he keeps files in.
export const indexRoots = () => (process.env.WEBCHAT_INDEX_ROOTS
  ?? '~/.local/state:~/.local/share:~/.config:~/.claude:~/projects:~/Documents:~/Desktop:~/Downloads')
  .split(':').filter(Boolean).map((root) => resolve(root.replace(/^~(?=\/|$)/u, home())));
// evaluation (1.3M captured runs), chrome-cdp (browser profiles) and fuzz corpora are bulk, not files a reply points at.
const PRUNED = ['node_modules', '.git', '.cache', '.npm', '.cargo', '.rustup', 'site-packages', '.Trash', 'migration-from-old', '__pycache__', '.venv', 'evaluation', 'chrome-cdp', 'fuzz', '.build'];
export const indexFile = () => process.env.WEBCHAT_PATH_INDEX || webchatStorePath('path-index.txt');

let building = null;

export function indexAge() {
  try { return Date.now() - statSync(indexFile()).mtimeMs; } catch { return Infinity; }
}

/** Rebuild the list now. Resolves when the new list is in place (or the build failed or timed out). */
export function buildIndex() {
  if (building) return building;
  const target = indexFile();
  const part = `${target}.${process.pid}.part`;
  building = new Promise((done) => {
    try { mkdirSync(dirname(target), { recursive: true }); } catch {  }
    const roots = indexRoots().filter((root) => existsSync(root));
    if (!roots.length) { done(false); return; }
    const prune = PRUNED.flatMap((name, index) => (index ? ['-o', '-name', name] : ['-name', name]));
    // Folders are printed with a trailing slash, files as they are, in one walk; the name is the last
    // segment; the sort is bytewise so searchIndex can bisect it.
    const find = [...roots, '-xdev', '(', ...prune, ')', '-prune', '-o', '-type', 'd', '-exec', 'printf', '%s/\\n', '{}', '+', '-o', '-type', 'f', '-print'];
    const pipeline = `find "$@" | awk '{n=$0; sub(/\\/$/, "", n); sub(/.*\\//, "", n); print n "\\t" $0}' | LC_ALL=C sort > "$PART"`;
    const child = spawn('nice', ['-n', '15', 'sh', '-c', pipeline, 'sh', ...find], { stdio: 'ignore', detached: true, env: { ...process.env, PART: part } });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid); } catch { child.kill(); } }, BUILD_LIMIT_MS);
    child.on('error', () => { clearTimeout(timer); rmSync(part, { force: true }); done(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) { rmSync(part, { force: true }); done(false); return; }
      try { renameSync(part, target); done(true); } catch { rmSync(part, { force: true }); done(false); }
    });
  }).finally(() => { building = null; });
  return building;
}

/** Start a rebuild in the background when the list is missing or stale; never waits. */
export function refreshIndex() {
  if (!building && indexAge() > REFRESH_MS) buildIndex();
}

const CHUNK = 8192;
function lineStart(fd, pos) {
  if (pos <= 0) return 0;
  const length = Math.min(CHUNK, pos);
  const buffer = Buffer.alloc(length);
  readSync(fd, buffer, 0, length, pos - length);
  const at = buffer.lastIndexOf(10);
  return at === -1 ? pos - length : pos - length + at + 1;
}
function lineAt(fd, start, size) {
  const length = Math.min(CHUNK, size - start);
  if (length <= 0) return null;
  const buffer = Buffer.alloc(length);
  readSync(fd, buffer, 0, length, start);
  const at = buffer.indexOf(10);
  return { text: buffer.subarray(0, at === -1 ? length : at), next: start + (at === -1 ? length : at + 1) };
}

/**
 * Every listed path that ends in the given tail, as whole segments ("clean/a.json" matches
 * ".../desert-reader/clean/a.json", not ".../xclean/a.json"). A tail ending in "/" names a folder
 * (returned without the slash). Bisects the sorted list by the tail's last segment.
 */
export function searchIndex(tail, { limit = 400 } = {}) {
  const wanted = String(tail || '').replace(/^\/+/u, '');
  const name = wanted.replace(/\/+$/u, '').split('/').pop();
  const file = indexFile();
  if (!name || !existsSync(file)) return Promise.resolve([]);
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const key = Buffer.from(`${name}\t`);
    let lo = 0, hi = size;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const start = lineStart(fd, mid);
      const line = lineAt(fd, start, size);
      if (!line) { hi = start; continue; }
      if (Buffer.compare(line.text.subarray(0, key.length), key) < 0) lo = line.next; else hi = start;
    }
    const hits = [];
    for (let at = lo; at < size && hits.length < limit;) {
      const line = lineAt(fd, at, size);
      if (!line || !line.text.subarray(0, key.length).equals(key)) break;
      const path = line.text.subarray(key.length).toString('utf8');
      if (path === `/${wanted}` || path.endsWith(`/${wanted}`)) hits.push(path);
      at = line.next;
    }
    return Promise.resolve(hits);
  } catch {
    return Promise.resolve([]);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {  }
  }
}
