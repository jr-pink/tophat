// The machine-surface gate: loopback, not through the tunnel, and the service token.
//
// Several routes here are doors for programs on this Mac rather than for his browser:
// /api/inbound wakes a chat, /api/replies/projection reconciles the Beeper badge, /api/health is
// what the deploy guard reads, and /api/agent and /api/state let a running agent touch its own chat
// and his notes. Every one of them asks the same questions, and every one of them answered by hand:
// the same three loopback literals in five files, with the same token read and timing-safe compare
// copied in beside two of them.
//
// Five copies of an authorization rule is five places for it to drift, and the half that loosens is
// the half nobody notices. The rule lives here:
//
//   loopback  the peer is 127.0.0.1, ::1 or ::ffff:127.0.0.1, and an address the adapter cannot
//             give is never local
//   direct    no x-forwarded-for and no cf-connecting-ip: cloudflared sets those, so a request
//             carrying one came through the tunnel however local the socket looks
//   token     Authorization: Bearer <the one line of TOPHAT_SECRETS_DIR/webchat-service-token>,
//             compared in constant time; an unreadable or empty token file refuses everything
//
// Every refusal answers 404 at the caller, never 401 or 403: a machine surface does not tell a
// stranger it is there. The caller writes that response itself, so nothing here imports
// @sveltejs/kit and tests/local-gate.test.mjs can drive the rule directly.
//
// Two shapes, one rule. `localRefusal` reads the token file synchronously, which is what a GET that
// was already doing synchronous work can afford; `localRefusalAsync` awaits the read, because a read
// on the HTTP thread waits on the disk like any other, and /api/inbound is on the path that wakes a
// chat. They differ in nothing else, and neither reads anything when the caller passes `expected` or
// asks only about reach.
//
// /api/replies/projection and /api/inbound ask through this. /api/health (loopback only), /api/agent
// and /api/state still carry their own copies; finishing that is the rest of this merge, and those
// three are the only places that should ever grow one again.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { secretsDir } from './secrets.js';

export const LOOPBACK = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const SERVICE_TOKEN_FILE = 'webchat-service-token';

export const isLoopback = (address) => LOOPBACK.includes(String(address ?? ''));

/** The peer address, or '' when the adapter cannot say. An unknown peer is not local. */
export function clientAddress(event) {
  try { return event.getClientAddress(); } catch { return ''; }
}

export const throughProxy = (request) =>
  request.headers.has('x-forwarded-for') || request.headers.has('cf-connecting-ip');

/** The service token as webchat/scripts/start.mjs writes it, or '' when it cannot be read. */
export function serviceToken(dir = secretsDir()) {
  try { return readFileSync(join(dir, SERVICE_TOKEN_FILE), 'utf8').trim(); } catch { return ''; }
}

/** The same token, read off the HTTP thread. */
export async function serviceTokenAsync(dir = secretsDir()) {
  try { return (await readFile(join(dir, SERVICE_TOKEN_FILE), 'utf8')).trim(); } catch { return ''; }
}

/** Constant-time compare of the request's bearer against the service token. */
export function tokenMatches(request, expected = serviceToken()) {
  if (!expected) return false;
  const given = Buffer.from((request.headers.get('authorization') || '').replace(/^Bearer /iu, ''));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The half of the rule that needs no file: who the peer is and how the request got here. */
function reachRefusal(event) {
  if (!isLoopback(clientAddress(event))) return 'not-loopback';
  if (throughProxy(event.request)) return 'through-proxy';
  return null;
}

/**
 * Why this request may not touch a machine surface, or null when it may: 'not-loopback',
 * 'through-proxy' or 'bad-token'. Pass `token: true` for a surface that can act; health is
 * loopback alone.
 */
export function localRefusal(event, { token = false, expected } = {}) {
  const reach = reachRefusal(event);
  if (reach) return reach;
  if (token && !tokenMatches(event.request, expected ?? serviceToken())) return 'bad-token';
  return null;
}

/** The same verdict with the token read awaited rather than taken on the HTTP thread. */
export async function localRefusalAsync(event, { token = false, expected } = {}) {
  const reach = reachRefusal(event);
  if (reach) return reach;
  if (token && !tokenMatches(event.request, expected ?? await serviceTokenAsync())) return 'bad-token';
  return null;
}
