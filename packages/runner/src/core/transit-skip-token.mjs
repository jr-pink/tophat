// The one-tap "skip the auto-call" capability: one rule, one implementation.
//
// The signature is an HMAC of the event id under ~/.config/tophat/secrets/transit-skip-key.
//
// It was written twice, byte-equivalent, with neither side naming the other: the minting half in
// tools/tophat-transit/notify.mjs (skipSig) and the verifying half in
// webchat/src/lib/server/transit-skip.js (sigFor/verify). The same magic prefix, the same base64url,
// the same truncation to 32 characters, in two trees that are deployed separately. A capability
// whose minter and verifier are two implementations fails silently when either moves: every live
// link answers 404, or the verifier loosens and nobody notices.
//
// src/core is where it lives because both halves already import out of their own tree into src (the
// webchat through password-manager.js and scopes-gate.js, rev6 and the tools through secrets.mjs and
// the runner's redactor), and neither imports the other.
//
// Never: print the key, or widen `verify` to a non-constant-time compare.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEY_FILE = path.join(os.homedir(), '.config/tophat/secrets/transit-skip-key');

/** The HMAC message prefix and the signature length. Changing either invalidates every live link. */
export const SIG_PREFIX = 'transit-skip:';
export const SIG_CHARS = 32;

export function sigFor(eventId, key) {
  return crypto.createHmac('sha256', key).update(`${SIG_PREFIX}${eventId}`).digest('base64url').slice(0, SIG_CHARS);
}

/** Constant-time check of one event's signature. A missing key, id or signature never verifies. */
export function verify(eventId, sig, key) {
  if (!eventId || !sig || !key || eventId.length > 300) return false;
  const want = Buffer.from(sigFor(eventId, key));
  const got = Buffer.from(String(sig));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** The key as it stands, or null when it has never been minted. Never printed. */
export function readKey(file = KEY_FILE) {
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** The key, minting one (0600, inside an owner-only directory) the first time a link is signed. */
export function ensureKey(file = KEY_FILE) {
  const held = readKey(file);
  if (held) return held;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return readKey(file); // another process minted it first
  }
}
