# Components

Every component of tophat and whether it ships. "ships" = in this workspace with tests; "planned" = designed, not landed; "out of scope" = deliberately not part of the product, with the reason.

## Store (`packages/linknotes`), ships

| component | status | notes |
|---|---|---|
| TenantStore (groups, roles, per-row ACLs, append-only notes, action log, per-viewer CNF page cache, links) | ships, vendored | copied from upstream; the content screen is config `screens` |
| policy, crypto, sync, hub | ships, vendored | hub service name `tophat-hub` (one transform) |
| the memory store TenantStore subclasses (store, common, identity, pages, schema) | ships, vendored | no default store path (pass a file or `LINKNOTES_DB`); native roster paths for group names are env-configured, empty by default |
| private-people blocklist | ships | the shipped roster is `[]`; the blocklist is config (`people` / `peopleFile`) |
| owner name in prompts | replaced | from `LINKNOTES_OWNER_NAME`, default "the owner" |
| graph viewer (`/graph`) | ships, optional | `packages/viewer`, below: it runs in the browser over the ciphertext log, so the hub serves static files and never plaintext |
| MemoryStore interface, SqliteBackend, CLI (`tophat-linknotes`, umbrella `tophat`) | ships | this repo's own |
| a per-tenant plaintext server | out of scope | it would hold each tenant's plaintext; all memory stays end-to-end encrypted and "hosted" means the ciphertext-only hub |

## Viewer (`packages/viewer`), optional

The memory graph and entity pages in a browser tab, with nothing decrypted outside it. Removing the package removes `/graph` and nothing else.

| component | status | notes |
|---|---|---|
| static app (force layout in a Web Worker, plain / regions / community / local / time modes, hulls, side panel, page modal with history, search, keyboard) | ships | ported from the upstream graph page; the bundle is built by `scripts/build.mjs` and committed under `assets/` |
| WebCrypto cipher (open, seal, device unwrap, passphrase boxes) | ships | byte-compatible with the linknotes Node cipher (test) |
| in-browser replay (receive, unopened retry, ACL grants and revocations, purge tombstones, source policy, links, page cache) | ships | equals a replica of the same user on a generated multi-scope log (test) |
| graph and entity pages built in the browser | ships | the outline generator; a cached page is used when its CNF admits the viewer |
| key import: passphrase-sealed key file (scope keys and/or a viewer device key), device token pasted | ships | `tophat-viewer export-keys`, `tophat-viewer enroll` |
| encrypted IndexedDB copy of the decrypted view and layout (or memory only) | ships | key derived from the passphrase (PBKDF2-SHA256, 600k) |
| `hubView()` for the Node hub, `tophat-viewer hub` | ships | static files at `/graph`, `/graph/<asset>`, `/e/<id>`; strict CSP, `connect-src` the hub only |
| the same static files on the edge-worker hub | planned | `viewerAssets()` returns them as a path map for any host |
| passkey unlock (WebAuthn PRF) instead of a passphrase | planned | |
| replay in a Web Worker, incremental graph deltas | planned | replay runs on the page's thread today |

## Push (`packages/push`), ships (core)

| component | status | notes |
|---|---|---|
| the poll cycle and derivation (`pollOnce`, `deriveOnce`, CLI `tophat-push`) | ships | ingest, packet with coded records and candidates, model, apply, pages; generic prompt `prompts/derive.txt` |
| budget | ships | daily USD cap and prices from config, append-only spend ledger |
| model calls | provider registry | openai-compatible, anthropic, command, stub |
| entity resolution helpers (autolink, ambiguity, text links, facets, discovery) | planned | candidates are found by store search today |
| an assistant loop (wakes, alerts, task discharge, reflections, data repairs) | out of scope | belongs to an assistant built on top, not to the memory |

## Sources (`packages/sources`), ships (core)

