// The /api/docs/guest/* endpoints: a guest of a public document binds their display name to a
// passkey, signs in with one made earlier, renames, or signs out. The store, tokens and cookies
// are doc-guests.js; this file is the HTTP shape only.
//
// What a guest token is good for: the name docs-routes.js whoOf() shows for that tab, and nothing
// else. hooks.server.js admits these paths without the owner session and never reads the guest
// cookie; the cookie is set only on Path=/docs and Path=/api/docs; and no owner check anywhere
// consults it. Begin endpoints are rate limited per address, since they write a challenge row.
import { error, json } from '@sveltejs/kit';
import { docGuests, guestCookieSets, GuestError, GUEST_COOKIE } from './doc-guests.js';
import { allow } from './docs.js';

const NO_STORE = { 'cache-control': 'no-store' };

const clientIp = (event) => event.request.headers.get('cf-connecting-ip')
  || (() => { try { return event.getClientAddress(); } catch { return 'local'; } })();

function rateLimited(event) {
  if (allow(`guest:${clientIp(event)}`, { perSecond: 1, burst: 10 })) return null;
  return json({ error: 'Too many requests; slow down' }, { status: 429, headers: { 'retry-after': '2', ...NO_STORE } });
}

function fail(cause) {
  if (cause instanceof GuestError) error(cause.status, cause.message);
  throw cause;
}

const bodyOf = (event) => event.request.json().catch(() => ({}));

function setCookies(event, session) {
  const secure = event.url.protocol === 'https:';
  for (const { value, opts } of guestCookieSets(session, { secure })) event.cookies.set(GUEST_COOKIE, value, opts);
}

// The HttpOnly cookie is the credential; the token never goes into the JSON.
function signedIn(event, session) {
  setCookies(event, session);
  return json({ guestId: session.guestId, name: session.name, bound: true }, { headers: NO_STORE });
}

export async function guestRegisterBegin(event) {
  const refused = rateLimited(event);
  if (refused) return refused;
  const { name } = await bodyOf(event);
  try { return json(await docGuests().beginRegister(name), { headers: NO_STORE }); } catch (cause) { return fail(cause); }
}

export async function guestRegisterFinish(event) {
  const { response } = await bodyOf(event);
  if (!response || typeof response !== 'object') error(400, 'response is required');
  try { return signedIn(event, await docGuests().finishRegister(response)); } catch (cause) { return fail(cause); }
}

export async function guestAuthBegin(event) {
  const refused = rateLimited(event);
  if (refused) return refused;
  try { return json(await docGuests().beginAuth(), { headers: NO_STORE }); } catch (cause) { return fail(cause); }
}

export async function guestAuthFinish(event) {
  const { response } = await bodyOf(event);
  if (!response || typeof response !== 'object') error(400, 'response is required');
  try { return signedIn(event, await docGuests().finishAuth(response)); } catch (cause) { return fail(cause); }
}

export async function guestRename(event) {
  const { name } = await bodyOf(event);
  let who = null;
  try { who = docGuests().rename(event.cookies.get(GUEST_COOKIE), name); } catch (cause) { fail(cause); }
  if (!who) error(401, 'No guest passkey session');
  return json({ guestId: who.guestId, name: who.name, bound: true }, { headers: NO_STORE });
}

export function guestSignout(event) {
  setCookies(event, null);
  return json({ ok: true }, { headers: NO_STORE });
}

/** The guest a request's cookie names, or null. Never consulted for owner access. */
export function guestOf(cookies) {
  const token = cookies?.get?.(GUEST_COOKIE);
  if (!token) return null;
  try { return docGuests().verifyGuestToken(token); } catch { return null; }
}
