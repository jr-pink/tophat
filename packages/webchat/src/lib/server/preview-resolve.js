// The decision /api/file makes for one path, as a function: which conversation is asking, what that
// conversation owns, and where the bytes are (this Mac, another machine over ssh, or nowhere). The
// route and scripts/preview-sweep.mjs both call it, so the sweep measures the code that serves.
import { conversationDirs, conversationRemoteDirs, locateAny, namesCredential, ownerNamedPath } from './files.js';
import { locateRemote } from './remote-files.js';
import { refreshIndex } from './path-index.js';

/**
 * kind: 'credential' (the route answers 403), 'local' (found), 'remote' (found over ssh) or
 * 'missing' (the route answers 404).
 */
export async function resolvePreview({ store, conversationId, path, cwd, remote = true }) {
  // The file-name index behind shorthand lookup is rebuilt in the background when it is stale.
  refreshIndex();
  // The folders this conversation has been working in, so a relative path a model wrote from inside
  // a project resolves there.
  const context = await conversationDirs(store, conversationId);
  // A credential store is refused before anything is looked up, and said out loud rather than served
  // as a 404: whoever asked already knows the name, and a silent miss would read as "no such file".
  if (await namesCredential(path, cwd, context)) return { kind: 'credential', context };
  // Outside the openable roots and outside this conversation's working directory, only a path the
  // owner typed into this conversation himself opens. A path that arrives from a model's message, a
  // tool result or a hand-made query string does not.
  const ownerNamed = ownerNamedPath(store, conversationId, path);
  const found = await locateAny(path, cwd, { ownerNamed, context });
  if (found) return { kind: 'local', found, context, ownerNamed };
  if (remote) {
    // Another machine's files: its own home opens (the analogue of `~`), anything else only when the
    // owner typed it. The script enforces the home rule on the far side; credential names are refused
    // on this side whatever it found.
    const bases = await conversationRemoteDirs(store, conversationId);
    const hit = await locateRemote(path, { bases, ownerNamed });
    if (hit) return { kind: 'remote', remote: hit, context, ownerNamed };
  }
  return { kind: 'missing', context, ownerNamed };
}
