import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { error, json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { SESSION_COOKIE } from '$lib/server/auth.js';
import { readerStore } from '$lib/server/reader-store.js';
import { browse, keep } from '$lib/server/reader-browse.js';
import { secretsDir, writeSecret } from '$lib/server/secrets.js';
import { shortcutFile } from '$lib/server/reader-shortcut.js';

// The share sheet's way in. iOS does not implement the web share target in the manifest, so a page
// shared out of Chrome or Safari on the phone cannot reach the installed app at all; what can is a
// Shortcut, and a Shortcut has no browser session. This is the one endpoint that takes a bearer
// instead of the session cookie: give it a url, it fetches and keeps the page, and the phone gets
// a title back to show in a notification. Nothing opens, nothing waits for a browser.
//
// The token lives beside the service token, in the secrets directory, and is read at request time
// so a token written after the server started still works. No token file, no sharing.

function shareToken() {
  try { return readFileSync(join(secretsDir(), 'reader-share-token'), 'utf8').trim(); }
  catch { return ''; }
}

function authorized(request, url) {
  const expected = shareToken();
  if (!expected) return false;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /iu, '')
    || url.searchParams.get('token') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A share sheet sends a bare url, or a sentence with the url inside it, or a title and a url on
// two lines. Take the first http(s) url anywhere in what arrives.
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/u;

async function target(request, url) {
  const type = request.headers.get('content-type') || '';
  let fields = {};
  if (type.includes('application/json')) fields = await request.json().catch(() => ({}));
  else if (type.includes('form')) {
    const form = await request.formData().catch(() => null);
    if (form) fields = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  } else {
    const body = await request.text().catch(() => '');
    if (body) fields = { text: body };
  }
  const given = [fields.url, fields.text, fields.title, url.searchParams.get('url'), url.searchParams.get('text')]
    .map((value) => String(value || '').trim())
    .find((value) => value);
  if (!given) return '';
  if (/^https?:\/\//iu.test(given)) return given;
  return (given.match(URL_IN_TEXT) || [''])[0];
}

export async function POST({ request, url }) {
  if (!authorized(request, url)) return json({ error: 'a share token is required' }, { status: 401 });

  const link = await target(request, url);
  if (!link) return json({ error: 'a url is required' }, { status: 400 });

  const store = readerStore();
  // Something he has already shared is not fetched twice; the shortcut says so and stops.
  const existing = store.docByUrl(link);
  if (existing) return json({ id: existing.id, title: existing.title, saved: true, already: true });

  let page;
  try {
    page = await browse(link);
  } catch (cause) {
    return json({ error: `could not fetch that page: ${cause.message}` }, { status: cause.status || 502 });
  }
  const id = keep(store, page);
  const doc = store.doc(id);
  return json({ id, title: doc?.title || link, saved: true, already: false });
}


// --- installing it ------------------------------------------------------------------------------

// GET is the one place the share token is handed out, and that token lets whoever holds it put
// pages into his reader. It is his alone, so it needs his session: hooks.server.js keeps it behind
// one (the ?token= exemption on this path is the Shortcut's POST and nothing else,
// src/lib/server/public-paths.js), and the handler checks again so a later change to that list
// cannot reopen it, the way /api/mp/rooms does.
//
// Before this check, GET was exempted whenever ?token= was present, which is the query string the
// Shortcut POSTs with; so `GET /api/reader/share?token=anything` answered an unauthenticated
// stranger with the real token, and ?install=1 handed over a Shortcut carrying it.
//
// A tool running on this machine does not need this route: the token is a file, read the way every
// other service token here is read (~/.config/tophat/secrets/reader-share-token).
export async function GET({ url, cookies }) {
  if (!app.auth.valid(cookies.get(SESSION_COOKIE))) error(401, 'Sign in required');

  let token = shareToken();
  if (!token) {
    token = randomBytes(24).toString('base64url');
    writeSecret('reader-share-token', token);
  }
  const endpoint = `${url.origin}/api/reader/share`;

  if (url.searchParams.get('install')) {
    const { bytes, signed } = await shortcutFile({ endpoint, token });
    return new Response(bytes, {
      headers: {
        'content-type': 'application/x-shortcut',
        'content-disposition': 'attachment; filename="Send to Reader.shortcut"',
        'cache-control': 'no-store',
        'x-shortcut-signed': String(signed)
      }
    });
  }

  return json({
    install: `${endpoint}?install=1`,
    endpoint,
    token,
    how: 'Open the install link on the phone and tap the downloaded file; Shortcuts adds "Send to Reader" to the share sheet.'
  }, { headers: { 'cache-control': 'no-store' } });
}
