// Reading a page without keeping it.
//
// Browsing and saving are different acts: following next through a series, or clicking a link in a
// post, should show the page and leave no trace. So a browse fetches and extracts into a small
// cache and returns it; nothing reaches the store until he asks for it, or until he highlights
// something, which is the same as asking.
//
// The cache is what makes "add to library" free: the page he is looking at is already extracted,
// so keeping it is a write, not a second fetch (and not a second, possibly different, version of
// the page).

import { assertFetchableUrl, fetchPage, extractArticle } from './reader-extract.js';
import { seriesKey } from '../core/reader-links.js';
import { scoreText } from './reader-text-quality.js';

const CACHE_MAX = 24;
const CACHE_MS = 30 * 60_000;
const cache = new Map();     // url -> { at, payload }
const inflight = new Map();  // url -> Promise, so N askers cause one fetch

function remember(url, payload) {
  cache.delete(url);
  cache.set(url, { at: Date.now(), payload });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return payload;
}

export function cached(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) { cache.delete(url); return null; }
  return hit.payload;
}

export function forget(url) { cache.delete(url); inflight.delete(url); }

/** For the tests: how many fetches are in flight right now. */
export const inflightCount = () => inflight.size;

/**
 * Fetch and extract a page. Nothing here writes to the store.
 *
 * Askers for the same url share one fetch: the warm path, the read that follows it and a second
 * tab all arriving at once are one request to the site, not three.
 */
export async function browse(url, { refresh = false } = {}) {
  if (!refresh) {
    const hit = cached(url);
    if (hit) return hit;
    const running = inflight.get(url);
    if (running) return running;
  }
  const work = fetchAndExtract(url);
  inflight.set(url, work);
  work.catch(() => { /* warm() has no one to report to; the read that follows will fetch again */ });
  try {
    return await work;
  } finally {
    if (inflight.get(url) === work) inflight.delete(url);
  }
}

/**
 * Start a browse and return at once, so the extraction is done before he presses Enter. Writes
 * nothing, refuses exactly what a fetch refuses, and is free to call again with the same url.
 */
export function warm(url) {
  assertFetchableUrl(url);              // private and loopback hosts are refused before any fetch
  if (cached(url)) return { warming: false, cached: true };
  if (inflight.has(url)) return { warming: true, cached: false };
  browse(url).catch(() => { /* reported when he actually opens it */ });
  return { warming: true, cached: false };
}

async function fetchAndExtract(url) {
  const page = await fetchPage(url);
  if (/application\/(pdf|epub\+zip)/u.test(page.contentType || '')) {
    const error = new Error('that link is a file, not a page; PDF and EPUB arrive by upload for now');
    error.status = 415;
    throw error;
  }
  const article = extractArticle({ html: page.html, url: page.url });
  const host = (() => { try { return new URL(page.url).host; } catch { return ''; } })();
  const links = ['next', 'prev', 'up']
    .map((rel) => ({ rel, ...(article.links?.[rel] || {}) }))
    .filter((link) => link.href);

  const payload = {
    url: page.url,
    canonicalUrl: article.canonicalUrl || page.url,
    title: article.title || page.url,
    byline: article.byline || '',
    site: article.siteName || host,
    seriesKey: seriesKey(page.url),
    lang: article.lang || '',
    excerpt: article.excerpt || '',
    publishedAt: article.publishedAt || null,
    words: article.words || 0,
    html: article.contentHtml,
    text: article.text,
    fallback: Boolean(article.fallback),
    links
  };
  // Cached under both the asked-for url and the one the redirects landed on, so a save after a
  // browse finds it either way.
  remember(url, payload);
  if (page.url !== url) remember(page.url, payload);
  return payload;
}

/** Keep a browsed page: the same extraction he was reading, written to the store. */
export function keep(store, payload) {
  // What goes in is scored, never silently stored: a page whose extraction came out as broken
  // words or OCR soup says so in its own record instead of being discovered while reading it.
  const quality = scoreText(payload.text || '');
  if (quality.verdict !== 'ok') {
    console.warn(`reader: ${quality.verdict} text from ${payload.url}: ${quality.reasons.join('; ')}`);
  }
  const id = store.saveDoc({
    kind: 'article',
    url: payload.url,
    canonicalUrl: payload.canonicalUrl,
    title: payload.title,
    byline: payload.byline,
    site: payload.site,
    seriesKey: payload.seriesKey,
    lang: payload.lang,
    excerpt: payload.excerpt,
    publishedAt: payload.publishedAt,
    words: payload.words,
    sections: 1,
    meta: { fallback: payload.fallback, textQuality: quality }
  });
  store.setSections(id, [{ href: payload.url, title: payload.title, html: payload.html, text: payload.text, words: payload.words }]);
  store.setLinks(id, payload.links);
  return id;
}
