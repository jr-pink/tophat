
import { build, files, version } from '$service-worker';
import { APP_ROUTES, precacheList, shellRoutes } from '$lib/core/precache.js';
import {
  SHELL_STAMP,
  cacheableNavigation,
  cachesToKeep,
  navigationRedirected,
  servableAcrossGenerations,
  serverUnavailable,
  shellIsCurrent,
  signedOutRedirect
} from '$lib/core/sw-cache.js';

const CACHE = `webchat-${version}`;

// Proxied remote images. Named outside the `webchat-` generations on purpose: a new build must not
// discard the pictures a transcript was read with. The URL is the identity (the server keys its own
// cache by the same hash), so a hit is never stale.
const IMAGE_CACHE = 'remote-images-v1';
const IMAGE_CACHE_ENTRIES = 400;


const SHELL = [...build, ...files];
const PRECACHE = precacheList(SHELL);

// ssr=false in src/routes/+layout.js, so the document is the same bytes for every route and
// every signed-in user; the router picks the page in the browser. One fetch at install is
// therefore the shell for all of them, and a new generation starts with /reader, /notes and
// the rest already answerable instead of network-only until each is visited again.
const ROUTES = shellRoutes(APP_ROUTES);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    
    
    
    
    
    
    
    await Promise.all(PRECACHE.map((path) =>
      cache.add(path).catch(() => {})
    ));
    await precacheShell(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const keep = cachesToKeep(keys, CACHE);

    for (const key of keys) {
      if (!keep.has(key) && key !== IMAGE_CACHE) await caches.delete(key);
    }

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  
  
  if (url.pathname === '/api/remote-image') {
    event.respondWith(remoteImage(request));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigation(event, request, url));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let hit = await cache.match(url.pathname) || await cache.match(request);

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    if (!hit && servableAcrossGenerations(url.pathname)) {
      hit = await caches.match(request);
    }

    if (hit) return hit;
    try {
      const response = await fetch(request);
      if (response.ok && SHELL.includes(url.pathname)) cache.put(url.pathname, response.clone());
      return response;
    } catch (cause) {
      const fallback = await cache.match('/');
      if (fallback) return fallback;
      throw cause;
    }
  })());
});

// A document this build stored is served straight out of the cache, with no network in the
// way, and refreshed behind the launch. Within a generation the shell cannot change, and a
// generation is a new cache, so there is nothing to race: the old code spent up to 700ms of
// every cold launch waiting for a copy it already had.
async function navigation(event, request, url) {
  const cache = await caches.open(CACHE);
  const path = url.pathname;
  const cached = await cache.match(path);

  if (shellIsCurrent(cached, version)) {
    event.waitUntil(revalidate(cache, request, path));
    return cached;
  }

  try {
    const response = await fetch(request);
    if (serverUnavailable(response)) {
      const fallback = cached || (await cache.match('/'));
      if (fallback) return fallback;
    }
    event.waitUntil(store(cache, path, response.clone()));
    return response;
  } catch {
    return cached || (await cache.match('/')) || Response.error();
  }
}

async function revalidate(cache, request, path) {
  let response;
  try {
    // A request of our own, not the navigation: its redirects are followed and readable, so a
    // bounce to this origin's /login (signed out) is told apart from a captive portal or an access
    // gateway, which must never cost him the shell he reads offline from.
    response = await fetch(path, { credentials: 'same-origin', redirect: 'follow', cache: 'no-store' });
  } catch {
    return;
  }
  if (serverUnavailable(response)) return;
  if (navigationRedirected(response) && !signedOutRedirect(response, self.location.origin)) return;
  if (signedOutRedirect(response, self.location.origin)) {
    await Promise.all(ROUTES.map((route) => cache.delete(route).catch(() => false)));
    await cache.delete(path).catch(() => false);
    await tellClients({ type: 'tophat:shell-redirect' });
    return;
  }
  await store(cache, path, response);
}

async function store(cache, path, response) {
  if (!cacheableNavigation(response, path)) return;
  let stamped;
  try {
    stamped = await stamp(response);
  } catch {
    return;
  }
  await cache.put(path, stamped).catch(() => {});
}

async function stamp(response, body) {
  const bytes = body ?? await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set(SHELL_STAMP, version);
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
}

async function precacheShell(cache) {
  let response;
  try {
    
    
    response = await fetch('/', { credentials: 'same-origin', cache: 'reload' });
  } catch {
    return;
  }
  if (!cacheableNavigation(response, '/')) return;
  let body;
  try {
    body = await response.arrayBuffer();
  } catch {
    return;
  }
  for (const route of ROUTES) {
    try {
      await cache.put(route, await stamp(response, body));
    } catch {  }
  }
}

async function tellClients(message) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage(message);
  } catch {  }
}

// Cache first, network on a miss, and only an image answer is stored: a 401, a 5xx or a Cloudflare
// error page is never kept, so a failure shows the caption link and a later load can still succeed.
async function remoteImage(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && (response.headers.get('content-type') || '').startsWith('image/')) {
    await cache.put(request.url, response.clone()).catch(() => {});
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - IMAGE_CACHE_ENTRIES))) await cache.delete(key);
  }
  return response;
}
