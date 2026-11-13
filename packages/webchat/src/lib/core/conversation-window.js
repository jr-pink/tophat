// How a transcript page is addressed, in one place.
//
// A client asks for part of a conversation with four query parameters: `after` (a cursor to read
// forward from), `before` (a cursor to read backward from), `limit` and `newest`. The rule that
// turns them into a window is small and entirely mechanical, and it was written twice, byte for
// byte, in two routes that must not disagree: /api/conversation/<id> and
// /api/incognito/conversation/<id>. Each carried its own `20000`, its own `bounded()` and its own
// "a `before` implies newest-first" line, so the durable transcript and the incognito transcript
// were one rule with two implementations, and a change to the ceiling would have reached only the
// route somebody remembered.
//
// The ceiling is here rather than in either route for the reason the standing rule gives: a limit
// lives in one place and code reads it.
//
// Pure: a URL in, a plain window out, so webchat/src/lib/core/conversation-window.test.js can drive
// it without a server.

export const MAX_TRANSCRIPT_LIMIT = 20000;

/** A requested page size, bounded. Nothing, zero, a negative and a non-number all mean the default. */
export function boundedLimit(raw, fallback = MAX_TRANSCRIPT_LIMIT) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), MAX_TRANSCRIPT_LIMIT);
}

/**
 * The window `store.conversationEvents` takes: { after, before, limit, newest }.
 *
 * `before` is absent rather than zero when it was not asked for, because zero is a real cursor and
 * means "from the beginning"; asking for anything before a cursor is asking for the newest events
 * under it, so a `before` sets `newest` whether or not the client also said so.
 */
export function conversationWindow(url) {
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam == null ? null : Math.max(0, Number(beforeParam) || 0);
  return {
    after: Math.max(0, Number(url.searchParams.get('after') || 0)),
    before,
    limit: boundedLimit(url.searchParams.get('limit')),
    newest: url.searchParams.get('newest') === '1' || before != null
  };
}
