// One-tap "skip the auto-call" for tophat-transit (tools/tophat-transit/README.md). The link is the whole
// credential, opened from his phone's Pushover with no session, and all it can do is create that one event's skip
// flag; tophat-transit reads the flag before any request.
//
// The signature has ONE owner, src/core/transit-skip-token.mjs. This file held a second copy of sigFor and
// verify and notify.mjs a third, with the same prefix, the same base64url and the same 32-character
// truncation, and neither named the other. A minter and a verifier that are two implementations of one
// capability drift into "every live link answers 404" with nothing anywhere to say why.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEY_FILE, readKey, sigFor, verify } from '../../../../runner/src/core/transit-skip-token.mjs';

export { KEY_FILE, sigFor, verify };

export const SKIP_DIR = path.join(os.homedir(), '.local/state/tophat/transit/skip');

export function skip(eventId, sig, { keyFile = KEY_FILE, dir = SKIP_DIR } = {}) {
  let key = null;
  try { key = readKey(keyFile); } catch { key = null; }
  if (!key || !verify(eventId, sig, key)) return { ok: false, status: 404 };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, encodeURIComponent(eventId)), JSON.stringify({ at: new Date().toISOString(), by: 'pushover-link' }));
  return { ok: true };
}
