// What a share token shows a stranger. One projection, two surfaces: a reader document and a
// chat, because the two already share a notes model (reader-store's chatDocId) and the owner expects
// the same share control in both.
//
// The notes variant is a different token, resolved here; the clean variant never loads a note at
// all, so a reader of the clean link cannot reach the annotated one by any request it can make.

import { readerStore, chatDocId } from './reader-store.js';
import { shareStore } from './shares.js';
import { remoteImageSources } from '../core/rich-content.js';

const esc = (s) => String(s ?? '')
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

// An exact quote that appears once in the section's html, outside of any tag, can be wrapped where
// it sits. Anything else (a quote that spans markup, or appears twice) stays in the notes list
// only; a wrong mark in the middle of someone's essay is worse than no mark.
function markQuotes(html, notes) {
  let out = String(html || '');
  for (const note of notes) {
    const quote = String(note.quote || '').trim();
    if (quote.length < 12) continue;
    const needle = esc(quote);
    const first = out.indexOf(needle);
    if (first < 0 || out.indexOf(needle, first + 1) >= 0) continue;
    if (out.lastIndexOf('<', first) > out.lastIndexOf('>', first)) continue; // inside a tag
    out = `${out.slice(0, first)}<mark class="shared-mark" id="n${esc(note.id)}">${needle}</mark>${out.slice(first + needle.length)}`;
  }
  return out;
}

function noteShape(note) {
  return {
    id: note.id,
    quote: note.quote || '',
    note: note.note || '',
    color: note.color || 'yellow',
    createdAt: note.createdAt || note.created_at || '',
    sectionIdx: note.sectionIdx ?? note.section_idx ?? 0,
    replies: (note.replies || []).map((reply) => ({
      id: reply.id, note: reply.note || '', author: reply.author || 'owner',
      createdAt: reply.createdAt || reply.created_at || '',
    })),
  };
}

function docView(share, { store = readerStore() } = {}) {
  const doc = store.doc(share.targetId);
  if (!doc) return null;
  const notes = share.withNotes
    ? store.highlights(share.targetId).map(noteShape).filter((n) => n.quote || n.note)
    : [];
  const bySection = new Map();
  for (const note of notes) {
    if (!bySection.has(note.sectionIdx)) bySection.set(note.sectionIdx, []);
    bySection.get(note.sectionIdx).push(note);
  }
  const sections = store.sectionList(share.targetId).map(({ idx, title }) => {
    const row = store.section(share.targetId, idx);
    const mine = bySection.get(idx) || [];
    return { idx, title: title || '', html: share.withNotes ? markQuotes(row?.html || '', mine) : (row?.html || '') };
  });
  return {
    kind: 'doc',
    withNotes: share.withNotes,
    title: doc.title || 'Untitled',
    byline: doc.byline || '',
    site: doc.site || '',
    sourceUrl: doc.canonical_url || doc.url || '',
    words: doc.words || 0,
    sections,
    notes,
  };
}

// A transcript, flattened to what a person reads: his messages and the assistant's answers, in
// order. Tool traffic, thinking and run bookkeeping stay out; a share is for reading, and those
// carry file paths and internals that have no business on a public page. The askable link's agent
// reads exactly this list and nothing else (share-ask.js), so what a visitor can learn by asking is
// what they could have read on the page.
export function flattenChat(store, conversationId) {
  const messages = [];
  for (const event of store.allConversationEvents(conversationId)) {
    if (event.kind !== 'message.user' && event.kind !== 'assistant.message') continue;
    const body = event.content || {};
    const text = String(body.text ?? '').trim();
    if (!text) continue;
    messages.push({
      id: body.itemId || `${event.kind === 'message.user' ? 'u' : 'a'}${event.cursor}`,
      role: event.kind === 'message.user' ? 'owner' : 'assistant',
      text, at: event.at || '',
    });
  }
  return messages;
}

function chatView(share, { store, reader = readerStore() } = {}) {
  const conversation = store.conversation(share.targetId);
  if (!conversation) return null;
  const messages = flattenChat(store, share.targetId);
  const notes = share.withNotes
    ? reader.highlights(chatDocId(share.targetId)).map(noteShape).filter((n) => n.quote || n.note)
    : [];
  return {
    kind: 'chat',
    withNotes: share.withNotes,
    title: conversation.title || 'Chat',
    byline: '',
    site: '',
    sourceUrl: '',
    messages,
    notes,
  };
}

/**
 * Resolve a public token into a page, or null when it is unknown or revoked. `store` is the
 * conversation store (app.store); it is passed in so this module stays testable without booting
 * the app.
 */
export function shareView(token, { store = null, shares = shareStore() } = {}) {
  const share = shares.resolve(token);
  if (!share) return null;
  const view = share.kind === 'doc' ? docView(share)
    : share.kind === 'chat' && store ? chatView(share, { store })
      : null;
  if (!view) return null;
  shares.recordView(token);
  // Only ever notes -> clean, never the other way (shares.plainTwinOf refuses the clean token).
  const twin = share.withNotes ? shares.plainTwinOf(token) : null;
  // `ask` is whether THIS token lets a visitor put questions to the transcript (share-ask.js); the
  // clean and notes tokens never do, whatever the page around them shows.
  return { ...view, ask: share.kind === 'chat' && share.ask, sharedAt: share.createdAt, cleanUrl: twin ? `/s/${twin}` : '' };
}

/**
 * The remote image URLs a chat share may have fetched for its readers: those written on an image line
 * of their own in its stored messages. Empty for an unknown or revoked token and for a document
 * share. Does not count as a view.
 */
export function shareRemoteImages(token, { store = null, shares = shareStore() } = {}) {
  const share = shares.resolve(token);
  if (!share || share.kind !== 'chat' || !store) return new Set();
  const urls = new Set();
  for (const event of store.allConversationEvents(share.targetId)) {
    if (event.kind !== 'message.user' && event.kind !== 'assistant.message') continue;
    for (const url of remoteImageSources(String(event.content?.text ?? ''))) urls.add(url);
  }
  return urls;
}
