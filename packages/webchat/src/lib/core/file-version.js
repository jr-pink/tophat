// A local file embedded in a reply (`![caption](/abs/path.png)`) is addressed by its path, and a path
// is the same string after the file is rewritten. A browser keeps one decoded picture per URL for the
// life of the page, so a later reply embedding the same path showed the first reply's bytes. The fix is
// to make the URL name the bytes: `&v=<mtime ms>-<size>`, resolved by the server (`&version=1`) when a
// reply is drawn, and served with an immutable cache only when that v still matches the file.

// `mtime` is the ISO string the file lookup returns (a Date, so whole milliseconds) or a number of ms.
export function fileVersion(file) {
  if (!file || file.directory) return null;
  const ms = typeof file.mtime === 'number' ? Math.trunc(file.mtime) : Date.parse(file.mtime);
  const size = Number(file.size);
  if (!Number.isFinite(ms) || !Number.isSafeInteger(size) || size < 0) return null;
  return `${ms}-${size}`;
}

// The versioned form of a local-file URL; any other URL, or one with no known version, comes back as is.
// `amp` is the text of the "&" between parameters: "&amp;" inside compiled HTML, "&" in a plain URL.
export function withFileVersion(url, version, amp = '&') {
  if (!version || typeof url !== 'string' || !url.startsWith('/api/file?') || /[?&]v=/u.test(url.replaceAll('&amp;', '&'))) return url;
  return `${url}${amp}v=${encodeURIComponent(version)}`;
}

// The paths of the local-file URLs in a piece of compiled HTML or in a URL, as written in the query.
const RAW_IN_HTML = /\/api\/file\?(?:conversation=[^&"]*&amp;)?path=([^&"]+)&amp;raw=1(?!&amp;v=)/gu;
export function rawPathsIn(html) {
  const out = new Set();
  for (const match of String(html || '').matchAll(RAW_IN_HTML)) {
    try { out.add(decodeURIComponent(match[1])); } catch {  }
  }
  return [...out];
}

// Stamp every local-file image URL in compiled HTML whose path has a version; a path still waiting for
// its version loses its src, so the browser never fetches (and keeps) the unversioned URL first.
// `versions` maps path -> version string, or '' once the lookup failed (the plain URL is then used).
export function stampImages(html, versions) {
  const text = String(html || '');
  if (!text.includes('/api/file?')) return text;
  return text.replace(/<img src="(\/api\/file\?(?:conversation=[^&"]*&amp;)?path=([^&"]+)&amp;raw=1)"/gu, (whole, src, enc) => {
    let path;
    try { path = decodeURIComponent(enc); } catch { return whole; }
    const v = versions[path];
    if (v === undefined) return '<img data-pending-version="1"';
    return v ? `<img src="${withFileVersion(src, v, '&amp;')}"` : whole;
  });
}

// Ask the server for a file's version. Resolves to '' on any failure so a caller falls back to the
// plain URL (a missing file then shows the same broken-image state as before).
export async function fetchFileVersion(path, conversationId, doFetch = globalThis.fetch) {
  try {
    const params = new URLSearchParams({ path, version: '1' });
    if (conversationId) params.set('conversation', conversationId);
    const response = await doFetch(`/api/file?${params}`);
    if (!response.ok) return '';
    const body = await response.json();
    return typeof body?.v === 'string' ? body.v : '';
  } catch {
    return '';
  }
}
