# demo (not a workspace package)

The public site at tophat.md is a running instance of tophat: the real webchat, unmodified, talking to the real runner. This directory is
the thin layer that makes that safe and gives it a first impression. It renders no chat UI of its own.

## How a visit works

1. The edge (`edge/`, a Cloudflare Worker on tophat.md) proxies to the demo origin. If the origin is unreachable (connection error, 5xx, 52x,
   no answer in 6 s) a page navigation gets `edge/fallback.html` instead: plain monospace prose, the original copy only.
2. The origin is `src/serve.mjs`, a shim in front of the demo instance's webchat. It is the sign-in service the webchat's own scope gate
   asks, so every visitor is a guest account with a personal scope; the app's scoping then keeps each visitor to their own chats. The
   registry of guests is a file the shim writes and the webchat re-reads.
3. A new visitor gets their own copy of the starting chats (`seed/chats.json`; cached real answers fill the `slot` ones), written through the
   store's script writer: folders, side chats, an empty chat open. Fictional or about tophat itself.
4. `src/shim.js` (the one script injected into the page) runs the human check in the background (Turnstile, managed, shown only when
   Cloudflare asks), types "so whats ur deal ?" into the real composer and presses the real send button. The typing replays the owner's
   own recorded keystroke gaps (`OPENER_GAPS_MS` in `src/answer.mjs`, no randomness). On a first visit it is staged as the opening motion
   (`src/intro.css`, driven by the shim, the webchat untouched): black, only the bar at half its width, zoomed, the caret fixed at the middle
   of the screen with the bar sliding left under it, a beat, the send button pressed; then one eased motion (900 ms) brings the app, the
   black, the bar's width and the message (it flies up from the bar) to their real places. A visitor's key, click or touch drops it at
   once; reduced-motion visitors never get it. The opener never shows "sending". The shim answers that one action
   itself: the message and the description (`content/description.md` with a widget after each feature, `widgets/`) are stored as an ordinary
   turn and streamed through the real event feed in token-sized deltas. No model call.
   A page for a guest this browser has not shown yet first clears the webchat's per-browser leftovers of earlier guests (IndexedDB `tophat-engine*`,
   `qk:*` keys; `src/guest-reset.js`, inline in the page's first script) and starts with the Inbox folded.
   A request for the page with no session and no html `Accept` (a link preview, curl) gets the description as a plain 200 page with title,
   description and og: tags (`og.png` in `public/`) and no guest is made for it.
5. Every later message is a real runner turn. The runner is the demo user's, with its tools cut to `memory_search` and `memory_read`
   (`TOPHAT_RUNNER_TOOLS_ALLOW`; `TOPHAT_RUNNER_PROMPT_MODE=public` makes its system prompt name just those tools and show no path), no subagents or chat tools, the cheap model, the direct provider, no auto routing and the instance workspace forced on every chat action that carries settings or a directory (`src/pin.mjs`, including a message that creates its chat), and the agent's standing context
   generated from `seed/agent-policy.md`, `content/agent-context.md` and `content/description.md` (`tophat-demo instructions`).
6. After `visitors.turnsPerSession` real turns across all of a visitor's chats (demo.json, the one place the number lives) the server refuses
   more and the page grays out with the download block. Turn caps per address, a daily spend cap (then "resting") and a per-address session cap
   sit in the same file.
7. No JavaScript, a failed or timed-out check (60 s), or a blocked check script: the page is replaced by `/_demo/text`, the description as
   plain text. An app that never boots lands on `/_fallback`.

The shim passes only the API paths the app needs, serves no file but `widgets/*.html`, and answers `/api/scopes` as "off" so the page draws
no scope picker (the scopes are still enforced by the server).

## Staying on main

One pipeline, two halves:

