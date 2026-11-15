// Where a child process finds store/cli.mjs, and the directory it runs in.
//
// A runner is a long-lived process: a restart hands its conversation to the new server and the runner keeps going from the
// release it was started from. If that release directory is removed while it runs (2026-11-14: a hand `rm -rf` of old
// release trees), every spawn with `cwd: <own repo>` failed with
// `spawnSync .../bin/node ENOENT` (the kernel reports the missing cwd as a missing binary), so goal_close, task and memory
// tools died in every older live chat. The modules already loaded keep working; only the children need a directory that exists.
// So the store checkout is the first of these that still holds store/cli.mjs: TOPHAT_REPO (the launcher's stable path),
// this file's own package, the runner runtime dirs the launcher named. None left is a clear error, never a bare ENOENT.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OWN_REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** Candidate checkouts, in order of preference, deduplicated. */
export function storeRepoCandidates(env = process.env, own = OWN_REPO) {
  return [...new Set([env.TOPHAT_REPO, own, env.TOPHAT_RUNNER_RUNTIME_DIR, env.TOPHAT_RUNTIME_DIR].filter(Boolean))];
}

/** The first candidate holding store/cli.mjs; throws naming every candidate when none does. */
export function storeRepo(env = process.env, own = OWN_REPO) {
  const candidates = storeRepoCandidates(env, own);
  for (const dir of candidates) if (existsSync(join(dir, 'store', 'cli.mjs'))) return dir;
  throw Object.assign(new Error(`store/cli.mjs is in none of ${candidates.join(', ')}: the release this process runs from was removed while it ran; set TOPHAT_REPO to a live checkout or restart this chat's runner`), { code: 'store_repo_missing' });
}
