import { error } from '@sveltejs/kit';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mimeFor } from '$lib/server/files.js';
import { rawFileResponse } from '$lib/server/file-response.js';
import { CORS, liveStream, storeView } from '$lib/server/quicklook-live.js';

// Published quicklook artifacts, served where their links actually point.
//
// The ULID is the credential, as it always was for the quicklook server itself.
//
// Containment is checked after realpath, not before: path.resolve does not follow symlinks, and a link
// inside the root once served any file on this Mac.

const QUICKLOOK_ROOT = process.env.TOPHAT_QUICKLOOK_ROOT
  || join(homedir(), '.local/share/tophat/quicklook');

function contain(root, candidate) {
  let real;
  try { real = realpathSync(candidate); } catch { return null; }
  const base = realpathSync(root);
  return real === base || real.startsWith(base + sep) ? real : null;
}

// SvelteKit's default trailingSlash is 'never', which 308s /view/<ulid>/ to /view/<ulid> before
// this handler runs. A published directory's index.html served at the slashless URL resolves every
// relative link one level up (/view/a.txt) and 404s them all, which broke every directory share.
// So the slash is left alone here, and the handler decides: a directory asked for without its
// slash is redirected to the slash form before index.html is served.
export const trailingSlash = 'ignore';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

// The live channel (src/lib/server/quicklook-live.js) lives at two reserved names inside an
// artifact: GET /view/<ulid>/__live and POST /view/<ulid>/__view. The ULID stays the only credential
// (this route is public by design, see public-paths.js); the page is in an opaque origin, so its
// requests carry no cookie and are answered with CORS `*`.
function artifactDir(ulid) {
  if (!ULID.test(ulid)) error(404, 'Not found');
  const dir = contain(QUICKLOOK_ROOT, resolve(QUICKLOOK_ROOT, ulid));
  if (!dir || !statSync(dir).isDirectory()) error(404, 'Not found');
  return dir;
}

// The origin the browser actually asked on. With ORIGIN set in the environment, url.origin is that
// configured value, not the host the page was opened on (a second public hostname, or the tunnel), and
// a prefix naming the other host blocks every sub-resource. So the forwarded host and proto the tunnel
// sends (else Host) come first, the configured origin after it. A host that is not a plain
// hostname[:port] is ignored, so a forged header cannot inject CSP text.
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/iu;
function artifactOrigins(request, here) {
  const first = (v) => String(v || '').split(',')[0].trim();
  const host = first(request.headers.get('x-forwarded-host')) || first(request.headers.get('host'));
  const proto = first(request.headers.get('x-forwarded-proto')).toLowerCase() || here.protocol.replace(/:$/u, '');
  const out = [];
  if (host && HOST.test(host) && (proto === 'https' || proto === 'http')) out.push(`${proto}://${host.toLowerCase()}`);
  if (!out.includes(here.origin)) out.push(here.origin);
  return out;
}

const split = (params) => String(params.path || '').split('/').filter(Boolean);

export function OPTIONS({ params }) {
  const parts = split(params);
  if (!parts.length || !ULID.test(parts[0])) error(404, 'Not found');
  return new Response(null, { status: 204, headers: { ...CORS, 'cache-control': 'no-store' } });
}

export async function POST({ params, request }) {
  const parts = split(params);
  if (parts.length !== 2 || parts[1] !== '__view') error(404, 'Not found');
  const dir = artifactDir(parts[0]);
  const text = await request.text();
  const status = storeView(dir, text);
  return new Response(null, { status, headers: { ...CORS, 'cache-control': 'no-store' } });
}

export function GET({ params, request, url }) {
  const parts = split(params);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) error(404, 'Not found');
  const [ulid, ...rest] = parts;
  if (!ULID.test(ulid)) error(404, 'Not found');

  if (rest.length === 1 && rest[0] === '__live') {
    const dir = artifactDir(ulid);
    return new Response(liveStream(dir), {
      headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' }
    });
  }

  const asked = resolve(QUICKLOOK_ROOT, ulid, ...rest);
  let real = contain(QUICKLOOK_ROOT, asked);
  if (!real) error(404, 'Not found');

  let stat = statSync(real);
  if (stat.isDirectory()) {
    const here = url || new URL(request.url);
    if (!here.pathname.endsWith('/')) {
      return new Response(null, {
        status: 308,
        headers: { location: `${here.pathname}/${here.search}`, 'cache-control': 'no-store' }
      });
    }
    // A published directory, or a bare ULID: index.html is the entry, as the publisher writes it.
    const index = contain(QUICKLOOK_ROOT, join(real, 'index.html'));
    if (!index) error(404, 'Not found');
    real = index;
    stat = statSync(real);
  }
  if (!stat.isFile()) error(404, 'Not found');

  const here = url || new URL(request.url);
  // The page's sources name this artifact's own URL prefix, so it can load its scripts, styles,
  // images, fonts, models and __live from its own folder and nothing else.
  const artifactSrc = artifactOrigins(request, here).map((o) => `${o}/view/${ulid}/`).join(' ');
  return rawFileResponse({ path: real, size: stat.size }, mimeFor(real), request.headers.get('range'), {
    interactiveHtml: true,
    artifactSrc,
    immutable: here.searchParams.has('v'),
    extraHeaders: CORS
  });
}
