// Search over the derived chat index, off the server's thread.
//
// Here it runs on its own worker thread (offload.js defineService, one read-only connection per index
// file) and the caller awaits the answer. The index lags the log by one batch, so a search never sees an
// event newer than that; nothing else does.

import { defineService } from './offload.js';
import { ChatIndex } from './chat-index.js';
import { expandIndex, searchIndex } from './store-shared.js';

const open = new Map();

function reader(file) {
  let index = open.get(file);
  if (!index) { index = ChatIndex.openReadOnly(file); open.set(file, index); }
  return index;
}

export const searchService = defineService(import.meta.url, 'chatsearch', {
  search(file, query, options) { return searchIndex(reader(file).db, query, options); },
  expand(file, query, options) { return expandIndex(reader(file).db, query, options); },
  /** The file was replaced (a rebuild, a cutover): forget the connection so the next call opens the new one. */
  forget(file) { const index = open.get(file); if (index) { index.close(); open.delete(file); } return true; }
});
