import { json } from '@sveltejs/kit';
import { fetchPage } from '$lib/server/reader-extract.js';

// Enough of a browser to find something and open it in the reader: the omnibox sends a phrase
// here, this asks DuckDuckGo's HTML endpoint and returns the result links. Nothing is stored;
// the page he picks is what gets saved.
const RESULT = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu;
const SNIPPET = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gu;

const strip = (html) => String(html)
  .replace(/<[^>]+>/gu, '')
  .replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
  .replace(/&quot;/gu, '"').replace(/&#x27;|&#39;/gu, "'").replace(/&nbsp;/gu, ' ')
  .replace(/\s+/gu, ' ').trim();

// DuckDuckGo wraps results in /l/?uddg=<encoded>; unwrap so the reader saves the real page.
function unwrap(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.href;
  } catch { return href; }
}

export async function GET({ url }) {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) return json({ results: [] });
  let page;
  try {
    page = await fetchPage(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeoutMs: 12000 });
  } catch (cause) {
    return json({ error: `search failed: ${cause.message}`, results: [] }, { status: 502 });
  }
  const snippets = [...String(page.html).matchAll(SNIPPET)].map((m) => strip(m[1]));
  const results = [...String(page.html).matchAll(RESULT)].slice(0, 12).map((m, i) => ({
    url: unwrap(m[1]),
    title: strip(m[2]),
    snippet: snippets[i] || ''
  })).filter((r) => /^https?:/u.test(r.url));
  return json({ query, results });
}
