// Where a tool's executable actually is, resolved without trusting PATH.
//
// This is one rule with one owner. It was written four times, and the fourth
// time it was written wrong, which is how it was found.
//
// The rule exists because of a measured failure this repository has now paid
// for three times. A LaunchAgent runs with PATH=/usr/bin:/bin:/usr/sbin:/sbin
// (io.tophat.webchat.plist), and rev5's scrubbedEnv passes that PATH straight
// through to anything it spawns, so /opt/homebrew/bin is not on it. A spawn
// that names a binary bare is then ENOENT for every installed tool, for ever,
// and the caller reports that as "found nothing" rather than "I could not run
// it". src/core/memory-evidence.mjs lost three nights of consolidation to it;
// src/automation/pdf-text.mjs went on looking in two Homebrew directories and
// nowhere else, although the owner's instructions say plainly that "`pdftotext`
// is in `~/.local/bin`", so under launchd every PDF attachment read answered
// pdf-extractor-unavailable.
//
// So: one list of directories, with ~/.local/bin on it, and one resolver.
// Callers keep their own tool name, their own environment override and their
// own error message, because what a MISSING binary means is the caller's
// question; where a binary IS is this module's.
//
// Never: spawn a bare tool name and let PATH decide, in anything that can run
// under launchd.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The system locations a tool is installed into on this Mac, in search order. */
export const SYSTEM_BIN_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin']);

/**
 * The directories to search for a tool: the system ones first, then any the
 * caller names (a language's own bin directory, say), then ~/.local/bin, which
 * is where the owner keeps what he installed himself and is the one place a
 * launchd PATH never reaches.
 */
export function binDirs(home = homedir(), extra = []) {
  return [...SYSTEM_BIN_DIRS, ...extra, join(home, '.local', 'bin')];
}

/** The absolute candidates for `name`, in search order. */
export function binaryCandidates(name, { home = homedir(), extra = [], dirs = binDirs(home, extra) } = {}) {
  return dirs.map((dir) => join(dir, name));
}

/**
 * An absolute path to `name`, or the bare name when none of the known
 * locations has it, so the caller can still report a usable error either way.
 *
 * `envVar` names an environment override for a machine that keeps the tool
 * somewhere else; it wins when the path it names exists. An override naming a
 * file that is not there is ignored rather than returned, because a resolver
 * that hands back a path it has just been told is absent is not a resolver.
 */
export function findBinary(name, {
  env = process.env, envVar = null, exists = existsSync,
  home = homedir(), extra = [], dirs = binDirs(home, extra),
} = {}) {
  const named = envVar ? env[envVar] : null;
  if (named && exists(named)) return named;
  for (const candidate of binaryCandidates(name, { dirs })) if (exists(candidate)) return candidate;
  return name;
}
