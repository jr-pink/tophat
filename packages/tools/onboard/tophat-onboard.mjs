#!/usr/bin/env node
// tophat-onboard: mint, list and revoke one-time onboarding channel URLs for the webchat.
// A minted URL lets a new device or agent POST text into one chat with curl, anonymously, until it
// expires (--hours), hits its cap (--max) or is revoked. Only sha256(token) is stored, in $TOPHAT_ONBOARD_DIR/tokens.json (0600). Logic: webchat/src/lib/server/onboard.js.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const { mint, load, revoke, onboardDir } = await import(path.join(here, '..', '..', 'webchat', 'src', 'lib', 'server', 'onboard.js'));

const USAGE = `usage:
  tophat-onboard mint --chat <conversationId> [--label TEXT] [--hours 48] [--max 20]
  tophat-onboard list
  tophat-onboard revoke <hash-prefix | token>
store: ${onboardDir()}/tokens.json`;

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
};

try {
  if (cmd === 'mint') {
    const hours = Number(opt('hours', 48));
    const max = Number(opt('max', 20));
    if (!(hours > 0) || !(max > 0)) throw new Error('--hours and --max must be positive');
    const { url, row } = mint({ chat: opt('chat'), label: opt('label', ''), hours, max });
    console.log(url);
    console.error(`id ${row.hash.slice(0, 12)}  chat ${row.chat}  label ${JSON.stringify(row.label)}  expires ${row.expiresAt}  max ${row.max}`);
  } else if (cmd === 'list') {
    const now = Date.now();
    for (const t of load().tokens) {
      const state = t.revoked ? 'revoked' : Date.parse(t.expiresAt) <= now ? 'expired' : t.count >= t.max ? 'used-up' : 'live';
      console.log(`${t.hash.slice(0, 12)}  ${state.padEnd(7)}  ${t.count}/${t.max}  expires ${t.expiresAt}  chat ${t.chat}  ${t.label}`);
    }
  } else if (cmd === 'revoke') {
    const row = revoke(rest[0]);
    console.log(`revoked ${row.hash.slice(0, 12)} (${row.label || 'no label'}, chat ${row.chat})`);
  } else {
    console.error(USAGE);
    process.exit(cmd ? 2 : 0);
  }
} catch (cause) {
  console.error(`tophat-onboard: ${cause.message}`);
  process.exit(1);
}
