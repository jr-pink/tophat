// The side of a chat's marks that talks to the reader's note store (core/chat-notes-state.js holds what the panes show).
// Writes go through the reader replica's op log (client/reader-offline.js): on disk before the screen says it happened,
// replayed in order and idempotent on the server, so a highlight or a delete made with the server down survives a
// reload and lands later. Every change is one action on the kit state first, so every pane painting the document
// updates at once, and the replica only reports whether the server has it yet. This file makes no request of its own.
import { liveSubscribe } from './live.js';

export function createChatNotes({ store, replica, flush = async () => {} }) {
  async function load(doc) {
    if (!doc) return;
    try {
      const body = await replica.api(`/api/reader/notes?doc=${encodeURIComponent(doc)}`);
      store.dispatch('notes.load', { doc, rows: body?.highlights || [] });
    } catch { /* offline or refused: the marks last seen stay on screen */ }
  }

  /** A highlight or a note on words in a transcript. Resolves to the stored row. */
  async function save(doc, payload) {
    const body = await replica.writeNote({ ...payload, docId: doc });
    const row = body?.highlight || null;
    if (row) store.dispatch('note.add', { doc, row: { ...row, ...(body.queued ? { pending: true } : {}) } });
    return row;
  }

  /** Delete one mark: gone from every pane now; the server hears it now or when it is back. Safe to call twice. */
  async function remove(doc, id) {
    if (!id) return;
    store.dispatch('note.delete', { doc, id });
    try {
      const body = await replica.deleteNote(id, { docId: doc });
      if (body && !body.queued) store.dispatch('note.settled', { id });
    } catch { /* a refusal leaves the delete held; the next load retires it or the op log retries */ }
  }

  /** Re-read the document when another tab or device changed the store, and push anything this device still owes. */
  function follow(docs) {
    const again = () => { flush().catch(() => {}); for (const doc of docs()) load(doc); };
    const stop = liveSubscribe('reader', again);
    globalThis.addEventListener?.('online', again);
    return () => { stop(); globalThis.removeEventListener?.('online', again); };
  }

  return { load, save, remove, follow };
}
