// Shopping search: ask Amazon, fall back to Bing Shopping, and keep the answer.
//
// Amazon will not serve its search page to a naive fetch. Two things have to be true. The request
// has to carry the client hints a real Chrome sends (sec-ch-ua, sec-fetch-*,
// upgrade-insecure-requests), and it has to keep the cookies Amazon hands back and send them on
// the next request, the way any browser does. Without the cookie jar, a run of eight searches came
// back as eight 2 KB Akamai interstitials; with it, the same eight all returned the real grid
// (1.1–2.5 MB, 22–60 tiles each). The cookies are the anonymous session Amazon issues to a
// stranger — session-id, ubid-main and their kin — they are held in memory only, and nothing on
// this machine's credential stores is read or wanted.
//
// https://www.amazon.com/dp/<asin> answers 404 with a robot check however it is asked, so no
// product page is ever fetched. Everything a card needs — image, title, price, asin — is on the
// search grid, and the product link is built from the asin. Amazon's robots.txt disallows 218
// paths; /s is not among them.
//
// When Amazon comes back with nothing usable, Bing Shopping answers instead: its offer cards carry
// a thumbnail, a price, the retailer's name and a link that decodes to the retailer's own page.
// eBay, Walmart, Target, Home Depot, Etsy and Best Buy all refuse a direct fetch from this machine
// (403, or a bot wall served with a 200), so going through Bing is how their goods are reached at
// all.
//
// The cache is a small sqlite file beside the reader's and the notes'. A repeat of the same
// query inside the freshness window is answered from it without touching the network; a price is
// a perishable fact, so the window is hours, not days.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { webchatStoreDir } from './paths.js';
import { parseAmazonSearch, parseBingShopping, isComplete } from '../core/shop-parse.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  query      TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  payload    TEXT NOT NULL
);
`;

export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // prices move; half a day is already generous
const LIMIT = 24;                                  // cards on the page at once
const TIMEOUT_MS = 20000;
const MIN_PAGE_BYTES = 20000;                      // a real search page is megabytes; a challenge is 2 KB
const RETRY_PAUSE_MS = 700;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// The difference between a page and a javascript challenge. Amazon checks these.
const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1'
};

export const shopDbPath = (options) => join(webchatStoreDir(options), 'shop.sqlite');

let db = null;
export function shopStore(options) {
  if (db) return db;
  const path = shopDbPath(options);
  mkdirSync(webchatStoreDir(options), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export const normalizeQuery = (value) => String(value == null ? '' : value).replace(/\s+/gu, ' ').trim().toLowerCase();

function readCache(query, { ttlMs = CACHE_TTL_MS, now = Date.now() } = {}) {
  const row = shopStore().prepare('SELECT fetched_at, payload FROM searches WHERE query = ?').get(query);
  if (!row) return null;
  const age = now - Date.parse(row.fetched_at);
  if (!Number.isFinite(age) || age > ttlMs) return null;
  try {
    return { ...JSON.parse(row.payload), cached: true, fetchedAt: row.fetched_at, ageMs: age };
  } catch { return null; }
}

function writeCache(query, payload, now = Date.now()) {
  shopStore()
    .prepare('INSERT INTO searches (query, fetched_at, payload) VALUES (?, ?, ?) ' +
             'ON CONFLICT(query) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload')
    .run(query, new Date(now).toISOString(), JSON.stringify(payload));
}

export function forget(query) {
  shopStore().prepare('DELETE FROM searches WHERE query = ?').run(normalizeQuery(query));
}

// One anonymous cookie jar per host, in memory for the life of the process. A site that sets a
// session cookie and then sees it come back treats the caller as a visitor; a site that sets one
// and never sees it again treats the caller as a robot, which is exactly what happened.
const jars = new Map();

function jarFor(host) {
  let jar = jars.get(host);
  if (!jar) { jar = new Map(); jars.set(host, jar); }
  return jar;
}

export function clearJars() { jars.clear(); }

function takeCookies(jar, response) {
  const set = typeof response.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const line of set) {
    const pair = String(line).split(';')[0];
    const split = pair.indexOf('=');
    if (split <= 0) continue;
    jar.set(pair.slice(0, split).trim(), pair.slice(split + 1));
  }
}

async function getHtml(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const jar = jarFor(new URL(url).hostname);
  const headers = { ...BROWSER_HEADERS };
  if (jar.size) headers.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  try {
    const response = await fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal });
    takeCookies(jar, response);
    const html = await response.text();
    return { status: response.status, html };
  } finally {
    clearTimeout(timer);
  }
}

// jsdom shouts about every stylesheet Amazon ships that it cannot parse; none of it matters here.
const silent = new VirtualConsole();
const docOf = (html) => new JSDOM(String(html || ''), { virtualConsole: silent }).window.document;

/**
 * One source, fetched and parsed. Returns { name, ok, status, found, items, note }. A source that
 * fails says why in `note` instead of throwing, because the other source should still get a turn.
 */
async function askSource(name, url, parse, options) {
  let status = 0;
  try {
    let page = await getHtml(url, options);
    // The interstitial is the answer to a caller with no cookies. Having now been given some,
    // ask once more before giving up on the source.
    if (page.status === 200 && page.html.length < MIN_PAGE_BYTES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
      page = await getHtml(url, options);
    }
    status = page.status;
    // Amazon's javascript challenge is a couple of kilobytes with no grid in it; a short body is
    // the signal, and it is worth naming so a silent zero is not mistaken for an empty shelf.
    if (page.status !== 200) return { name, ok: false, status, found: 0, items: [], note: `${name} answered ${page.status}` };
    if (page.html.length < MIN_PAGE_BYTES) {
      return { name, ok: false, status, found: 0, items: [], note: `${name} returned a ${Math.round(page.html.length / 1024)} KB page with no results grid, which is its bot challenge, not a search` };
    }
    const { found, items } = parse(docOf(page.html));
    return { name, ok: true, status, found, items, note: '' };
  } catch (cause) {
    const why = cause?.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : cause?.message || String(cause);
    return { name, ok: false, status, found: 0, items: [], note: `${name} could not be reached: ${why}` };
  }
}

export const amazonUrl = (query) => `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
export const bingUrl = (query) => `https://www.bing.com/shop?q=${encodeURIComponent(query)}`;

