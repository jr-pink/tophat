
export const CACHE_PREFIX = 'webchat-';

export const CACHE_GENERATIONS = 3;


export function generationOf(key) {
  if (typeof key !== 'string' || !key.startsWith(CACHE_PREFIX)) return null;
  const stamp = key.slice(CACHE_PREFIX.length);
  return stamp.length ? stamp : null;
}

export function cachesToKeep(keys, current, generations = CACHE_GENERATIONS) {
  const ours = keys
    .filter((key) => generationOf(key) !== null)
    
    
    
    
    .sort((a, b) => (generationOf(a) < generationOf(b) ? 1 : -1));

  const keep = new Set(ours.slice(0, Math.max(0, generations)));
  keep.add(current);
  return keep;
}

export function servableAcrossGenerations(pathname) {
  return typeof pathname === 'string' && pathname.startsWith('/_app/immutable/');
}

// A document copy the worker wrote itself carries this header, with the build it belongs to.
// Nothing else in the system sets it, so it is how a navigation tells a shell this worker
// stored from one that something else put in the cache or one left by an older build.
export const SHELL_STAMP = 'x-webchat-shell';

export function shellStampOf(response) {
  const value = response?.headers?.get?.(SHELL_STAMP);
  return typeof value === 'string' && value.length ? value : null;
}

// Serve a cached document immediately only when this build wrote it. An unstamped '/' is the
// shape a superseded or hand-written entry has, and it goes to the network instead.
export function shellIsCurrent(response, version) {
  if (!response || typeof version !== 'string' || !version.length) return false;
  return shellStampOf(response) === version;
}

// A navigation answered with a redirect: either the browser followed it (redirected/3xx) or the
// request's manual redirect mode turned it into an opaqueredirect the worker cannot read. Both
// mean the server did not hand us the shell for this path; signed out, that is the /login bounce.
export function navigationRedirected(response) {
  if (!response) return false;
  if (response.type === 'opaqueredirect') return true;
  if (response.redirected === true) return true;
  return typeof response.status === 'number' && response.status >= 300 && response.status < 400;
}

// What may be stored under a navigation path: a 200 for that very path. A response whose final
// URL is some other path (the /login bounce) must never be filed under the path that was asked
// for, or a signed-out moment would leave the login page cached as every surface.
export function cacheableNavigation(response, pathname) {
  if (!response || response.ok !== true) return false;
  if (navigationRedirected(response)) return false;
  if (typeof response.url !== 'string' || !response.url.length) return true;
  try {
    return new URL(response.url).pathname === pathname;
  } catch {
    return false;
  }
}

// A navigation answer that is not the app: no response, or a gateway page (Cloudflare 502/530 when
// the tunnel or the origin is down, 503/504 from anything in between). With a shell in the cache,
// that is the moment to serve it, whatever build stored it: an older shell that boots beats a
// Cloudflare error page, and its hashed chunks are still answerable across generations.
const GATEWAY_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
export function serverUnavailable(response) {
  if (!response) return true;
  if (response.type === 'error') return true;
  return GATEWAY_STATUS.has(response.status) || response.status >= 500;
}

// Signed out is the app itself sending this origin's /login. Any other redirect (a captive portal,
// an access gateway on another host) says nothing about his session, and must not cost him the
// cached shell he reads offline from.
export function signedOutRedirect(response, origin) {
  if (!response || response.redirected !== true || typeof response.url !== 'string') return false;
  try {
    const url = new URL(response.url);
    return url.origin === origin && url.pathname === '/login';
  } catch {
    return false;
  }
}
