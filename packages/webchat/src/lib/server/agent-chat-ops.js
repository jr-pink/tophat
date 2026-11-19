// What a chat's own agent may do to its chat that the owner does from the chat menu: move it to a host (chat_host) and file it under
// a folder (chat_workspace). Both go through applyAction with the action the browser sends (ACTIONS.HOST, ACTIONS.WORKSPACE), so
// there is one write path: the agent tool and the host selector in the menu differ only in who authenticates (the service token here,
// the owner's session there). The host event itself is written by applyHostAction, which app.js's ACTIONS.HOST case also calls, so the
// two cannot drift (test/agent-chat-host.test.mjs).
import { ACTIONS } from '../core/contract.js';
import { canonicalWorkspace } from '../core/workspaces.js';

/** The conversation.host event the menu's selector writes: the host's device id, null for this host. */
export function applyHostAction({ store, id, payload, at }) {
  store.append(id, 'conversation.host', { host: String(payload?.host || '').trim() || null }, { at });
}

const LOCAL_WORDS = new Set(['', 'local', 'this', 'here', 'this host', 'this machine', 'self', 'none', 'null']);
const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Resolves the name an agent gives (a label such as "teamhost", a device id, or "local") against listHosts(): { host } ('' = this host) or { error }. */
export function resolveHost(hosts, name) {
  const want = norm(name);
  const local = hosts.find((h) => h.local);
  if (LOCAL_WORDS.has(want) || (local && (norm(local.id) === want || norm(local.label) === want))) return { host: '', label: local?.label || 'this host' };
  const found = hosts.find((h) => !h.local && (norm(h.id) === want || norm(h.label) === want));
  if (!found) {
    const names = hosts.map((h) => (h.local ? `local (${h.label})` : h.label === h.id ? h.id : `${h.label} (${h.id})`));
    return { error: `no host "${name}"; hosts this chat can run on: ${names.join(', ')}` };
  }
  if (!found.configured) return { error: `host ${found.label} has no address on this instance, so a chat cannot run there` };
  return { host: found.id, label: found.label };
}

/** chat_host: moves chat `id` to a host exactly as the menu selector does. Idempotent: already there appends nothing. Reads the chat back. */
export function moveChatHost({ store, apply, hosts, id, host }) {
  const r = resolveHost(hosts, host);
  if (r.error) return { status: 400, body: { error: r.error } };
  const before = store.conversation(id)?.host || null;
  const target = r.host || null;
  const changed = before !== target;
  if (changed) apply({ op: ACTIONS.HOST, conversation_id: id, payload: { host: r.host || null } });
  const after = store.conversation(id)?.host || null;
  if (after !== target) return { status: 500, body: { error: `host did not change: the chat is on ${after || 'this host'}, wanted ${target || 'this host'}` } };
  const now = hosts.find((h) => (h.local ? '' : h.id) === (after || ''));
  return { status: 200, body: { ok: true, id, host: after, label: now?.label || after || 'this host', changed } };
}

/**
 * chat_workspace: files chat `id` under a folder. A name that matches an existing folder (case-insensitively) files into that folder
 * under its own spelling; an unknown name is refused, listing the folders, unless `create` is true (the owner asked for a new folder).
 * An empty name takes the chat out of every folder.
 */
export function fileChatWorkspace({ apply, id, workspace, create = false, folders }) {
  const wanted = canonicalWorkspace(workspace);
  if (!wanted) { apply({ op: ACTIONS.WORKSPACE, conversation_id: id, payload: { workspace: null } }); return { status: 200, body: { ok: true, id, workspace: null } }; }
  const existing = folders.find((f) => f.toLowerCase() === wanted.toLowerCase());
  if (!existing && create !== true) {
    return { status: 409, body: { error: `no folder "${wanted}"; nothing was filed. Existing folders: ${folders.join(', ') || '(none)'}. Pass create=true only when the owner explicitly asked for a new folder` } };
  }
  apply({ op: ACTIONS.WORKSPACE, conversation_id: id, payload: { workspace: existing || wanted } });
  return { status: 200, body: { ok: true, id, workspace: existing || wanted, created: !existing } };
}
