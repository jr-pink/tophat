// Server side reader view: fetch a page safely, then turn it into clean
// reader HTML plus the series navigation links found on the whole page.

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { classifyLinks } from '../core/reader-links.js';

const MAX_BYTES = 8 * 1024 * 1024;

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BINARY_TYPES = ['application/pdf', 'application/epub+zip'];

const DROP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'FORM',
  'INPUT',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'LINK',
  'META',
  'NOSCRIPT',
  'SVG'
]);

const KEEP_ATTRS = new Set([
  'id',
  'class',
  'href',
  'src',
  'alt',
  'title',
  'colspan',
  'rowspan',
  'start',
  'datetime'
]);

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);

const RECOVERABLE = 'figure, table, pre, blockquote, img';

/* ------------------------------------------------------------------ fetch */

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata',
  'metadata.google.internal',
  'instance-data'
]);

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (PRIVATE_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link local, includes the metadata IP
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

/** Throws on anything we refuse to fetch; returns the parsed URL otherwise. */
export function assertFetchableUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`reader: not a url: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`reader: refusing scheme ${u.protocol}`);
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error(`reader: refusing private or loopback host ${u.hostname}`);
  }
  return u;
}

function charsetOf(contentType) {
  const match = /charset=["']?([\w-]+)/i.exec(contentType || '');
  return match ? match[1].toLowerCase() : '';
}

// Decide the encoding from the header, then the document's own <meta>, then the bytes.
//
// Defaulting to UTF-8 and hoping is what produced that, so when UTF-8 leaves replacement
// characters behind and windows-1252 does not, windows-1252 wins.
function decodeHtml(bytes, contentType) {
  const declared = charsetOf(contentType);
  const decode = (label) => new TextDecoder(label, { fatal: false }).decode(bytes);
  if (declared && declared !== 'utf-8' && declared !== 'utf8') return decode(declared);
  const utf8 = decode('utf-8');
  if (!declared) {
    const head = utf8.slice(0, 4096);
    const metaCharset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
    if (metaCharset && metaCharset !== 'utf-8' && metaCharset !== 'utf8') return decode(metaCharset);
  }
  const bad = (utf8.match(/\ufffd/gu) || []).length;
  if (!bad) return utf8;
  const latin = decode('windows-1252');
  return (latin.match(/\ufffd/gu) || []).length < bad ? latin : utf8;
}

async function readCapped(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) throw new Error('reader: body larger than 8 MB');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error('reader: body larger than 8 MB');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * fetchPage(url, { timeoutMs, userAgent })
 * -> { url, status, contentType, html, bytes, byteLength, binary }
 * html is null for pdf/epub responses; bytes is the raw body.
 */
export async function fetchPage(url, { timeoutMs = 20000, userAgent = DESKTOP_UA } = {}) {
  const target = assertFetchableUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(target.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
  } catch (error) {
    clearTimeout(timer);
    if (error && error.name === 'AbortError') {
      throw new Error(`reader: timed out after ${timeoutMs}ms fetching ${target}`);
    }
    throw error;
  }
  try {
    const finalUrl = response.url || target.toString();
    // a redirect can land on a private host, so check the final url too
    assertFetchableUrl(finalUrl);
    const contentType = response.headers.get('content-type') || '';
    const bytes = await readCapped(response);
    const binary = BINARY_TYPES.some((type) => contentType.toLowerCase().includes(type));
    const html = binary ? null : decodeHtml(bytes, contentType);
    return {
      url: finalUrl,
      status: response.status,
      contentType,
      html,
      bytes,
      byteLength: bytes.byteLength,
      binary
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- extract */

function absolute(href, base) {
  if (!href) return '';
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function areaOf(element) {
  let node = element.parentElement;
  while (node) {
    const tag = node.tagName.toUpperCase();
    if (tag === 'NAV') return 'nav';
    if (tag === 'FOOTER') return 'footer';
    if (tag === 'HEADER') return 'header';
    if (tag === 'ARTICLE' || tag === 'MAIN') return 'article';
    node = node.parentElement;
  }
  return 'body';
}

// Comment widgets are marked on the candidate so the classifier can drop them.
function inCommentContainer(element) {
  let node = element;
  while (node) {
    const hay = `${node.getAttribute ? node.getAttribute('class') || '' : ''} ${node.id || ''}`.toLowerCase();
    if (/(comment|disqus|respond|isso|hyvor)/.test(hay)) return true;
    node = node.parentElement;
  }
  return false;
}

// Block children inside an anchor would otherwise run together ("NextThe third
// letter"), so join them with a space.
function anchorText(element) {
  let out = '';
  for (const child of element.childNodes) {
    if (child.nodeType === 3) out += child.nodeValue || '';
    else if (child.nodeType === 1) {
      const tag = child.tagName.toUpperCase();
      out += BLOCK_TAGS.has(tag) || tag === 'BR' ? ` ${anchorText(child)} ` : anchorText(child);
    }
  }
  return out;
}

/** Every anchor on the page plus head link rels, as classifyLinks candidates. */
export function collectCandidates(document, pageUrl) {
  const candidates = [];
  for (const link of document.querySelectorAll('head link[rel]')) {
    const rel = (link.getAttribute('rel') || '').toLowerCase();
    if (!/\b(next|prev|previous|up|index|contents)\b/.test(rel)) continue;
    candidates.push({
      href: absolute(link.getAttribute('href'), pageUrl),
      text: link.getAttribute('title') || '',
      rel,
      className: link.getAttribute('class') || '',
      id: link.id || '',
      ariaLabel: '',
      inHead: true,
      area: 'header',
      position: 0
    });
  }
  const anchors = [...document.querySelectorAll('a[href]')];
  const span = Math.max(anchors.length - 1, 1);
  anchors.forEach((anchor, index) => {
    const className = `${anchor.getAttribute('class') || ''}${inCommentContainer(anchor) ? ' comment-container' : ''}`.trim();
    candidates.push({
      href: absolute(anchor.getAttribute('href'), pageUrl),
      text: anchorText(anchor).replace(/\s+/g, ' ').trim(),
      rel: anchor.getAttribute('rel') || '',
      className,
      id: anchor.id || '',
      ariaLabel: anchor.getAttribute('aria-label') || '',
      inHead: false,
      area: areaOf(anchor),
      position: index / span
    });
  });
  return candidates;
}

function sanitize(root, pageUrl) {
  for (const element of [...root.querySelectorAll('*')]) {
    if (DROP_TAGS.has(element.tagName.toUpperCase())) {
      element.remove();
      continue;
    }
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (!KEEP_ATTRS.has(name)) element.removeAttribute(attr.name);
    }
    if (element.hasAttribute('href')) {
      const href = element.getAttribute('href').trim();
      if (/^(javascript|data):/i.test(href)) element.removeAttribute('href');
      else element.setAttribute('href', absolute(href, pageUrl));
    }
    if (element.hasAttribute('src')) {
      const src = element.getAttribute('src').trim();
      if (/^javascript:/i.test(src)) element.removeAttribute('src');
      else if (/^data:image\//i.test(src)) element.setAttribute('src', src); // inline images may stay
      else if (/^data:/i.test(src)) element.removeAttribute('src');
      else element.setAttribute('src', absolute(src, pageUrl));
    }
  }
  // strip html comments
  const walker = root.ownerDocument.createTreeWalker(root, 128);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const comment of comments) comment.remove();
  return root;
}

function normText(node) {
  return (node.textContent || '').replace(/\s+/g, ' ').trim();
}

function signatureOf(element, pageUrl) {
  const tag = element.tagName.toUpperCase();
  if (tag === 'IMG') return `img:${absolute(element.getAttribute('src'), pageUrl)}`;
  return `${tag}:${normText(element).slice(0, 80)}`;
}

// Readability sometimes throws away tables, figures or code that the reader
// wants. Put the missing ones back, anchored to the block they followed.
function restoreDropped(sourceDoc, contentRoot, pageUrl) {
  const present = new Map();
  for (const element of contentRoot.querySelectorAll('*')) {
    const signature = signatureOf(element, pageUrl);
    if (!present.has(signature)) present.set(signature, element);
  }
  const sourceElements = [...sourceDoc.querySelectorAll('*')];
  const restored = [];
  // What is already in the content, as one normalized string. Text already present is not a
  // dropped figure.
  let contentText = normText(contentRoot);
  for (const element of sourceDoc.querySelectorAll(RECOVERABLE)) {
    const signature = signatureOf(element, pageUrl);
    if (present.has(signature)) continue;
    if (alreadyPresent(normText(element), contentText)) continue;
    if (element.closest('nav, header, footer, aside, form')) continue;
    if (inCommentContainer(element)) continue;
    if (element.tagName.toUpperCase() !== 'IMG' && !normText(element)) continue;
    if (element.closest(RECOVERABLE) !== element) continue; // nested inside another recoverable
    // anchor: the nearest earlier block in the source that survived
    const index = sourceElements.indexOf(element);
    let anchor = null;
    for (let i = index - 1; i >= 0 && !anchor; i -= 1) {
      const candidate = sourceElements[i];
      if (candidate.contains(element)) continue;
      anchor = present.get(signatureOf(candidate, pageUrl)) || null;
    }
    const copy = contentRoot.ownerDocument.importNode(element, true);
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(copy, anchor.nextSibling);
    else contentRoot.appendChild(copy);
    present.set(signature, copy);
    contentText = `${contentText} ${normText(element)}`;
    restored.push(signature);
  }
  return restored;
}

// Is this element's prose already in the content? Sampled rather than compared whole, because
// the surviving copy has different whitespace and may have lost a caption or a stray link.
function alreadyPresent(elementText, contentText) {
  if (elementText.length < 200) return false;
  const probes = 5;
  const width = 100;
  let hits = 0;
  for (let i = 0; i < probes; i += 1) {
    const at = Math.floor(((elementText.length - width) * i) / (probes - 1));
    if (contentText.includes(elementText.slice(at, at + width))) hits += 1;
  }
  return hits >= 3;
}

// "Post title - Site Name" reads badly in a reader; drop the site suffix when
// the separator makes it unambiguous.
function trimSiteSuffix(title, siteName) {
  if (!title || !siteName) return title;
  const match = /^(.*?)\s*[|\u2013\u2014\-\u00b7:]\s*([^|\u2013\u2014\-\u00b7:]+)$/.exec(title);
  if (!match) return title;
  const head = match[1].trim();
  const tail = match[2].trim().toLowerCase();
  if (!head || head.length < 4) return title;
  return tail === siteName.trim().toLowerCase() ? head : title;
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(String(value).trim());
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

// --- who wrote it --------------------------------------------------------------------------------
//
// A read-later shelf wants the person, not the publication: "Jane Doe", not "Field Notes".
// Pages put the name in six or seven different places and agree on none of them, so every place is
// asked in order of how much it can be trusted, and the site name is only ever a last resort.

const AUTHOR_META = [
  'meta[name="author" i]',
  'meta[property="author" i]',
  'meta[name="article:author" i]',
  'meta[property="article:author" i]',
  'meta[name="dc.creator" i]',
  'meta[name="DC.creator" i]',
  'meta[name="citation_author" i]',
  'meta[name="parsely-author" i]',
  'meta[name="sailthru.author" i]',
  'meta[itemprop="author" i]'
];

// Selectors a blog engine actually emits around the name. Nothing inside a comment widget.
const AUTHOR_NODES = [
  '[rel~="author"]',
  '[itemprop="author"] [itemprop="name"]',
  '[itemprop="author"]',
  '.post-author', '.entry-author', '.author-name', '.byline__author', '.p-author',
  'article .byline', '.post-footer .author h4', '.author h4',
  'a[href*="/author/"]', 'a[href*="/authors/"]'
];

const NOT_A_NAME = /^(admin|staff|editor|guest|author|unknown|the editors?)$/iu;

/**
 * Tidy one candidate. Strips the "By " a page prints in front of the name, the trailing date or
 * reading time some themes glue on, and anything that is plainly not a name (a url, a paragraph).
 */
export function cleanAuthor(value) {
  let out = String(value == null ? '' : value).replace(/\s+/gu, ' ').trim();
  if (!out) return '';
  out = out.replace(/^(?:by|written by|words by|posted by|author)\s*[:\u2014-]?\s+/iu, '');
  out = out.split(/\s*[|\u00b7\u2022\u2013\u2014]\s+/u)[0].trim();   // "Jane Doe | The Paper", "Jane Doe - 7 min read"
  out = out.replace(/,?\s+(?:on\s+)?\w+\s+\d{1,2},?\s+\d{4}$/u, '').trim();  // a date glued to the name
  out = out.replace(/[\s,|\u00b7\u2022]+$/u, '').trim();
  if (!out || out.length > 80) return '';          // a paragraph is not a byline
  if (/^https?:\/\//iu.test(out)) return '';       // an author link's href is not its name
  if (NOT_A_NAME.test(out)) return '';
  if (!/[a-z\u00c0-\u024f]/iu.test(out)) return '';  // digits and punctuation only
  return out;
}

// Any author-ish key in any schema.org blob on the page: a string, a Person, or a list of them.
function jsonLdAuthor(document) {
  const nameOf = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return cleanAuthor(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = nameOf(item);
        if (found) return found;
      }
      return '';
    }
    if (typeof value === 'object') return cleanAuthor(value.name || value['@name'] || '');
    return '';
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent || '');
    } catch {
      continue;
    }
    const stack = [data];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      const found = nameOf(node.author) || nameOf(node.creator);
      if (found) return found;
      stack.push(...Object.values(node));
    }
  }
  return '';
}

/**
 * The author of a page, and where it was found. Returns { author, source }; author is '' when the
 * page genuinely names nobody, which is the only case where the caller should show the site.
 */
export function findAuthor(document, parsedByline = '') {
  for (const selector of AUTHOR_META) {
    for (const el of document.querySelectorAll(selector)) {
      const author = cleanAuthor(el.getAttribute('content'));
      if (author) return { author, source: selector };
    }
  }
  const fromLd = jsonLdAuthor(document);
  if (fromLd) return { author: fromLd, source: 'json-ld' };

  const fromReadability = cleanAuthor(parsedByline);
  if (fromReadability) return { author: fromReadability, source: 'readability' };

  for (const selector of AUTHOR_NODES) {
    for (const el of document.querySelectorAll(selector)) {
      if (inCommentContainer(el)) continue;
      const author = cleanAuthor(el.getAttribute('title') || el.textContent);
      if (author) return { author, source: selector };
    }
  }
  const handle = cleanAuthor((document.querySelector('meta[name="twitter:creator" i]') || { getAttribute: () => '' })
    .getAttribute('content'));
  if (handle && handle.startsWith('@')) return { author: handle.slice(1), source: 'twitter:creator' };
  return { author: '', source: '' };
}

function jsonLdDate(document) {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent || '');
    } catch {
      continue;
    }
    const stack = [data];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      if (typeof node.datePublished === 'string') return node.datePublished;
      stack.push(...Object.values(node));
    }
  }
  return null;
}

function publishedFrom(document) {
  const meta = (selector, attr = 'content') => {
    const el = document.querySelector(selector);
    return el ? el.getAttribute(attr) : null;
  };
  const ordered = [
    meta('meta[property="article:published_time"]'),
    meta('meta[name="article:published_time"]'),
    meta('meta[name="date"]'),
    meta('time[datetime]', 'datetime'),
    jsonLdDate(document)
  ];
  for (const value of ordered) {
    const iso = toIso(value);
    if (iso) return iso;
  }
  return null;
}

function textOf(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += (child.nodeValue || '').replace(/\s+/g, ' ');
    } else if (child.nodeType === 1) {
      const tag = child.tagName.toUpperCase();
      if (tag === 'BR') {
        out += '\n';
      } else if (tag === 'PRE') {
        out += `\n${child.textContent || ''}\n`;
      } else if (BLOCK_TAGS.has(tag)) {
        out += `\n${textOf(child)}\n`;
      } else {
        out += textOf(child);
      }
    }
  }
  return out;
}

function blockText(node) {
  return textOf(node)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

// Heuristic used when readability gives up: the element whose paragraphs hold
// the most text.
function largestTextBlock(document) {
  let best = null;
  let bestScore = 0;
  for (const element of document.querySelectorAll('article, main, section, div, td')) {
    let score = 0;
    for (const p of element.querySelectorAll(':scope > p, :scope > pre, :scope > blockquote, :scope > ul, :scope > ol')) {
      score += normText(p).length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = element;
    }
  }
  if (best) return best;
  const body = document.body;
  return body && normText(body) ? body : null;
}

/**
 * extractArticle({ html, url })
 * -> { title, byline, siteName, publishedAt, lang, excerpt, contentHtml, text,
 *      words, canonicalUrl, links, images, fallback, restored }
 */
export function extractArticle({ html, url, seriesTitle }) {
  const pageUrl = String(url || 'https://example.invalid/');
  const dom = new JSDOM(String(html == null ? '' : html), { url: pageUrl });
  const document = dom.window.document;

  const meta = (selector, attr = 'content') => {
    const el = document.querySelector(selector);
    const value = el ? el.getAttribute(attr) : null;
    return value ? value.trim() : '';
  };

  let parsed = null;
  try {
    parsed = new Readability(document.cloneNode(true), {
      keepClasses: false,
      charThreshold: 250
    }).parse();
  } catch {
    parsed = null;
  }

  const contentDom = new JSDOM('<body></body>', { url: pageUrl });
  const holder = contentDom.window.document.body;
  let fallback = false;

  if (parsed && parsed.content && normText(new JSDOM(parsed.content).window.document.body).length >= 140) {
    holder.innerHTML = parsed.content;
    const page = holder.querySelector('#readability-page-1');
    if (page) holder.innerHTML = page.innerHTML;
  } else {
    fallback = true;
    const block = largestTextBlock(document);
    holder.innerHTML = block ? block.innerHTML : '';
  }

  const restored = restoreDropped(document, holder, pageUrl);
  sanitize(holder, pageUrl);

  const contentHtml = holder.innerHTML.trim();
  const text = blockText(holder);
  const words = text.split(/\s+/).filter(Boolean).length;

  const canonicalHref = meta('link[rel~="canonical"]', 'href');
  const canonicalUrl = canonicalHref ? absolute(canonicalHref, pageUrl) : pageUrl;

  const rawTitle =
    (parsed && parsed.title && parsed.title.trim()) ||
    meta('meta[property="og:title"]') ||
    normText(document.querySelector('title') || { textContent: '' }) ||
    normText(document.querySelector('h1') || { textContent: '' }) ||
    '';

  const { author, source: bylineSource } = findAuthor(document, parsed && parsed.byline);
  const byline = author || null;
  const siteName = (parsed && parsed.siteName && parsed.siteName.trim()) || meta('meta[property="og:site_name"]') || null;
  const lang =
    (document.documentElement.getAttribute('lang') || '').trim() ||
    meta('meta[http-equiv="content-language"]') ||
    (parsed && parsed.lang) ||
    null;
  const title = trimSiteSuffix(rawTitle, siteName);
  const excerpt =
    (parsed && parsed.excerpt && parsed.excerpt.trim()) ||
    meta('meta[property="og:description"]') ||
    meta('meta[name="description"]') ||
    '';

  const links = classifyLinks(collectCandidates(document, pageUrl), {
    pageUrl: canonicalUrl || pageUrl,
    seriesTitle: seriesTitle || undefined
  });

  const images = [...holder.querySelectorAll('img')]
    .map((img) => ({ src: img.getAttribute('src') || '', alt: img.getAttribute('alt') || '' }))
    .filter((img) => img.src);

  return {
    title,
    byline,
    bylineSource,
    siteName,
    publishedAt: publishedFrom(document),
    lang,
    excerpt,
    contentHtml,
    text,
    words,
    canonicalUrl,
    links,
    images,
    fallback,
    restored
  };
}

export default { fetchPage, extractArticle, collectCandidates, assertFetchableUrl, findAuthor, cleanAuthor };
