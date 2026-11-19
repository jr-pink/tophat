// One chat's live events as a server-sent stream: what a peer reads to attach a chat that lives on this host.
//
// A chat has one host, the peer whose runner answers it (hosts.js). The peers' webchats talk to each other over the same
// frames the browser reads on /api/events (sse.js: `{events:[...]}`, `{hello,cursor}`, `{resync,cursor}`, `{ping}`), narrowed
// to one conversation, so a peer sees token deltas, thinking, tool input and run state exactly as a local tab does. Resume is
// by the store's cursor (`after`), so a dropped connection replays what it missed from the log and never repeats an event.
import { eventStream } from './sse.js';

/** The store as eventStream reads it, narrowed to one conversation. */
export function conversationView(store, id) {
  return new Proxy(store, {
    get(target, prop) {
      // Backlog pages come from the conversation's own index, so a page is always full while more exists (a global page filtered afterwards
      // would look short and end the catch-up early).
      if (prop === 'cursor') return () => target.conversationEvents(id, { newest: true, limit: 1 }).at(-1)?.cursor ?? 0;
      if (prop === 'behind') return (after, cap) => target.conversationEvents(id, { after, limit: cap }).length;
      if (prop === 'since') return (after, limit) => target.conversationEvents(id, { after, limit });
      if (prop === 'subscribe') return (listener) => target.subscribe((event) => { if (event.conversation_id === id) listener(event); });
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export function conversationEventStream({ store, id, after = 0, ...options }) {
  return eventStream({ store: conversationView(store, id), after: Math.max(0, Number(after) || 0), ...options });
}

export const SSE_HEADERS = Object.freeze({
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no'
});
