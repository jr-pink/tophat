// Where the webchat keeps its store.
//
// app.js, uploads.js, interaction.js and scripts/start.mjs each carried their own
// default for this, and they disagreed: the entry point decided whether a
// conversation landed under .local/state or under .config. The state directory is
// the right home, and a store already sitting in the old config location keeps
// being used, because changing the default silently would open an empty database
// beside his existing conversations.
//
// WHY THIS IS NOT MERGED WITH rev6/base/paths.mjs, which carries the same
// base/legacy/marker body. This module is in the LAUNCHER'S RAW PUBLISHED FILE
// CLOSURE: webchat/scripts/start.mjs imports it directly, and
// webchat/scripts/publish-server-files.mjs publishes and hash-verifies the
// launcher and its local imports as files rather than through the Svelte bundle.
// Today that closure is entirely inside webchat/ and imports nothing but node
// builtins; pointing it at ../../../../src/ would make the deployed launcher
// depend on a file the publish step may not carry, and a launcher that cannot
// import is a webchat that does not come back. (src/lib/server/password-manager.js
// and retry-wakes.js do import out of tree, which is safe: they are route-reachable
// modules that Vite inlines, not published files.) The same note is on the rev6
// side. Merging this pair is a decision about the publish step, not a cleanup.
// src/retrieval/kill-tree.mjs and its webchat twin are the same arrangement.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STORE_MARKER = 'events.sqlite';

export function webchatStoreDir({ env = process.env, home = homedir() } = {}) {
  const base = env.TOPHAT_STATE_DIR ? join(env.TOPHAT_STATE_DIR, 'webchat') : join(home, '.local', 'state', 'tophat', 'webchat');
  const legacy = join(home, '.config', 'tophat', 'webchat');
  if (!existsSync(join(base, STORE_MARKER)) && existsSync(join(legacy, STORE_MARKER))) return legacy;
  return base;
}

export function webchatStorePath(name, options) {
  return join(webchatStoreDir(options), name);
}
