import { error } from '@sveltejs/kit';
import { app, bootIsBuild } from '$lib/server/app.js';
import { SESSION_COOKIE } from '$lib/server/auth.js';
import { liveFeed, withOrigin } from '$lib/server/live-feed.js';
import { sweepIncognitoRoot } from '$lib/server/incognito.js';
import { installLagGuard, withRoute } from '$lib/server/lag-guard.js';
import { webchatStorePath } from '$lib/server/paths.js';
import { hasRoom } from '$lib/server/mp.js';
import { hasDoc } from '$lib/server/docs.js';
import { scopeGate } from '$lib/server/scopes-gate.js';
import { maskResponse, publicMode } from '$lib/server/home-mask.js';
import { preloadBundle } from '$lib/core/shell-preload.js';
import { DOC_PAGE_SHAPE, docToken, isPublicPath, roomToken } from '$lib/server/public-paths.js';

// The feed listens to the stores from boot, so a write made before the first page subscribes is
// still in its ring when that page resumes.
liveFeed();

// The loop-stall guard: every stall over 100 ms is one line in lag.jsonl and on stderr, with the
// requests in flight and the synchronous call that held the thread (src/lib/server/lag-guard.js).
if (!bootIsBuild()) installLagGuard({ logPath: webchatStorePath('lag.jsonl') });

// No incognito chat outlives the process that held it (src/lib/server/incognito.js), so whatever
// scratch an earlier process left behind is removed before this one serves anything.
if (!bootIsBuild()) sweepIncognitoRoot();

const notFound = (what) => new Response(what, {
  status: 404,
  headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }
});

export async function handle({ event, resolve }) {
  const path = event.url.pathname;

  // A room or a document token that was never minted is a dead end, decided before the session
  // check so a guessed link reveals nothing and never asks a stranger for his passkey.
  const room = roomToken(path);
  if (room && !hasRoom(room)) return notFound('No such room');
  if (DOC_PAGE_SHAPE.test(path)) {
    const token = docToken(path);
    if (!token || !hasDoc(token)) return notFound('No such document');
  }

  // Which surfaces answer without his session, and why each one may, is
  // src/lib/server/public-paths.js, which tests/public-paths.test.mjs pins. Every path on that list
  // re-checks inside its own handler; this is the outer gate, not the only one.
  const bearer = (event.request.headers.get('authorization') || '').startsWith('Bearer ');
  const open = isPublicPath({
    path,
    method: event.request.method,
    bearer,
    shareToken: event.url.searchParams.has('token')
  });
  // The account and its scopes ride on event.locals.scopeContext for the routes that bind chats
  // to a scope. With scopes on, the webchat's own passkey cookie is not a way in.
  const gate = scopeGate();
  if (gate && !open) {
    const who = await gate(event.request);
    if (!who.ok) return who.response;
    event.locals.scopeContext = { email: who.email, account: who.account, name: who.name, personalScope: who.personalScope, scopes: who.scopes };
  } else if (!open && !app.auth.valid(event.cookies.get(SESSION_COOKIE))) {
    if (path.startsWith('/api/')) error(401, 'Sign in required');
    return new Response(null, {
      status: 303,
      headers: { location: '/login', 'cache-control': 'no-store', vary: 'cookie' }
    });
  }

  // A write names the tab it came from (x-tophat-client), so the live feed can tell that tab to
  // skip its own echo; reads are never attributed, because a read that refreshes tasks writes
  // things the reading tab did not make.
  const origin = event.request.method === 'GET' ? null : event.request.headers.get('x-tophat-client');
  // The shell's bundle download starts with its stylesheet's, not after it (src/lib/core/shell-preload.js).
  const resolveShell = () => resolve(event, { transformPageChunk: ({ html }) => preloadBundle(html) });
  const response = await withRoute(`${event.request.method} ${path}`, () => (origin ? withOrigin(origin, resolveShell) : resolveShell()));
  if (response.headers.get('content-type')?.includes('text/html')) {
    response.headers.set('cache-control', 'no-store');
    response.headers.set('vary', 'cookie');
    // Early hints would preload chunks of a build this client may not be on.
    response.headers.delete('link');
  }
  // An instance that serves strangers (public prompt mode) never tells a client where on the host's disk it runs.
  if (path.startsWith('/api/') && publicMode()) return maskResponse(response);
  return response;
}
