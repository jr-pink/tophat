// A per-chat, per-turn read path from a team host back to his home host (docs/HOST-DESIGN.md, item 5. PROTOTYPE, read-only, and nothing here
// opens a port or a tunnel by itself.
//
// The model. The home host (the one holding the files) grants; the team host never reaches in on its own.
//   grant      a random token bound to one chat and one folder (the chat's cwd, as a real path), valid until the turn ends (remote-runtime
//              endTurn revokes it), the TTL passes, or the home restarts (grants live in memory only).
//   door       GET /api/hostfile (routes/api/hostfile): loopback only, not through the tunnel proxy, the grant token as the bearer. It answers
//              a listing or the text of one file under the grant's folder, never a credential store, never outside it by `..` or a symlink.
//   path       the home host starts the reverse tunnel when it grants (reverseTunnelArgv: ssh -N -R 127.0.0.1:<port>:127.0.0.1:<home webchat
//              port> <team host>), so the team host's loopback port reaches only this door; the team host's runner is handed the port and token
//              as injected context (op inject: not a message, not memory). The tunnel is killed when the grant ends.
// Writes ("the runner on server should be able to edit the files on my mac") are not here: see the design doc, they need a separate
// grant mode with a per-write ledger and his confirmation, and are not built.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { credential } from './files.js';

export const GRANT_TTL_MS = 30 * 60_000;
export const MAX_READS = 300;
export const MAX_BYTES = 400_000;
export const MAX_ENTRIES = 500;

export class GrantError extends Error { constructor(message, status) { super(message); this.status = status; } }

export function createGrantBook({ now = () => Date.now(), makeToken = () => randomBytes(24).toString('base64url'), makeId = () => randomBytes(6).toString('hex') } = {}) {
  const byChat = new Map(); // chat id -> grant
  return {
    /** A new grant for the chat (any earlier one for it is replaced). `root` must already be a real path. */
    grant(chatId, root, { ttlMs = GRANT_TTL_MS } = {}) {
      const g = { id: makeId(), chatId: String(chatId), root, token: makeToken(), expiresAt: now() + ttlMs, reads: 0 };
      byChat.set(g.chatId, g);
      return { id: g.id, token: g.token, expiresAt: new Date(g.expiresAt).toISOString(), root };
    },
    revoke(chatId) { return byChat.delete(String(chatId)); },
    /** The live grant this id and token name, else null; an expired one is removed on the way. */
    authorize(id, token) {
      for (const g of byChat.values()) {
        if (g.id !== String(id)) continue;
        if (g.expiresAt <= now()) { byChat.delete(g.chatId); return null; }
        const a = Buffer.from(String(token ?? '')), b = Buffer.from(g.token);
        return a.length === b.length && timingSafeEqual(a, b) ? g : null;
      }
      return null;
    },
    /** What is granted now, without the tokens (for a status line). */
    active() { return [...byChat.values()].map((g) => ({ id: g.id, chat: g.chatId, root: g.root, expiresAt: new Date(g.expiresAt).toISOString(), reads: g.reads })); }
  };
}

/** The listing or text of one path under the grant's folder. Throws GrantError (403 outside the folder or a credential, 404 absent, 429 over the read cap). */
export async function readUnderGrant(grant, requested) {
  if (grant.reads >= MAX_READS) throw new GrantError('read limit for this turn reached', 429);
  grant.reads += 1;
  const rootReal = await realpath(grant.root);
  const wanted = String(requested || '.').replace(/^~(?=\/|$)/u, '');
  const joined = isAbsolute(wanted) ? wanted : join(rootReal, wanted);
  let real;
  try { real = await realpath(joined); } catch { throw new GrantError('no such path', 404); }
  // Containment is on the real path: a `..` or a symlink that leaves the folder is the same refusal as naming the outside path.
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new GrantError('outside the folder this turn was granted', 403);
  if (credential(real)) throw new GrantError('credential stores are never served', 403);
  const s = await stat(real);
  if (s.isDirectory()) {
    const names = (await readdir(real, { withFileTypes: true })).filter((d) => !credential(join(real, d.name))).slice(0, MAX_ENTRIES);
    return { kind: 'dir', path: real, entries: names.map((d) => (d.isDirectory() ? `${d.name}/` : d.name)) };
  }
  const handle = await open(real, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(s.size, MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { kind: 'file', path: real, size: s.size, binary: true };
    return { kind: 'file', path: real, size: s.size, mtime: s.mtimeMs, text: bytes.toString('utf8'), truncated: s.size > MAX_BYTES };
  } finally { await handle.close(); }
}

/** The command the home host runs to open the reverse path while a grant lives (not run by this module; the caller kills it when the grant ends). */
export function reverseTunnelArgv({ teamHost, remotePort, localPort }) {
  if (!/^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/u.test(String(teamHost || ''))) throw new Error('a team host name is required');
  for (const p of [remotePort, localPort]) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('ports must be unprivileged integers');
  return ['ssh', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, teamHost];
}
