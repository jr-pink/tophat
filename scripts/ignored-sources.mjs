// Source files the app assembly reads from the upstream checkout that git does not track because an ignore rule covers
// them. Such a file exists on the working disk and in the assembled output, but a clean checkout of the same commit
// lacks it, so an assembly run from one silently drops the file (the two /api/mp state routes went that way: a
// `state/` ignore rule matched their directory). The assembly refuses to run while any file of its closure is in
// that state, and says which rule to fix upstream.
import { execFileSync } from 'node:child_process';

/** Files of `files` (paths relative to `dir`, forward slashes) that exist untracked and ignored in the git work tree at `dir`. */
export function ignoredSources(dir, files) {
  try { execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, stdio: 'ignore' }); }
  catch { return []; } // not a git checkout: nothing to compare against
  const ignored = new Set(execFileSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.'], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0').filter(Boolean));
  return files.filter((f) => ignored.has(f));
}
