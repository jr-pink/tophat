# tophat-pass

Read a tophat credential vault from the command line with no passkey and no web session. Read verbs only (`list`, `find`,
`lookup`, `fields`, `get`, `totp`, `history`, `status`); it never writes a record, a catalog or the key file. `tophat-pass --help`
lists them. Values print only for `get` and `lookup --reveal`; an argument echoed in an error is shaped like an id or hidden.

- Vault: `TOPHAT_VAULT_DIR` (default `~/.config/tophat/vault`) and `TOPHAT_VAULT_KEY_FILE` (default `vault-master-key` beside it).
- Manager module: `TOPHAT_PASS_MANAGER`, default the runner package's `src/vault/manager.mjs` beside this package.
- A passphrase-protected vault: `TOPHAT_PASS_PASSPHRASE` or `--passphrase-stdin`; otherwise exit 4.
- A vault sealed under an older record-binding prefix (a store made before a product rename) reads when
  `TOPHAT_VAULT_LEGACY_AAD_PREFIX` names that prefix. It is a read fallback: writes elsewhere use the current prefix.
- Exit codes: 0 ok, 1 error, 2 usage, 3 unknown credential or field, 4 locked.

`tophat-cdp --secret-from VAULT_ID[:field]` and `tophat-vnc` read their secrets through this command (or through
`TOPHAT_CDP_PASS_BIN` / `TOPHAT_VNC_PASS_BIN`, any command with the same `get ID --raw -n` and `totp ID` interface).
Tests: `test/pass.test.mjs`.
