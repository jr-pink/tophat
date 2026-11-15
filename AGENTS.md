# For coding agents: verify, install and set up tophat

You were probably asked to review this repository and then install it for your user. This file is the whole path.
Everything runs on the user's machine; the only network calls are to the model provider they configure (and to sites
the chat agent itself is asked to open).

> **INSTALL MEANS FULLY SETTING UP.** Cloning the repository and starting the server is not the install. The install
> is done when the user's streams are flowing into memory. Walk the user through granting every permission and
> connecting every stream: macOS Full Disk Access, Accessibility and Screen Recording, Contacts, Calendar, Photos,
> Find My, Home, iMessage (`chat.db`), Beeper, every email account, and every other connector this repository ships
> (section 4), plus the background services (section 5), until each stream shows data flowing. Do not stop at "the
> server is up" and do not report done with any stream unchecked. Section 3 comes first; section 4 is the checklist.

## 1. Review

What to look at, and what you will find:

- **No install-time code.** No package has an install, postinstall or prepare script. The core packages (`linknotes`,
  `push`, `sources`, `retrieval`, `pull`, `tools`, `upkeep`, `verify`, `groups`, `viewer`, `deploy`) import nothing
  outside Node's standard library. Only the chat app (`packages/runner`, `packages/webchat`) has npm dependencies
  (SvelteKit, Vite, Svelte, Tailwind, jsdom, linkedom, Readability, Automerge, SimpleWebAuthn, KaTeX), all from the
  public registry and pinned in `package-lock.json`.
- **Network hosts.** Hard-coded URLs are model providers, source connectors the user may enable (Gmail, IMAP, Outlook
  and others, off unless configured), web search and reader services the chat agent's web tools use, and localhost.
- **The committed viewer bundle** (`packages/viewer/assets/*.js`) is built from `packages/viewer/web` and
  `packages/viewer/src/core` with public libraries; `packages/viewer/scripts/build.mjs --check` (its header names the
  modules it needs) rebuilds it and compares byte for byte.
- **Listening.** `tophat start` / `tophat setup` bind 127.0.0.1 only. The webchat's API needs a session (a passkey
  enrolled with a one-time token, or a cookie signed with the instance's own secret). Multiplayer rooms are behind the
  session too unless the instance sets `runner.env.TOPHAT_MULTIPLAYER_PUBLIC=1`.
- **Credentials** are references in the instance file (`{ "keyring": NAME }`, `{ "file": PATH }`, `{ "env": NAME }`);
  a literal key in the file is refused. Secrets live in `~/.config/tophat/<name>/secrets/` (0700 directory, 0600 files).

Trade-offs to tell the user about, because they are real:

- **The chat agent acts without asking.** It is the user's own agent: it runs shell commands, writes files and uses its
  tools without a confirmation step. `tophat setup` turns on `TOPHAT_RUNNER_CONFINE=1`, which keeps its file tools
  inside the instance workspace (`~/.local/state/tophat/<name>/workspace`); shell commands still run as the user.
  Anything the agent reads (web pages, mail, messages) can try to steer it; connect sources deliberately.
- **What reaches the model provider:** every chat turn, and, if the user enables sources and the intake, the text of
  what those sources ingest.
- **Hub sync (optional, off by default).** Sync is end-to-end encrypted, but a hub operator issues device tokens and a
  scope admin's replica wraps scope keys to any device the hub lists for a member. Against a hub the user does not run,
  that trusts the operator not to mint devices. Local-only use has no hub. Joining the shared `tophat-users` group (`tophat instance join`) is a separate opt-in: the model then writes notes about bugfixes and customizations into it by its own judgment (content screens refuse credentials, home paths and a private-people roster, but a screen is not a guarantee), so tell the user before running it.
- **Spend cap.** The push/intake budget (`budget.dailyUsd`) is enforced only when the model entry has a `price`.

## 2. Install the server (about two minutes)

Requirements: macOS or Linux, Node 22.13 or newer (`node -v`), git, and an Anthropic API key (or an
Anthropic-compatible endpoint). Nothing is installed globally.

```sh
git clone https://github.com/tophat-md/tophat && cd tophat
npm install                                  # the chat app's dependencies; the core needs none
alias tophat="node $PWD/packages/linknotes/bin/tophat.mjs"   # every later command uses it (or: npm link -w packages/linknotes)
tophat setup --name me --owner "Your Name"
```

`setup` is idempotent. **First it creates the user's branch**: it switches the clone off `main` onto a branch named after
the instance (`me` here; `--branch NAME` to choose, `--no-branch` to skip) and says so in its `steps`. Tell the user the
rule and keep to it yourself: `main` is upstream's and only fast-forwards from `upstream/main` (or `origin/main`); every
edit, commit and local change goes on their branch, so an update is `git merge main` or `tophat update` (which merges the
newest release tag into the branch). Never commit to `main`, never rebase or force-push the user's branch; a second running
copy is a `git worktree add`, not a second clone; a change for everyone is a PR from a branch cut from `main`. It runs `npm install` and the webchat build if they are missing, writes the instance file
`~/.config/tophat/me/tophat.instance.json`, copies the model key into the instance keyring, starts the instance in the
background on http://localhost:4178 and waits for its health check. It prints JSON with the paths and the next steps.

