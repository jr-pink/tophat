import os from 'node:os';
import path from 'node:path';

// A test process must never resolve a path into the owner's live tophat state.
//
// Fixtures that called loadConfig({home: tmp}) therefore got the live stateDir,
// and tests truncated ~/.local/state/tophat/memory.sqlite (the 2.2 GB events
// plane, unrecoverable) and wrote fixture keys and archive jobs into it.
// scripts/test.sh strips the environment, but a bare `node --test` bypasses it, so
// the refusal lives here, in the resolvers every fixture goes through.
//
// "Under test" is the node test runner (it sets NODE_TEST_CONTEXT in every test
// child, and --test in execArgv for an in-process run) or a *.test.mjs entry run
// directly. "Live" is decided from the account's real home directory
// (os.userInfo, not os.homedir, which tests/isolate-env.mjs repoints).

export function underTest(env = process.env, argv = process.argv, execArgv = process.execArgv) {
  if (env.NODE_TEST_CONTEXT) return true;
  if (env.VITEST) return true;
  if ((execArgv || []).some(arg => arg === '--test' || arg.startsWith('--test='))) return true;
  return /\.test\.m?js$/.test(String(argv?.[1] || ''));
}

export function realHome(env = process.env) {
  try { return os.userInfo().homedir; } catch { return env.TOPHAT_TEST_REAL_HOME || os.homedir(); }
}

export function liveRoots(home = realHome()) {
  return [
    path.join(home, '.local', 'state', 'tophat'),
    path.join(home, '.local', 'state', 'tophat-rev5'),
    path.join(home, '.local', 'state', 'tophat-old'),
    path.join(home, '.local', 'share', 'tophat'),
    path.join(home, '.config', 'tophat'),
  ];
}

export function isLive(target, roots = liveRoots()) {
  if (typeof target !== 'string' || !target) return false;
  const resolved = path.resolve(target);
  return roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

/** Throws when a test process resolves `target` into live state. A no-op outside tests. */
export function refuseLiveUnderTest(target, what, { env = process.env, argv = process.argv, execArgv = process.execArgv, roots } = {}) {
  if (!underTest(env, argv, execArgv)) return target;
  if (!isLive(target, roots ?? liveRoots(realHome(env)))) return target;
  throw new Error(`live-state guard: ${what} resolves to ${target}, the owner's live tophat state, inside a test process. `
    + 'Give the fixture a temp home (loadConfig({home})) or run the suite through scripts/test.sh. See src/live-state-guard.mjs.');
}
