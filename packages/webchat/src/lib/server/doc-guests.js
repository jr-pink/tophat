// Guest identity for public documents (docs.js): a display name, optionally bound to a passkey.
//
// Two tiers, and the difference matters:
//
//  1. A name with no passkey is a label. The tab keeps it in localStorage (tophat.docs.name, the
//     key DocPage.svelte already uses) and sends it as x-doc-name; the server cleans it and shows
//     it. It is SPOOFABLE: anyone can type any name, including someone else's. Nothing here or in
//     docs-routes.js treats an unbound name as proof of anything.
//  2. A name with a passkey is bound. The guest registers a WebAuthn credential with the name;
//     the server stores credential id, public key, counter and the name in its own sqlite file and
//     hands back a signed guest token (cookie docs_guest). verifyGuestToken() then answers with the
//     name as stored, so a bound name cannot be claimed by another tab, and it follows the guest to
//     any device holding the passkey (finishAuth). It is still only a name a stranger chose: bound
//     means "the same person as before", never "who they say they are".
//
// Isolation from the owner session (auth.js), which is the property that must never break:
//  - a separate database file (docs/guests.sqlite by default), never the webchat store auth.js
//    keeps its credentials in, so a guest passkey can never sign in as the owner: auth.js only
//    accepts credentials in its own table;
//  - a separate secret (guests.secret beside the database, 0600), never webchat-session-secret;
//  - a different token shape ("dg1.<guestId>.<expires>.<sig>") and a domain-separated HMAC input,
//    so even if both secrets were the same bytes, auth.valid() recomputes HMAC(secret, payload)
//    over a different payload and the signature cannot match;
//  - a different cookie name (docs_guest) set only on Path=/docs and Path=/api/docs, so the browser
//    never sends it anywhere else.
// The tests in doc-guests.test.mjs feed a guest token to a real createAuth().valid() to hold this.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
import { webchatStoreDir } from './paths.js';

