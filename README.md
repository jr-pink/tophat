# tophat

A personal memory you can share by scope. Entities, append-only notes and work items live in a local SQLite store (the `@tophat-md/linknotes` package); every row carries the scopes (groups) that may read it; replicas sync through a hub that only ever holds ciphertext; and each viewer gets derived pages built from every note they can read across all their scopes. **All memory is end-to-end encrypted**: plaintext exists only in the replicas on your own devices (and those of the people you share a scope with), and the hub, hosted or self-run, stores and relays ciphertext it cannot open. One backend implements the interface: **sqlite**, a local replica with optional hub sync. A push plane fills the store from your sources (mail, messages, files, webhooks) through a model you configure, under a daily budget.

Node 22.13 or newer. The core packages have no dependencies; the chat app (`runner`, `webchat`) installs its npm dependencies with `npm install`.

## Install

    git clone https://github.com/tophat-md/tophat && cd tophat
    npm install
    alias tophat="node $PWD/packages/linknotes/bin/tophat.mjs"                      # or: npm link -w packages/linknotes
    tophat setup --name me --owner "Your Name"                                       # reads ANTHROPIC_API_KEY, or --key-file PATH

`tophat setup` first moves the clone off `main` onto a branch of your own, named after the instance (`me` above; `--branch NAME` picks another, `--no-branch` skips it): `main` is upstream's and only ever fast-forwards, and every edit, commit and instance change you make goes on your branch. Then it builds the chat app, writes `~/.config/tophat/me/tophat.instance.json`, copies the model key into the instance's keyring (0600, never printed) and starts the instance on http://localhost:4178 (loopback only). Then:

    tophat chat --config ~/.config/tophat/me/tophat.instance.json "Remember that my favourite tea is genmaicha."   # a first turn; it writes memory
    tophat graph --config ~/.config/tophat/me/tophat.instance.json                                                 # the memory graph on http://localhost:4179/graph

Open http://localhost:4178 and enrol a passkey with the token in `~/.config/tophat/me/secrets/webchat-bootstrap-token`. Coding agents asked to review and install this repository: read [AGENTS.md](AGENTS.md), which covers the review, the install, verification and the trade-offs to tell the user about. **Install means fully setting up**: not just cloning and starting the server, but granting every macOS permission and connecting every stream until each one shows data flowing; AGENTS.md section 4 is the checklist.

## Updating

An install is a git clone with two kinds of branch. `main` is upstream's: never commit to it, only fast-forward it. Your own branch (created by `tophat setup`, named after the instance) is where everything of yours goes, so upstream can always be merged in. Your changes live there in one of two ways: as extensions (`docs/extensions.md`; they never touch tophat's code, so an update never collides with them), or as commits on your branch. To take upstream by hand:

    git fetch upstream                      # `origin` when you cloned without renaming it
    git switch main && git merge --ff-only upstream/main
    git switch me && git merge main         # `me` is your branch; conflicts are yours to resolve, on your branch

A second copy running at once (a staging or test instance) is a `git worktree add ../tophat-test me`, never another clone, so every checkout shares one object store and one history. Changes meant for everyone go in as a pull request from a branch cut from `main`, not from yours. `tophat update` merges the newest upstream release tag (`vX.Y.Z`) into that branch, so the branch only moves forward, one merge commit per release, and local commits are never rebased or dropped:

    tophat update --config ~/.config/tophat/me/tophat.instance.json --check      # { current, latest, behind }; changes nothing
    tophat update --config ~/.config/tophat/me/tophat.instance.json              # merge, check, apply, ship, restart
    tophat update --config FILE --dry-run | --no-restart | --resume DIR [--accept-ui]

What a run does: fetches tags from the `upstream` remote (else `origin`); commits any uncommitted local work on the branch (`local: snapshot before update to vX`, never a stash); merges the release in a staging worktree under `<paths.state>/update/`, never in the live checkout; there it installs dependencies (`npm ci` when the lock changed, otherwise a copy of the live `node_modules`), runs `npm test`, the extension gate (`tophat ext check`) and the webchat build, and a UI check: the staged and the current release each boot a scratch webchat (empty state, spare loopback port), every main route must load with all its assets, and with Chrome present each route is screenshotted in both and a blank page, a new console error or a large pixel difference is a failure (screenshots are kept for the fixer). Only when all pass does the live branch fast-forward onto the tested merge, followed by `instance ship`, a restart of the instance's launchd jobs and a health check; an instance that does not come back healthy is rolled back to the previous commit.

