// The sink for a document's comment op log: today the docs server (webchat's own authority for a document), through
// the same two-method transport the kit gives a Docstore Stream (`push(stream, entries)`, `pull(stream, cursor)`), so
// the log can be delivered to the docs server and, with a second sink, to Docstore L1 without the reducers knowing.
//
// push: each entry is one request, in log order (a thread's first comment lands before its resolve or its delete). The server
// keeps the first copy of a comment id, a resolve is absolute and a delete is a tombstone (a repeat is the same answer), so a batch that fails half way is simply replayed whole.
// An offline failure (5xx, a Cloudflare page, no answer, a timeout) rejects the push and the entries stay pending; a
// refusal for good (too long, thread gone) is reported through `refuse` and the entry is acknowledged, never retried
// for ever. pull: the docs server has no entry feed (threads are read whole by `refresh`), so there is nothing to pull.
import { fromStreamEntry } from '../../../../runner/tools/docstore-kit/lib/model.js';

export const isOffline = (cause) => Boolean(cause?.offline) || cause?.name === 'TimeoutError' || cause instanceof TypeError;

export function docsCommentSink({ call, me, adopt, refuse }) {
  return {
    async push(_stream, rows) {
      for (const row of rows) {
        const { type, payload } = fromStreamEntry(row);
        try {
          const answer = type === 'thread.delete'
            ? await call('DELETE', { threadId: payload.threadId })
            : type === 'thread.resolve'
            ? await call('PATCH', { threadId: payload.threadId, resolved: payload.resolved }, payload.author)
            : await call('POST', { threadId: payload.threadId, id: payload.id, lineId: payload.lineId, quote: payload.quote, start: payload.start, end: payload.end, body: payload.body }, payload.author || me());
          adopt(answer.threads);
        } catch (cause) {
          if (isOffline(cause)) throw cause;
          if (type === 'thread.delete' && cause.status === 404) continue;   // already gone: the delete is done
          refuse(cause.message, type);
        }
      }
    },
    async pull(_stream, cursor) { return { entries: [], cursor: cursor ?? null, more: false }; }
  };
}
