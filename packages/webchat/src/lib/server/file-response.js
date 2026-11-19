import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

// Strict by default: no script anywhere. SVG always gets this one.
const STRICT_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:";
// Published, self-contained interactive pages (Plotly exports and the like). The sandbox directive
// has no allow-same-origin, so the document runs in an opaque origin: no cookies, no storage, no
// reach into the chat app. connect-src, frame-src, form-action and base-uri stay closed, so a script
// can draw but cannot phone home or navigate-submit. 'unsafe-eval' is there for WebGL charts (regl
// builds its shaders with new Function).
const INTERACTIVE_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// A published artifact may load and talk back to its own folder only: `artifactSrc` is that
// artifact's URL prefix (origin + /view/<ULID>/, or several space-separated when the page is
// reachable on more than one host), a CSP source expression that matches by path prefix. It is added
// to script, style, img, media, font, worker and connect sources, so a multi-file artifact (HTML + ES
// modules + images + models) works while every other origin and every other path stays closed. The
// sandbox gives the page an opaque origin, so 'self' would match nothing; the explicit prefix is what
// names it. `connectSrc` is the older name and means the same. `immutable`
// is for a file asked for by content hash (?v=<hash>): the URL names the bytes, so the browser may
// keep them for good and a reload or an app swap never fetches them again.
// `connect` is an app-declared allowlist of extra connect-src origins (quicklook.json "connect", carried in the artifact's
// meta.json by docstore-kit). Only exact https:// or wss:// origins pass; anything else is dropped here, so a bad meta.json
// can never widen the policy beyond named hosts, and only connect-src is touched (no script, frame or form origins).
const CONNECT_ORIGIN = /^(?:(?:https|wss):\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|(?:http|ws):\/\/(?:localhost|127\.0\.0\.1))(?::\d{1,5})?$/u;
export function connectOriginsFrom(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list.slice(0, 8)) {
    const o = String(raw).trim().toLowerCase();
    if (CONNECT_ORIGIN.test(o) && !out.includes(o)) out.push(o);
  }
  return out;
}
export function interactiveCsp(artifactSrc = null, connect = []) {
  const src = String(artifactSrc || '').trim();
  const extra = connectOriginsFrom(connect).join(' ');
  if (!src) return extra ? INTERACTIVE_CSP.replace("connect-src 'none'", `connect-src ${extra}`) : INTERACTIVE_CSP;
  return INTERACTIVE_CSP
    .replace("script-src 'unsafe-inline' 'unsafe-eval'", `script-src 'unsafe-inline' 'unsafe-eval' ${src}`)
    .replace("style-src 'unsafe-inline'", `style-src 'unsafe-inline' ${src}`)
    .replace('img-src data: blob:', `img-src data: blob: ${src}`)
    .replace('media-src data: blob:', `media-src data: blob: ${src}`)
    .replace('font-src data:', `font-src data: ${src}`)
    .replace('worker-src blob:', `worker-src blob: ${src}`)
    .replace("connect-src 'none'", `connect-src ${src}${extra ? ' ' + extra : ''}`);
}

export function rawFileResponse(found, mime, range, { interactiveHtml = false, artifactSrc = null, connectSrc = null, connect = [], immutable = false, extraHeaders = null } = {}) {
  const interactive = interactiveCsp(artifactSrc || connectSrc, connect);
  const headers = {
    'content-type': mime,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'private, max-age=5',
    ...(extraHeaders || {}),
    'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff',
    ...(mime === 'text/html' ? { 'content-security-policy': interactiveHtml ? interactive : STRICT_CSP }
      : mime === 'image/svg+xml' ? { 'content-security-policy': STRICT_CSP } : {})
  };
  let start = 0, end = found.size - 1, status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${found.size}` } });
    if (!match[1]) start = Math.max(0, found.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= found.size) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${found.size}` } });
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${found.size}`;
  }
  headers['content-length'] = String(Math.max(0, end - start + 1));
  return new Response(found.size ? Readable.toWeb(createReadStream(found.path, { start, end })) : null, { status, headers });
}
