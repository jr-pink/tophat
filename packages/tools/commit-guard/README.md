# tophat-commit-guard

A `pre-commit` hook that refuses a commit carrying a byte-exact reversion of an earlier commit's change to a file.
Source: `packages/tools/commit-guard/tophat-commit-guard`. Install it once per checkout:

```sh
tophat-commit-guard install     # writes .git/hooks/pre-commit (it names this script by absolute path; re-run if the tool moves)
tophat-commit-guard status
tophat-commit-guard check       # what the hook runs; exit 1 means refuse
tophat-commit-guard uninstall
```

Escapes, for a revert you mean: `TOPHAT_ALLOW_REVERT=1 git commit ...` or `git commit --no-verify`.
Merges, cherry-picks, reverts and rebases are skipped, as is a commit touching more than 200 paths.
Cost is two `git rev-list`/`rev-parse` calls per staged path.

## The failure it exists for

Several agent sessions can share one checkout, and a checkout has one index.

- Session A commits with an explicit pathspec, so it takes only its own files.
- Session B, comparing an unrelated test failure against the older file, runs
  `git checkout HEAD~1 -- path/to/file ... ; git checkout HEAD -- path/to/file`.
  `git checkout <rev> -- <path>` writes the old blob into **the index** as well as the working tree.
- Seconds later, session C commits its own work with `git add a b && git commit -m ...`: no pathspec, so the commit
  takes the whole index, session B's staged reversion included. The reversion lands unnoticed (B's trailing
  `git checkout HEAD -- <path>` resolves HEAD to the new commit and "restores" the clobbered file, so `git status`
  comes back clean).

Two habits avoid it and neither can be relied on, which is why the check is mechanical:

- Commit with a pathspec: `git commit -m ... -- path1 path2`. `git add` plus a bare `git commit` commits whatever else
  is in the shared index.
- To read an old version of a file, use `git show REV:path > path` (or into `/tmp`), not `git checkout REV -- path`,
  which stages it.
