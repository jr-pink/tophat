// A visitor's own copy of the starting chats: folders (the chats' workspace names), side chats, the empty opener chat.
// They are written the way the webchat writes any chat (conversation.created, message.user, assistant.message,
// run.completed) through the store's script writer, into the visitor's personal scope, so the real app lists, opens,
// searches and continues them like any other. A `message.user` written this way is marked as transcript (`writtenBy:
// script`), so no runner owes it an answer.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { openStoreForScript } from '../../webchat/src/lib/server/store.js';
import { normalizeSettings } from '../../webchat/src/lib/core/contract.js';
import { FIGURES } from './answer.mjs';

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
export function loadTemplates({ file, cacheDir, slots = [], widgetsDir = '' }) {
  // a `<!-- figure:NAME -->` line in a seed message is the same figure the landing answer places (answer.mjs FIGURES): an image-style line the app renders as the live widget
  const fig = (t) => (typeof t === 'string' && widgetsDir ? t.replace(/^<!--\s*figure:([\w-]+)\s*-->[ \t]*$/gm, (_, n) => (FIGURES[n] ? `![${FIGURES[n][1]}](${path.join(widgetsDir, FIGURES[n][0])})` : '')) : t);
  const defs = JSON.parse(readFileSync(file, 'utf8')).chats.map((d) => (d.messages ? { ...d, messages: d.messages.map((m) => ({ ...m, text: fig(m.text) })) } : d));
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

// ---- the seed set: frozen, identical for every visitor ---------------------------------------------------------------
// A guest's copy of the starting chats lives in the guest's own scope (the webchat isolates by scope), but it is a copy of one
// set: the same chats, titles, folders and transcripts for everyone, written once and never changed per visitor.
//   - Every id is stable: `<chat>-<fp>-<guest>` where fp is a hash of the chat's own definition (title, folder, transcript,
//     side chats). The same definition is always the same id, so seeding twice finds what it wrote and changes nothing; an edited
//     definition (a release, or the one live chat's answer changing) is a new id, and the old row is retired, never edited in place.
//   - A retired row moves to SEED_RETIRED_SCOPE, which no guest holds, with the webchat's own "this left your scope" marker; a page
//     that still holds it drops it on its next sync (the sidebar's revoked-chat rule), so an old copy cannot come back from a
//     client cache. Rows that a visitor made (their own chats, forks of a seed chat) never match a seed id and are never touched.
//   - A visitor who types into a seed chat continues in a fork of it (forkSeedChat); the seed row is not written to.
export const SEED_RETIRED_SCOPE = 'seed-retired';
const shortOf = (guest) => guest.slice(0, 10);
const fingerprint = (t) => createHash('sha256').update(JSON.stringify([t.title, t.workspace || null, t.messages || [], (t.sidechats || []).map((s) => [s.quote, s.title, s.messages]), t.read ? 'read' : 'unread'])).digest('hex').slice(0, 8);
export const seedIdOf = (t, guest) => `${t.id}-${fingerprint(t)}-${shortOf(guest)}`;
/** Whether `id` names a seed row (a chat or a side chat) of this guest, at any version of the seed. The opener and a visitor's own ids never match. */
export function isSeedId(id, guest) {
  const m = new RegExp(`^([a-z]+)-(?:[0-9a-f]{8}-)?${shortOf(guest)}(?:-s\\d+)?$`).exec(String(id));
  return Boolean(m) && m[1] !== 'opener';
}

/** Everything the seed would write for this guest: id -> { template, parent } (side chats carry their parent's id). */
export function plannedSeed(templates, guest) {
  const out = new Map();
  for (const t of templates) {
    if (t.opener) continue;
    const id = seedIdOf(t, guest);
    out.set(id, { template: t, parent: null });
    for (const [i] of (t.sidechats || []).entries()) out.set(`${id}-s${i + 1}`, { template: t, parent: id });
  }
  return out;
}

/** The ids of the seed rows this guest's scope holds now, whichever version wrote them. */
export const seedRowsOf = (store, { scope, guest }) => store.conversationIdsInScope(scope).filter((id) => isSeedId(id, guest));

/** Retire one seed row: out of every guest's scope, then the marker that tells a page holding it to drop it. */
export function retire(store, id, at) {
  store.append(id, 'conversation.meta', { scope: SEED_RETIRED_SCOPE, scopeMove: { id: `retire:${id}`, from: 'guest', to: SEED_RETIRED_SCOPE, actor: 'seed' } }, { at });
}

/**
 * Makes the guest's seed rows exactly the current seed: writes what is missing, retires what the seed no longer has (an older
 * version of a chat, a chat that was dropped from the set). Idempotent: a second call, or a call after a restart or release that
 * changed nothing, writes nothing. Times are spread into the past (newest first in file order after the opener) so the sidebar
 * orders the chats the way a used account would. Returns what it did.
 */
export function seedGuest(store, { guest, scope, templates, model, provider = 'direct', cwd = null, now = Date.now() }) {
  const settings = normalizeSettings({ model, provider, autoModel: false });
  const want = plannedSeed(templates, guest);
  const have = new Set(seedRowsOf(store, { scope, guest }));
  const out = { created: 0, retired: 0, kept: 0 };
  for (const id of have) if (!want.has(id)) { retire(store, id, new Date(now).toISOString()); out.retired++; }
  let slot = 0;
  for (const t of templates) {
    if (t.opener) continue;
    const id = seedIdOf(t, guest), n = ++slot;
    if (have.has(id)) { out.kept++; continue; }
    const born = new Date(now - (n * 40 * 60_000 + 3 * 3600_000)).toISOString();
    const stamp = (k) => new Date(Date.parse(born) + k * 1000).toISOString();
    create(store, { id, title: t.title, workspace: t.workspace, scope, settings, cwd, at: born });
    const items = writeMessages(store, id, t.messages || [], stamp, `${id}`);
    // read or unread: a chat the template marks `read` is read through its last message (the webchat's own read mark, the same event the app writes
    // when a chat is opened); any other starts with the unread dot, because its assistant messages are newer than its read pointer.
    if (t.read) store.append(id, 'conversation.meta', { read: true }, { at: stamp((t.messages || []).length + 1) });
    out.created++;
    for (const [i, s] of (t.sidechats || []).entries()) {
      const parent = items.find((m) => m.role === 'assistant' && m.text.includes(s.quote));
      if (!parent) continue;
      const start = parent.text.indexOf(s.quote);
      const sid = `${id}-s${i + 1}`;
      create(store, { id: sid, title: `↳ ${s.title}`, workspace: t.workspace, scope, settings, cwd, at: stamp(60 + i), parentId: id, sidechat: { itemId: parent.itemId, start, end: start + s.quote.length, quote: s.quote } });
      writeMessages(store, sid, s.messages, (k) => stamp(61 + i + k), sid);
    }
  }
  return out;
}

/**
 * A visitor's message to a seed chat: the seed row stays as it is and the visitor gets a chat of their own, a copy of it up to
 * now (same title, folder and transcript), under a new id in their scope. The caller sends the message to the returned id.
 */
export function forkSeedChat(store, { sourceId, forkId, scope, at = new Date().toISOString() }) {
  if (store.conversation(forkId)) return forkId;
  const src = store.conversation(sourceId);
  if (!src) throw new Error('unknown seed chat');
  const created = store.conversationEvents(sourceId).find((e) => e.kind === 'conversation.created')?.content || {};
  create(store, { id: forkId, title: src.title, workspace: created.workspace, scope, settings: src.settings, cwd: src.cwd, at });
  for (const e of store.conversationEvents(sourceId)) {
    if (e.kind.startsWith('conversation.')) continue;
    const content = { ...e.content, ...(e.content.itemId ? { itemId: e.content.itemId.replace(sourceId, forkId) } : {}) };
    store.append(forkId, e.kind, content, { at: e.at });
  }
  return forkId;
}

/** The fork id for a visitor's chat of a seed chat: stable per (guest, source), so a retried message lands in the same fork. */
export const forkIdOf = (sourceId, guest) => `fork-${createHash('sha256').update(`${guest}:${sourceId}`).digest('hex').slice(0, 20)}`;

/** One empty intro chat (the template marked `opener`) under the given id, in the guest's scope. */
export function seedOpener(store, { id, template, scope, model, autoModel = false, provider = 'direct', cwd = null, now = Date.now() }) {
  const settings = normalizeSettings({ model, provider, autoModel });
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
