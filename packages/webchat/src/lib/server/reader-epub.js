// EPUB ingest: unzip an .epub from bytes and return chapters as sanitized HTML + plain text.
// Zip reading is done here (no dependencies): end of central directory, central directory,
// local headers, stored (0) and deflate (8) via zlib.inflateRawSync, with zip64 support.
import zlib from 'node:zlib';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SIG_LOCAL = 0x04034b50, SIG_CEN = 0x02014b50;
const SIG_EOCD = 0x06054b50, SIG_EOCD64 = 0x06064b50, SIG_EOCD64_LOC = 0x07064b50;

/* ---------------------------------------------------------------- zip ---- */

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  throw new Error('readEpub: expected a Buffer or Uint8Array of the .epub file');
}

const hasZipMagic = (buf) => buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL;

// The end of central directory record sits at the end, but a trailing comment (max 64k) may follow it.
function findEocd(buf) {
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  return -1;
}

// zip64: the classic record keeps 0xffff / 0xffffffff placeholders and the real numbers live in
// the zip64 record pointed at by the locator that precedes the classic one. Missing locator is fine.
function readDirectoryLocation(buf, eocd) {
  let count = buf.readUInt16LE(eocd + 10);
  let size = buf.readUInt32LE(eocd + 12);
  let offset = buf.readUInt32LE(eocd + 16);
  const needs64 = count === 0xffff || size === 0xffffffff || offset === 0xffffffff;
  const loc = eocd - 20;
  if (needs64 && loc >= 0 && buf.readUInt32LE(loc) === SIG_EOCD64_LOC) {
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === SIG_EOCD64) {
      count = Number(buf.readBigUInt64LE(z64 + 32));
      size = Number(buf.readBigUInt64LE(z64 + 40));
      offset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  return { count, size, offset };
}

// Per entry zip64 extra field (header id 0x0001): only the fields that were maxed out are present,
// in this fixed order: uncompressed size, compressed size, local header offset, disk number.
function applyZip64Extra(extra, entry) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      const take = () => { const v = Number(extra.readBigUInt64LE(q)); q += 8; return v; };
      if (entry.size === 0xffffffff && q + 8 <= p + 4 + len) entry.size = take();
      if (entry.compSize === 0xffffffff && q + 8 <= p + 4 + len) entry.compSize = take();
      if (entry.offset === 0xffffffff && q + 8 <= p + 4 + len) entry.offset = take();
      break;
    }
    p += 4 + len;
  }
}

// A zip is read through a source: either a buffer already in memory, or a file descriptor. The
// file source is what makes a 100 MB book cost nothing to open: only the end of central directory,
// the central directory and whichever entry is being read are ever in memory.
function bufferSource(buf) {
  return { size: buf.length, read: (off, len) => buf.subarray(off, off + len), close() {} };
}

function fileSource(path) {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  let closed = false;
  return {
    size,
    read(off, len) {
      if (len <= 0 || closed) return Buffer.alloc(0);
      const want = Math.max(0, Math.min(len, size - off));
      const out = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const n = readSync(fd, out, got, want - got, off + got);
        if (n <= 0) break;
        got += n;
      }
      return got === want ? out : out.subarray(0, got);
    },
    close() { if (!closed) { closed = true; closeSync(fd); } }
  };
}

// Where the central directory is, read from the tail of the file rather than from the whole of it.
function locateDirectory(source) {
  const tailLen = Math.min(source.size, 22 + 0xffff + 20);
  const base = source.size - tailLen;
  const tail = source.read(base, tailLen);
  const at = findEocd(tail);
  if (at < 0) throw new Error('not an epub: no zip end of central directory record found');
  let count = tail.readUInt16LE(at + 10);
  let size = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  const needs64 = count === 0xffff || size === 0xffffffff || offset === 0xffffffff;
  const loc = at - 20;
  if (needs64 && loc >= 0 && tail.readUInt32LE(loc) === SIG_EOCD64_LOC) {
    const z64 = Number(tail.readBigUInt64LE(loc + 8));
    const rec = z64 >= base ? tail.subarray(z64 - base) : source.read(z64, 56);
    if (rec.length >= 56 && rec.readUInt32LE(0) === SIG_EOCD64) {
      count = Number(rec.readBigUInt64LE(32));
      size = Number(rec.readBigUInt64LE(40));
      offset = Number(rec.readBigUInt64LE(48));
    }
  }
  return { count, size, offset };
}