export const GUEST_COOKIE = 'docs_guest';
export const GUEST_COOKIE_PATHS = Object.freeze(['/docs', '/api/docs']);
export const GUEST_TOKEN_TTL_MS = 30 * 86_400_000;
export const NAME_MAX = 40;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOKEN_PREFIX = 'dg1';
const HMAC_DOMAIN = 'tophat-docs-guest-token-v1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guests (
  guest_id      TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  renamed_at    TEXT
);
CREATE TABLE IF NOT EXISTS guest_credentials (
  credential_id TEXT PRIMARY KEY,
  guest_id      TEXT NOT NULL REFERENCES guests(guest_id),
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guest_challenges (
  challenge     TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  guest_id      TEXT,
  display_name  TEXT,
  created_at    INTEGER NOT NULL
);
`;

export function defaultGuestsPath({ env = process.env } = {}) {
  if (env.TOPHAT_DOCS_DIR) return join(env.TOPHAT_DOCS_DIR, 'guests.sqlite');
  return join(webchatStoreDir({ env }), 'docs', 'guests.sqlite');
}

/**
 * A display name a stranger typed, made safe to show: control, zero-width and bidi-override
 * characters removed, anything that could be markup removed (< > and the tags between them),
 * whitespace collapsed, trimmed, cut to 40 characters (code points, so an emoji is not split).
 * Returns null when nothing is left, so the caller decides between refusing and "anonymous".
 */
export function sanitizeName(raw) {
  if (raw === null || raw === undefined) return null;
  let name = String(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu, '')
    .replace(/<\/?[A-Za-z!][^>]*>/gu, '')
    .replace(/[<>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  name = [...name].slice(0, NAME_MAX).join('').trim();
  return name.length ? name : null;
}

function requireName(raw) {
  const name = sanitizeName(raw);
  if (!name) throw new GuestError('A name is required (1 to 40 characters)', 400);
  return name;
}

export class GuestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function loadSecret(file) {
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (value.length >= 32) return value;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const value = randomBytes(32).toString('hex');
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return value;
}

function challengeOf(response) {
  try {
    const json = Buffer.from(String(response?.response?.clientDataJSON || ''), 'base64url').toString('utf8');
    const challenge = JSON.parse(json).challenge;
    return typeof challenge === 'string' && challenge ? challenge : null;
  } catch {
    return null;
  }
}

/**
 * The guest store. `path` is the sqlite file (":memory:" for tests); the secret lives beside it as
 * guests.secret unless `secret` is given (tests). rpId and origin must be the public document
 * origin's (the same WEBCHAT_RP_ID / WEBCHAT_ORIGIN app.js hands auth.js).
 */
export function createDocGuests({
  path = defaultGuestsPath(),
  secretPath,
  secret,
  rpId = process.env.WEBCHAT_RP_ID || 'localhost',
  origin = process.env.WEBCHAT_ORIGIN || 'http://localhost:5173',
  rpName = 'tophat docs',
  now = () => Date.now()
} = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // An in-memory store (tests) gets an ephemeral secret unless one is given; a file store keeps
  // its secret beside the file, so tokens survive a restart.
  const key = secret || (secretPath ? loadSecret(secretPath)
    : path === ':memory:' ? randomBytes(32).toString('hex') : loadSecret(join(dirname(path), 'guests.secret')));

  const q = {
    putChallenge: db.prepare('INSERT OR REPLACE INTO guest_challenges (challenge, kind, guest_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)'),
    getChallenge: db.prepare('SELECT * FROM guest_challenges WHERE challenge = ? AND kind = ?'),
    dropChallenge: db.prepare('DELETE FROM guest_challenges WHERE challenge = ?'),
    sweep: db.prepare('DELETE FROM guest_challenges WHERE created_at < ?'),
    putGuest: db.prepare('INSERT INTO guests (guest_id, display_name, created_at) VALUES (?, ?, ?)'),
    getGuest: db.prepare('SELECT * FROM guests WHERE guest_id = ?'),
    rename: db.prepare('UPDATE guests SET display_name = ?, renamed_at = ? WHERE guest_id = ?'),
    renameCreds: db.prepare('UPDATE guest_credentials SET display_name = ? WHERE guest_id = ?'),
    putCred: db.prepare('INSERT INTO guest_credentials (credential_id, guest_id, public_key, counter, transports, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    getCred: db.prepare('SELECT * FROM guest_credentials WHERE credential_id = ?'),
    bump: db.prepare('UPDATE guest_credentials SET counter = ? WHERE credential_id = ?')
  };

  function remember(challenge, kind, guestId = null, name = null) {
    q.sweep.run(now() - CHALLENGE_TTL_MS);
    q.putChallenge.run(challenge, kind, guestId, name, now());
  }

  // One use: the row is gone whether or not verification then succeeds, so a response cannot be
  // replayed. Keyed by the challenge itself (read out of clientDataJSON), not by a single global
  // slot as auth.js does, because many strangers register at once.
  function recall(response, kind) {
    const challenge = challengeOf(response);
    if (!challenge) throw new GuestError('Malformed passkey response', 400);
    const row = q.getChallenge.get(challenge, kind);
    q.dropChallenge.run(challenge);
    if (!row || now() - row.created_at > CHALLENGE_TTL_MS) throw new GuestError('Passkey request expired; start again', 400);
    return row;
  }

  const mac = (guestId, expires) => createHmac('sha256', key).update(`${HMAC_DOMAIN}|${guestId}|${expires}`).digest('base64url');

  function issueToken(guestId) {
    const expires = now() + GUEST_TOKEN_TTL_MS;
    return { value: `${TOKEN_PREFIX}.${guestId}.${expires}.${mac(guestId, expires)}`, expires: new Date(expires) };
  }

  function verifyGuestToken(token) {
    if (typeof token !== 'string' || token.length > 256) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return null;
    const [, guestId, expiresRaw, sig] = parts;
    if (!/^[A-Za-z0-9_-]{16,64}$/u.test(guestId) || !/^\d{1,16}$/u.test(expiresRaw)) return null;
    const provided = Buffer.from(sig);
    const expected = Buffer.from(mac(guestId, expiresRaw));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    if (Number(expiresRaw) <= now()) return null;
    const guest = q.getGuest.get(guestId);
    if (!guest) return null;
    return { guestId, name: guest.display_name };
  }

  function session(guestId, name) {
    const token = issueToken(guestId);
    return { guestId, name, sessionToken: token.value, expires: token.expires };
  }

  return {
    db,

    /** Registration options for a new guest passkey carrying `name`. JSON-safe; send as is. */
    async beginRegister(rawName) {
      const name = requireName(rawName);
      const guestId = randomBytes(16).toString('base64url');
      const options = await generateRegistrationOptions({
        rpName,
        rpID: rpId,
        userID: Buffer.from(guestId, 'base64url'),
        userName: name,
        userDisplayName: name,
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
      });
      remember(options.challenge, 'register', guestId, name);
      return options;
    },

    /** Verify the browser's startRegistration() result; store the credential; sign the guest in. */
    async finishRegister(response) {
      const row = recall(response, 'register');
      let result;
      try {
        result = await verifyRegistrationResponse({
          response, expectedChallenge: row.challenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: false
        });
      } catch (cause) {
        throw new GuestError(`Passkey could not be verified: ${cause.message}`, 400);
      }
      if (!result.verified) throw new GuestError('Passkey could not be verified', 400);
      const info = result.registrationInfo.credential;
      if (q.getCred.get(info.id)) throw new GuestError('That passkey is already registered', 409);
      const at = new Date(now()).toISOString();
      db.exec('BEGIN');
      try {
        q.putGuest.run(row.guest_id, row.display_name, at);
        q.putCred.run(info.id, row.guest_id, Buffer.from(info.publicKey), info.counter || 0,
          JSON.stringify(response.response?.transports || []), row.display_name, at);
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
      return session(row.guest_id, row.display_name);
    },

    /** Options for signing in with a guest passkey: discoverable, so no name or id is asked for. */
    async beginAuth() {
      const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'preferred', allowCredentials: [] });
      remember(options.challenge, 'authenticate');
      return options;
    },

    /** Verify startAuthentication(); answers with the name bound to that credential's guest. */
    async finishAuth(response) {
      const row = recall(response, 'authenticate');
      const cred = q.getCred.get(String(response?.id || ''));
      if (!cred) throw new GuestError('Unknown passkey', 401);
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response,
          expectedChallenge: row.challenge,
          expectedOrigin: origin,
          expectedRPID: rpId,
          credential: {
            id: cred.credential_id,
            publicKey: new Uint8Array(cred.public_key),
            counter: cred.counter,
            transports: cred.transports ? JSON.parse(cred.transports) : undefined
          },
          requireUserVerification: false
        });
      } catch (cause) {
        throw new GuestError(`Passkey rejected: ${cause.message}`, 401);
      }
      if (!result.verified) throw new GuestError('Passkey rejected', 401);
      q.bump.run(result.authenticationInfo.newCounter, cred.credential_id);
      const guest = q.getGuest.get(cred.guest_id);
      return session(cred.guest_id, guest.display_name);
    },

    /** {guestId, name} for a valid, unexpired, untampered token of a guest that still exists; else null. */
    verifyGuestToken,

    /** Rename a bound guest. Needs their token; returns the new {guestId, name}, or null for a bad token. */
    rename(token, rawName) {
      const who = verifyGuestToken(token);
      if (!who) return null;
      const name = requireName(rawName);
      q.rename.run(name, new Date(now()).toISOString(), who.guestId);
      q.renameCreds.run(name, who.guestId);
      return { guestId: who.guestId, name };
    },

    close() { db.close(); }
  };
}

/**
 * Set-Cookie header values for a guest token: one per path, because a cookie has one Path and the
 * page (/docs/<token>) and the API (/api/docs/<token>/*) are siblings. HttpOnly, SameSite=Lax,
 * Secure unless the origin is plain http (localhost dev). Pass `null` to clear both.
 */
export function guestCookieHeaders(session, { secure = true } = {}) {
  return GUEST_COOKIE_PATHS.map((path) => {
    const value = session ? encodeURIComponent(session.sessionToken ?? session.value) : '';
    const expires = session ? new Date(session.expires).toUTCString() : 'Thu, 01 Jan 1970 00:00:00 GMT';
    const maxAge = session ? Math.max(0, Math.floor((new Date(session.expires).getTime() - Date.now()) / 1000)) : 0;
    return `${GUEST_COOKIE}=${value}; Path=${path}; Expires=${expires}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  });
}

/** The same, as SvelteKit `cookies.set(GUEST_COOKIE, value, opts)` calls: [{ value, opts }]. */
export function guestCookieSets(session, { secure = true } = {}) {
  return GUEST_COOKIE_PATHS.map((path) => ({
    value: session ? (session.sessionToken ?? session.value) : '',
    opts: session
      ? { path, httpOnly: true, sameSite: 'lax', secure, expires: new Date(session.expires) }
      : { path, httpOnly: true, sameSite: 'lax', secure, maxAge: 0 }
  }));
}

let shared = null;
/** The server's one guest store, opened on first use at the default path. */
export function docGuests() {
  if (!shared) shared = createDocGuests();
  return shared;
}
export function resetDocGuests() {
  if (shared) shared.close();
  shared = null;
}
