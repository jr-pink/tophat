// Desktop sign-in handoff. The Electron app cannot use a macOS platform passkey (Electron has no Touch ID WebAuthn), so
// it signs in through the system browser and collects the session there, PKCE-style:
//   1. the app makes a random verifier, opens  <origin>/login?desktop=<sha256(verifier) base64url>  in the browser;
//   2. the browser signs in with its passkey as usual; the login page, once signed in, POSTs {step:'grant', challenge}
//      with its session cookie, and this module parks a fresh session for that challenge (2 minutes, one use);
//   3. the app, polling, POSTs {step:'redeem', verifier}; the hash must match a parked grant, which is handed over once
//      and deleted. A stranger who sees the URL holds only the hash, never the verifier, so cannot redeem.
// In-memory on purpose: a grant lives two minutes and a restart just means "sign in again".
import { createHash } from 'node:crypto';

const TTL_MS = 120_000;
const grants = new Map();   // challenge -> { session, at }

const hash = (verifier) => createHash('sha256').update(String(verifier)).digest('base64url');
const sweep = (now) => { for (const [k, g] of grants) if (now - g.at > TTL_MS) grants.delete(k); };
const shaped = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);

export function grantDesktop(challenge, session, now = Date.now()) {
  if (!shaped(challenge)) throw new Error('Bad desktop challenge');
  sweep(now);
  grants.set(challenge, { session, at: now });
}

/** The parked session for this verifier, once; null while the browser has not signed in yet. */
export function redeemDesktop(verifier, now = Date.now()) {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) throw new Error('Bad desktop verifier');
  sweep(now);
  const key = hash(verifier);
  const g = grants.get(key);
  if (!g) return null;
  grants.delete(key);
  return g.session;
}

export const desktopChallenge = hash;
