// Where a comment on a public document lives, and how to find it again after the line changes.
// A docs comment is anchored to a span of one line (the reader's highlight model, reader-anchor.js):
// the line id, the quoted words, and their character offsets in the line's rendered text. The
// offsets are a hint; the quote is the anchor. When the line is edited the quote is found again in
// the same line, and when the line is gone or no longer holds the words, in any other line. A
// comment whose words are nowhere is detached: listed, never dropped.
import { resolveAnchor } from './reader-anchor.js';

export const QUOTE_MAX = 600;

/** The anchor to send for a selection from `start` to `end` of a line's rendered `text`. */
export function docAnchor(lineId, text, start, end) {
  const body = String(text || '');
  const from = Math.max(0, Math.min(body.length, Math.floor(Number(start) || 0)));
  let to = Math.max(from, Math.min(body.length, Math.floor(Number(end) || 0)));
  // Trim the selection's own edges, as a double-click selects a word and its trailing space.
  let a = from;
  while (a < to && /\s/u.test(body[a])) a += 1;
  while (to > a && /\s/u.test(body[to - 1])) to -= 1;
  const quote = body.slice(a, to).slice(0, QUOTE_MAX);
  if (!lineId || !quote) return null;
  return { lineId: String(lineId), quote, start: a, end: a + quote.length };
}

/**
 * Where a thread's words are now. `rows` is [{ lineId, text }] in document order (the rendered
 * text of each line). Returns { lineId, start, end, how, moved } or null when the words are gone.
 */
export function locateThread(thread, rows = []) {
  const quote = String(thread?.quote || '');
  if (!quote) return null;
  const anchor = { quote, start: Number(thread.start) || 0 };
  const own = rows.find((row) => row.lineId === thread.lineId);
  if (own) {
    const hit = resolveAnchor(own.text, anchor);
    if (hit) return { lineId: own.lineId, start: hit.start, end: hit.end, how: hit.how, moved: false };
  }
  for (const row of rows) {
    if (row === own) continue;
    const at = String(row.text || '').indexOf(quote);
    if (at !== -1) return { lineId: row.lineId, start: at, end: at + quote.length, how: 'elsewhere', moved: true };
  }
  return null;
}

/** Threads that resolve nowhere: the "detached" list. */
export function detachedThreads(threads = [], rows = []) {
  return threads.filter((thread) => !locateThread(thread, rows));
}

/**
 * Google Docs' "insert comment" chord: ⌘⌥M on a Mac, Ctrl+Alt+M elsewhere. Matched on the
 * physical key as well as the character, because ⌥M types "µ" on a Mac and the key's character
 * moves with the layout (on Colemak, for one, M sits on the same physical key as QWERTY's M).
 */
export function isCommentChord(event) {
  if (!event || event.shiftKey || !event.altKey) return false;
  if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)) return false;
  const key = String(event.key || '').toLowerCase();
  return event.code === 'KeyM' || key === 'm' || key === 'µ';
}
