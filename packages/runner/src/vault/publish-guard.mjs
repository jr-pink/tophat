// What must never be copied to a public URL.
//
// Until tonight the publish route asked the same question a second, much weaker
// way: a list of two basenames, 'gh-pwd' and 'Passwords.csv'. A file called
// passwords-export.csv, Keychain.kdbx, bitwarden.json or 1Password.1pux was
// published to the internet. One rule, two implementations, and the loose half
// was the one sitting on the path that publishes.
//
// This is the owner's rule, plus the extension-less basenames it cannot see:
// secretExportName needs an extension or an archive suffix, and `gh-pwd` has
// neither. Vault-value matching (the third test in secretFileReason) is
// deliberately left out: it needs the vault open and the whole file read, and a
// publish decides from the name and the first few kilobytes.
//
// Nothing here returns or logs a value: only a reason string.
import { secretExportHeader, secretExportName } from './secret-file.mjs';

/** Credential stores whose basename carries no extension to recognise them by. Lowercase. */
export const NEVER_PUBLISH = ['gh-pwd', 'passwords.csv'];

/**
 * The reason this file must not be published, or null when it may be.
 * `head` is the first few kilobytes as text, or null when they could not be
 * read or are not text; a null head simply skips the header test.
 */
export function publishRefusal(filePath, head = null) {
  const base = String(filePath ?? '').split('/').pop() || '';
  if (!base) return null;
  if (NEVER_PUBLISH.includes(base.toLowerCase())) return 'name:known-credential-file';
  return secretExportName(base) ?? secretExportHeader(head) ?? null;
}
