# tophat-pass

Command line for a tophat credential vault, with no passkey and no web session. The vault is the runner's
`PasswordManager` (`packages/runner/src/vault/`): every record is AES-256-GCM encrypted at rest under an owner-only local key
file (or a key wrapped by a passphrase), bound to its own name, so a value file cannot be swapped for another's.

What it stores: logins (several usernames, emails and phones per account, websites, an optional TOTP seed), standalone TOTP
seeds, recovery codes (each spent once), SSH keys, OAuth grants, secrets, and passkey references (relying party and provider
only; platform passkeys are not exportable). Entries carry groups and notes, can be archived and restored, and every change
lands in a value-free history. Imports: Chrome, Apple Passwords (Safari), 1Password (CSV, JSON, `.1pux`), Bitwarden (CSV,
JSON), KeePass and generic CSV; an item whose site is not HTTPS lands as a secret, never as an autofillable login.

Never-print defaults: `list`, `find`, `fields`, `history`, `status`, `recovery`, `set`, `import` and every other write verb print
metadata only. Values print only from `get`, `totp`, `recovery --spend`, `generate` and `lookup --reveal`. A secret is read from
`--file` or stdin, never argv; an argument echoed in an error is shaped like an id or hidden. `tophat-pass --help` lists every verb.

- Vault: `TOPHAT_VAULT_DIR` (default `~/.config/tophat/vault`) and `TOPHAT_VAULT_KEY_FILE` (default `vault-master-key` beside it).
- Manager module: `TOPHAT_PASS_MANAGER`, default the runner package's `src/vault/manager.mjs` beside this package.
- A passphrase-protected vault: `TOPHAT_PASS_PASSPHRASE` or `--passphrase-stdin`; otherwise exit 4. `protect` takes the new
  passphrase from `TOPHAT_PASS_NEW_PASSPHRASE` or stdin.
- `import` deletes the export after a good import (it is every password in cleartext); `--keep` retains it, and a failed import
  deletes nothing.
- A vault sealed under an older record-binding prefix (a store made before a product rename) reads when
  `TOPHAT_VAULT_LEGACY_AAD_PREFIX` names that prefix. It is a read fallback: writes use the current prefix.
- Exit codes: 0 ok, 1 error, 2 usage, 3 unknown credential or field, 4 locked.

`tophat-cdp --secret-from VAULT_ID[:field]` and `tophat-vnc` read their secrets through this command (or through
`TOPHAT_CDP_PASS_BIN` / `TOPHAT_VNC_PASS_BIN`, any command with the same `get ID --raw -n` and `totp ID` interface).
Tests: `packages/tools/test/pass.test.mjs` and `pass-write.test.mjs` (the CLI), `packages/runner/test/vault*.test.mjs`,
`import-formats.test.mjs` and `archive-import.test.mjs` (the manager, merge, history, imports).
