import { json } from '@sveltejs/kit';
import { readerStore } from '$lib/server/reader-store.js';
import { extractArticle } from '$lib/server/reader-extract.js';
import { seriesKey } from '$lib/core/reader-links.js';
import { scoreText } from '$lib/server/reader-text-quality.js';

// Save a page whose HTML is already in hand: a page he copied out of a browser that needed a
// login, or a saved file. Same extraction, same navigation links, no fetch.
export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const url = String(body.url || '').trim();
  const html = String(body.html || '');
  if (!url || !html) return json({ error: 'url and html are required' }, { status: 400 });

  const article = extractArticle({ html, url });
  const quality = scoreText(article.text || '');
  if (quality.verdict !== 'ok') console.warn(`reader: ${quality.verdict} text from ${url}: ${quality.reasons.join('; ')}`);
  const store = readerStore();
  const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
  const id = store.saveDoc({
    kind: 'article',
    url,
    canonicalUrl: article.canonicalUrl || url,
    title: article.title || url,
    byline: article.byline || '',
    site: article.siteName || host,
    seriesKey: seriesKey(url),
    lang: article.lang || '',
    excerpt: article.excerpt || '',
    publishedAt: article.publishedAt || null,
    words: article.words || 0,
    sections: 1,
    meta: { fallback: Boolean(article.fallback), imported: true, textQuality: quality }
  });
  store.setSections(id, [{ href: url, title: article.title || '', html: article.contentHtml, text: article.text, words: article.words }]);
  store.setLinks(id, ['next', 'prev', 'up']
    .map((rel) => ({ rel, ...(article.links?.[rel] || {}) }))
    .filter((link) => link.href));
  return json({ id, doc: store.doc(id), links: store.links(id) });
}