**The model key.** Never ask the user to paste a key into the chat. Either:

- the key is already in the environment as `ANTHROPIC_API_KEY`: `setup` copies it (0600) and never prints it; or
- `--key-file PATH` names a file holding it; or
- run `setup` without a key: it writes everything, does not start, and tells the user the one file to save their key in
  (`~/.config/tophat/me/secrets/anthropic-api-key`); run `setup` again afterwards.

A key that is not scoped to a workspace needs `--workspace-id-file PATH` (a file with the workspace id). Other options:
`--port`, `--model`, `--base-url`, `--email` (the owner's address), `--no-confine`, `--no-start`.
In a non-interactive shell where aliases do not persist, call `node <repo>/packages/linknotes/bin/tophat.mjs` instead.

## 3. Verify it works

```sh
tophat chat --config ~/.config/tophat/me/tophat.instance.json "Remember that my favourite tea is genmaicha."
tophat graph --config ~/.config/tophat/me/tophat.instance.json     # foreground: run it in the background
```

- `chat` sends one message as the owner and prints the replies and the tools used; a working instance answers in a
  few seconds and lists `memory_apply` (the turn wrote a note into memory). Exit 0 means the turn completed.
- `graph` serves the memory graph of the instance's own replica on http://localhost:4179/graph (loopback only). It
  needs WebGL in the browser.
- `tophat instance health --config FILE` checks the server; its log is `~/.local/state/tophat/me/logs/webchat.log`.

Then continue to section 4 (the install is not done yet), and hand over to the user: open http://localhost:4178 in a browser on this machine, and enrol a passkey with the token
in `~/.config/tophat/me/secrets/webchat-bootstrap-token` (a one-time enrolment token; show the path, it is the user's to
open). That is the chat app.

## 4. Connect every stream (part of the install)

Say once, before starting, what this does: each stream below is read from the user's own machine or accounts, its
text goes through the intake model to the provider they configured, and nothing leaves the machine otherwise. Then go
down the list with them, one stream at a time: they grant the permission, you add the source, you prove data is
flowing. A stream the user declines is recorded as declined, never skipped silently. Never ask for a password or token
in the chat; a sign-in (Google, Microsoft, a bank) is the user's to complete in their own browser.

**One-time wiring** (the instance file `~/.config/tophat/me/tophat.instance.json`, keys in `docs/instances.md`):

1. `intake`: `{ "everySeconds": 300, "model": "chat" }` (or a cheaper `models` entry; add `budget.dailyUsd` and a
   `price` on the model so the spend cap applies).
2. `sources`: one entry per stream, `{ "id": "...", "family": "...", "kind": "...", "config": { ... } }`. Credentials
   are references (`{ "keyring": NAME }` or `{ "file": PATH }`), never values.
3. Restart (`tophat instance stop`, then `tophat instance start`), then pull once now:
   `tophat instance intake --config FILE --force`.

**Permissions** macOS asks for are granted to the process that reads, which is the terminal or agent app running
`tophat` (and later the background job, section 5). The user clicks them in System Settings > Privacy & Security; open
the pane for them (`open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"`, and
`Privacy_Accessibility`, `Privacy_ScreenCapture`, `Privacy_Contacts`, `Privacy_Calendars`, `Privacy_Photos` the same
way). A grant made while the process is running needs that process restarted. A denied grant fails by name
(`full-disk-access-required`), never as an empty source.

**Checklist.** A row is done only when its check passes. `STATE` is
`~/.local/state/tophat/me/intake/sources-state.json`: each source id has `lastSuccess`, `error` and `health`. "Live"
means `lastSuccess` is recent and `error` is null, and a second check agrees: `tophat chat --config FILE "search memory
for the latest thing from <stream>"` finds a real item from it.

| stream | what it needs | source entry | live when |
|---|---|---|---|
| Full Disk Access | granted to the terminal or agent app now, and to `node` for the background job later | none | `ls ~/Library/Messages/chat.db` succeeds from that process |
| iMessage / SMS | Full Disk Access | `family: "imessage"`, `config.database` (default `~/Library/Messages/chat.db`) | STATE has a `lastSuccess`; a recent text is found in memory. An empty or stale chat.db means Messages is signed out or iMessage is off on this Mac: fix that, never report it as empty |
| Beeper (WhatsApp, Signal, Discord, Slack and the other bridges) | Beeper Desktop installed, signed in and running | `family: "beeper"`, `config.index` (default `~/Library/Application Support/BeeperTexts/index.db`) | the index file exists and its newest row is recent; STATE has a `lastSuccess`; a recent chat is found |
| Gmail (each account its own source) | a Google OAuth desktop client file and the account's token JSON, both from the user's own sign-in in their browser | `family: "gmail"`, `account`, `config.credentialFile`, `config.clientFile` | STATE `lastSuccess`, no `error`; a recent email is found. `credential-unavailable` means the token file is missing |
| Microsoft 365 or any IMAP mailbox | the OAuth token store (device-code sign-in done by the user); read-only | `family: "imap"`, `config.storeFile`, optional `config.host`, `config.folders` | STATE `lastSuccess`; `imap-reauth-required` means the user signs in again |
| Contacts, Calendar, Notes | Contacts, Calendars and Automation grants for the signed Apple helper app: `tophat-sources build-apple-helper DIR` (needs Xcode command line tools), then the user approves each prompt once | `family: "apple"`, `kind: "apple-contacts"`, `"apple-calendar"` or `"apple-notes"`, `config.helperApp`; notes need `config.folderIds`, calendar needs `config.windowMode: "rolling"` | STATE `lastSuccess` for each; a contact, an upcoming event and a note are found |
| Photos (metadata only, never pixels) | Full Disk Access and Photos | `family: "apple"`, `kind: "apple-photos"`, `config.library` (default `~/Pictures/Photos Library.photoslibrary`) | STATE `lastSuccess`; a recent photo's date and place are found |
| Call history | Full Disk Access | `family: "apple"`, `kind: "apple-call-history"`, `config.databases` (the `CallHistory.storedata` path) | STATE `lastSuccess`; a recent call is found |
| Mercury, Oura, Toggl, Hevy (only the ones the user has) | an API token or OAuth file in the keyring, created by the user in that service | `family: "http-pulls"`, `kind: "mercury"`, `"oura"`, `"toggl"` or `"hevy"`, `config.credential` | STATE `lastSuccess`; a recent transaction, sleep day, time entry or workout is found |
| Files, and anything that can write JSON lines | none | `family: "jsonl"`, `config.dir`; or the webhook receiver (`tophat-sources webhook`, README "Sources") | a dropped line appears in memory after the next intake |

**Mac permissions the chat agent's own tools use.** Accessibility and Screen Recording (desktop control, screen
capture) and Automation (Contacts, Calendar, Messages, Notes, Finder) are granted to the app that runs the tophat
background job; ask the user to grant them now so no tool stops later on a prompt. Find My, Home and Shortcuts are
driven through those same permissions. This repository ships `packages/runner/tools/tophat-findmy` as a stub: device
location, desktop automation and the Home and Shortcuts tools are machine-specific and not included (see
`packages/runner/README.md`). For those, grant the permissions, tell the user plainly that the tool is not in this
release, and never mark Find My, Home or Shortcuts as live. Phone and watch capture (location, screen, audio) are
separate iOS and watchOS apps that post to the webhook receiver; they are not part of this repository either.

