

const FALLBACK = ['claude'];

export const backends = $state({ providers: FALLBACK, loaded: false });

let inFlight = null;

export function ensureBackends(fetchImpl = globalThis.fetch) {
  if (backends.loaded || inFlight) return inFlight;
  if (typeof fetchImpl !== 'function') return null;
  inFlight = fetchImpl('/api/backends')
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      if (Array.isArray(body?.providers) && body.providers.length) backends.providers = body.providers;
      backends.loaded = true;
    })
    .catch(() => {
      
      
      backends.loaded = true;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}
