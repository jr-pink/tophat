// Chat search over the replica, in the /api/search body shape. The search itself is the kit's
// (tools/quicklook-kit/lib/engine/search.js: tokens, deadline, coverage); what is chat-specific is which event
// fields are text, that streaming fragments are skipped, and the result row the search palette renders.

import { searchStore } from '../../../../runner/tools/quicklook-kit/lib/engine/search.js';

const TEXT_FIELDS = ['text', 'output', 'title', 'description', 'prompt', 'message'];
export const chatTextOf = (event) => {
  const c = event?.content || {};
  let out = '';
  for (const k of TEXT_FIELDS) if (typeof c[k] === 'string') out += (out ? '\n' : '') + c[k];
  return out;
};

export async function searchReplica(store, headers, query, { mode = 'smart', conversation = null, limit = 60, deadlineMs = 1500 } = {}) {
  const rows = headers || [];
  const byId = new Map(rows.map((h) => [h.id, h]));
  const r = await searchStore(store, query, {
    textOf: chatTextOf, partOf: (e) => e.conversation_id, keyOf: (e) => e.cursor,
    skip: (e) => typeof e.kind === 'string' && e.kind.endsWith('delta'),
    titles: rows.map((h) => ({ id: h.id, title: h.title })), only: conversation, limit, deadlineMs
  });
  const results = r.hits.map((h) => {
    const header = byId.get(h.part) || {};
    return { conversationId: h.part, title: header.title || h.part, score: h.score, cursor: h.best?.key ?? null,
      excerpt: h.best?.excerpt ?? (header.preview || ''), archived: Boolean(header.archived), offline: true };
  });
  return { query, mode, expanded: [], results, offline: true, complete: r.complete, scanned: r.scanned, ms: r.ms };
}
