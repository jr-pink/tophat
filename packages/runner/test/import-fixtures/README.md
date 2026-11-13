# Import fixtures

Synthetic exports, one per format the manager claims to read. Every entry here is
invented: `example.test` is a reserved TLD, the usernames and passwords are made
up, and the OTP secret is the published `JBSWY3DPEHPK3PXP` example. No file here
came from a real vault.

Each file is authored to the column header or JSON shape the exporter documents,
not captured from a running exporter: this machine has no `op`, `bw` or
`keepassxc-cli` installed, so a capture was not available. Replace a file with a
real capture, keeping the entries synthetic, if one of those tools is ever
installed. The headers came from each exporter's documentation:

- `chrome-passwords.csv` — Chrome/Edge password export: `name,url,username,password,note`
- `safari-passwords.csv` — Safari/Apple Passwords export: `Title,URL,Username,Password,Notes,OTPAuth`
- `bitwarden-export.csv` — Bitwarden CSV, multiple URIs newline-separated in one cell
- `bitwarden-export.json` — Bitwarden unencrypted JSON, with folders and a soft-deleted item
- `keepassxc-export.csv` — KeePassXC CSV: `Group,Title,Username,Password,URL,Notes,TOTP,Icon,Last Modified,Created`
- `1password-export.csv` — 1Password CSV: `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes`
- `1password-export.data` — the `export.data` member of a `.1pux` archive; the test zips it into one

Added for the awkward cases a happy-path fixture cannot reach:

- `chrome-passwords-grown.csv` — the same Chrome export a week later: one new row
  at the top and the survivors re-ordered, with rows otherwise byte-identical to
  `chrome-passwords.csv`. A row's imported id is derived from website, username
  and title, never from its position, or re-importing this file would duplicate
  every entry instead of skipping it.
- `chrome-duplicate-rows.csv` — two rows alike on website and username with
  different titles, which is what Chrome keeps after a password change, and two
  rows alike on all three. The first kind stays distinct by title; the second can
  only be told apart by an occurrence number, so those two ids follow their order
  in the file.
- `chrome-windows-crlf.csv` — a UTF-8 BOM, CRLF row terminators and a quoted cell
  whose own line break is CRLF. Chrome on Windows terminates rows with CRLF, and a
  BOM is prepended by several Windows exporters and by any spreadsheet round trip;
  the two are combined in one file rather than captured from one tool.
- `bitwarden-implicit-folder.json` — a `folderId` naming a folder the export does
  not contain, which is what a partial or hand-edited export looks like.
- `bitwarden-steam-totp.csv` — Steam codes in the TOTP column, in both spellings
  Bitwarden uses. They are not RFC 6238 and this manager cannot generate them, so
  they are skipped with a warning while the login on the same row still imports.
- `bitwarden-unmapped.csv` — card and identity rows, which carry no password, note
  or code. They are reported as skipped rather than dropped without a word.
