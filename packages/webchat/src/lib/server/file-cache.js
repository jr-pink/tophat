// What /api/file?raw=1 tells a browser about keeping a local file's bytes. A path stays the same string
// after the file is rewritten, so the cache key has to carry the bytes' identity: the client asks for
// the file's version (`<mtime ms>-<size>`, `&version=1`) when it draws a reply and puts it on the image
// URL (`&v=`). A URL whose v equals the file's current version names those exact bytes, so it is kept
// for good; any other URL (no v, or a v the file has moved past) is revalidated each time by etag, so a
// rewritten file is never shown from a copy kept under the same URL, and an unchanged one costs a 304.
export function rawCacheHeaders({ version, requestedVersion, mime }) {
  const headers = version ? { etag: `"${version}"` } : {};
  if (version && requestedVersion === version) headers['cache-control'] = 'private, max-age=31536000, immutable';
  else if (String(mime).startsWith('image/')) headers['cache-control'] = 'private, no-cache';
  return headers;
}

// True when the request's If-None-Match already names this etag (and no Range is asked, which a 304 cannot answer).
export function notModified({ headers, ifNoneMatch, range }) {
  return Boolean(headers.etag) && !range && ifNoneMatch === headers.etag;
}
