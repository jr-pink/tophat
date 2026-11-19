// The per-turn grant behind the host door (host-door.js; docs/HOST-DESIGN.md item 5).
//
// The boundary is the grant. A grant is minted by this (home) host for one chat the owner is in, for one turn he started; it dies when that
// turn and everything it started have ended (host-door.js) or at the 2 hour cap after his last message in the chat. A restart of this host
// does not end it: host-door.js keeps the open grants in an owner-only file and restores them under the same ids on boot. Who may use a
// grant is decided by the door (the chat key plus the subagent the caller names, mapped to its grant by the team host's ledger), not by a
// token held per grant. Inside it the door is
// plain access as his user: run a command, read or write any file he could. There are no path fences, because a command could step over
// any of them. What stays: a timeout and an output cap on commands, a size cap on what a read returns, and one append-only log line per call.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, open, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const GRANT_TTL_MS = 2 * 60 * 60_000; // the hard cap: 2 h after his last message in the chat
export const READ_BYTES = 8_000_000;    // what one read returns (the rest is marked truncated)
export const WRITE_BYTES = 8_000_000;   // one write body
export const MAX_ENTRIES = 2000;        // one listing
export const EXEC_TIMEOUT_MS = 120_000;
export const EXEC_TIMEOUT_CAP_MS = 10 * 60_000;
export const EXEC_OUTPUT_BYTES = 200_000;

export class GrantError extends Error { constructor(message, status) { super(message); this.status = status; } }

export function createGrantBook({ now = () => Date.now(), makeId = () => randomBytes(6).toString('hex') } = {}) {
  const byId = new Map(); // grant id -> grant (one per turn; a chat may hold several while earlier turns' work still runs)
  const view = (g) => ({ id: g.id, chatId: g.chatId, root: g.root, expiresAt: new Date(g.expiresAt).toISOString() });
  return {
    /** A new grant for one turn of the chat. `root` is the chat folder, the default cwd. */
    grant(chatId, root, { ttlMs = GRANT_TTL_MS } = {}) {
      const g = { id: makeId(), chatId: String(chatId), root, expiresAt: now() + ttlMs };
      byId.set(g.id, g);
      return view(g);
    },
    /** A grant that was live before a restart, under its own id (host-door.js restores its doors on boot). */
    restore({ id, chatId, root, expiresAt }) {
      if (!id || !chatId || !root || !(expiresAt > now())) return null;
      const g = { id: String(id), chatId: String(chatId), root, expiresAt };
      byId.set(g.id, g);
      return view(g);
    },
    revoke(grantId) { return byId.delete(String(grantId)); },
    /** Move a live grant's end to `untilMs` (his next message in the chat pushes the hard cap out). */
    extend(grantId, untilMs) { const g = byId.get(String(grantId)); if (!g) return false; g.expiresAt = untilMs; return true; },
    /** The live grant with this id, else null; an expired one is removed on the way. The door's caller proof is the chat key and the agent it
     *  presents (host-door.js), never a token per grant. */
    get(id) {
      const g = byId.get(String(id));
      if (!g) return null;
      if (g.expiresAt <= now()) { byId.delete(g.id); return null; }
      return g;
    },
    /** What is granted now (for a status line). */
    active() { return [...byId.values()].map(view); }
  };
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** A path as he would type it: `~` is his home (his own paths, not a store: the one homedir() the lint allows here), a relative path is under the chat folder. */
const place = (grant, p) => { const s = String(p || '.').replace(/^~(?=\/|$)/u, homedir()); return isAbsolute(s) ? resolve(s) : resolve(grant.root, s); };

/** One append-only line per door call: { at, chat, grant, op, path|cwd, ..., exit }. */
export async function logCall(logPath, line) {
  if (!logPath) return;
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(line) + '\n');
}

/** A folder listing. */
export async function listPath(grant, requested) {
  const at = place(grant, requested);
  let all;
  try { all = await readdir(at, { withFileTypes: true }); } catch (cause) { throw new GrantError(cause.code === 'ENOTDIR' ? 'not a folder' : 'no such folder', cause.code === 'ENOTDIR' ? 400 : 404); }
  return { path: at, entries: all.slice(0, MAX_ENTRIES).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)), truncated: all.length > MAX_ENTRIES };
}