Any failure (a conflict, a test, the gate, the build, the UI, health) leaves the live checkout as it was, records `<paths.state>/update/last.json`, and posts an automated event into the instance's own chat app naming the staging worktree, the failing command and its log: the agent fixes it there, commits, and runs `tophat update --config FILE --resume DIR`, which merges anything newer, re-runs every check and applies. The next scheduled run resumes the same staging tree too, so a fix is never discarded by a newer release.

The `update` job (`tophat instance jobs`) runs it daily by default (`update.everySeconds`); `update: false` in the instance file drops the job, `update.fixer: false` records failures without waking a chat, and `update.command` hands the release tag to the instance's own deploy command instead (`docs/instances.md`).

## Packages

| package | what it is | entry |
|---|---|---|
| `@tophat-md/linknotes` (`packages/linknotes`) | the store: MemoryStore interface, sqlite backend, hub, tenancy, sync, CLI | `open(config)`, `tophat-linknotes`, `tophat` |
| `@tophat-md/push` (`packages/push`) | poll sources, derive entities/notes/pages with a budget-capped model, write through any backend | `pollOnce(store, cfg)`, `tophat-push` |
| `@tophat-md/sources` (`packages/sources`) | adapter plugin interface, runner, file drop, webhook, Gmail, iMessage, Beeper, IMAP, Apple (helper app, calls, photos), HTTP pulls | `registerAdapter`, `runSources`, `tophat-sources` |
| `@tophat-md/retrieval` (`packages/retrieval`) | corpus registry, the one refresh job (per-corpus intervals), ask with rank fusion | `refresh`, `ask`, `tophat-retrieval` |
| `@tophat-md/pull` (`packages/pull`) | context assembly (hits + cross-scope pages) and a reference one-call runner | `contextFor`, `runOnce`, `tophat-ask` |
| `@tophat-md/tools` (`packages/tools`) | the memory as agent tools; an MCP stdio server | `listTools`, `callTool`, `tophat-mcp` |
| `@tophat-md/upkeep` (`packages/upkeep`) | one scheduler: heartbeat, consolidate, health, log-rotate, backup, retrieval; optional understanding | `runDue`, `tophat-upkeep` |
| `@tophat-md/verify` (`packages/verify`) | multi-party leak fuzz across replicas, origin-vs-replica differential after hub sync | `tophat-verify` |
| `@tophat-md/runner` (`packages/runner`, optional, assembled) | the chat runner: one stream-json child per conversation, goals, waits, tools | `rev6/pull/pull.mjs` |
| `@tophat-md/webchat` (`packages/webchat`, optional, assembled; needs runner) | the chat web app (SvelteKit) | `npm run build -w @tophat-md/webchat`, `serve.mjs` |
| `@tophat-md/deploy` (`packages/deploy`, optional) | instance config, the component manifest check, `tophat start` | `tophat components`, `tophat start --config`, `tophat instance` |
| `@tophat-md/groups` (`packages/groups`, optional) | shared derived pages: page subtrees keyed by their notes, adopted across viewers, publishable only to groups holding every note; facets and tiered layout | `buildPage`, `decide`, `publish`, `allocate` |
| `@tophat-md/viewer` (`packages/viewer`, optional) | the memory graph and entity pages in a browser tab: pulls the ciphertext log, decrypts with WebCrypto, replays and lays out there; the hub only serves the static files | `hubView()`, `exportKeys()`, `tophat-viewer` |

