# @tophat-md/runner

The chat runner: one child process per conversation (`node rev6/pull/pull.mjs --session-id ID --model M --permission-mode P --cwd DIR`) that reads stream-json user messages on stdin and writes stream-json events on stdout, calling the model itself (Messages API wire shape; `TOPHAT_RUNNER_API_BASE`, key from the file `TOPHAT_RUNNER_API_KEY_FILE`). Goals, waits, subagents and tools live here.

Memory and shared work are `@tophat-md/linknotes`: `store/memory.mjs` (hand-written, not assembled) answers every store request, and `store/cli.mjs` is the same thing as a child process (`node store/cli.mjs --db PATH COMMAND < request.json`, and `serve` for the warm reader). The replica is the instance scope: `TOPHAT_SCOPE` is the user it writes as, `TOPHAT_SCOPE_GROUPS` the further groups it may share into, so a group runner writes into the group.

This package is assembled from an upstream application; do not edit it in place (an assembly manifest kept in the source repository records every file), except `store/` and `instance-config.mjs`, which are this repository's own. Everything else is configured by environment variables that `tophat start` sets from `tophat.instance.json` (see docs/instances.md).

For tests, `rev5/fake-provider.mjs` serves the Messages API wire shape locally (`startFakeProvider({ reply })`).

Not included: attachment extraction of archives and office documents needs a container worker that is not part of this package (it answers `container-extractor-unavailable`); device location, desktop automation and other machine-specific tools are stubs.
