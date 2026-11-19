// What must never be copied to a public URL.
//
// A file called passwords-export.csv, Keychain.kdbx, bitwarden.json or 1Password.1pux
// was published to the internet. One rule, two implementations, and the loose half was
// the one sitting on the path that publishes.
//
// This is the owner's rule, plus the two things it structurally cannot see:
//
//   name    a credential store whose WHOLE BASENAME is the name, with no
//           extension to recognise it by: `.env` and its variants, `.netrc`,
//           `.pgpass`, `.npmrc`, `.git-credentials`, the ssh private keys, a
//           bare `credentials` or `secrets`. `secretExportName` needs an
//           extension or an archive suffix, and `gh-pwd` has neither, which is
//           why a two-name list existed here at all; the list was two names
//           long, so `~/Downloads/.env` and `~/Documents/id_rsa` published.
//           The same shapes are already refused by path part in
//           src/actions/artifact-observation.mjs, so this is the third place
//           that rule is stated and the first one on the path that publishes.
//   head    the first few kilobytes carry credential material: a PEM private
//           key block, or any of the nine prefix-anchored patterns the
//           redaction owner (src/agent/redact.mjs KEY_PATTERNS) already
//           enumerates. One table, two consumers: a shape that is certainly a
//           credential while it is being redacted out of a transcript is
//           certainly a credential when it is about to be served on a public
//           URL with no sign-in. The table is imported, never copied.
//
// The key scan is deliberately NOT pushed down into secret-file.mjs, which the
// documents index also reads. Refusing to PUBLISH a document that quotes a JWT
// costs one manual copy; refusing to INDEX it costs retrieval of the owner's
// own document for ever. The publish gate is the strict side on purpose.
//
// Vault-value matching (the third test in secretFileReason) is still left out:
// it needs the vault open and the whole file read, and a publish decides from
// the name and the first few kilobytes. src/vault/publish-guard.credentials.test.mjs
// pins that difference, so a later reader does not "fix" it by accident.
//
// Nothing here returns or logs a value: only a reason string.
import { KEY_PATTERNS } from '../agent/redact.mjs';
import { secretExportHeader, secretExportName } from './secret-file.mjs';

/** Credential stores whose basename carries no extension to recognise them by. Lowercase. */
export const NEVER_PUBLISH = ['gh-pwd', 'passwords.csv'];

/**
 * A whole basename that IS the credential store, matched case-insensitively
 * against the basename alone and never against a directory part. An ssh public
 * key (`id_rsa.pub`) is deliberately not here: it is not secret.
 */
export const CREDENTIAL_NAME = /^(?:\.env(?:\..+)?|\.envrc|\.?netrc|_netrc|\.pgpass|\.htpasswd|\.npmrc|\.pypirc|\.git-credentials|credentials?|secrets?|id_(?:rsa|dsa|ecdsa|ed25519))$/i;

/**
 * A PEM private key's opening line on its own. KEY_PATTERNS requires the
 * matching END line too, and a few kilobytes of head may not reach the end of a
 * 4096-bit key, so the opening line is enough to refuse.
 */
export const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

// Copies without the global flag, so `test` is not stateful (a global regex
// carries lastIndex between calls) and the redaction owner's own regex objects
// are never mutated from here.
const KEY_TESTS = KEY_PATTERNS.map(([pattern, kind]) => [new RegExp(pattern.source, pattern.flags.replace(/g/g, '')), kind]);

/** The credential material this head carries, as a reason string, or null. Never the value. */
export function headCarriesKey(head) {
  if (typeof head !== 'string' || !head) return null;
  if (PRIVATE_KEY_BEGIN.test(head)) return 'key:private key';
  for (const [pattern, kind] of KEY_TESTS) if (pattern.test(head)) return `key:${kind}`;
  return null;
}

/**
 * The reason this file must not be published, or null when it may be.
 * `head` is the first few kilobytes as text, or null when they could not be
 * read or are not text; a null head simply skips the two head tests.
 */
export function publishRefusal(filePath, head = null) {
  const base = String(filePath ?? '').split('/').pop() || '';
  if (!base) return null;
  if (NEVER_PUBLISH.includes(base.toLowerCase())) return 'name:known-credential-file';
  if (CREDENTIAL_NAME.test(base)) return 'name:credential-file';
  return secretExportName(base) ?? secretExportHeader(head) ?? headCarriesKey(head) ?? null;
}