function openZip(source) {
  if (source.size < 4 || source.read(0, 4).readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error('not an epub: the bytes do not start with the zip magic PK\\x03\\x04');
  }
  const dir = locateDirectory(source);
  const cd = source.read(dir.offset, dir.size);
  const entries = new Map();
  const order = [];
  let p = 0;
  for (let i = 0; i < dir.count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== SIG_CEN) break;
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const entry = {
      name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'), // names are decoded as UTF-8
      method: cd.readUInt16LE(p + 10),
      compSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42)
    };
    applyZip64Extra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), entry);
    if (!entries.has(entry.name)) { entries.set(entry.name, entry); order.push(entry.name); }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw new Error('not an epub: the zip central directory is empty or unreadable');
  return { source, entries, order, close: () => source.close() };
}

function parseZip(bytes) {
  const buf = toBuffer(bytes);
  if (!hasZipMagic(buf)) throw new Error('not an epub: the bytes do not start with the zip magic PK\\x03\\x04');
  return openZip(bufferSource(buf));
}

// Read one entry. The local header's own sizes are zero when a data descriptor is used (flag bit 3),
// so the compressed size always comes from the central directory instead.
function readZipEntry(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  const header = zip.source.read(e.offset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== SIG_LOCAL)
    throw new Error(`corrupt epub: bad local header for "${name}"`);
  // The local header's own name and extra lengths can differ from the central directory's, so the
  // data offset is worked out from the local header; its sizes are not trusted, because an entry
  // written with a data descriptor (flag bit 3) leaves them zero.
  const start = e.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = zip.source.read(start, e.compSize);
  if (raw.length < e.compSize) throw new Error(`corrupt epub: "${name}" is truncated`);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported epub compression method ${e.method} for "${name}"`);
}

function readZipText(zip, name) {
  const b = readZipEntry(zip, name);
  return b ? b.toString('utf8').replace(/^\uFEFF/, '') : null;
}

/* --------------------------------------------------------------- paths ---- */

function decodeHref(href) {
  try { return decodeURIComponent(href); } catch { return href; }
}

function normalizePath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

const dirOf = (p) => (p.lastIndexOf('/') < 0 ? '' : p.slice(0, p.lastIndexOf('/')));

// Resolve a manifest/nav href against the directory of the file that named it.
function resolveHref(baseFile, href) {
  const h = decodeHref(String(href || '').trim());
  if (h.startsWith('/')) return normalizePath(h);
  const base = dirOf(baseFile);
  return normalizePath(base ? `${base}/${h}` : h);
}

function splitFragment(href) {
  const i = href.indexOf('#');
  return i < 0 ? { path: href, frag: '' } : { path: href.slice(0, i), frag: href.slice(i) };
}

const MEDIA_BY_EXT = {
  xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', opf: 'application/oebps-package+xml',
  ncx: 'application/x-dtbncx+xml', css: 'text/css', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf',
  woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4', js: 'text/javascript', json: 'application/json'
};

function guessMedia(path) {
  const ext = path.split('.').pop().toLowerCase();
  return MEDIA_BY_EXT[ext] || 'application/octet-stream';
}

/* ----------------------------------------------------------------- dom ---- */

// OPF/NCX/nav are XML; parse as XML when well formed, otherwise fall back to the tolerant HTML parser.
function parseMarkup(text, xml) {
  if (xml) {
    try { return new JSDOM(text, { contentType: 'text/xml' }).window.document; } catch { /* fall back to HTML */ }
  }
  return new JSDOM(text, { contentType: 'text/html' }).window.document;
}

const localName = (el) => String(el.localName || el.tagName || '').toLowerCase().split(':').pop();

// Own pre order walk instead of getElementsByTagName: jsdom's live HTMLCollection costs O(n^2)
// to iterate, which is minutes instead of milliseconds on a big chapter.
function descendants(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    const kids = [];
    for (let c = node.firstElementChild; c; c = c.nextElementSibling) kids.push(c);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    if (node !== root) out.push(node);
  }
  return out;
}

function allLocal(root, name) {
  return descendants(root).filter((el) => localName(el) === name);
}

const firstLocal = (root, name) => allLocal(root, name)[0] || null;
const childrenLocal = (el, name) => Array.from(el.children || []).filter((c) => localName(c) === name);
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------ sanitize ---- */

const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'noscript', 'applet']);
const URL_ATTRS = ['href', 'src', 'xlink:href', 'data', 'action', 'poster', 'formaction'];
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'div', 'dd', 'dl', 'dt', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
]);

const isJavascriptUrl = (v) => /^\s*javascript\s*:/i.test(String(v || '').replace(/[\u0000-\u0020]/g, (c) => (c === ' ' ? ' ' : '')));
const isAbsoluteUrl = (v) => /^[a-z][a-z0-9+.-]*:/i.test(v);

// Rewrite a relative image url to `epub:<zip path>` so the app can serve it from the archive later.
function rewriteImageUrl(value, chapterHref) {
  const v = String(value || '').trim();
  if (!v || v.startsWith('#')) return v;
  if (isAbsoluteUrl(v)) return v; // http(s):, data:, already epub: and friends stay untouched
  const { path } = splitFragment(v);
  return `epub:${resolveHref(chapterHref, path)}`;
}

function sanitizeBody(doc, chapterHref) {
  const body = doc.body || doc.documentElement;
  for (const el of descendants(body)) {
    if (!el.parentNode) continue; // already removed with an ancestor
    if (DROP_TAGS.has(localName(el))) { el.remove(); continue; }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name); // event handlers
      else if (URL_ATTRS.includes(name) && isJavascriptUrl(attr.value)) el.removeAttribute(attr.name);
    }
    const tag = localName(el);
    if (tag === 'img' || tag === 'image' || tag === 'source') {
      for (const a of ['src', 'href', 'xlink:href']) {
        const v = el.getAttribute(a);
        if (v) el.setAttribute(a, rewriteImageUrl(v, chapterHref));
      }
    }
  }
  return body;
}

// Plain text: block elements become line breaks, inline whitespace is collapsed.
function textOf(node, inPre = false) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += inPre ? child.nodeValue : String(child.nodeValue).replace(/[^\S\n]+/g, ' ');
    } else if (child.nodeType === 1) {
      const tag = localName(child);
      if (tag === 'br') { out += '\n'; continue; }
      const block = BLOCK_TAGS.has(tag);
      if (block) out += '\n';
      out += textOf(child, inPre || tag === 'pre');
      if (block) out += '\n';
    }
  }
  return out;
}

function plainText(el) {
  return textOf(el)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const countWords = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

/* ----------------------------------------------------------------- opf ---- */

function findOpfPath(zip) {
  const container = readZipText(zip, 'META-INF/container.xml');
  if (container) {
    const doc = parseMarkup(container, true);
    for (const rf of allLocal(doc, 'rootfile')) {
      const full = rf.getAttribute('full-path');
      if (full) return normalizePath(decodeHref(full));
    }
  }
  // Tolerate a missing or broken container.xml by taking the first .opf in the archive.
  const guess = zip.order.find((n) => n.toLowerCase().endsWith('.opf'));
  if (guess) return guess;
  throw new Error('not an epub: no OPF package document found (no META-INF/container.xml rootfile and no .opf entry)');
}

function metaText(doc, name) {
  for (const el of allLocal(doc, name)) {
    const t = collapse(el.textContent);
    if (t) return t;
  }
  return '';
}

function readManifest(doc, opfPath) {
  const items = new Map();
  const manifest = firstLocal(doc, 'manifest') || doc;
  for (const el of allLocal(manifest, 'item')) {
    const id = el.getAttribute('id');
    const href = el.getAttribute('href');
    if (!id || !href) continue;
    items.set(id, {
      id,
      href: resolveHref(opfPath, href),
      mediaType: el.getAttribute('media-type') || guessMedia(href),
      properties: (el.getAttribute('properties') || '').split(/\s+/).filter(Boolean)
    });
  }
  return items;
}

function readSpine(doc, items) {
  const spineEl = firstLocal(doc, 'spine');
  const out = [];
  if (!spineEl) return out;
  for (const el of allLocal(spineEl, 'itemref')) {
    const item = items.get(el.getAttribute('idref'));
    if (item) out.push(item);
  }
  return out;
}

/* ----------------------------------------------------------------- toc ---- */

function tocFromNav(zip, navItem) {
  const text = readZipText(zip, navItem.href);
  if (!text) return [];
  const doc = parseMarkup(text, false); // nav is XHTML; the HTML parser keeps epub:type readable
  const navs = allLocal(doc, 'nav');
  const navEl =
    navs.find((n) => /toc/i.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) || navs[0] || doc.body;
  if (!navEl) return [];
  const out = [];
  // Document order over every anchor flattens a multi level ol/li/ol tree into reading order.
  for (const a of allLocal(navEl, 'a')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const { path, frag } = splitFragment(decodeHref(href.trim()));
    if (!path) continue;
    out.push({ title: collapse(a.textContent), href: resolveHref(navItem.href, path) + frag, order: out.length });
  }
  return out;
}

function tocFromNcx(zip, ncxItem) {
  const text = readZipText(zip, ncxItem.href);
  if (!text) return [];
  const doc = parseMarkup(text, true);
  const map = firstLocal(doc, 'navmap');
  if (!map) return [];
  const out = [];
  for (const point of allLocal(map, 'navpoint')) {
    const label = childrenLocal(point, 'navlabel')[0];
    const content = childrenLocal(point, 'content')[0];
    const src = content && content.getAttribute('src');
    if (!src) continue;
    const { path, frag } = splitFragment(decodeHref(src.trim()));
    out.push({
      title: label ? collapse((firstLocal(label, 'text') || label).textContent) : '',
      href: resolveHref(ncxItem.href, path) + frag,
      order: out.length
    });
  }
  return out;
}

function findNavItem(items) {
  for (const item of items.values()) if (item.properties.includes('nav')) return item;
  return null;
}

function findNcxItem(doc, items) {
  const spineEl = firstLocal(doc, 'spine');
  const tocId = spineEl && spineEl.getAttribute('toc');
  if (tocId && items.has(tocId)) return items.get(tocId);
  for (const item of items.values()) if (item.mediaType === 'application/x-dtbncx+xml') return item;
  return null;
}

function findCover(zip, doc, items) {
  let item = null;
  for (const it of items.values()) if (it.properties.includes('cover-image')) item = it;
  if (!item) {
    for (const m of allLocal(doc, 'meta')) {
      if ((m.getAttribute('name') || '').toLowerCase() === 'cover') {
        const byId = items.get(m.getAttribute('content'));
        if (byId) item = byId;
      }
    }
  }
  if (!item) return null;
  const bytes = readZipEntry(zip, item.href);
  if (!bytes) return null;
  return { href: item.href, mediaType: item.mediaType || guessMedia(item.href), bytes: new Uint8Array(bytes) };
}



/* ------------------------------------------------------- chapter scan ---- */
//
// Chapters are scanned, not parsed into a DOM. jsdom retains about half a megabyte per document
// even after window.close(), which is fine for one page and fatal for a book: walking a ten
// thousand chapter EPUB grew the heap by that much per chapter until the process died. This single
// pass emits the sanitized HTML and the plain text together, holds only the current chapter, and
// is about ten times faster as well.

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['script', 'style']);
// Dropped with everything inside them; the void members of DROP_TAGS are simply skipped.
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'applet']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', mdash: '\u2014', ndash: '\u2013',
  hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', middot: '\u00b7',
  times: '\u00d7', deg: '\u00b0', eacute: '\u00e9', egrave: '\u00e8', uuml: '\u00fc', ouml: '\u00f6',
  auml: '\u00e4', szlig: '\u00df', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', bull: '\u2022',
  laquo: '\u00ab', raquo: '\u00bb', shy: '', ensp: ' ', emsp: ' ', thinsp: ' '
};

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/giu, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const found = NAMED_ENTITIES[body.toLowerCase()];
    return found === undefined ? whole : found;
  });
}

const escapeAttr = (value) => String(value).replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;');

// Attributes of one start tag, in source order. Values may be quoted either way or bare.
function readAttributes(source) {
  const attrs = [];
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  let match = re.exec(source);
  while (match) {
    attrs.push({ name: match[1], value: match[2] ?? match[3] ?? match[4] ?? '' });
    match = re.exec(source);
  }
  return attrs;
}

/**
 * Scan one chapter. Returns the sanitized inner HTML of its body, the plain text, the document
 * title and the first heading, in one pass over the source.
 */
function scanChapter(source, chapterHref) {
  const html = [];
  const text = [];
  const open = [];           // open element names, so unbalanced markup is closed rather than leaking
  let inBody = !/<body[\s>]/iu.test(source);   // a fragment with no body element is all body
  let preDepth = 0;
  let docTitle = '';
  let heading = '';
  let headingTag = '';
  let capture = null;        // 'title' | 'heading' while inside one
  let captured = '';
  let i = 0;

  const emitText = (raw) => {
    if (!inBody) return;
    const decoded = decodeEntities(raw);
    if (capture) captured += decoded;
    html.push(raw);
    text.push(preDepth > 0 ? decoded : decoded.replace(/[^\S\n]+/gu, ' '));
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) { emitText(source.slice(i)); break; }
    if (lt > i) emitText(source.slice(i, lt));

    // comments, doctype, CDATA and processing instructions carry nothing we keep
    if (source.startsWith('<!--', lt)) { const end = source.indexOf('-->', lt); i = end === -1 ? source.length : end + 3; continue; }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt);
      emitText(source.slice(lt + 9, end === -1 ? source.length : end));
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt); i = end === -1 ? source.length : end + 1; continue;
    }

    const end = source.indexOf('>', lt);
    if (end === -1) { emitText(source.slice(lt)); break; }
    const inner = source.slice(lt + 1, end);
    i = end + 1;

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim().toLowerCase().split(':').pop();
      if (name === 'body') { inBody = false; continue; }
      if (!inBody) continue;
      if (capture === 'heading' && name === headingTag) { heading = captured; capture = null; }
      const at = open.lastIndexOf(name);
      if (at === -1) continue;                     // stray end tag
      for (let k = open.length - 1; k >= at; k -= 1) {
        html.push(`</${open[k]}>`);
        if (open[k] === 'pre') preDepth = Math.max(0, preDepth - 1);
        if (BLOCK_TAGS.has(open[k])) text.push('\n');
      }
      open.length = at;
      continue;
    }

    const nameMatch = /^([a-z][^\s/>]*)/iu.exec(inner);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase().split(':').pop();
    const selfClosing = inner.trimEnd().endsWith('/') || VOID_TAGS.has(name);
    const attrs = readAttributes(inner.slice(nameMatch[0].length));

    if (name === 'body') { inBody = true; continue; }
    if (name === 'title' && !inBody) {
      const close = source.toLowerCase().indexOf('</title', i);
      docTitle = decodeEntities(source.slice(i, close === -1 ? i : close));
      i = close === -1 ? i : source.indexOf('>', close) + 1;
      continue;
    }
    if (RAW_TEXT_TAGS.has(name) || DROP_WITH_CONTENT.has(name)) {
      // skip the element and everything in it, counting nesting of the same name
      let depth = 1;
      let at = i;
      const opener = new RegExp(`<${name}[\\s>]`, 'iu');
      while (depth > 0 && at < source.length) {
        const closeAt = source.toLowerCase().indexOf(`</${name}`, at);
        if (closeAt === -1) { at = source.length; break; }
        const between = source.slice(at, closeAt);
        if (opener.test(between)) depth += 1; else depth -= 1;
        at = source.indexOf('>', closeAt);
        at = at === -1 ? source.length : at + 1;
      }
      i = at;
      continue;
    }
    if (DROP_TAGS.has(name)) continue;             // link, meta, base: the tag alone
    if (!inBody) continue;

    const kept = [];
    for (const attr of attrs) {
      const lower = attr.name.toLowerCase();
      if (lower.startsWith('on')) continue;                                        // event handlers
      if (URL_ATTRS.includes(lower) && isJavascriptUrl(attr.value)) continue;      // javascript: urls
      let value = attr.value;
      if ((name === 'img' || name === 'image' || name === 'source') && ['src', 'href', 'xlink:href'].includes(lower)) {
        value = rewriteImageUrl(decodeEntities(value), chapterHref);
      }
      kept.push(`${attr.name}="${escapeAttr(value)}"`);
    }

    html.push(`<${name}${kept.length ? ` ${kept.join(' ')}` : ''}${selfClosing && VOID_TAGS.has(name) ? '' : ''}>`);
    if (name === 'br') text.push('\n');
    else if (BLOCK_TAGS.has(name)) text.push('\n');
    if (!selfClosing) {
      open.push(name);
      if (name === 'pre') preDepth += 1;
      if (!heading && (name === 'h1' || name === 'h2')) { capture = 'heading'; headingTag = name; captured = ''; }
    }
  }

  for (let k = open.length - 1; k >= 0; k -= 1) html.push(`</${open[k]}>`);

  const plain = text.join('')
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { html: html.join('').trim(), text: plain, docTitle: collapse(docTitle), heading: collapse(heading) };
}

/* --------------------------------------------------------- package ---- */

// Everything a book says about itself, without touching a single chapter. This is what makes the
// outline and the contents rail available the moment an upload lands.
function openPackage(zip) {
  const opfPath = findOpfPath(zip);
  const opfText = readZipText(zip, opfPath);
  if (opfText == null) throw new Error(`not an epub: OPF package document "${opfPath}" is missing from the archive`);
  const opf = parseMarkup(opfText, true);
  if (!firstLocal(opf, 'manifest')) throw new Error(`not an epub: "${opfPath}" has no manifest`);

  const metaEl = firstLocal(opf, 'metadata') || opf;
  const items = readManifest(opf, opfPath);
  const spineItems = readSpine(opf, items).filter((item) => zip.entries.has(item.href));

  const navItem = findNavItem(items);
  const ncxItem = findNcxItem(opf, items);
  let toc = navItem ? tocFromNav(zip, navItem) : [];
  if (!toc.length && ncxItem) toc = tocFromNcx(zip, ncxItem);

  // Toc titles per target document. An entry without a fragment names the whole document and beats
  // the chapter's own heading; an entry with a fragment names a spot inside it, so it is a fallback.
  const tocTitles = new Map();
  const tocFragTitles = new Map();
  for (const t of toc) {
    const { path, frag } = splitFragment(t.href);
    const into = frag ? tocFragTitles : tocTitles;
    if (t.title && !into.has(path)) into.set(path, t.title);
  }

  return {
    opf, opfPath, items, toc, tocTitles, tocFragTitles,
    spine: spineItems.map((item, order) => ({ order, id: item.id, href: item.href })),
    meta: {
      title: metaText(metaEl, 'title'),
      author: metaText(metaEl, 'creator'),
      language: metaText(metaEl, 'language'),
      identifier: metaText(metaEl, 'identifier')
    }
  };
}

// One chapter, parsed and then released. The jsdom window is closed explicitly: without it a walk
// of a ten thousand chapter book keeps every document it has ever parsed.
function buildSection(zip, pkg, item) {
  const raw = readZipText(zip, item.href);
  if (raw == null) return null;
  const scanned = scanChapter(raw, item.href);
  let title = pkg.tocTitles.get(item.href) || '';
  if (!title) title = scanned.heading || pkg.tocFragTitles.get(item.href) || scanned.docTitle || '';
  return {
    order: item.order,
    id: item.id,
    href: item.href,
    title,
    html: scanned.html,
    text: scanned.text,
    words: countWords(scanned.text)
  };
}

/* -------------------------------------------------------------- public ---- */

export function isEpub(bytes) {
  try {
    const buf = toBuffer(bytes);
    if (!hasZipMagic(buf)) return false;
    const zip = parseZip(buf);
    return zip.entries.has('mimetype') || zip.order.some((n) => n.toLowerCase().endsWith('.opf'));
  } catch {
    return false;
  }
}

export function epubEntry(bytes, zipPath) {
  const zip = parseZip(bytes);
  const want = normalizePath(decodeHref(String(zipPath || '').replace(/^epub:/, '')));
  const name = zip.entries.has(want) ? want : zip.order.find((n) => normalizePath(n) === want);
  if (!name) return null;
  const data = readZipEntry(zip, name);
  if (!data) return null;
  let mediaType = guessMedia(name);
  try {
    const opfPath = findOpfPath(zip);
    const doc = parseMarkup(readZipText(zip, opfPath) || '', true);
    for (const item of readManifest(doc, opfPath).values()) {
      if (item.href === name && item.mediaType) mediaType = item.mediaType; // prefer the declared type
    }
  } catch { /* the manifest is optional when only raw bytes are wanted */ }
  return { bytes: new Uint8Array(data), mediaType };
}

export function readEpub(bytes) {
  const zip = parseZip(bytes);
  const pkg = openPackage(zip);
  const sections = [];
  for (const item of pkg.spine) {
    const section = buildSection(zip, pkg, { ...item, order: sections.length });
    if (section) sections.push(section); // a spine item missing from the zip is skipped, not fatal
  }
  return {
    ...pkg.meta,
    cover: findCover(zip, pkg.opf, pkg.items),
    sections,
    toc: pkg.toc
  };
}

/**
 * A book read from disk, one chapter at a time.
 *
 * The handle holds a file descriptor and the central directory (a map of byte ranges); it does not
 * hold the book. meta, spine and toc are available immediately, so the outline and the chapter list
 * can be shown while nothing has been parsed; section() and sections() parse one chapter at a time
 * and release it. This is the path a 100 MB, ten thousand entry book takes.
 */
export function openEpubFile(path) {
  const zip = openZip(fileSource(path));
  let pkg;
  try {
    pkg = openPackage(zip);
  } catch (cause) {
    zip.close();
    throw cause;
  }
  let closed = false;

  const titleFor = (order) => {
    const item = pkg.spine[order];
    if (!item) return '';
    return pkg.tocTitles.get(item.href) || pkg.tocFragTitles.get(item.href) || '';
  };

  const section = (order) => {
    const item = pkg.spine[order];
    if (!item || closed) return null;
    return buildSection(zip, pkg, item);
  };

  function* sections(range = {}) {
    const from = Math.max(0, Number(range.from || 0));
    const to = Math.min(pkg.spine.length, Number(range.to ?? pkg.spine.length));
    for (let order = from; order < to; order += 1) {
      const built = section(order);
      if (built) yield built;
    }
  }

  const entry = (zipPath) => {
    if (closed) return null;
    const want = normalizePath(decodeHref(String(zipPath || '').replace(/^epub:/, '')));
    const name = zip.entries.has(want) ? want : zip.order.find((n) => normalizePath(n) === want);
    if (!name) return null;
    const data = readZipEntry(zip, name);
    if (!data) return null;
    let mediaType = guessMedia(name);
    for (const item of pkg.items.values()) if (item.href === name && item.mediaType) mediaType = item.mediaType;
    return { bytes: new Uint8Array(data), mediaType };
  };

  const coverItem = (() => {
    for (const it of pkg.items.values()) if (it.properties.includes('cover-image')) return it;
    for (const m of allLocal(pkg.opf, 'meta')) {
      if ((m.getAttribute('name') || '').toLowerCase() === 'cover') {
        const byId = pkg.items.get(m.getAttribute('content'));
        if (byId) return byId;
      }
    }
    return null;
  })();

  return {
    meta: {
      ...pkg.meta,
      cover: coverItem ? { href: coverItem.href, mediaType: coverItem.mediaType || guessMedia(coverItem.href) } : null
    },
    spine: pkg.spine,
    toc: pkg.toc,
    count: pkg.spine.length,
    titleFor,
    section,
    sections,
    entry,
    close() { if (!closed) { closed = true; zip.close(); } }
  };
}

/** Whether a file on disk starts with the zip magic. Reads four bytes, not the file. */
export function isEpubFile(path) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.allocUnsafe(4);
    const got = readSync(fd, head, 0, 4, 0);
    return got === 4 && head.readUInt32LE(0) === SIG_LOCAL;
  } catch {
    return false;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* nothing to close */ }
  }
}

export default { readEpub, isEpub, epubEntry, openEpubFile, isEpubFile };
