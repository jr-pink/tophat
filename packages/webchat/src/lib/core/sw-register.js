// Registering the worker at a version-pinned URL.
//
// The browser's own update check bypasses the HTTP cache, but it still asks the edge, and the edge
// kept answering with the old worker; an old worker answers navigations from its own cache, so an
// hour of deploys was invisible. serve.mjs now sends no-store for that path, and this makes the
// script URL itself carry the build version, so a cacheable entry can never pin a client again: a new
// build asks for a URL the edge has never seen.
//
// The scope stays '/': a query string does not change the scope a script registers for, and the
// registration is keyed by scope, so a new URL updates the same registration rather than making a
// second one. updateViaCache 'none' keeps the worker and its imports out of the browser's HTTP cache.

export const SW_PATH = '/service-worker.js';

export function serviceWorkerUrl(version, base = '') {
  const path = `${base}${SW_PATH}`;
  if (version === undefined || version === null || version === '') return path;
  return `${path}?v=${encodeURIComponent(String(version))}`;
}

export function registerServiceWorker({ navigator: nav, version, base = '', onError } = {}) {
  if (!nav || !('serviceWorker' in nav)) return null;
  try {
    const url = serviceWorkerUrl(version, base);
    const result = nav.serviceWorker.register(url, { scope: `${base}/`, updateViaCache: 'none' });
    if (result && typeof result.catch === 'function') result.catch((error) => onError?.(error));
    return result;
  } catch (error) {
    onError?.(error);
    return null;
  }
}
