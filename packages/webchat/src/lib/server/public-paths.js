// Which paths this server answers without his session, in one place.
//
// hooks.server.js held the whole list inline, as a chain of regexes and ors grown one surface at a
// time. It is the authorization boundary of the entire app and it had no test, because
// hooks.server.js cannot be imported without booting the stores (app.js opens events.sqlite, the
// runner and the live feed at module load). This module imports nothing at all, so the decision is
// a pure function a node test can drive, and tests/public-paths.test.mjs pins it.
//
// hooks.server.js keeps what only it can do: answering 404 for a room or a document token that was
// never minted, BEFORE the session check, so a guessed token is a dead end rather than a sign-in
// prompt for a stranger.
//
// WHAT CHANGED WHEN THIS MOVED, and why. The exemption for /api/reader/share was written for the
// iOS Shortcut, which POSTs the share token in its query string: reader-shortcut.js builds exactly
// `${endpoint}?token=${token}` with WFHTTPMethod POST, because a Shortcut has no browser session.
// The exemption was not restricted to POST, and the GET on that path is the one place the share
// token is handed out. So `GET /api/reader/share?token=anything` skipped the session and answered
// with the real token in JSON, and `?install=1&token=anything` downloaded a Shortcut carrying it,
// from the public hostname. That token lets anyone POST arbitrary URLs into his reader. The route's
// own comment said "the session cookie is what lets it through the gate", which is what the code was
// meant to do and did not. The exemption is now POST only, and the GET handler checks the session
// itself the way /api/mp/rooms does, so a later edit to this list cannot reopen it.

/** A minted onboarding channel: /api/onboard/<token>. */
export const ONBOARD = /^\/api\/onboard\/[^/]+\/?$/u;

/** A minted multiplayer room page: /mp/<token>. */
export const MP_ROOM = /^\/mp\/([^/]+)\/?$/u;

// A public document's token: the ULID-shaped pair that docs.js mints, or a 22-character id.
const DOC_TOKEN = '(?:[0-9A-HJKMNP-TV-Z]{10}-[0-9A-HJKMNP-TV-Z]{16}|[A-Za-z0-9_-]{22})';

/** A well-formed public document page. */
export const DOC_PAGE = new RegExp(`^/docs/(${DOC_TOKEN})/?$`, 'u');

/** Anything SHAPED like a document page, so a malformed token is a 404 and never the app shell. */
export const DOC_PAGE_SHAPE = /^\/docs\/[^/]+\/?$/u;

const DOC_API = new RegExp(`^/api/docs/${DOC_TOKEN}(?:/(?:meta|comments|events|presence))?/?$`, 'u');

// How a stranger on a public document binds a display name to a passkey. These six paths only; the
// guest cookie they set is never read by an owner check and grants nothing but a name.
const DOC_GUEST = /^\/api\/docs\/guest\/(?:(?:register|authenticate)\/(?:begin|finish)|rename|signout)\/?$/u;

export const roomToken = (path) => MP_ROOM.exec(String(path ?? ''))?.[1] ?? null;
export const docToken = (path) => DOC_PAGE.exec(String(path ?? ''))?.[1] ?? null;

// Multiplayer mode is public by design: the room page and its endpoints are what a stranger with
// the link gets, and nothing of his is readable through them, because /api/mp/* serves only the
// gated projection of that one room conversation (src/lib/server/mp.js) and accepts only a join, a
// message and an interrupt on it. /api/mp/rooms, which MINTS a room, is the one path under
// /api/mp/ that stays behind the session.
export function isMultiplayerPath(path) {
  // A tophat instance keeps multiplayer behind the session unless its owner opens it (TOPHAT_MULTIPLAYER_PUBLIC=1):
  // a room message starts an agent turn, and a fresh install must not hand that to anyone who can reach the port.
  if (process.env.TOPHAT_MULTIPLAYER_PUBLIC !== '1') return false;
  return path === '/mp' || MP_ROOM.test(path) || (path.startsWith('/api/mp/') && path !== '/api/mp/rooms');
}

