// Sign-in for scoped tophat: a request needs an org-domain session that the sign-in service vouches
// for, and that identity must map to an account in the scope registry.
//
// The verification is the one server's shop gate uses (services/shop/src/server/gate.ts): the
// browser holds cookie __Secure-edge_session (Domain .eng.rose, HttpOnly, set by the auth
// Worker), this server forwards it to GET <authBase>/api/session, which answers {email, org} or
// 401. We never parse the cookie ourselves; the Worker is the store of record. A session seen OK
// is trusted for 5 minutes, and for 12 hours when auth.eng.rose is unreachable. org is true only
// for an exact org-domain address (the Worker's rule); this module checks the domain again.
//
// Nothing here trusts the network: no loopback exemption, because a tunnel delivers remote
// requests as loopback. Only the paths the caller names public (health, for the deploy guard)
// skip it, and that decision stays in hooks.server.js.

import { readFileSync, statSync } from 'node:fs';
import { accountsFor, parseRegistry } from './registry.mjs';

export const EDGE_COOKIE = '__Secure-edge_session';
const FRESH_MS = 5 * 60_000;
const OFFLINE_MS = 12 * 3600_000;

export function sessionToken(cookieHeader) {
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === EDGE_COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

// Reads the registry file again when its mtime changes, so an edit lands without a restart.
export function registryFromFile(path) {
  let stamp = null;
  let registry = null;
  return () => {
    const m = statSync(path).mtimeMs;
    if (!registry || m !== stamp) { registry = parseRegistry(readFileSync(path, 'utf8')); stamp = m; }
    return registry;
  };
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'cookie' }
});

/**
 * @param {object} o
 * @param {string} o.authBase       the sign-in service origin (it answers GET /api/session)
 * @param {string} o.orgDomain      the one email domain allowed in, e.g. example.org
 * @param {string|null} o.publicBase  where this server is reached, for the post-sign-in return
 * @param {() => object} o.registry   returns a parsed registry (registryFromFile)
 * @param {Function} [o.fetchSession] test seam: (cookieHeader) => {email, org} | null, throws if unreachable
 * @param {() => number} [o.now]
 */
export function makeScopeGate({ authBase, orgDomain, publicBase = null, registry, fetchSession, now = Date.now }) {
  if (!authBase || !orgDomain) throw new Error('scope gate needs authBase and orgDomain');
  const suffix = '@' + String(orgDomain).replace(/^@/, '').toLowerCase();
  const seen = new Map();
  const ask = fetchSession || (async (cookie) => {
    const r = await fetch(`${authBase}/api/session`, { headers: { cookie }, signal: AbortSignal.timeout(4000) });
    if (r.status === 401) return null;
    if (!r.ok) throw new Error(`auth ${r.status}`);
    return r.json();
  });

  async function who(token) {
    const hit = seen.get(token);
    if (hit && now() - hit.at < FRESH_MS) return hit;
    try {
      const s = await ask(`${EDGE_COOKIE}=${token}`);
      if (!s || typeof s.email !== 'string') { seen.delete(token); return null; }
      const rec = { email: s.email.trim().toLowerCase(), org: Boolean(s.org), at: now() };
      seen.set(token, rec);
      if (seen.size > 5000) seen.delete(seen.keys().next().value);
      return rec;
    } catch {
      return hit && now() - hit.at < OFFLINE_MS ? hit : null;
    }
  }

  /**
   * Resolve a request to {ok:true, email, account, name, personalScope, scopes} or
   * {ok:false, response}. Pages (GET accepting html) are sent to sign-in; everything else gets 401
   * or 403 JSON.
   */
  return async function check(request) {
    const token = sessionToken(request.headers.get('cookie'));
    const s = token ? await who(token) : null;
    const url = new URL(request.url);
    const page = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
    if (!s) {
      if (page) {
        const back = `${publicBase || url.origin}${url.pathname}${url.search}`;
        return { ok: false, response: Response.redirect(`${authBase}/?next=${encodeURIComponent(back)}`, 302) };
      }
      return { ok: false, response: json(401, { error: `sign in with your ${orgDomain} passkey`, signIn: authBase }) };
    }
    if (!s.org || !s.email.endsWith(suffix) || s.email.split('@').length !== 2) {
      return { ok: false, response: json(403, { error: `${orgDomain} accounts only` }) };
    }
    const account = accountsFor(s.email, registry());
    if (!account) {
      return { ok: false, response: json(403, { error: `no account for ${s.email}; ask an admin to add it to the scope registry` }) };
    }
    return { ok: true, ...account };
  };
}