Packages talk only through their public entries (the interface, the adapter contract, the provider registry). COMPONENTS.md lists every component, what ships and why; `tophat.components.json` is the machine-readable manifest (`tophat components list | tree | check`). An instance (a personal assistant, a team's, a group runner) is one `tophat.instance.json`: see [docs/instances.md](docs/instances.md).

Every CLI is also reachable through one command, `tophat` (in `@tophat-md/linknotes`): `tophat ask|mcp|push|retrieval|sources|upkeep|verify ARGS` runs `tophat-<that>`, and anything else runs `tophat-linknotes ARGS`.

## The store from the command line

    git clone https://github.com/tophat-md/tophat && cd tophat
    alias tophat-linknotes="node $PWD/packages/linknotes/bin/tophat-linknotes.mjs"   # or: npm link -w packages/linknotes

Your replica (E2E with the hub):

    tophat-linknotes init sqlite --user alex                         # store, device key, your private scope "alex"
    tophat-linknotes note --entity "Dana Okafor" --type person "Met Dana at the bench; she runs the sprinkler tests."
    tophat-linknotes search sprinkler
    tophat-linknotes page <entity id>

### Join a shared scope with someone else

1. The hub's operator issues your device a hub token (`tophat-linknotes hub token ... --out FILE`; you receive the file, never a pasted secret). Initialise with it: `tophat-linknotes init sqlite --user alex --hub https://<hub> --hub-token-file FILE`, then `tophat-linknotes sync` (registers your device's public key).
2. The scope's admin runs `tophat-linknotes scope add <scope> alex write` and syncs: their device wraps the scope key to your device key.
3. `tophat-linknotes sync` again: you hold the scope key and receive the scope's rows. Write into it with `--scopes <scope>` (or `scopes` per item in `apply`); everything else defaults to your private scope and never leaves your devices except as ciphertext under your own key.

Sharing is per row: `tophat-linknotes share note <id> alex,<scope>` widens one note; `tophat-linknotes retract note <id>` takes it out of every scope (the log keeps it; replicas hide it). Two entity ids for one thing (your "Dana" and the shared "Dana Okafor") merge for reads with `tophat-linknotes link <id> <id>`; the link replicates only into scopes both entities share.

## The interface

`open(config)` returns a `MemoryStore`; every method is async (JSDoc types in `packages/linknotes/src/interface.mjs`). `registerBackend(name, factory)` adds another implementation; the shipped one is `sqlite`.

| method | does |
|---|---|
| `whoami()` | user, device, backend, default write scopes |
| `apply({entities, notes, work}, {scopes?, sourceRefs?, ackRaw?})` | write; new rows without their own `scopes` go to `opts.scopes`, else the config's `writeScopes`. Notes cite raw data; without sourceRefs the call itself is recorded as raw evidence, one record per distinct note scope set |
| `ingest(records, {scopes?, pusher?})` | store raw records `{id, source, text, time, author?, thread?, ...}`, deduplicated by (source, account, id, revision) |
| `pending({pusher, limit?})` | raw records this pusher stored that nothing has been derived from yet |
| `search(query, {kind?, limit?})` | full-text over raw, entities, notes, work, pages: only what the viewer may read |
| `read(kind, id)`, `entity(id)` | one row; an entity with every visible note (linked ids merged) |
| `page(entityId)` | the derived page (below) |
| `share(kind, id, scopes)`, `retract(kind, id)` | change who can read a row |
| `putPageNode(record, {scopes?})`, `pageNodes({entity, key?, scopes?})` | derived page nodes (`@tophat-md/groups`): replicated like notes, scoped to the groups holding every note they cite, never notes and never evidence |
| `link(a, b, linked?)` | two entity ids are one thing for reads (reversible) |
| `scopes()`, `createScope(s)`, `addMember(s, user, role)` | groups with roles read < write < admin; role `none` removes and rotates the key |
| `sync()` | push and pull ciphertext with the hub, then wrap scope keys to new member devices |

### Sharing, devices and cross-scope pages

