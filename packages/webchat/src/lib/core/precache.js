
const FONT = /^(?<face>.+)\.[A-Za-z0-9_-]+\.(?<ext>woff2|woff|ttf|eot|otf)$/u;

const fontOf = (path) => FONT.exec(path.split('/').pop() ?? '')?.groups ?? null;

export const precacheList = (assets) => {
  const modern = new Set();
  for (const path of assets) {
    const font = fontOf(path);
    if (font?.ext === 'woff2') modern.add(font.face);
  }
  return assets.filter((path) => {
    const font = fontOf(path);
    return !font || font.ext === 'woff2' || !modern.has(font.face);
  });
};

// Every top-level route in src/routes that has a +page.svelte. The worker stores one copy of
// the document shell under each of them at install, so a fresh cache generation can answer a
// navigation to a surface this generation has never been asked for. sw-cache.test.js fails if
// a route is added to the app and not to this list.
export const APP_ROUTES = Object.freeze([
  '/',
  '/docs',
  '/files',
  '/fnf',
  '/login',
  '/mp',
  '/notes',
  '/reader',
  '/secrets',
  '/shop'
]);

const normalize = (route) => {
  if (typeof route !== 'string' || !route.startsWith('/')) return null;
  const trimmed = route.length > 1 ? route.replace(/\/+$/u, '') : route;
  return trimmed || '/';
};

// The precache keys for navigations: normalized, deduplicated, '/' always present, because the
// offline fallback reads it.
export const shellRoutes = (routes = APP_ROUTES) => {
  const out = new Set(['/']);
  for (const route of routes ?? []) {
    const path = normalize(route);
    if (path) out.add(path);
  }
  return [...out];
};
