// memory_apply with groups. The Python store (rev5/cli.py) writes plain rows; the memory cloud's triggers capture them and the next
// heartbeat flush seals them with the writer's default ACL, so a note could not be written straight into the the team group, nor shared
// before a heartbeat. Without groups nothing changes.
import { join } from 'node:path';

const KINDS = ['notes', 'entities', 'work'];
const named = (x) => x !== undefined && x !== null;

/** Whether this memory_apply request asks for groups anywhere. */
export function wantsGroups(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (named(payload.groups)) return true;
  const ch = payload.changes && typeof payload.changes === 'object' ? payload.changes : {};
  return KINDS.some((k) => Array.isArray(ch[k]) && ch[k].some((it) => it && typeof it === 'object' && (named(it.groups) || named(it.acl))));
}

/** The Node CLI call for a grouped apply: [binary, args, request]. `sync: true` asks the CLI for one hub round after the write. */
export function groupedApplyCall(store, payload, env = process.env) {
  const bin = env.TOPHAT_RUNNER_NODE || process.execPath;
  return [bin, [join(store.cwd, 'store', 'cli.mjs'), '--db', store.db, 'apply'], { ...payload }];
}

/** Text for the tool description, one copy for both runners. */
export const GROUPS_DOC = 'groups (optional): who may read the new notes, entities and work items of this batch, e.g. ["personal","team"] to share with a team; default is this machine\'s writer group. An item may carry its own groups. A group with a content screen refuses text that matches it; an existing entity a note names is not widened (the result lists it under entities_narrower_than_note).';

// A chat outside the instance's write scope: its memory_apply must not reach the instance's default group, which the hub syncs to every
// member. rev6/pull/chat-scope.mjs says which chats those are (and names the chat's scope); this rewrites the request so the store files every
// new row under the group named like that scope, and the store's own write check then refuses it when no such group exists or this writer may
// not write to it. An explicit `groups` (batch or item `groups`/`acl`) may only name that group; a change to an existing row (work update,
// entity update or merge, identity) is refused, since the row keeps the ACL it already has, which is not the chat's.
const temp = (id) => typeof id === 'string' && id.startsWith('$');
const list = (v) => (Array.isArray(v) ? v : [v]);

/** { payload } with every group set to [scope], or { error } when the request cannot stay inside the scope. */
export function confineToScope(payload, scope) {
  const only = (v) => list(v).every((g) => g === scope);
  const widen = (v, what) => (v === undefined || v === null || only(v) ? null : `${what} names ${JSON.stringify(v)}: a chat in scope "${scope}" may only write to the group "${scope}"`);
  const out = structuredClone(payload ?? {});
  const bad = widen(out.groups, 'groups');
  if (bad) return { error: bad };
  out.groups = [scope];
  const ch = out.changes && typeof out.changes === 'object' ? out.changes : {};
  for (const kind of KINDS) {
    for (const it of Array.isArray(ch[kind]) ? ch[kind] : []) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
      for (const f of ['groups', 'acl']) { const w = widen(it[f], `${kind} item ${f}`); if (w) return { error: w }; if (named(it[f])) it[f] = [scope]; }
      const existing = (kind === 'work' && typeof it.id === 'string' && !temp(it.id)) || (kind === 'entities' && ((typeof it.id === 'string' && !temp(it.id)) || it.merge_into || it.unmerge));
      if (existing) return { error: `${kind} item ${JSON.stringify(it.id ?? it.merge_into)} is an existing row, which keeps the groups it already has, not "${scope}"; a chat in scope "${scope}" may only add new rows` };
    }
  }
  if (Array.isArray(ch.identities) && ch.identities.length) return { error: `identities change existing entities, which keep their own groups; a chat in scope "${scope}" may only add new rows` };
  return { payload: out };
}

/** The tool error for a refused write from a chat outside the write scope: nothing was written. */
export const scopedWriteError = (scope, writeScope, detail) => ({ ok: false, reason: 'refused', error: `memory_apply refused: this chat is in scope "${scope}"${writeScope ? `, outside this instance's write scope "${writeScope}"` : ''}, so its writes may only be filed under a group named "${scope}"; ${detail}. Nothing was written; the instance's default group is never used for such a chat.` });