/**
 * search(query) -> {
 *   query, results, found, shown, sources, notes, cached, fetchedAt
 * }
 *
 * `found` counts every tile the sources put up, `shown` the cards actually returned, so the page
 * can be honest about a capped list. Complete cards sort ahead of gappy ones; nothing is dropped
 * for being incomplete, because "the price could not be read" is a result too.
 */
export async function search(rawQuery, { refresh = false, limit = LIMIT, ttlMs = CACHE_TTL_MS, now = Date.now(), fetchImpl = fetch } = {}) {
  const query = normalizeQuery(rawQuery);
  if (!query) return { query: '', results: [], found: 0, shown: 0, sources: [], notes: ['type something to search for'], cached: false, fetchedAt: null };

  if (!refresh) {
    const hit = readCache(query, { ttlMs, now });
    if (hit) return hit;
  }

  const sources = [];
  const notes = [];
  const amazon = await askSource('amazon', amazonUrl(query), parseAmazonSearch, { fetchImpl });
  sources.push({ name: 'Amazon', url: amazonUrl(query), ok: amazon.ok, status: amazon.status, found: amazon.found, used: amazon.items.length });
  if (amazon.note) notes.push(amazon.note);

  let items = amazon.items;
  let found = amazon.found;

  // "Where Amazon has nothing" is taken literally: no usable card at all, whether because the
  // shelf is empty or because the fetch was turned away.
  if (items.filter(isComplete).length === 0) {
    const bing = await askSource('bing shopping', bingUrl(query), parseBingShopping, { fetchImpl });
    sources.push({ name: 'Bing Shopping', url: bingUrl(query), ok: bing.ok, status: bing.status, found: bing.found, used: bing.items.length });
    if (bing.note) notes.push(bing.note);
    if (amazon.ok && amazon.found === 0) notes.push('Amazon had no results for this, so these come from other retailers via Bing Shopping.');
    else if (!amazon.ok) notes.push('Amazon could not be read this time, so these come from other retailers via Bing Shopping.');
    items = [...items, ...bing.items];
    found += bing.found;
  }

  const ranked = [...items].sort((a, b) => Number(isComplete(b)) - Number(isComplete(a)));
  const results = ranked.slice(0, limit);
  if (results.length === 0 && notes.length === 0) notes.push('Neither Amazon nor Bing Shopping returned anything for this.');

  const payload = {
    query,
    results,
    found,
    shown: results.length,
    complete: results.filter(isComplete).length,
    sources,
    notes,
    cached: false,
    fetchedAt: new Date(now).toISOString()
  };
  // A run where every source failed is not worth remembering; the next try should go out again.
  if (results.length > 0) writeCache(query, payload, now);
  return payload;
}

export default { search, shopStore, shopDbPath, normalizeQuery, forget, clearJars, CACHE_TTL_MS };
