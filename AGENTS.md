# For coding agents: verify, install and set up tophat

You were probably asked to review this repository and then install it for your user. This file is the whole path.
Everything runs on the user's machine; the only network calls are to the model provider they configure (and to sites
the chat agent itself is asked to open).

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
  that trusts the operator not to mint devices. Local-only use has no hub.
- **Spend cap.** The push/intake budget (`budget.dailyUsd`) is enforced only when the model entry has a `price`.

## 2. Install and set up (about two minutes)

Requirements: macOS or Linux, Node 22.13 or newer (`node -v`), git, and an Anthropic API key (or an
Anthropic-compatible endpoint). Nothing is installed globally.

```sh
git clone https://github.com/tophat-md/tophat && cd tophat
npm install                                  # the chat app's dependencies; the core needs none
alias tophat="node $PWD/packages/linknotes/bin/tophat.mjs"   # every later command uses it (or: npm link -w packages/linknotes)
tophat setup --name me --owner "Your Name"
```

`setup` is idempotent. It runs `npm install` and the webchat build if they are missing, writes the instance file
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

Then hand over to the user: open http://localhost:4178 in a browser on this machine, and enrol a passkey with the token
in `~/.config/tophat/me/secrets/webchat-bootstrap-token` (a one-time enrolment token; show the path, it is the user's to
open). That is the chat app.

## 4. Optional, ask before doing

- **Keep it running** across logins: `tophat instance unit --config FILE` prints a launchd agent (`--kind systemd` for a
  systemd user unit); installing it is the user's choice.
- **Memory in other agents:** `tophat-mcp` serves the memory as MCP tools over stdio.
- **Sources and intake** (mail, messages, files into memory, through a budget-capped model): `docs/instances.md`, keys
  `sources` and `intake`. Each source reads private data and sends its text to the model; enable one at a time.
- **Sync between devices or with other people:** a hub, `README.md` "Running a hub".

## 5. Stop and remove

```sh
tophat instance stop --config ~/.config/tophat/me/tophat.instance.json
rm -rf ~/.config/tophat/me ~/.local/state/tophat/me     # the instance's config, keys, chats and memory
```

## Tests

`npm test` runs every package's tests (the chat-app tests need `npm install` first). They use temporary state and a
local fake model; nothing reads the user's files or calls a provider.