// A public document is the same bargain as a minted room, each serving only its own document.
// /docs (his list) and /api/docs (the list and minting) stay behind the session.
export const isPublicDocPath = (path) => DOC_PAGE.test(path) || DOC_API.test(path);
export const isDocGuestPath = (path) => DOC_GUEST.test(path);

// The token in the path is the whole credential; /s/<token> renders one document or one chat and
// nothing else of his, and the notes variant is a separate token the clean page never names.
// /view/<ulid>/<file> is the same bargain for a published quicklook artifact, which has been
// internet-facing since 2026-08.
export const isSharePath = (path) => path.startsWith('/s/') || path.startsWith('/view/');

/**
 * Whether this request may be served without his session.
 *
 * `bearer` is whether an Authorization: Bearer header is present (the handler behind the path
 * compares the token itself, in constant time, and refuses anything else). `shareToken` is whether
 * ?token= is present, which is how the iOS Shortcut carries the reader share token.
 */
export function isPublicPath({ path, method = 'GET', bearer = false, shareToken = false } = {}) {
  if (typeof path !== 'string' || !path) return false;

  // Signing in, and the passkey ceremony itself.
  if (path === '/login' || path.startsWith('/api/auth/')) return true;

  // The machine surfaces. Each one re-checks inside the handler: /api/health is loopback only (the
  // deploy guard and src/lib/server/liveness.js probe it with no credential), and /api/inbound,
  // /api/agent and /api/replies/projection are loopback plus the service token.
  if (path === '/api/health' || path === '/api/inbound' || path === '/api/agent' || path === '/api/replies/projection') return true;
  // An extension job's dispatch (loopback, service token; routes/api/ext/dispatch re-checks both).
  if (path === '/api/ext/dispatch' && method === 'POST') return true;

  if (isMultiplayerPath(path)) return true;
  if (isSharePath(path)) return true;
  if (isPublicDocPath(path) || isDocGuestPath(path)) return true;

  // /api/state carries its own gate (loopback plus the service token) inside the handler, because a
  // state composer or a repair agent runs with no browser session at all. Exempted here only when it
  // presents a bearer, so an anonymous read of the state area is still refused.
  if (path === '/api/state' && bearer) return true;
  // A peer host reading and writing a chat that runs on it, in the app's own shapes (peer-actions.js): the same /api/actions, /api/sync and
  // /api/events a browser uses, entered with a bearer. Open here only with one; each handler runs peerCaller (loopback plus the service
  // token) and answers 404 to a bearer that fails it.
  if (bearer && (path === '/api/actions' || path === '/api/sync' || path === '/api/events')) return true;
  // A peer host's member asking whether work of one door grant still runs here (door-work.js): bearer only, the handler runs peerCaller.
  if (bearer && method === 'GET' && path === '/api/door') return true;

  // The Shortcut's POST, and nothing else. See the header: the GET on this path hands the token out
  // and is the owner's alone.
  if (path === '/api/reader/share' && method === 'POST' && (bearer || shareToken)) return true;

  // The Apple Watch capture: POST (capture) and GET ?key= (the reply's follow-up), bearer only; the handler checks the token.
  if (path === '/api/watch-capture' && (method === 'POST' || method === 'GET') && bearer) return true;

  // The one-time onboarding channel: a minted single-use URL a new device or agent can POST to
  // with curl and nothing else. The handler checks the token's hash, expiry, cap and revocation and
  // answers 404 for any other method and for any token not live (src/lib/server/onboard.js, tools/tophat-onboard).
  if (ONBOARD.test(path)) return true;

  // tophat-transit's one-tap "skip the auto-call" link from a Pushover notification: GET only, and the handler
  // answers 404 unless the HMAC in the query matches that event id (src/lib/server/transit-skip.js).
  if (path === '/api/transit/skip' && method === 'GET') return true;

  return false;
}
