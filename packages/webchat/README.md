# @tophat-md/webchat

The chat web app (SvelteKit, adapter-node): conversations over the runner, notes, a reader, share links. Needs `@tophat-md/runner`.

Build: `npm run build -w @tophat-md/webchat` (writes `build/`). Run: `tophat start --config tophat.instance.json`, which sets every path, port, name and credential reference from the instance file and serves `build/` with `serve.mjs`. `GET /api/health` (loopback only) reports the store, the runner and the build.

This package is assembled from an upstream application; do not edit it in place (an assembly manifest kept in the source repository records every file). Watch capture and the bridge to a separate notes product are not part of it (stubs).
