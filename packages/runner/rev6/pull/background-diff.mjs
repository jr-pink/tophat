// What a background turn changed on disk, read back mechanically so its report can show the diff itself. The runner
// takes a snapshot just before each round of tool calls (snapshotCalls) and, when the round was a background turn's,
// diffs it against the disk afterwards (diffSince). Judgment about what to say stays in the prompt (background.mjs
// backgroundReportText); this file only finds the edits.
//
// What it sees: write_file's path; for shell, every path the command text names (relative ones against the command's
// cwd or the `cd` it starts with) plus the git working tree of the directory it runs in, compared by `git status` before
// and after. A shell command that writes somewhere neither names nor git reports is the gap: the report then says the
// command looked like a write and no change was found, rather than claiming nothing changed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const FILE_CAP = 512 * 1024, PATH_CAP = 40;
/** Shell text that can change files; the git-status comparison runs only for these. */
export const SHELL_WRITES = /(?:^|[\s;&|(`])(?:sed\s+(?:-\w*i|--in-place)|perl\s+-\w*i|tee|patch|git\s+(?:apply|checkout|restore|reset|stash|rm|mv|am|cherry-pick|merge|rebase|commit|pull)|mv|cp|rm|install|truncate|dd|ln|touch|npm\s+(?:install|i|ci)|ed|ex|python3?|node|ruby|uv)\b|\d?>>?\s*[^\s&>]/u;

const MUTATORS = new Set(['write_file', 'shell']);
const git = (args, cwd) => { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const readText = (path) => {
  try { const s = statSync(path); if (!s.isFile()) return null; if (s.size > FILE_CAP) return { big: s.size }; return readFileSync(path, 'utf8'); } catch { return null; }
};
const same = (a, b) => (a === b) || (a && b && typeof a === 'object' && typeof b === 'object' && a.big === b.big);

/** The paths a call names, absolute, at most PATH_CAP. */
export function pathsOf(call, cwd, env = process.env) {
  const input = call?.input || {};
  const home = env.HOME || homedir();
  const at = (base, p) => resolve(isAbsolute(p) ? p : p.startsWith('~/') ? join(home, p.slice(2)) : join(base, p));
  if (call?.name === 'write_file') return input.path ? [at(cwd, String(input.path))] : [];
  if (call?.name !== 'shell') return [];
  const command = String(input.command || '');
  let base = input.cwd ? at(cwd, String(input.cwd)) : cwd;
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/u.exec(command);
  if (cd) base = at(base, cd[1].replace(/^["']|["']$/gu, ''));
  const out = new Set();
  for (const token of command.split(/[\s'"`;|&()<>=]+/u)) {
    if (!token || token.startsWith('-') || token.startsWith('/dev/') || !/[/.]/u.test(token)) continue;
    const path = at(base, token);
    if (existsSync(path) ? statSync(path).isFile() : existsSync(resolve(path, '..'))) out.add(path);
    if (out.size >= PATH_CAP) break;
  }
  return [...out];
}

/** The state of the disk a round of calls is about to change, or null when none of them can change files. */
export function snapshotCalls(calls, { cwd, env = process.env } = {}) {
  const mine = (calls || []).filter((c) => MUTATORS.has(c.name));
  if (!mine.length) return null;
  const files = new Map(), repos = new Map();
  let writes = false;
  for (const call of mine) {
    const base = call.input?.cwd ? resolve(cwd, String(call.input.cwd)) : cwd;
    for (const p of pathsOf(call, cwd, env)) if (!files.has(p)) files.set(p, readText(p));
    if (call.name === 'write_file' || SHELL_WRITES.test(String(call.input?.command || ''))) {
      writes = true;
      const root = git(['rev-parse', '--show-toplevel'], base)?.trim();
      if (root && !repos.has(root)) repos.set(root, git(['status', '--porcelain'], root));
    }
  }
  return { files, repos, writes, names: mine.map((c) => c.name) };
}

function unified(path, before, after) {
  if ((before && typeof before === 'object') || (after && typeof after === 'object')) return `${path}: changed (a file over ${FILE_CAP} bytes; not diffed)`;
  if (String(before ?? '').includes('\0') || String(after ?? '').includes('\0')) return `${path}: binary file changed`;
  const dir = mkdtempSync(join(tmpdir(), 'bgdiff-'));
  try {
    const a = join(dir, 'a'), b = join(dir, 'b');
    writeFileSync(a, before ?? ''); writeFileSync(b, after ?? '');
    const args = ['-u', '--label', before === null ? '/dev/null' : `a${path}`, '--label', after === null ? '/dev/null' : `b${path}`, a, b];
    try { execFileSync('diff', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }); return ''; }
    catch (error) { return error.status === 1 ? String(error.stdout || '') : `${path}: changed (diff failed: ${error.message})`; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The unified diff of everything the round changed since `snap`; '' when nothing was found. `note` is set when a shell write left no trace we can see. */
export function diffSince(snap) {
  if (!snap) return { text: '', note: '' };
  const parts = [], done = new Set();
  for (const [path, before] of snap.files) {
    const after = readText(path);
    if (same(before, after)) continue;
    done.add(path);
    const d = unified(path, before, after);
    if (d) parts.push(d.endsWith('\n') ? d.slice(0, -1) : d);
  }
  for (const [root, before] of snap.repos) {
    const after = git(['status', '--porcelain'], root);
    if (before === null || after === null) continue;
    const had = new Set(before.split('\n'));
    for (const line of after.split('\n')) {
      if (!line || had.has(line)) continue;
      const rel = line.slice(3).replace(/^"|"$/gu, '').split(' -> ').pop(), path = join(root, rel);
      if (done.has(path)) continue;
      done.add(path);
      if (rel.endsWith('/')) { parts.push(`${path}: new directory (untracked)`); continue; }
      const tracked = git(['ls-files', '--error-unmatch', '--', rel], root) !== null;
      const d = tracked ? git(['diff', 'HEAD', '--no-color', '--', rel], root) : unified(path, null, readText(path));
      parts.push(d ? d.replace(/\n$/u, '') : `${path}: ${line.slice(0, 2).trim() || 'changed'} (git status)`);
    }
  }
  const text = parts.join('\n');
  return { text, note: !text && snap.writes ? 'a call looked like it could write files, but no change was found in the paths it names or in the git working tree it ran in' : '' };
}
