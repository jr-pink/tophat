// Remote images in chat: `![caption](https://cdn.example.com/photo.jpg)`.
//
// The browser never fetches the URL. The server does, once, and keeps the bytes on disk keyed by the
// hash of the URL, so (1) a transcript seen once still shows its pictures with the origin gone or the
// laptop offline (the service worker keeps the proxied response too), and (2) the one place that
// decides which addresses we will talk to is here, not in every client.
//
// What is refused, and why:
//  - a scheme other than http(s), credentials in the URL, a port other than 80/443: nothing here
//    needs them and each widens what a link in a message can make this machine do;
//  - any host that is, or resolves to, a loopback, private, link-local, CGNAT, multicast or
//    unspecified address. The check runs inside the socket's own DNS lookup, so it is the address
//    actually connected to (a name that resolves to 127.0.0.1, or flips after a first answer, is
//    refused), and again on every redirect hop;
//  - a response that is not image/* (SVG excluded: it can carry script and would be served from our
//    origin), is larger than MAX_BYTES, takes longer than TIMEOUT_MS, or redirects more than
//    MAX_REDIRECTS times.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { webchatStorePath } from './paths.js';

export const MAX_BYTES = 8 * 1024 * 1024;
export const TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
export const MAX_URL_LENGTH = 2048;

export class RemoteImageError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RemoteImageError';
    this.status = status;
  }
}

function ipv4Public(text) {
  const [a, b, c] = text.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;       // CGNAT
  if (a === 169 && b === 254) return false;                 // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;        // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false;    // benchmarking
  if (a >= 224) return false;                               // multicast, reserved, broadcast
  return true;
}

/** True only for a globally routable unicast address; anything unparsable is false. */
export function isPublicAddress(address) {
  const text = String(address || '').replace(/^\[|\]$/gu, '').split('%')[0].toLowerCase();
  const kind = net.isIP(text);
  if (kind === 4) return ipv4Public(text);
  if (kind !== 6) return false;
  const mapped = text.match(/^(?:0{0,4}:){2,5}(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/u)
    || text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (mapped) return ipv4Public(mapped[1]);
  const hex = text.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return ipv4Public(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (text === '::' || text === '::1') return false;
  const first = parseInt(text.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false;            // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false;            // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false;            // multicast
  if (first === 0x2001 && text.startsWith('2001:db8')) return false; // documentation
  if (first === 0x64 && text.startsWith('64:ff9b:')) return false;   // NAT64 can reach v4 private space
  if (first === 0) return false;                            // ::/8 includes v4-compatible forms
  return true;
}

const BLOCKED_NAME = /(^|\.)(localhost|local|localdomain|internal|lan|home|corp|intranet)$/u;

/** Parse and vet a URL before any connection; throws RemoteImageError(400|403). `ports` is test-only. */
export function vetRemoteUrl(input, { ports = ['80', '443'], addresses = isPublicAddress } = {}) {
  const text = String(input ?? '').trim();
  if (!text || text.length > MAX_URL_LENGTH) throw new RemoteImageError(400, 'Not a usable image URL');
  let url;
  try { url = new URL(text); } catch { throw new RemoteImageError(400, 'Not a URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RemoteImageError(400, 'Only http(s) images');
  if (url.username || url.password) throw new RemoteImageError(403, 'Credentials in a URL are refused');
  if (url.port && !ports.includes(url.port)) throw new RemoteImageError(403, 'Port not allowed');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (!host) throw new RemoteImageError(400, 'No host');
  if (net.isIP(host)) {
    if (!addresses(host)) throw new RemoteImageError(403, 'Private address refused');
  } else if (BLOCKED_NAME.test(host) || !host.includes('.')) {
    throw new RemoteImageError(403, 'Private host name refused');
  }
  return url;
}

/** A dns.lookup that refuses to hand back anything but public addresses. */
export function guardedLookup(allowed = isPublicAddress, resolver = dns.lookup) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    resolver(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return done(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (!list.length || list.some((entry) => !allowed(entry.address))) {
        return done(Object.assign(new Error(`refused address for ${hostname}`), { code: 'EREFUSED' }));
      }
      if (opts.all) return done(null, list);
      return done(null, list[0].address, list[0].family);
    });
  };
}

export function imageType(header) {
  const type = String(header || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/u.test(type) || type === 'image/svg+xml') return null;
  return type;
}

function once({ url, lookup, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET', lookup, timeout: timeoutMs,
      headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (compatible; tophat-webchat-image-proxy)', 'accept-encoding': 'identity' },
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: new URL(response.headers.location, url).toString() });
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new RemoteImageError(502, `Image host answered ${status}`));
        return;
      }
      const type = imageType(response.headers['content-type']);
      if (!type) { response.resume(); reject(new RemoteImageError(415, 'Not an image')); return; }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) { response.resume(); reject(new RemoteImageError(413, 'Image too large')); return; }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(); reject(new RemoteImageError(413, 'Image too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ type, bytes: Buffer.concat(chunks) }));
      response.on('error', (error) => reject(new RemoteImageError(502, error.message)));
    });
    request.on('timeout', () => { request.destroy(); reject(new RemoteImageError(504, 'Image host timed out')); });
    request.on('error', (error) => reject(error instanceof RemoteImageError ? error
      : new RemoteImageError(error.code === 'EREFUSED' ? 403 : 502, error.code === 'EREFUSED' ? 'Private address refused' : 'Could not fetch image')));
    request.end();
  });
}

