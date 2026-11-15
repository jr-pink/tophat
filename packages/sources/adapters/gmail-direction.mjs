// Who wrote a Gmail message. The SENT label is authoritative (Gmail sets it on anything this mailbox sent, send-as
// aliases included). A From address that is one of the owner's own covers mail one of their accounts sent to another
// (it lands in INBOX without SENT). DRAFT is the owner's writing but was not sent.
// The owner's addresses are configuration only: the source's own `account`, `config.account`, `config.aliases`, and
// the adapter-wide `ownerAddresses` list (sources config). No address is in code.
//

/** The bare, lowercased address of a From header ("Name <a@b>" or "a@b"), or ''. */
export function addressOf(fromHeader) {
  const s = String(fromHeader || ''), angle = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angle ? angle[1] : (s.match(/[^\s<>"',;:()]+@[^\s<>"',;:()]+/) || [''])[0];
  return bare.trim().toLowerCase();
}

/** The owner's addresses for one source: its account and aliases plus options.ownerAddresses (or source.config.ownerAddresses). */
export function ownerAddresses(source = {}, options = {}) {
  const c = source.config || {};
  return new Set([...(options.ownerAddresses || []), ...(Array.isArray(c.ownerAddresses) ? c.ownerAddresses : []), source.account, c.account,
    ...(Array.isArray(c.aliases) ? c.aliases : [])].filter(Boolean).map((a) => String(a).trim().toLowerCase()));
}

/** {type, direction, sender, labels} for a Gmail API message: direction 'sent' | 'draft' | 'received'. */
export function gmailMetadata(mail, fromHeader, source = {}, options = {}) {
  const labels = Array.isArray(mail?.labelIds) ? mail.labelIds.map(String) : [];
  const sender = addressOf(fromHeader), mine = Boolean(sender) && ownerAddresses(source, options).has(sender);
  const direction = labels.includes('SENT') ? 'sent' : labels.includes('DRAFT') ? (mine ? 'draft' : 'received') : mine ? 'sent' : 'received';
  return { type: 'gmail', direction, sender: sender || null, labels };
}