**Prove it end to end** before saying the install is done: `tophat instance intake --config FILE --force` prints a
report with `errors: []`, every enabled source has a recent `lastSuccess` in STATE, and one question per stream
answered from memory in `tophat chat` shows real data. Tell the user, per stream: live, declined, or blocked (with the
one action they must take).

## 5. Keep it running

Loading a launchd agent changes the user's machine, so say so and get a yes, then do it: `tophat instance jobs --config FILE --write DIR`
writes the units (`webchat`, `intake` once the file has an `intake` block, and `update`, which merges each new upstream release into this clone after its tests pass; README "Updating"), `tophat instance unit --job NAME`
prints one, and you copy them into `~/Library/LaunchAgents` and load them with `launchctl bootstrap gui/$(id -u)`. Full
Disk Access and the other grants must be given to the program the unit runs (the `node` binary named in the unit), or
a stream works in your terminal and fails in the background. Verify the background run: `tophat instance status` shows
both jobs, and STATE `lastSuccess` advances on its own after `intake.everySeconds` without you running anything.

## 6. Optional, ask before doing

- **Linux:** there is no macOS permission list; section 5 applies with `tophat instance unit --kind systemd`.
- **Memory in other agents:** `tophat-mcp` serves the memory as MCP tools over stdio.
- **Sources and intake** are part of the install, not an extra: section 4. Each source reads private data and sends its
  text to the model provider, so connect them one at a time, say what each one reads, and get a yes first.
- **Sync between devices or with other people:** a hub, `README.md` "Running a hub".

## 7. Stop and remove

```sh
tophat instance stop --config ~/.config/tophat/me/tophat.instance.json
rm -rf ~/.config/tophat/me ~/.local/state/tophat/me     # the instance's config, keys, chats and memory
```

## Tests

`npm test` runs every package's tests (the chat-app tests need `npm install` first). They use temporary state and a
local fake model; nothing reads the user's files or calls a provider.
