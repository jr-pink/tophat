# demo (not a workspace package)

The public demo of a running instance, embedded on the landing page. `bin/tophat-demo.mjs`:

- `export --repo DIR --out DIR [--deny FILE]`: the repo's own docs (README, COMPONENTS, docs/, package READMEs) and commit log become records, after a private-data gate (the traceability deny list, a local deny file, and fixed patterns for mail addresses, phone numbers, money, tokens, home paths); a record with any hit is left out and named in `manifest.json`.
- `seed --config demo.json`: records into the instance replica's group scope (idempotent), then the graph snapshot the viewer reads in its public mode (`<meta name="th-public">`, `packages/viewer/src/core/snapshot.mjs`).
- `ask --slot ID`: one real turn on the instance through its loopback `/api/agent`, cached for the page (the seeded chats).
- `daily`: seed, then re-ask every slot marked `daily`.
- `serve`: the page. Seeded chats from the cache; visitor turns after a Turnstile check, `turnsPerSession` per signed session (cookie, or the `x-demo-session` header), a per-IP daily cap, a daily spend cap (then "resting"), a per-call token cap and a step cap. A visitor turn's only tools read the replica (search, one entity) and point the graph pane; a visitor's chats are stored per session and shown only to it.

The config (`demo.json`) names the instance file, the replica, the cache, the visitor model and caps, Turnstile keys (files), `frameAncestors` and `downloadUrl`.
