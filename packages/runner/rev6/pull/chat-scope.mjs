// Which chats may write into this instance's memory store.
//
// The runner writes a chat's words into the memory store (raw `webchat/<session>/<seq>` rows from the turn drain in pushq.mjs, the
// owner's words ahead of each turn and the chat's work item in pull.mjs). The store files every row under the instance's own
// group, whatever the chat's scope. On an instance that serves one shared scope (the organisation's, whose group syncs to every member) a
// chat in a personal scope would therefore publish its transcript to the whole group. This is the one rule for which chats may
// write: the deployed instance's intake claim of transcript rows reads the same function, so the two cannot drift.
//
// With scopes off (config `scopes.enabled` false or absent: a single-owner install) every chat is admitted and nothing changes.
// With scopes on, a chat is admitted when it is unscoped or `legacy`, is in the instance's own write scope (env TOPHAT_SCOPE), or is
// in a registry group open to everyone (`everyone: true`). A personal scope, a member-limited group and an unknown scope are
// refused for good (`retry: false`). A chat the webchat store cannot be read for, or does not know, is refused for now (`retry:
// true`): the caller keeps its work pending and asks again, since the answer may only be a store that was busy or a row not yet written.
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { configFile } from '../base/paths.mjs';
import { webchatDbPath } from '../retrieval/webchat.mjs';

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** null when a chat may write into this instance's memory, else { why, retry }. `ids` are the names the chat goes by (runner session id, conversation id). */
export function chatScopeVerdict(ids, env = process.env) {
  const cfg = readJson(env.TOPHAT_CONFIG || configFile(env))?.scopes;
  if (!cfg?.enabled) return null;
  const names = [...new Set([].concat(ids).filter(Boolean))];
  const dbFile = webchatDbPath(env);
  if (!names.length) return { why: 'scopes are on and the chat has no id', retry: true };
  if (!dbFile || !existsSync(dbFile)) return { why: 'scopes are on but the webchat store is not readable', retry: true };
  let row;
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 3000');
      const find = db.prepare('SELECT scope FROM conversations WHERE session_id = ? OR id = ?');
      for (const name of names) { row = find.get(name, name); if (row) break; }
    } finally { db.close(); }
  } catch (e) { return { why: `scopes are on but the chat's scope could not be read (${String(e.message).slice(0, 80)})`, retry: true }; }
  if (!row) return { why: 'scopes are on and the chat is not in the webchat store', retry: true };
  const scope = row.scope || '';
  if (!scope || scope === 'legacy' || scope === (env.TOPHAT_SCOPE || null)) return null;
  const entry = readJson(cfg.registryFile || cfg.registryPath || '')?.scopes?.[scope];
  if (entry?.kind === 'group' && entry.everyone === true) return null;
  return { why: `chat scope "${scope}" is not open to everyone`, retry: false, scope };
}

/** The runner's call: the verdict for the chat this runner serves (its session id and TOPHAT_CONVERSATION_ID). */
export const runnerChatVerdict = (sessionId, env = process.env) => chatScopeVerdict([sessionId, env.TOPHAT_CONVERSATION_ID], env);