Every replica is the same code (TenantStore over SQLite), one per device: your laptop and your phone are two replicas of one user, and the people you share a scope with run their own. Every committed write becomes one logged action whose rows are sealed per scope set (AES-256-GCM under a fresh key, shared to each scope's key; scope keys are wrapped to device X25519 keys), so the hub orders and filters ciphertext by membership and can open none of it. A note written into a shared scope reaches every member's devices at their next sync; a note in your private scope reaches only your own devices. Reads go through one filter: a viewer sees a row when any of its scopes is one of theirs. A page for an entity is built from every note the viewer can read across all their scopes, following `link`s, and cached under sha256(prompt version, the visible note ids) together with the AND of those notes' scope sets; a cached page is served only to a reader who satisfies every clause, so two viewers with the same visible notes share it and anyone missing one note gets their own. The other party's page never includes your private notes because their replica never receives them (tests check the file bytes).

### Hosted means the hub

"Hosted" is the hub run for you: the same append-only relay (`tophat-linknotes hub serve`), typically behind a CDN or edge worker that passes device sync calls through to it. It stores the ordered log of sealed actions (ciphertext) plus the routing metadata it needs (device and user ids, group ids and memberships), never a scope key, so its operator cannot read, search or derive anything. Reads, search, pages and derivation always run in a replica on a device you control. There is no server that holds your plaintext.

## Groups: shared pages (optional)

`@tophat-md/groups` lets members of a group reuse each other's derived pages without ever reading a page built on a note they lack. It is pure functions over note sets; the store, the model calls (`generate(part)`, `rankFacets(candidates)`) and the record log are passed in, so it imports no model client.

- **Plan.** A page is an outline tree per entity. Under the root, one node per facet: a facet is a co-linked entity (linked by at least two of the notes), and a note goes to the rarest facet it links (rarity is the facet's note count when it was first made, then frozen), else to `~other`. A node with more than `leafMax` notes splits by month, ISO week, day, then fixed-size chunks. Membership depends only on the note and the facet identities, never on ranking.
- **Keys.** `nodeKey(entity, noteIds, generatorVersion, path)` hashes the sorted note ids under a node, so equal notes give equal keys and one extra note changes only its leaf and the path to the root.
- **Audience.** `audience(noteIds, scopesOf)` is the set of groups holding every one of the notes. A published node is a `PageNode` record `{ entity, path, key, text, citedNoteIds, childKeys, facetList, generatorVersion, author, at, sig }`, derived and never a note, stored with scopes = its audience. `publish(log, records, group, { scopesOf })` accepts a record only when its audience includes `group`. An own page is the same thing with audience = your private scope (`scopesFrom(notes, { own })` counts your private scope as holding every note you read).
- **Adopt or generate.** `decide(view, published, trust)` walks the viewer's own plan top-down and adopts a record for a node only when its key equals the viewer's key for that node, its cited ids hash to that key and are all held by the viewer, its children match, its Ed25519 signature verifies, and its author is trusted: in the `pagewriters` of a group the record came through (`pagewritersFor`: the group's runner by default, every member for a small trusted group) or added locally by the viewer. Among trusted records for one key the earliest hybrid-logical-clock stamp wins, the record hash breaks ties. Everything else is generated: the differing leaves, then each ancestor re-rolled from its children (`materialize`).
- **Layout.** `rankFacets` (a cheap model, re-run on every build) puts facets into tiers `background`, `current`, `detail` with a reason; `allocate` splits the page budget 0.25 / 0.45 / 0.30 by tier, within a tier by weight times sqrt(note count), with a floor per background facet, a ceiling per facet and a recency slot for the most active facets; what current cannot use flows to detail, then background. The status section is generated fresh on every build, outside the budget, and never published.
- `buildPage({ store | notes, entity, published, trust, generate, rankFacets, author, clock, privateKey })` runs all of it and returns the page text and the new records to publish. `memoryLog()` is an in-process log with the `append(record, scopes)` / `list({ entity, groups })` interface.

## Push: filling the store from sources

`tophat-linknotes push` runs one cycle from `config.push`: poll every due source, ingest its records into `scopes`, derive notes and entities with the configured model, refresh the touched pages, sync.

    "push": {
      "id": "alex-laptop",                    // marks the raw rows this pusher derives from
      "scopes": ["alex"],                      // where ingested and derived rows go
      "stateDir": "~/.local/state/linknotes/push",
      "model": { "provider": "anthropic", "model": "<model id>", "apiKeyEnv": "ANTHROPIC_API_KEY",
                 "price": { "inputPerMTok": 3, "outputPerMTok": 15 }, "maxTokens": 4000 },
      "budget": { "dailyUsd": 2 },
      "ownerAddresses": ["me@example.org"],    // whose mail counts as sent by you
      "sources": [
        { "id": "drop", "family": "jsonl", "config": { "dir": "/abs/path/drop" } },
        { "id": "work-mail", "family": "gmail", "account": "me@example.org", "schedule": 300,
          "config": { "credentialFile": "/abs/path/gmail-token.json", "clientFile": "/abs/path/google-desktop-client.json" } },
        { "id": "imessage", "family": "imessage", "schedule": 300, "config": {} }
      ]
    }

Providers: `openai` (any OpenAI-compatible endpoint, `baseUrl`), `anthropic`, `command` (a local program: request JSON on stdin, reply on stdout), `stub` (deterministic, no model). Keys are read from the environment variable `apiKeyEnv` names. A priced call is made only when today's spend plus its worst-case cost stays under `budget.dailyUsd`; actual spend is appended to `<stateDir>/spend.jsonl`. Add a provider with `registerProvider(name, cfg => ({ complete }))`.

### Sources

An adapter exports `poll(source, ctx) -> { records, cursor, complete, health }`; the runner owns cursors (committed only after the store has the records) and deadlines, and one broken source never stops the rest. Shipped: `jsonl` (file drop: one `{id, text, time, author?, thread?}` per line), the webhook receiver (`POST /v1/records/<source>` with a per-source token, spooled for `jsonl`), `gmail`, `imessage` (macOS, Full Disk Access). Accounts, paths, credential references and owner addresses are configuration only; credentials resolve from an absolute file path, `LINKNOTES_SECRET_<NAME>`, or `~/.config/linknotes/secrets/<name>`. Add one with `registerAdapter('family', () => import('./my-adapter.mjs'))`.

The private-people blocklist (people whose message bodies never reach a model) is config: `people` (inline) or `peopleFile` in the store config. Content screens (keep matching text out of a scope by label alone) are `screens: [{ groups, pattern, label }]`.

## Retrieval, answering, agent tools, upkeep

    "retrieval": { "stateDir": "~/.local/state/linknotes/retrieval",
                   "corpora": [ { "name": "linknotes", "kind": "linknotes" },
                                { "name": "notes", "kind": "files", "dir": "/abs/notes", "everySeconds": 86400 } ] },
    "pull": { "model": { "provider": "anthropic", "model": "<model id>", "apiKeyEnv": "ANTHROPIC_API_KEY" } },
    "upkeep": { "stateDir": "~/.local/state/linknotes/upkeep",
                "jobs": { "heartbeat": { "everySeconds": 300 }, "consolidate": { "everySeconds": 3600 }, "health": { "everySeconds": 300 },
                          "log-rotate": { "everySeconds": 86400 }, "backup": { "everySeconds": 86400, "dir": "/abs/backups", "keep": 7 },
                          "retrieval": { "everySeconds": 300 } } }

- `tophat-retrieval refresh` is the one index refresh; each corpus has its own interval, so frequent mail and daily notes share one job. `tophat-retrieval ask QUESTION` fuses every corpus.
- `tophat-ask QUESTION` assembles context (retrieval hits plus the derived pages of the entities hit, across all your scopes) and makes one model call; `--context-only` prints the packet.
- `tophat-mcp` serves memory_search, memory_entity, memory_page, memory_read, memory_apply, memory_share, memory_scopes over MCP stdio, for any agent harness.
- `tophat-upkeep forever` (or `once` from cron/launchd) runs the due jobs; `understanding` is optional, off by default, and runs a command you configure.
- `tophat-verify --seeds 10` runs the multi-party leak fuzz and the origin-vs-replica differential on temp stores.

### Apple helper (optional)

Contacts, calendar and notes need a signed helper app that owns the macOS privacy grants: `tophat-sources build-apple-helper ~/Library/Application\ Support/linknotes` (needs Xcode command line tools), then point the source's `config.helperApp` at the built app and approve the prompts once. Call history, photo metadata and iMessage need Full Disk Access for the process running the push instead.

## Running a hub

    tophat-linknotes hub serve --db hub.sqlite --secret-file hub-secret --port 8791
    tophat-linknotes hub token --secret-file hub-secret --device alex-laptop --user alex --out alex.hub-token

The hub service is named `tophat-hub` (its `GET /healthz` answers `{ ok, service: "tophat-hub", head }`). It is append-only (no delete route) and per-device sequenced; tokens are HMAC device tokens, one per device (a second device of the same user gets its own token and its own key; an admin's next sync wraps the scope keys to it). It holds ciphertext only.

## Graph viewer in the browser (optional)

`@tophat-md/viewer` draws the memory as a force-directed hypergraph (entities are nodes, each note one hyperedge over its entities; modes plain, regions, community, local, time) with entity pages in a modal, and everything that needs plaintext happens in the browser tab. The hub serves the static files at `/graph` and the ciphertext log over its existing device pull API (`GET /v1/pull`), and nothing else: no plaintext, key or passphrase ever reaches it.

    tophat-viewer hub --db hub.sqlite --secret-file hub-secret --port 8791          # the hub as above, plus the app at /graph
    tophat-linknotes hub token --secret-file hub-secret --device alex-browser --user alex --out alex-browser.hub-token
    tophat-viewer export-keys --config ~/.config/linknotes/config.json --out alex.viewer-keys.json   # asks for a passphrase

Open `https://<hub>/graph`, choose the key file, paste the device token, enter the passphrase. The tab then:

1. opens the key file (PBKDF2-SHA256, 600,000 rounds, AES-256-GCM) and reads the token's user and device;
2. pulls the log from the token's cursor, page by page (`more` and `next` followed; a hub may cut a page at 16 MB), with a progress bar against the hub's head; when the user turns out to have gained a scope, it starts over from 0 as a replica does;
3. opens each sealed part with WebCrypto (the same AES-256-GCM, XOR-share and X25519/HKDF formats as the store) and replays the rows into an in-memory view with the replica's rules: additive grants, revocations by hub order, purge on unshare, last writer wins by hub sequence, the source policy; parts it has no key for wait sealed and are retried when a key arrives;
4. builds the graph and each entity page from that view (the store's outline, or a cached page whose scope clauses admit the viewer), and lays it out in a Web Worker;
5. keeps the decrypted view and the settled layout in IndexedDB sealed under a key derived from the passphrase, unless "keep an encrypted copy" is unticked (then memory only). A revisit asks for the passphrase alone, paints from that copy, and pulls what the log gained. "lock" drops everything from the tab.

Keys, two ways:

- **Scope keys** (`export-keys`): the scope keys your replica holds right now. Use a device id for the token that no replica pushes from (the hub returns a device's own actions without their parts). A key rotated later (someone removed from a scope) needs a fresh export.
- **A viewer device** (`tophat-viewer enroll --hub URL --token-file alex-browser.hub-token --out alex.viewer-keys.json [--config ...]`): registers a fresh device key for the token's device id with the hub; each scope admin's next `sync` wraps the scope keys to it, and the tab unwraps them from the log itself, rotations included.

A tab without a scope's key reads nothing of that scope even when the hub serves its parts (they stay sealed), and a token of another user gets nothing at all (the hub filters by membership). The private-people blocklist of a replica's config is not applied in the tab (it is enforced where notes are derived). The page's CSP limits network access to its own origin; `tophat-viewer hub --hub-url URL` (or `hubView({ hubUrl })`) points the app at a hub on another origin and adds only that origin. WebCrypto with X25519 is required, and a secure context (https, or http on localhost).

The bundle is committed under `packages/viewer/assets` (about 550 KB, 150 KB gzipped; the drawing libraries are most of it) so neither the hub nor the page needs npm or a CDN. Rebuild after changing `packages/viewer/web` or `src/core`: `node packages/viewer/scripts/build.mjs --modules DIR` with esbuild, sigma, graphology, graphology-communities-louvain and d3-force installed in DIR (header of the script); `--check` fails when `assets/` is stale.

## Tests

    npm test                    # every package

The store suite runs one conformance file twice over a real hub on a temp port: on a single replica, and on two replicas of one user (A writes, and every read the suite makes is answered by both A and B after hub sync and must be identical). The two-party test gives each party its own replica (one party on two devices) and checks visibility, page composition and the leak property on file bytes: no private note reaches the other party's replica, reads, search or pages, and the hub file holds no plaintext at all. The viewer's tests check its WebCrypto cipher byte for byte against the store's, its replay against a replica of the same user on a generated three-party log (visible notes and entities, the whole graph, every page; paged, incremental and from the encrypted cache), and the scope-leak property; an opt-in smoke test (`VIEWER_SMOKE_CDP`, `VIEWER_SMOKE_TARGET`) loads the built bundle in a real browser against a local hub. `verify` adds a multi-party fuzz (three users, one on two devices) and an origin-vs-replica differential; two known issues in the replicated core are kept as `todo` tests (they report, the suite stays green): concurrent scope changes to one note on two devices can leave the devices disagreeing, and notes with the same `at` can render in a different order on each device. Tests never touch a live store.

## Where the code comes from

`packages/` is the source: everything here is edited here, including the replicated store core under `packages/linknotes/core`, the runner and the webchat. The app tests need the packages' npm dependencies and skip without them.

## License

MIT, see `LICENSE`.
