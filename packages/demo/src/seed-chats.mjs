// A visitor's own copy of the starting chats: folders (the chats' workspace names), side chats, the empty opener chat.
// They are written the way the webchat writes any chat (conversation.created, message.user, assistant.message,
// run.completed) through the store's script writer, into the visitor's personal scope, so the real app lists, opens,
// searches and continues them like any other. A `message.user` written this way is marked as transcript (`writtenBy:
// script`), so no runner owes it an answer.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { openStoreForScript } from '../../webchat/src/lib/server/store.js';
import { normalizeSettings } from '../../webchat/src/lib/core/contract.js';

export const OPENER_ID = (guest) => `opener-${guest.slice(0, 10)}`;
/** The nth intro chat of a guest: the first is OPENER_ID, a replayed intro is `<OPENER_ID>-<n>` (the chat it replaces is archived). */
export const OPENER_GEN_ID = (guest, n) => (n ? `${OPENER_ID(guest)}-${n}` : OPENER_ID(guest));
export function openerGenOf(guest, id) {
  const base = OPENER_ID(guest);
  if (id === base) return 0;
  const m = id.startsWith(base) ? /^-(\d+)$/.exec(id.slice(base.length)) : null;
  return m ? Number(m[1]) : null;
}

/** The chat definitions: seed/chats.json, with each `slot` chat's transcript taken from the cached real turn (skipped when none is cached yet). */
export function loadTemplates({ file, cacheDir, slots = [] }) {
  const defs = JSON.parse(readFileSync(file, 'utf8')).chats;
  const out = [];
  for (const d of defs) {
    if (!d.slot) { out.push(d); continue; }
    const f = path.join(cacheDir || '', `${d.slot}.json`);
    if (!cacheDir || !existsSync(f)) continue;
    let cached; try { cached = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    const title = d.title || slots.find((s) => s.id === d.slot)?.title || cached.title || d.slot;
    out.push({ ...d, title, messages: [{ role: 'user', text: d.prompt || cached.prompt }, { role: 'assistant', text: cached.answer }] });
  }
  return out;
}

export function openStore(dbPath) { return openStoreForScript(dbPath); }

/**
 * Writes every template into the store under the guest's scope. Times are spread into the past (newest first in file
 * order after the opener) so the sidebar orders them the way a used account would.
 */
export function seedGuest(store, { guest, scope, templates, model, provider = 'direct', cwd = null, now = Date.now() }) {
  const settings = normalizeSettings({ model, provider, autoModel: false });
  const short = guest.slice(0, 10);
  let slot = 0;
  for (const t of templates) {
    const id = t.opener ? OPENER_ID(guest) : `${t.id}-${short}`;
    // opener: now; others: 40 minutes apart going back, so recency order is the file order
    const born = new Date(now - (t.opener ? 0 : (++slot) * 40 * 60_000 + 3 * 3600_000)).toISOString();
    const stamp = (n) => new Date(Date.parse(born) + n * 1000).toISOString();
    create(store, { id, title: t.title, workspace: t.workspace, scope, settings, cwd, at: born });
    const items = writeMessages(store, id, t.messages || [], stamp, `${id}`);
    for (const [i, s] of (t.sidechats || []).entries()) {
      const parent = items.find((m) => m.role === 'assistant' && m.text.includes(s.quote));
      if (!parent) continue;
      const start = parent.text.indexOf(s.quote);
      const sid = `${id}-s${i + 1}`;
      create(store, { id: sid, title: `↳ ${s.title}`, workspace: t.workspace, scope, settings, cwd, at: stamp(60 + i), parentId: id, sidechat: { itemId: parent.itemId, start, end: start + s.quote.length, quote: s.quote } });
      writeMessages(store, sid, s.messages, (n) => stamp(61 + i + n), sid);
    }
  }
}

/** One empty intro chat (the template marked `opener`) under the given id, in the guest's scope. */
export function seedOpener(store, { id, template, scope, model, provider = 'direct', cwd = null, now = Date.now() }) {
  const settings = normalizeSettings({ model, provider, autoModel: false });
  create(store, { id, title: template.title, workspace: template.workspace, scope, settings, cwd, at: new Date(now).toISOString() });
}

function create(store, { id, title, workspace, scope, settings, cwd, at, parentId = null, sidechat = null }) {
  store.ensureConversation(id, { at, cwd, settings, title, scope, parentId, sidechat });
  store.append(id, 'conversation.created', { title, settings, cwd, ...(parentId ? { parentId } : {}), ...(sidechat ? { sidechat } : {}), scope, ...(workspace ? { workspace } : {}) }, { at });
}

function writeMessages(store, id, messages, stamp, prefix) {
  const items = [];
  let n = 0;
  for (const m of messages) {
    const itemId = `${prefix}-m${++n}`;
    if (m.role === 'user') store.append(id, 'message.user', { itemId, text: m.text, writtenBy: 'script' }, { at: stamp(n) });
    else { store.append(id, 'assistant.message', { itemId, text: m.text }, { at: stamp(n) }); store.append(id, 'run.completed', { costUsd: 0 }, { at: stamp(n) }); }
    items.push({ ...m, itemId });
  }
  return items;
}