export const cacheKey = (url) => createHash('sha256').update(String(url)).digest('hex');

/**
 * Bytes and content type for a remote image: from the disk cache when present, otherwise fetched
 * under every guard above and cached. Throws RemoteImageError.
 */
export async function remoteImage(input, {
  dir = webchatStorePath('remote-images'),
  allowed = isPublicAddress,
  resolver = dns.lookup,
  maxBytes = MAX_BYTES,
  timeoutMs = TIMEOUT_MS,
  maxRedirects = MAX_REDIRECTS,
  vetting = undefined, // test seam only; the routes never pass options
} = {}) {
  const vet = (value) => vetRemoteUrl(value, vetting);
  let url = vet(input);
  const key = cacheKey(url.toString());
  try {
    const meta = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'));
    const bytes = await readFile(join(dir, `${key}.bin`));
    if (imageType(meta.type) && bytes.length) return { type: meta.type, bytes, cached: true };
  } catch { /* not cached */ }
  const lookup = guardedLookup(allowed, resolver);
  for (let hop = 0; ; hop += 1) {
    const result = await once({ url, lookup, timeoutMs, maxBytes });
    if (result.redirect) {
      if (hop >= maxRedirects) throw new RemoteImageError(502, 'Too many redirects');
      url = vet(result.redirect);
      continue;
    }
    if (!result.bytes.length) throw new RemoteImageError(502, 'Empty image');
    try {
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `${key}.${process.pid}.tmp`);
      await writeFile(tmp, result.bytes);
      await rename(tmp, join(dir, `${key}.bin`));
      await writeFile(join(dir, `${key}.json`), JSON.stringify({ url: input, type: result.type, at: new Date().toISOString() }));
    } catch (error) {
      await rm(join(dir, `${key}.${process.pid}.tmp`), { force: true }).catch(() => {});
    }
    return { type: result.type, bytes: result.bytes, cached: false };
  }
}

/** The Response both routes return; errors are plain text with no-store so nothing caches a failure. */
export async function remoteImageResponse(input, options) {
  try {
    const { type, bytes } = await remoteImage(input, options);
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': type,
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'referrer-policy': 'no-referrer',
      },
    });
  } catch (error) {
    const status = error instanceof RemoteImageError ? error.status : 502;
    return new Response(error instanceof RemoteImageError ? error.message : 'Could not fetch image', {
      status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
