// Turning a retailer's search page into product cards.
//
// Nothing here fetches. Every function takes html (or a url) and returns plain data, so the
// shape of a card is settled in one place and can be tested against a saved page.
//
// Two sources, in the order the page asks for them:
//
//   amazon   www.amazon.com/s?k=...  parsed out of the search grid. Amazon serves this page to a
//            plain fetch only when the request carries a full set of browser client hints; with a
//            bare User-Agent it answers a 2 KB javascript challenge instead, and /dp/<asin> is a
//            404 robot check no matter what is sent. So the search grid is the whole of what
//            Amazon gives us: image, title, price and asin are all on it, and the product link is
//            built from the asin rather than followed.
//
//   bing     www.bing.com/shop?q=... used when Amazon returns nothing. Its offer cards carry a
//            parameter is the real destination, base64 of a percent-encoded url.
//
// A field that could not be read stays null. It is never guessed and never filled with a
// placeholder: a card with price: null is shown saying the price could not be read, which is a
// true thing to say, and an invented number is not.

const AMAZON_CARD = 'div[data-component-type="s-search-result"]';
const ASIN = /^[A-Z0-9]{10}$/u;

const clean = (value) => String(value == null ? '' : value).replace(/\s+/gu, ' ').trim();

/** Returns null when there is no number to read. */
export function readPrice(text) {
  const raw = clean(text);
  if (!raw) return null;
  const match = /(\$|US\s?\$|USD|£|€)?\s*([\d][\d,]*(?:\.\d{1,2})?)/u.exec(raw);
  if (!match) return null;
  const amount = Number(match[2].replace(/,/gu, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const symbol = (match[1] || '$').replace(/\s/gu, '');
  const currency = symbol === '£' ? 'GBP' : symbol === '€' ? 'EUR' : 'USD';
  return { text: raw, amount, currency };
}

/** Unwrap it, and then unwrap one more layer when the destination is itself a click tracker
 * carrying the shop's url in a query parameter. Anything that does not decode to an http url is
 * returned unchanged, so a link that cannot be unwrapped still opens the page Bing pointed at.
 */
export function unwrapRedirect(href) {
  let current = clean(href);
  if (!current) return '';
  for (let hop = 0; hop < 3; hop += 1) {
    let url;
    try { url = new URL(current); } catch { return current; }
    const encoded = url.searchParams.get('u');
    if (encoded) {
      const decoded = decodeBase64Url(encoded);
      if (decoded && decoded !== current) { current = decoded; continue; }
    }
    // A search-ads tracker keeps the destination in the clear, under one of a few names.
    let next = '';
    for (const key of ['ds_dest_url', 'destination', 'dest', 'redirect', 'target', 'url', 'r']) {
      const value = url.searchParams.get(key);
      if (value && /^https?:\/\//iu.test(value)) { next = value; break; }
    }
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

function decodeBase64Url(value) {
  // Bing prefixes some payloads with a two character version tag ("a1") before the base64.
  const candidates = /^a\d/u.test(value) ? [value.slice(2), value] : [value];
  for (const candidate of candidates) {
    try {
      const normalized = candidate.replace(/-/gu, '+').replace(/_/gu, '/');
      let text = Buffer.from(normalized, 'base64').toString('utf8');
      if (/%[0-9a-f]{2}/iu.test(text)) {
        try { text = decodeURIComponent(text); } catch { /* keep the raw decode */ }
      }
      if (/^https?:\/\//iu.test(text)) return text;
    } catch { /* try the next candidate */ }
  }
  return '';
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./u, ''); } catch { return ''; }
}

/**
 * parseAmazonSearch(document) -> { found, items }
 *
 * `found` is every result tile on the page, `items` the ones with at least a title, so the page
 * can say "12 of 60" honestly rather than pretending the 48 it dropped were never there.
 */
export function parseAmazonSearch(document) {
  const tiles = [...document.querySelectorAll(AMAZON_CARD)];
  const items = [];
  const seen = new Set();
  for (const tile of tiles) {
    const asin = clean(tile.getAttribute('data-asin'));
    if (!ASIN.test(asin) || seen.has(asin)) continue;
    const heading = tile.querySelector('h2');
    const image = tile.querySelector('img.s-image');
    const price = tile.querySelector('.a-price .a-offscreen');
    // The alt text repeats the title but is elided with an ellipsis, so it is only a fallback;
    // both carry a "Sponsored Ad - " prefix on paid placements, which is a label, not a name.
    const title = clean(heading?.textContent) ||
      clean(image?.getAttribute('alt')).replace(/^Sponsored Ad\s*-\s*/u, '');
    if (!title) continue;
    seen.add(asin);
    items.push({
      id: `amazon:${asin}`,
      title,
      url: `https://www.amazon.com/dp/${asin}`,
      image: clean(image?.getAttribute('src')) || null,
      price: readPrice(price?.textContent),
      retailer: 'Amazon',
      source: 'amazon',
      sponsored: Boolean(tile.querySelector('.puis-sponsored-label-text, .s-sponsored-label-text'))
    });
  }
  return { found: tiles.length, items };
}

/**
 * parseBingShopping(document) -> { found, items }
 *
 * Bing repeats the same offer across its carousels, so offers are folded on the retailer plus the
 * title; the first sighting wins.
 */
export function parseBingShopping(document) {
  const cards = [...document.querySelectorAll('[data-offerid]')];
  const items = [];
  const seen = new Set();
  for (const card of cards) {
    // The div holds an elided title; the span inside it carries the whole one in @title.
    const titled = card.querySelector('.br-offTtl [title], .br-offTtl[title]');
    const title = clean(titled?.getAttribute('title')) ||
      clean(card.querySelector('.br-offTtl span, .br-offTtl')?.textContent);
    if (!title) continue;
    const retailer = clean(card.querySelector('.br-offSlrTxt')?.textContent) || null;
    const key = `${(retailer || '').toLowerCase()}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const anchor = card.querySelector('a[href*="/aclick"], a.br-offLink[href], a[href^="http"]');
    const url = unwrapRedirect(anchor?.getAttribute('href') || '');
    const image = card.querySelector('.br-offImg img, img[src^="https://th.bing.com"]');
    const src = clean(image?.getAttribute('src'));
    items.push({
      id: `bing:${clean(card.getAttribute('data-offerid')) || key}`,
      title,
      url: /^https?:\/\//iu.test(url) ? url : null,
      image: src && !src.startsWith('data:') ? src : null,
      price: readPrice(card.querySelector('.br-price, .br-standardPrice, .br-focusPrice')?.textContent),
      retailer: retailer || hostOf(url) || null,
      source: 'bing-shopping',
      sponsored: true   // every offer card on /shop is a paid placement; say so rather than imply otherwise
    });
  }
  return { found: cards.length, items };
}

/** A card is complete when a browser can show a picture, a number and a page to open. */
export const isComplete = (item) => Boolean(item && item.image && item.price && item.url);

/** What each card is missing, in words the page can print. */
export function gapsOf(item) {
  const gaps = [];
  if (!item.image) gaps.push('no image');
  if (!item.price) gaps.push('no price');
  if (!item.url) gaps.push('no link');
  return gaps;
}

export default {
  readPrice, unwrapRedirect, hostOf, parseAmazonSearch, parseBingShopping, isComplete, gapsOf
};
