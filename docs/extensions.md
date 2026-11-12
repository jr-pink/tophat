# Extensions (v1)

An extension is a directory with `extension.json` and an entry module, named by the instance file:

```json
"extensions": { "dirs": ["./extensions"], "disable": ["some-id"] }
```

`dirs` entries are either one extension or a directory of them. `tophat ext list|check|build --config FILE` lists, gate-checks
(exit 1 on a refusal) or resolves them; `tophat start` resolves them on every start into `<paths.state>/extensions/resolved.json`
(the webchat reads it through `TOPHAT_EXTENSIONS_FILE`) and links the tools they provide into `<paths.state>/extensions/bin`,
first on the children's `PATH`. A refused extension is reported (`/api/health` field `extensions`) and never loaded; the rest load.

```json
{ "id": "hello", "version": "1.0.0", "api": 1, "depends": { "core": "^1" }, "entry": "./index.mjs",
  "provides": { "routes": ["POST /api/hello"], "commands": ["ext.hello.say"], "menus": ["ui.sidebar.chatMenu:ext.hello.say"],
                "jobs": ["tick"], "tools": ["hello-tool"], "rules": ["on-archive"], "health": ["alive"] },
  "capabilities": { "observe": ["core.chat.archive"], "dispatch": ["core.chat.markRead", "core.chat.inbound"] } }
```

The entry's default export is a synchronous `register(x)`:

| call | slot | what it does |
|---|---|---|
| `x.route({ method, path, auth: 'own' \| 'session', handler(event, ctx) })` | http.route | a server route on a path no file route serves; `own` checks its own credential, `session` is behind the owner's sign-in |
| `x.command(id, { title, category?, run(args, ctx) })` | ui.palette.commands | one named action; `>` in the search palette lists them |
| `x.menu('ui.sidebar.chatMenu', { title, command, priority? })` | ui.sidebar.chatMenu | a chat row's right-click item running a command (its own, or a core action it may dispatch) |
| `x.job(name, { everySeconds, run(ctx) })` | job.upkeep | `tophat instance jobs` writes an interval unit running `tophat ext run-job` |
| `x.tool(name, relPath)` | tool.bin | a program on the agent's PATH |
| `x.on(rule, type, fn(action, ctx), { emits })` | reactions | runs after a live core action (never in replay); its dispatches carry an intent id derived from the trigger |
| `x.health(name, probe(ctx))` | health.fields | a probe in `/api/health` |

`ctx.dispatch(type, payload, { id })` is the only way to change state: the manifest's `capabilities.dispatch` is checked at
dispatch (a type outside it throws `CapabilityViolationError`), the entry is stamped `actor: app:<id>` and `caused_by`. Core
surface 1.0.0: `core.chat.inbound {text, wire?, title?, conversationId?}`, `core.chat.archive {id, on}`, `core.chat.markRead {id,
read}`, `core.chat.rename {id, title}`, `core.chat.pin {id, on}`, `core.chat.move {id, folder}`, `core.chat.send {id, text}`,
`core.voice.transcribe {bytes, mime}`; client-only: `core.chat.open`, `core.nav.palette`.

A load is refused for: an unknown manifest key, a registration missing from `provides` or a `provides` entry never registered, a
capability outside the manifest, a missing, out-of-range or cyclic dependency, two registrations of one name, two extensions on one
route, command or tool, a rule that emits what it observes without `reentry: 'guarded'`. Extensions run in-process and are trusted;
the capability check is not a sandbox.