- `tophat-demo release --repo DIR` (maintainer's machine) builds the committed `HEAD` and publishes `/Users/Shared/tophat-demo/releases/<sha>`,
  with `current` pointing at it. A git `post-commit` hook runs it after every commit and the LaunchAgent `md.tophat.demo-release` runs it every
  5 minutes as a safety net. Only committed work is published; one build at a time.
  The timer job passes `--revendor` (`src/revendor.mjs`): from clean checkouts of the upstream app and of this repository it runs
  `scripts/vendor-app.mjs --check`, and on upstream drift that has been quiet 2 minutes (newest upstream commit under the app's entry
  directories) it assembles, builds the webchat, and commits only the files the assembly changed (`ASSEMBLY.json`, `packages/webchat`,
  `packages/runner`) by explicit pathspec; the commit fires the hook. A check problem, a failed assembly or build, or uncommitted edits in an
  assembled file skip the run (logged as `revendor skipped: ...`); uncommitted upstream work is never vendored.
- `tophat-demo update --config demo.json` (demo user, LaunchDaemon `md.tophat.tophat-demo.update` every 60 s) installs `current` into the root
  when it differs (the root's own `node_modules` and the instance's state stay), removes any stale copy of a workspace package under a package's own `node_modules` (it shadows the workspace link), regenerates the memory-graph widget and the agent's standing
  context, and restarts only the demo's own processes; launchd brings them back. It refuses, loudly, a release whose `package-lock.json`
  differs from the root's (dependencies need a refresh first).
- `tophat-demo check [--repo DIR]` exits 1 when the live demo's build (`/healthz`) is not the published release or the repository's `HEAD`.

Webchat changes reach the demo by the usual route: upstream first, `scripts/vendor-app.mjs`, commit; this pipeline does the rest.

## Commands (`bin/tophat-demo.mjs`)

- `export` / `seed`: the repository's own docs and commit log become the memory the demo agent reads (private-data gate), plus the graph snapshot.
- `ask --slot ID` / `daily`: one real turn on the instance, cached as the transcript of a starting chat (`daily` also reseeds).
- `widgets`: writes `widgets/memory-graph.html` from the snapshot (the others are static).
- `instructions`: writes the agent's standing context next to the instance file.
- `instance [--check]`: applies (or checks) `seed/instance-policy.json` on the instance file; see Config.
- `serve`, `release`, `update`, `check`: above.

## Config

`demo.json` (demo user's `~/.config/tophat-demo/`): the instance file, the replica and snapshot, the cache, `visitors` (`turnsPerSession`,
`dailyUsd` (the only backstop: there is no per-address limit of any kind, since schools and libraries share one address), `usdPerTurn`, `model`), the Turnstile keys (files), `edgeSecretFile` (shared with the
Worker, so a client address header is trusted only from the edge), `downloadUrl`. The instance file carries the runner's environment
(tool allow-list, instructions size, the scopes config). The instance file's required settings are code, not a hand edit: `seed/instance-policy.json` (tool allow-list, no subagents or chat tools, `TOPHAT_RUNNER_PROMPT_MODE=public`, `TOPHAT_RUNNER_TRANSCRIPTS=0`) is merged into it by `tophat-demo instance` and on every update, before the restart. `tophat-demo instance --check` exits 1 when the file lacks one, or when the demo's memory holds any `webchat` row: no visitor chat may reach the shared tophat-dev memory (a personal-scope chat is also refused by the runner's scope gate, and the intake claims only open scopes).
Nothing in this directory names a person or an address.

## Edge

`edge/build.mjs` inlines the fallback page and icons into `dist/worker.js`; `edge/deploy.mjs` uploads it as `tophat-md-edge` with the
Cloudflare API and attaches `tophat.md` and `www.tophat.md` (www redirects to the apex). `/__dead/...` is a test route whose origin does not
exist, to see the fallback without stopping anything.

## Local development

`dev/fake-model.mjs` is a model stand-in with slow streamed replies; point a scratch instance's `models.chat.baseUrl` at it and run the shim
against that instance (`serve --config`) to drive the whole flow without spend.