/** The bytes of one file, up to READ_BYTES (`truncated` marks the rest). */
export async function catPath(grant, requested) {
  const at = place(grant, requested);
  let s;
  try { s = await stat(at); } catch { throw new GrantError('no such file', 404); }
  if (s.isDirectory()) throw new GrantError('that path is a folder', 400);
  const handle = await open(at, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(s.size, READ_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { path: at, size: s.size, bytes: buffer.subarray(0, bytesRead), truncated: s.size > READ_BYTES };
  } finally { await handle.close(); }
}

/** Replace or create one file (temp + rename, mode kept, parent folders made). */
export async function writePath(grant, requested, bytes) {
  if (!requested) throw new GrantError('a path is required', 400);
  let at = place(grant, requested);
  try { at = await realpath(at); } catch { /* a new file */ }
  let mode = null;
  try { const s = await stat(at); if (s.isDirectory()) throw new GrantError('that path is a folder', 400); mode = s.mode & 0o7777; } catch (cause) { if (cause instanceof GrantError) throw cause; }
  await mkdir(dirname(at), { recursive: true });
  const tmp = `${at}.door-${process.pid}-${Date.now()}.tmp`;
  await writeFile(tmp, bytes, mode != null ? { mode } : {});
  await rename(tmp, at);
  return { kind: 'written', path: at, bytes: bytes.length, sha256: sha(bytes) };
}

/**
 * Run one command as this user with this server's environment. `argv` (array, no shell) or `shell` (a string for /bin/bash -c); `cwd`
 * defaults to the chat folder. Timeout (default 120 s, cap 10 min) kills the process group; stdout and stderr are kept up to
 * EXEC_OUTPUT_BYTES together (`truncated` marks a cut). `onSpawn(child)` lets the door kill it when the grant ends.
 */
export async function execCommand(grant, { argv = null, shell = null, cwd = null, timeoutMs = EXEC_TIMEOUT_MS } = {}, { onSpawn = () => {}, env = process.env } = {}) {
  const hasArgv = Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string');
  const hasShell = typeof shell === 'string' && shell.trim() !== '';
  if (hasArgv === hasShell) throw new GrantError('give exactly one of argv (an array of strings) or shell (a string)', 400);
  const dir = place(grant, cwd || '.');
  try { if (!(await stat(dir)).isDirectory()) throw new Error(); } catch { throw new GrantError('cwd is not a folder', 400); }
  const limit = Math.min(Math.max(Number(timeoutMs) || EXEC_TIMEOUT_MS, 1000), EXEC_TIMEOUT_CAP_MS);
  const [cmd, args] = hasArgv ? [argv[0], argv.slice(1)] : ['/bin/bash', ['-c', shell]];
  const started = Date.now();
  const kept = []; let keptBytes = 0, truncated = false, timedOut = false;
  const result = await new Promise((done) => {
    let child;
    try { child = spawn(cmd, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (cause) { done({ exit: null, signal: null, error: cause.message }); return; }
    onSpawn(child);
    const take = (stream) => (chunk) => {
      const room = EXEC_OUTPUT_BYTES - keptBytes;
      if (room <= 0) { truncated = true; return; }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      kept.push({ stream, part }); keptBytes += part.length;
    };
    child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, limit);
    child.on('error', (e) => { clearTimeout(timer); done({ exit: null, signal: null, error: e.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); done({ exit: code, signal }); });
  });
  const text = (which) => Buffer.concat(kept.filter((k) => k.stream === which).map((k) => k.part)).toString('utf8');
  return { kind: 'exec', cwd: dir, exit: result.exit, signal: result.signal || null, timedOut, ms: Date.now() - started,
    stdout: text('stdout'), stderr: text('stderr'), truncated, ...(result.error ? { error: result.error } : {}) };
}

/** The command the home host runs to open the reverse path while a grant lives (the caller kills it when the grant ends). */
export function reverseTunnelArgv({ teamHost, remotePort, localPort }) {
  if (!/^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/u.test(String(teamHost || ''))) throw new Error('a team host name is required');
  for (const p of [remotePort, localPort]) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('ports must be unprivileged integers');
  return ['ssh', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, teamHost];
}
