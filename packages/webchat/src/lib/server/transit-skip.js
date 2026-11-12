// One-tap "skip the auto-call" for tophat-transit (tools/tophat-transit/README.md). The Pushover heads-up and
// "call a car now" carry <base>?e=<eventId>&s=<sig> (minted by tools/tophat-transit/notify.mjs), where sig is an
// HMAC of the event id under the transit config's skip.keyFile. The link is the whole credential, opened from his
// phone's Pushover with no session, and all it can do is create that one event's skip flag
// (<stateDir>/skip/<eventId>); tophat-transit reads the flag before any request.
//
// The signature and every location (host, key file, flag directory) have ONE owner, src/core/transit-skip-token.mjs,
// which reads them from the transit config (env TOPHAT_TRANSIT_CONFIG). the served tophat assembly renamed them to
// ~/.config/tophat and ~/.local/state/tophat, so the key was never found and every live link answered 404.
import fs from 'node:fs';
import path from 'node:path';
import { readKey, sigFor, skipSettings, verify } from '../../../../runner/src/core/transit-skip-token.mjs';

export { sigFor, verify };

/** Verify and set the flag. keyFile/dir override the config (tests). A bad signature or a missing key is 404. */
export function skip(eventId, sig, { keyFile = null, dir = null } = {}) {
  if (!keyFile || !dir) {
    let s;
    try { s = skipSettings(); } catch (error) { console.error(`transit skip: ${error.message}`); return { ok: false, status: 404 }; }
    keyFile ||= s.keyFile; dir ||= s.dir;
  }
  let key = null;
  try { key = readKey(keyFile); } catch { key = null; }
  if (!key) console.error(`transit skip: no key at ${keyFile}`);
  if (!key || !verify(eventId, sig, key)) return { ok: false, status: 404 };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, encodeURIComponent(eventId)), JSON.stringify({ at: new Date().toISOString(), by: 'pushover-link' }));
  return { ok: true };
}
