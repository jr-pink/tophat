// The stream is append-only by rule and lives outside the repository, but it is
// still a durable file that every later session reads, and the hook writes to it
// before any agent has seen the message. A secret pasted into chat is therefore
// on disk a second later, and taking it back out means editing a record whose
// whole value is that nothing edits it.
//
// This is a narrow net: things that are unambiguously credentials and nothing
// else. A payment card is recognised by Luhn rather than by length, so an order
// number, a phone number, a DOI or a row of measurements is left alone. The
// placeholder names what was removed and where the value belongs instead, so the
// substitution is visible in the record rather than being a silent edit of
// something somebody wrote.
//
// `src/mind/redact.mjs` guards the other direction (records on their way to a
// provider in a backfill). Importing the tables fixed that instance and left the
// loop duplicated, which is the same edit away from drifting again. There is now
// one loop, `redactWith`, and the two planes differ only in the wording of the
// placeholder, because the two point at different paste surfaces.

/** Where a removed value is supposed to go. */
const PASTE_TARGET = 'save it with `tophat vault save` instead';

// Prefix-anchored, because a credential is recognised by its issuer's marker.
// An unprefixed high-entropy string is not on this list: nothing distinguishes
// one from a hash, an id or a base64 attachment, and guessing costs the owner
// their own words.
export const KEY_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{24,}/g, 'anthropic key'],
  [/\bsk-[A-Za-z0-9]{32,}\b/g, 'api key'],
  [/\bghp_[A-Za-z0-9]{30,}\b/g, 'github token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'github token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, 'slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws key id'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, 'google api key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private key']
];

// 13 to 19 digits, optionally grouped by a single space or dash, and not
// touching another digit on either side.
export const CARD_CANDIDATE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;

/**
 * True when the separators, if there are any, group the digits the way a card
 * is written. Luhn alone is not enough: a row of seven three-digit readings runs
 * to eighteen digits and passes the checksum about a tenth of the time, which is
 * how this caught a table of measurements. Every issuer writes a leading group
 * of four and no group longer than six, so anything else is a list of numbers
 * that happens to sit next to itself.
 */
export function cardGrouping(match) {
  if (!/[ -]/.test(match)) return true;
  const groups = match.split(/[ -]/);
  return groups[0].length === 4 && groups.every(group => group.length >= 4 && group.length <= 6);
}

/** True when the digits satisfy the Luhn checksum a card number carries. */
export function luhn(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * The redaction pass itself, with the wording left to the caller.
 *
 * `placeholder(kind, {last4})` returns the text that replaces one hit; `last4`
 * is present only for a card number, because the last four digits are how a
 * person refers to a card and are not the card. Order matters and is part of
 * the rule: the prefixed keys go first, so a key that happens to contain a
 * digit run cannot be re-examined as a card afterwards.
 */
export function redactWith(text, placeholder) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', redactions: [] };
  const redactions = [];
  let out = text;

  for (const [pattern, kind] of KEY_PATTERNS) {
    out = out.replace(pattern, () => {
      redactions.push(kind);
      return placeholder(kind, {});
    });
  }

  out = out.replace(CARD_CANDIDATE, match => {
    const digits = match.replace(/[ -]/g, '');
    if (!cardGrouping(match) || !luhn(digits)) return match;
    redactions.push('card number');
    // The expiry and security code beside the number are useless without it and
    // are left alone rather than guessed at from context.
    return placeholder('card number', { last4: digits.slice(-4) });
  });

  return { text: out, redactions };
}

/**
 * Replace anything that is certainly a credential. Returns the rewritten text
 * and the kinds found, so a caller can say out loud that it happened.
 */
export function redactSecrets(text) {
  return redactWith(text, (kind, { last4 }) => (last4
    ? `[redacted card number ending ${last4}; ${PASTE_TARGET}]`
    : `[redacted ${kind}; ${PASTE_TARGET}]`));
}
