// Which blocks are open: tool cards, tool runs, hook cards, compaction cards,
// thinking blocks and agent cards, every one of them keyed by the item's own id.
//
// The keys are scoped by chat and kept in localStorage (see client/fold-store.js),
// so a fold he set survives the nav pill, a trip through another chat, and a reload.
// Scoping matters twice: two chats can carry the same item id, and two panes side by
// side each show a different chat, so one global set would let one decide the other.
//
// Nothing stored means nothing open, which is exactly the default this had before.

import { getContext } from 'svelte';
import { readFolds, writeFolds } from '$lib/client/fold-store.js';

// "<chat>\u0000<kind>:<id>". The separator is one no id carries.
let open = $state(new Set());
const loaded = new Set();

const scope = (chat, key) => `${chat ?? ''}\u0000${key}`;
const keys = (kind, ids) => (Array.isArray(ids) ? ids : [ids]).map((id) => `${kind}:${id}`);


/** Read back what he had open in this chat, once per chat per page. Called by the
 * transcript; a chat already read, or none at all, is a no-op. */
export function useChat(chat) {
  if (!chat || loaded.has(chat)) return;
  loaded.add(chat);
  const stored = readFolds(chat);
  if (!stored.length) return;
  const next = new Set(open);
  for (const key of stored) next.add(scope(chat, key));
  open = next;
}


export function isOpen(chat, kind, ids) {
  return keys(kind, ids).some((k) => open.has(scope(chat, k)));
}


export function toggleOpen(chat, kind, ids) {
  const next = new Set(open);
  const ours = keys(kind, ids).map((k) => scope(chat, k));
  if (ours.some((k) => next.has(k))) for (const k of ours) next.delete(k);
  else for (const k of ours) next.add(k);
  open = next;
  if (!chat) return;
  const prefix = scope(chat, '');
  writeFolds(chat, [...next].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
}


/** The same two calls for a block that is nested inside a transcript and does not carry
 * the chat itself. Call it at component setup, like any getContext. The chat is read on
 * every call, so a pane that changes chat is followed. */
export function useFolds() {
  const chatOf = getContext('artifact-conversation') || (() => null);
  return {
    isOpen: (kind, ids) => isOpen(chatOf(), kind, ids),
    toggle: (kind, ids) => toggleOpen(chatOf(), kind, ids)
  };
}
