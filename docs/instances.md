# Instances

An instance is one running tophat: the packages, plus one file, `tophat.instance.json`, that says whose it is, where it keeps its state, which hosts and ports it answers on, which model credentials it may use and which components are enabled. Two instances on one machine are two files; nothing about either is in the code.

## The instance file

```json
{
  "name": "demo",
  "owner": { "label": "Sam", "addresses": ["sam@example.org"] },
  "scope": { "default": "sam", "groups": [] },
  "components": ["linknotes", "runner", "webchat", "deploy"],
  "hosts": { "public": null, "bind": "127.0.0.1" },
  "ports": { "webchat": 4178 },
  "paths": { "state": "~/.local/state/tophat/demo", "config": "~/.config/tophat/demo", "instructions": "./instructions.md" },
  "models": {
    "chat": { "model": "some-model", "baseUrl": "https://api.example.com", "credential": { "keyring": "chat-api-key" } },
    "fast": { "baseUrl": "https://fast.example.com/v1", "credential": { "env": "FAST_MODEL_KEY" } }
  },
  "deploy": { "labelPrefix": "org.example" }
}
```

| key | meaning | default |
|---|---|---|
| `name` | instance id: lower case letters, digits, dashes; names its state directory and service label | required |
| `owner.label` | how the app names the person (or group) it serves | `the owner` |
| `owner.addresses` | mail addresses that count as the owner's own (sent-mail direction) | `[]` |
| `scope.default`, `scope.groups` | the memory scope the instance writes as, and the groups it creates and may share into (made on first open; this replica's user is their admin) | the instance name, `[]` |
| `scope.join` | groups someone else made that the instance joins and never creates; the group key arrives by hub sync once the group's admin has added the user (`tophat instance join`, below) | `[]` |
| `scope.screens`, `scope.peopleFile` | content screens (`[{ pattern, flags?, label?, groups? }]`, default groups: every created and joined group) and a private-people roster file: a row asked into a group is refused when its text matches a screen or names a rostered person. Joined groups also get built-in screens for credentials and home-directory paths | none |
| `components` | enabled component ids (see below) | required |
| `hosts.public` | public host name, when the instance is reachable from outside (share links, passkey origin) | none: `http://localhost:<port>` |
| `hosts.bind` | listen address | `127.0.0.1` |
| `ports.webchat` | webchat port | `4178` |
| `paths.state` | everything the instance writes: the chat store, the runner ledger, the workspace | `~/.local/state/tophat/<name>` |
| `paths.config` | config and the `secrets/` directory | `~/.config/tophat/<name>` |
| `paths.workspace`, `paths.secrets`, `paths.fileRoots` | the working directory of chats, the keyring directory, extra roots the file viewer may open | under state / config |
| `paths.instructions` | the system instructions file the runner reads; the product ships none | none |
| `models.chat` | the chat model: `model`, `baseUrl`, `credential` | the runner's defaults |
| `models.fast` | a cheap OpenAI-compatible model for titles, folders and routing: `baseUrl`, `credential` | off |
| `deploy.labelPrefix` | prefix of the service label | `md.tophat` |
| `scope.user` | the replica's user, when it differs from the write scope (a person writing into one of their groups) | `scope.default` |
| `models.chat.workspace` | workspace id file for a key scoped to an organisation: `{ file }` or `{ keyring }` | none |
| `sources` | source adapters `[{ id, family, account?, config }]`; secret-shaped config keys are credential references; the first `imessage` (`config.database`) and `beeper` (`config.index`) source name the stores the runner's message tools read | `[]` |
| `hub` | hub sync of the runner's replica: `{ url, token?, device?, deviceKey? }`, token and device key as `{ file }` or `{ keyring }`; the token is issued by the hub's operator and may not exist yet: without `token` it is the keyring entry `hub-token`, and a sync before the file exists is refused by name. `tophat instance sync --config FILE` runs one round (`--forever [--every S]` keeps doing it) | none |
| `runner.env` | extra environment for the runner and webchat children, `{ NAME: value }`: feature switches and the places tools and stores live (`TOPHAT_RUNNER_MAIL_ACCOUNTS`, `TOPHAT_RUNNER_WEB_CDP_BIN`, `TOPHAT_REV6_HARNESS`, `TOPHAT_RETRIEVAL_CONFIG`, `TOPHAT_CONTEXT_CLI`, `PATH` ...). A value is a string, number, boolean or an object (written as JSON). A name that reads as a secret (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`) is refused unless it ends in `_FILE`, `_DIR` or `_PATH`; a name the instance file already sets (`runner.env.TOPHAT_RUNNER_MODEL` beside `models.chat.model`) is refused. `TOPHAT_CONTEXT_CLI` names the instance's own retrieval command (`node CLI context --query TEXT`, its stdout is put in front of each turn by the claude hooks and the codex provider); without it a turn carries no retrieved context. Which tools a runner offers follows this environment: a mail, message, search or browser tool exists only when its place is named here or by `sources`; `tophat instance env --config FILE` prints the result | `{}` |
| `intake` | the intake into the runner's replica: `{ everySeconds, model, maxSteps?, batch?, budget? }`; `model` names a `models` entry (`chat` is read as Messages API, any other as OpenAI-compatible, unless the entry has `provider`) or is `{ provider, model?, baseUrl?, credential?, command? }` (providers of `@tophat-md/push`: `anthropic`, `openai`, `command`, `stub`). Every `everySeconds` the upkeep job `intake` polls the enabled `sources`, ingests into the instance's write scope and derives entities and notes with that model, then syncs through `hub` when there is one. `tophat instance intake --config FILE` runs it when due (`--force` now, `--forever [--tick S]` keeps checking); state under `<paths.state>/intake` and `<paths.state>/upkeep`. The pass also claims the chat transcripts the runner ingested (`webchat` records) for its derive: with `scopes.enabled` in the config file only chats that are unscoped, `legacy`, in the instance's write scope or in a registry group with `everyone: true` are claimed (`deploy/src/transcripts.mjs`). `intake.model.workspace` (`{ file }` or `{ keyring }`) adds the `anthropic-workspace-id` header an organisation-scoped Anthropic key needs. `intake.wake` (`true` or `{ maxAgeHours?, batch? }`): after each pass, arrivals from the sources (not chats) that the intake model judges to need someone are posted into the owning chat (or a new one) through the webchat's loopback `/api/inbound` as an automated event; one decision per record, kept in `<paths.state>/intake/wakes.jsonl` (`deploy/src/wake.mjs`) | none |

Relative paths resolve against the directory of the instance file. Unknown keys are refused.

**Credentials are references, never values.** A credential is exactly one of `{ "env": NAME }` (read from the starting process's environment), `{ "keyring": NAME }` (a file of that name in `paths.secrets`) or `{ "file": PATH }`. A literal key, or an `apiKey` field, is refused when the file is read. The chat runner reads its key from a file, so `models.chat.credential` is a `file` or a `keyring` entry; `models.fast.credential` may also be `env`, and its value reaches the webchat process through its environment only. `tophat instance env --config FILE` prints the environment an instance hands its children, which carries paths and names and never a credential value. It includes `TOPHAT_WEBCHAT_URL` (`http://127.0.0.1:<ports.webchat>`), the loopback origin the runner's own chat tools use, so two instances on one machine never reach each other.

## Components

`tophat.components.json` at the workspace root lists every component with its package, what it depends on, whether it is optional and whether it can be removed:

```
tophat components list          every component, its package, dependencies and whether it is installed
tophat components tree webchat  webchat -> runner
tophat components check --config tophat.instance.json
```

`check` fails (exit 1) when an enabled component needs one that is not enabled, when a required component (`linknotes`) is off, or when an id is unknown, and prints the smallest enabled set that would pass. `--present` also requires each enabled component's package to be installed. Removing a removable component's package leaves every component that does not depend on it working; `webchat` needs `runner`, nothing needs `webchat` or `deploy`.

## Running an instance

```
npm install
npm run build -w @tophat-md/webchat
tophat components check --config tophat.instance.json
tophat start --config tophat.instance.json
```

`tophat start` validates the file and the component set, creates the state, config and workspace directories (0700), creates the webchat's session secret, enrolment token and service token once in `paths.secrets` (0600), builds the child environment from the instance file alone (only `PATH`, `HOME`, `TMPDIR`, locale, `USER`, `SHELL` and `NODE_OPTIONS` are passed through), and serves the webchat build in the foreground. The first device enrols with the token in `<paths.secrets>/webchat-bootstrap-token`. `GET /api/health` answers on loopback only; `product` is the instance name. `--build DIR` serves another build.

To keep it running, `tophat instance unit --config FILE` prints a launchd agent (label `<deploy.labelPrefix>.<name>`) with `PATH` (`runner.env.PATH`, else the printing shell's) and `HOME` in its environment, since launchd starts a job with a bare `PATH`; `--kind systemd` prints a systemd user unit. Installing the unit is left to you.

Each conversation runs one runner child (`@tophat-md/runner`) that speaks stream-json on stdin and stdout and calls the model itself. For tests, `packages/runner/rev5/fake-provider.mjs` serves the model wire format locally; point `models.chat.baseUrl` at it and give it any key file.

## Jobs an instance needs

`tophat instance jobs --config FILE [--write DIR]` lists the background jobs the enabled components imply and, with `--write`, writes their launchd units as `DIR/<label>.plist` (never loaded): `webchat` when `webchat` is a component; `intake` (the push plane, `instance intake --forever`) when `push` and `upkeep` are components and the file has an `intake` block; `sync` (`instance sync --forever`, one hub round a minute) when the file has a `hub` block and no `intake` job, because the intake already syncs after each pass and a second process syncing the same replica reseals actions the hub then refuses; `fast-proxy` when `models.fast.workspace` is set. `tophat instance unit --job NAME` prints one. `models.fast` for a workspace-scoped key: `{ baseUrl, model, credential, workspace }` plus `ports.fastProxy`; the webchat's title and folder calls go to `http://127.0.0.1:<fastProxy>/chat/completions`, which adds the workspace header (`tophat instance fast-proxy`).

## A group runner is an instance whose scope is the group

Nothing distinguishes a personal assistant from one that serves a group except its instance file:

```json
{
  "name": "lab",
  "owner": { "label": "the lab" },
  "scope": { "default": "lab", "groups": ["lab"] },
  "components": ["linknotes", "hub", "runner", "webchat", "deploy"],
  "ports": { "webchat": 4280 },
  "paths": { "state": "/srv/tophat/lab", "config": "/etc/tophat/lab", "instructions": "./lab-instructions.md" },
  "models": { "chat": { "model": "some-model", "credential": { "keyring": "lab-chat-key" } } }
}
```

- **Scope.** `scope.default` is the group, so what the instance writes is meant to land in the group's scope and the memory it reads to be what the group can read: a linknotes replica whose user is the group, kept in step with the members' replicas through the ciphertext-only hub (the runner reads the scope from `TOPHAT_SCOPE`, `TOPHAT_SCOPE_GROUPS` and `TOPHAT_SCOPE_JOIN`, which the instance file sets). A member's private notes are never in the group replica unless that member shared them into the group.
- **Owner.** `owner.label` names the group where a personal instance names the person (see the limits below for where it is not substituted yet).
- **Separation.** Its state, secrets, port and service label are its own, so it runs beside personal instances on the same machine, or alone on a server, without sharing a store.
- **Instructions.** The group's rules are its instructions file; the product ships no rules of its own.

## Groups: create, join, add

A group is a memory scope shared through a hub. Three explicit commands, all on the instance file, none run by `tophat setup`:

```
tophat instance group create NAME --config FILE       make a group this instance administers, then one hub round
tophat instance group add NAME USER [--role read|write|admin] --config FILE   admin: add a member, wrap the group key to their devices
tophat instance join [NAME] --config FILE [--hub URL] [--user NAME]          opt in to a group someone else made
```

`group create` adds NAME to `scope.groups`; opening the replica creates the group (this replica's user is its admin) and the sync tells the hub. `group add` syncs first (a member's device reaches the hub when they first sync), adds the member and syncs again; the key is wrapped to the member's devices, and any later admin sync wraps it to devices that appear afterwards.

`join` is opt-in and never automatic. NAME defaults to `tophat-users`, the shared group of tophat users on `https://hub.tophat.md`, which holds ciphertext only. It writes into the instance file `scope.join` (the group is never created by the joiner), a `hub` block with that URL when the file has none, and a unique replica user `scope.user` of the form `th-<8 hex>` (a replica that already exists keeps its user, because its private scope belongs to that user; the command says so), then prints the user, the device and the device public key, and where the hub token goes (`<paths.secrets>/hub-token`). The one manual step is to send those to the group's admin: they issue the hub token and run `group add`. After the token is saved and the instance restarted, `tophat instance sync` brings the group key in. Until then a write into the group is refused with that reason and the instance's own scope is unaffected; `tophat instance env` shows `TOPHAT_SCOPE_JOIN`, and the memory `status` lists the groups still pending. No command mints a hub token or creates `tophat-users`.

**What is shared is judgment, in the prompt, and only notes replicate.** `join` also writes a guidance block into the instance's instructions file (`paths.instructions`, created beside the instance file when the instance names none; the block is between two `tophat:sharing` markers, so you can read, edit or delete it). It tells the model: bugfixes always, as a note (symptom and error text, cause, fix, where it applies); customizations that seem good, relevant and wanted by most users, as a note (what it is, why, how to apply it); things built on tophat that are worth showing, as a note; share with `memory_apply` and `groups: ["tophat-users"]` on the note, never anything about a person, credentials or home paths; one line to the owner saying what was shared. Configuration, instructions, skills and code are not synced; a customization travels as a note that describes it. The mechanism behind the judgment is the content screens: a write into a joined or created group is refused when its text matches a built-in screen (credentials, home-directory paths), `scope.screens`, or a name in the roster `scope.peopleFile` (`TOPHAT_PRIVATE_PEOPLE_FILE`), and the refusal writes nothing.

## Running it in the background

`tophat start` is the foreground process. To run an instance behind you:

```
tophat instance start  --config tophat.instance.json [--build DIR]
tophat instance status --config tophat.instance.json
tophat instance health --config tophat.instance.json
tophat instance stop   --config tophat.instance.json
tophat instance release --config tophat.instance.json [--set DIR]
```

`start` detaches the webchat into its own session, logs to `<paths.state>/logs/webchat.log`, and records the process it
spawned in `<paths.state>/run/webchat.json` so `stop` can signal it; a second `start` while it runs answers
`already_running`, and a port held by anything else answers `port_in_use`. `stop` is SIGTERM then SIGKILL after ten
seconds, and stopping what is not running is not an error. `status` reads the live process, never the record, so it is
right however the instance was started (`instance start`, `tophat start` under a unit, or by hand): the pid listening on
the loopback port, its parent chain (`ancestry`), and its `/api/health` answer, which names its pid and the build it
serves (`build`). `running` is true only when that listener is this instance; anything else on the port is reported as
`port_holder`. `release` is the `build-current` pointer a restart would serve; `health` is `GET /api/health` on the
loopback port (exit 1 when it does not answer). `instance release [--set DIR]` reads or flips that same pointer.
Nothing here installs a service; `tophat instance unit` still prints one.

Releasing a new webchat build to a running instance: `tophat instance ship --config FILE [--keep N]`. It builds into a
fresh `packages/webchat/build.<stamp>`, flips the `build-current` pointer (temp+rename) and SIGHUPs serve.mjs (the pid
in `/api/health`), which reloads the handler in the same process, so runner children are untouched; it keeps the newest
N builds plus the one served before. Never rebuild the directory a running server serves (`vite build` empties it and the
server's lazily imported chunks vanish: every page 500s). `tophat start` without `--build` or `webchat.build` follows
`build-current`; an explicit build is pinned and needs a restart to change.

## Peers

Instances on one hub are peers and a chat can live on any of them: see [peer-chat.md](peer-chat.md).

## Memory and shared work

The runner's memory and task tools are `@tophat-md/linknotes`. `packages/runner/store/memory.mjs` answers every store
request in process and `packages/runner/store/cli.mjs` is the same thing as a child process, so the webchat and the
runner reach one replica at `<paths.state>/runner/memory.sqlite`. `scope.default` is the user that replica writes as
and `scope.groups` are the groups it may share into, both created on first open (`scope.join` groups are never created here: see "Groups: create, join, add"): a group runner (an instance whose
scope is the group) writes into the group. Derived pages are built by linknotes on read; there is no model-driven
consolidation step in the product, so `push` answers `not_supported`.

## Current limits

- Attachment extraction of archives and office documents needs a container worker that is not part of the runner
  package: those files answer `container-extractor-unavailable` instead of text.
- The entity-lookup reader (a separate natural-language service) is off, so memory search is full text only.
- `owner.label` reaches the runner prompts, the inbox rule and the webchat's server-side strings; the browser UI still
  shows its own built-in labels.
- Device location, desktop automation, messaging, mail and shopping tools are stubs or need an instance to name the
  store or endpoint they use (message databases, the bridged-chat API, the browser endpoint); with none named they
  report that they are not configured.
- There is no live deploy: `tophat instance start` runs a build that is already on the machine.
