import { rawFileResponse } from '$lib/server/file-response.js';
import { json, error } from '@sveltejs/kit';
import { basename } from 'node:path';
import { resolvePreview } from '$lib/server/preview-resolve.js';
import { app, DEFAULT_CWD } from '$lib/server/app.js';
import { requireChat, scopeContext } from '$lib/server/scope-guard.js';
import { isText, listDirectory, mimeFor, readForPreview } from '$lib/server/files.js';
import { playable } from '$lib/server/video.js';
import { fileVersion } from '$lib/core/file-version.js';

export async function GET(event) {
  const { url, request } = event;
  const path = url.searchParams.get('path');
  const conversationId = url.searchParams.get('conversation');
  // A chat's files are the chat's: the same scope check as its transcript.
  if (conversationId) {
    const ctx = scopeContext(event, app.store, app.runner);
    if (ctx.enabled) requireChat(ctx, app.store.conversation(conversationId));
  }
  const cwd = (conversationId && app.store.conversation(conversationId)?.cwd) || DEFAULT_CWD;
  const resolved = await resolvePreview({ store: app.store, conversationId, path, cwd });
  if (resolved.kind === 'credential') error(403, 'Credential stores are never served over the web.');
  if (resolved.kind === 'remote') {
    const remote = resolved.remote;
    if (remote.directory) return json({ path: remote.path, name: basename(remote.path), directory: true, entries: remote.entries, remote: remote.remote }, { headers: { 'cache-control': 'no-store' } });
    return json({ path: remote.path, name: basename(remote.path), size: remote.size, mtime: remote.mtime, mime: mimeFor(remote.path), ...(remote.text.includes('\u0000') || !isText(remote.path) ? { binary: true } : { text: remote.text, truncated: remote.truncated }), remote: remote.remote }, { headers: { 'cache-control': 'no-store' } });
  }
  const found = resolved.kind === 'local' ? resolved.found : null;
  if (!found) error(404, `No file by that name: tried ${basename(cwd)}, the folders this chat worked in, the projects and your home`);

  if (found.directory) {
    return json(
      { path: found.path, name: basename(found.path), directory: true, entries: await listDirectory(found.path), shorthand: found.shorthand || null },
      { headers: { 'cache-control': 'no-store' } }
    );
  }

  // The file's version, `<mtime ms>-<size>`: what a reply asks for when it draws a local image, so the
  // image URL it then uses (`&v=`) changes whenever the file does.
  if (url.searchParams.get('version')) {
    return json({ path: found.path, v: fileVersion(found) }, { headers: { 'cache-control': 'no-store' } });
  }

  // Inline video player: `videometa` answers source resolution/fps/duration and whether the
  // browser-playable form is ready (starting a transcode if not); `video` serves that form with Range.
  if (url.searchParams.get('videometa') || url.searchParams.get('video')) {
    let v;
    try { v = await playable(found.path, { wait: false }); } catch (cause) { error(cause.status || 500, cause.message); }
    const { path: _p, size: _s, ...meta } = v;
    if (url.searchParams.get('videometa')) return json(meta, { headers: { 'cache-control': 'no-store' } });
    if (!v.ready) return json(meta, { status: 503, headers: { 'retry-after': '2', 'cache-control': 'no-store' } });
    return rawFileResponse({ path: v.path, size: v.size }, v.transcoded ? 'video/mp4' : mimeFor(found.path), request.headers.get('range'));
  }
  if (url.searchParams.get('download')) {
    // A hundred-megabyte epub read into one buffer with no accept-ranges gives the phone nothing to
    // resume from, so a dropped byte on cell fails the whole download and Safari says it cannot retry.
    // Same streaming, range-aware body as `raw`, wearing the attachment header.
    const streamed = rawFileResponse(found, mimeFor(found.path), request.headers.get('range'));
    const headers = new Headers(streamed.headers);
    headers.set('content-disposition', `attachment; filename="${basename(found.path).replaceAll('"', '')}"`);
    headers.set('cache-control', 'no-store');
    return new Response(streamed.body, { status: streamed.status, headers });
  }
  if (url.searchParams.get('raw')) {
    const mime = mimeFor(found.path);
    // A URL that names the bytes (`v` equal to the file's current version) never changes meaning, so it
    // is kept for good. Anything else is revalidated each time (an image), so a rewritten file is never
    // shown from a copy kept under the same URL; the etag makes that a 304 while the file is unchanged.
    const version = fileVersion(found);
    const pinned = Boolean(version) && url.searchParams.get('v') === version;
    const headers = version ? { etag: `"${version}"` } : {};
    if (pinned) headers['cache-control'] = 'private, max-age=31536000, immutable';
    else if (mime.startsWith('image/')) headers['cache-control'] = 'private, no-cache';
    if (version && !request.headers.get('range') && request.headers.get('if-none-match') === headers.etag) {
      return new Response(null, { status: 304, headers: { ...headers, 'cache-control': headers['cache-control'] || 'private, max-age=5' } });
    }
    return rawFileResponse(found, mime, request.headers.get('range'), { extraHeaders: headers });
  }
  const preview = await readForPreview(found);
  return json({ path: found.path, name: basename(found.path), size: found.size, mtime: found.mtime, mime: mimeFor(found.path), ...preview },
    { headers: { 'cache-control': 'no-store' } });
}