| component | status | notes |
|---|---|---|
| common helpers, bounded concurrent reads, guarded HTTP | ships | |
| `gmail` (with sent-mail direction and a shared rate-limit cooldown) | ships | accounts and owner addresses are config; credentials by file or secret name |
| `imessage` | ships | fixture test on a synthetic chat.db |
| runner | ships | cursors in a state file, committed after delivery |
| webhook receiver | ships | generic records format, per-source token digests |
| `jsonl` file drop | ships | |
| `beeper` | ships | index path is config (default: Beeper Desktop's standard location) |
| `imap` (IMAP over XOAUTH2, read-only; default host Microsoft 365, `config.host` for another) | ships | host, token store, folders, sent folder and owner addresses are config; any OAuth tool can write the token store |
| `apple` (contacts, calendar, notes via a helper app; call history; photo metadata; dated note entries; contacts backup; photo export) | ships | helper identity configurable (default `io.linknotes.source-reader`); building the helper is an optional step (`tophat-sources build-apple-helper DIR`) |
| `http-pulls` (Mercury, Oura, Toggl, Hevy public REST APIs) | ships | credentials by secret name or file; schema names `linknotes.*` |
| local reading-list and feed streams | planned | |

## Upkeep (`packages/upkeep`), ships (lite)

One scheduler, a handful of jobs:

| job | status |
|---|---|
| `heartbeat` (push poll + sync) | ships, default |
| `consolidate` (refresh dirty pages, checkpoint) | ships, default |
| `health` (writes health.json) | ships, default |
| `log-rotate` | ships, default |
| `backup` (consistent SQLite backup with retention) | ships, default |
| `retrieval` (ONE refresh job with per-corpus intervals) | ships |
| `understanding` (a command you configure; spends model budget) | ships, off by default |
| machine guards, watchers, bridges, deploy guards | out of scope (they operate a particular machine, not the memory) |

The one service shipped is the hub (`tophat-linknotes hub serve`, service name `tophat-hub`, ciphertext only).

## Retrieval (`packages/retrieval`), ships (generic)

| component | status | notes |
|---|---|---|
| tokenizer, document frequency, rare terms; ranking | ships, vendored | |
| corpus registry + `refresh` + `ask` (reciprocal-rank fusion) | ships | |
| built-in corpora | ships | `linknotes` (the store through the interface), `files` (a text directory in SQLite FTS5, incremental); register more with `registerCorpus` |

## Tools (`packages/tools`), ships (generic only)

| component | status | notes |
|---|---|---|
| memory tools (search, entity, page, read, apply, share, scopes) | ships | a tool registry over any MemoryStore + an MCP stdio server (`tophat-mcp`) |
| `tophat-cdp` (Chrome over the DevTools Protocol: jobs that own one tab each, secret-safe fill, frames, shadow roots, protected targets, passkeys) | ships | Node tool + Python reference twin (`packages/tools/cdp`), README, differential tests; endpoint, state and chat-host lists are config/env (`TOPHAT_CDP_*`), the older prefix is read through `TOPHAT_LEGACY_ENV_PREFIX` |
| `tophat-pass` (read verbs over a tophat credential vault: list, find, lookup, fields, get, totp, history) | ships | writes nothing; a vault sealed under an older record-binding prefix reads through `TOPHAT_VAULT_LEGACY_AAD_PREFIX` (read fallback only) |
| `tophat-fanout` (one brief to many models in parallel, web search on, replies side by side) | ships | `packages/tools/fanout`; key from `TOPHAT_FANOUT_SECRETS_DIR` or `<config dir>/secrets`; offline tests |
| `tophat-timer` (goal_wait retry timers seen from outside the server: list, check, fire, log, prune) | ships | `packages/tools/timer`, over the runner's waits |
| `tophat-onboard` (mint, list, revoke one-time onboarding channel URLs) | ships | `packages/tools/onboard`, over the webchat's onboard store |
| `tophat-transcribe` (handwritten notebook photos to text with a vision model) | ships | `packages/tools/transcribe`; owner name, key, glossary and uploads dir are env/config |
| `tophat-vnc` (scripted RFB console into another Mac: capture, OCR, click, type, unlock) | ships | `packages/tools/vnc`; targets come from `vnc-hosts.json`, passwords from `tophat-pass` |
| `tophat-mcp-client` (thin MCP client: HTTP or stdio servers, OAuth, watch and listen) | ships | `packages/tools/mcp`; named `-client` because `tophat-mcp` is the memory MCP server |
| `tophat-multiplayer` (one chat room, many tabs, one agent, every sentence through a privacy gate) | ships | `packages/tools/multiplayer`; the gate harness calls a live model and is run by hand |
| `tophat-commit-guard` (pre-commit hook refusing a byte-exact reversion of an earlier commit) | ships | `packages/tools/commit-guard`; offline tests |
| `tophat-redeploy` (run an optional preparation hook, then `tophat instance ship`; status; any instance verb) | ships | `packages/tools/redeploy`; instance file, deploy tool and hook are env |
| purchasing, banking, messaging, desktop automation | out of scope | not memory |
| project tracking over a purchasing pipeline | out of scope | tied to one deployment's order tools |

## Pull (`packages/pull`), interface + reference runner

| component | status | notes |
|---|---|---|
| `contextFor` (retrieval hits or store search + derived pages of the entities hit, cross-scope for the asker), `runOnce` (one model call), CLI `tophat-ask` | ships | |
| a full chat runner (loop, tools, wakes, UI) | out of scope | an agent harness plugs in through `contextFor` / `runOnce` or the MCP server |

## Verify (`packages/verify`), ships (interface-level harnesses)

| component | status | notes |
|---|---|---|
| `fuzzParties` (multi-party visibility, page and byte-leak property across replicas through one hub, one user on two devices), `differential` (one user's origin and second replica after hub sync read the same: entities, notes, pages, search), CLI `tophat-verify` | ships | the two former core issues (concurrent share divergence, equal-`at` order) are now ordinary passing tests; `differential({ concurrent: true })` exercises the first |
| model checks, differential and mutation testing of the vendored core | upstream | they test the vendored files where they are maintained |

## Groups (`packages/groups`), optional

| component | status | notes |
|---|---|---|
| node keys, audiences, hybrid logical clock, Ed25519 record signatures | ships | pure functions; `audience` = groups holding every note a record rests on |
| facet identities (rarest co-linked entity, frozen rarity) and the outline plan (facet, then month/week/day/size splits) | ships | membership independent of ranking |
| `decide` / `materialize` / `publish` (adopt-or-generate per node, pagewriters trust, earliest-clock conflicts, mechanical publish check) | ships | an own page is a page whose audience is your private scope; no separate code path |
| facet re-ranking through an injected `rankFacets`, tiered layout `allocate`, `render`, `buildPage` | ships | model calls are injected; tests use deterministic stubs |
| `memoryLog` (in-process PageNode log) | ships | the `append` / `list` interface a replicated log implements; kept for pure tests |
| `storeLog(store)`: the same interface over a replica (`putPageNode` / `pageNodes`) | ships | page nodes replicate like notes; the store re-derives the audience and refuses scopes outside it, so `publish`'s check is a pre-filter |
| PageNode as a record kind in the replicated store log | ships | vendored core `mc_pagenodes`: derived, never a note; `apply` refuses a source ref naming a page node |

## The component manifest and instances (`tophat.components.json`, `packages/deploy`), ships

Every component above, plus the app components below, is one row of `tophat.components.json`: `id`, `package`, `depends`, `optional`, `provides`, `removable`. Only `linknotes` is required. `tophat components list | tree | check` reads it; `check --config tophat.instance.json` fails when an enabled component needs one that is not enabled. An instance is one `tophat.instance.json` (see `docs/instances.md`).

| component | status | notes |
|---|---|---|
| `deploy`: instance config, component check, `tophat start` | ships | credentials in the instance file are references (env, keyring, file), never values |
| `runner`: the chat runner (a child process speaking stream-json; goals and waits) | assembled | `packages/runner`, produced by the app assembly step from the upstream app; see its README for what is included |
| `webchat`: the chat web app (SvelteKit) | assembled | `packages/webchat`, same step; needs `runner` |
| machine automation, shopping, banking, messaging sends, document filing, watch capture | out of scope | they operate one person's machine and accounts; stubbed in the assembled packages |
