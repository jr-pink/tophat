// The one-tap "skip the auto-call" capability: one rule, one implementation.
//
// tophat-transit's Pushover heads-up carries <base>?e=<eventId>&s=<sig>, and that link is the whole credential:
// his phone opens it with no session, and all it can do is set one event's skip flag. The signature is an HMAC of
// the event id under the key file named in the transit config.
//
// It was written twice, byte-equivalent, with neither side naming the other: the minting half in
// tools/tophat-transit/notify.mjs (skipSig) and the verifying half in
// webchat/src/lib/server/transit-skip.js (sigFor/verify). A capability whose minter and verifier are two
// implementations fails silently when either moves: every live link answers 404, or the verifier loosens and
// nobody notices.
//
// Where things live: the link's host, the key file and the state directory all come from ONE file, the transit
// config (env TOPHAT_TRANSIT_CONFIG, else ~/.config/tophat/transit.json): `stateDir` (skip flags are
// <stateDir>/skip/<eventId>), `skip.keyFile`, and `skip.instance` (the served instance's config, whose hosts.public
// is the host the link points at). Both the tool and the webchat read them here.
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

/** The route the webchat serves the link on (code: the route file lives at this path). */
export const SKIP_PATH = '/api/transit/skip';

const home = (p) => String(p).replace(/^~(?=\/|$)/u, os.homedir());

/** The transit config file (the one place the settings below live). */
export const transitConfigFile = () => process.env.TOPHAT_TRANSIT_CONFIG || path.join(os.homedir(), '.config/tophat/transit.json');

/** The parsed transit config; throws (never defaults) when it is missing or unreadable. */
export function readTransitConfig(file = transitConfigFile()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`transit config ${file} unreadable: ${e.message}`); }
}

/** tophat-transit's state directory: env TOPHAT_TRANSIT_STATE_DIR (tests), else the config's stateDir. */
export function transitStateDir(config = null) {
  if (process.env.TOPHAT_TRANSIT_STATE_DIR) return process.env.TOPHAT_TRANSIT_STATE_DIR;
  const c = config || readTransitConfig();
  if (!c.stateDir) throw new Error(`transit config ${transitConfigFile()}: "stateDir" is required`);
  return home(c.stateDir);
}

/** Where the link points, which key signs it and where a skip lands: { base, host, keyFile, dir }. Throws when unset. */
export function skipSettings(config = null) {
  const c = config || readTransitConfig();
  const s = c.skip || {};
  for (const k of ['keyFile', 'instance']) if (!s[k]) throw new Error(`transit config ${transitConfigFile()}: "skip.${k}" is required`);
  let inst;
  try { inst = JSON.parse(fs.readFileSync(home(s.instance), 'utf8')); } catch (e) { throw new Error(`skip.instance ${s.instance} unreadable: ${e.message}`); }
  const host = inst?.hosts?.public;
  if (!host) throw new Error(`skip.instance ${s.instance}: hosts.public is not set`);
  return { host, base: `https://${host}${SKIP_PATH}`, keyFile: home(s.keyFile), dir: path.join(transitStateDir(c), 'skip') };
}

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
export function readKey(file) {
  if (!file) throw new Error('readKey: no key file');
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** The key, minting one (0600, inside an owner-only directory) the first time a link is signed. */
export function ensureKey(file) {
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
