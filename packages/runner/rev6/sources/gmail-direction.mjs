// Who wrote a Gmail message, for every reader that turns one into an event
// (src/connectors/index.mjs's gmail arm, which the heartbeat runs, and its rev6 twin
// rev6/sources/gmail.mjs). Without it every message, the owner's own sent mail
// included, reached push intake with no direction and was stored role 'human'. The
// SENT label is authoritative: Gmail sets it on anything this mailbox sent, send-as
// aliases included. A From address that is one of his own covers mail one of his
// accounts sent to another (it lands in INBOX without SENT). DRAFT is his writing but
// was not sent; intake still attributes it to him.
//
// WHICH ADDRESSES ARE HIS now reads the live account list rather than only a copy of
// it. The standing rule is "The account list exists once: ~/.config/tophat/config.json
// `sources` of kind `gmail`", and src/core/gmail-accounts.mjs is the reader for it.
// OWNER_ADDRESSES stays as it was, and is a snapshot rather than the authority: other
// readers import the constant, and it also carries the addresses that are not accounts
// and never will be (his school and &co addresses, which appear as From on his own
// mail in the archive and have no grant, no mailbox and no config entry).
import { readGmailAccounts } from '../../src/core/gmail-accounts.mjs';

/** the owner's own mail addresses as a frozen snapshot: tools/calendar-tool.mjs MINE_ADDRS plus his school and &co
 * addresses. The live accounts come from config.json (configuredOwnerAddresses); these are the ones config does
 * not and will not hold.
 */
export const OWNER_ADDRESSES = Object.freeze(String(process.env.TOPHAT_OWNER_ADDRESSES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

let memo = null;

/** Every Gmail account address in config.json. Read once per process; `file` is for tests and reread forces it.
 * A config that cannot be read is no addresses, never a throw: this runs per message on the ingest path. */
export function configuredOwnerAddresses({ file, reread = false } = {}) {
  const read = () => {
    try { return readGmailAccounts(file ? { file } : {}).map((a) => a.email).filter(Boolean); }
    catch { return []; }
  };
  if (file) return read();
  if (memo && !reread) return memo;
  memo = read();
  return memo;
}

/** The bare, lowercased address of a From header ("Name <a@b>" or "a@b"), or ''. */
export function addressOf(fromHeader) {
  const s = String(fromHeader || ''), angle = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angle ? angle[1] : (s.match(/[^\s<>"',;:()]+@[^\s<>"',;:()]+/) || [''])[0];
  return bare.trim().toLowerCase();
}

/** The owner's addresses for one source: the configured accounts, the snapshot above, and the source's own account and aliases. */
export function ownerAddresses(source = {}, options = {}) {
  const c = source.config || {};
  return new Set([...OWNER_ADDRESSES, ...configuredOwnerAddresses(options), source.account, c.account,
    ...(Array.isArray(c.aliases) ? c.aliases : [])].filter(Boolean).map((a) => String(a).trim().toLowerCase()));
}

/** {type, direction, sender, labels} for a Gmail API message: direction 'sent' | 'draft' | 'received'. */
export function gmailMetadata(mail, fromHeader, source = {}, options = {}) {
  const labels = Array.isArray(mail?.labelIds) ? mail.labelIds.map(String) : [];
  const sender = addressOf(fromHeader), mine = Boolean(sender) && ownerAddresses(source, options).has(sender);
  const direction = labels.includes('SENT') ? 'sent' : labels.includes('DRAFT') ? (mine ? 'draft' : 'received') : mine ? 'sent' : 'received';
  return { type: 'gmail', direction, sender: sender || null, labels };
}
