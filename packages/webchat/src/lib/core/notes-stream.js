// The stream of recent notes, and what transcluding one into the notes document writes.
//
// A note is a thread in the reader's store: the root carries the quote and the anchor, its replies
// hang off it, and since a chat transcript is a document there too (`chat:<conversation id>`, see
// reader-store's chatDocId) the same rows hold notes on books and notes on chat messages alike. `GET
// /api/reader/notes?limit=N` hands that mixed list back newest first, which is the stream.
//
// Nothing here fetches, renders or writes. It is the shape of one row and the exact block a
// transclusion appends, so both can be tested without a browser, and so the page is left with the
// parts that genuinely need the DOM.

/** A chat note's conversation, or null when the note is on a book, an article or a PDF. */
export function conversationOf(note) {
  const docId = String(note?.docId || '');
  if (note?.docKind && note.docKind !== 'chat') return null;
  return docId.startsWith('chat:') ? docId.slice(5) || null : null;
}

/** Whitespace is collapsed because a quote is one row of the document, never a paragraph of it. */
export const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Where the note came from, as the row shows it and as the backlink points.
 *
 * A book note opens the reader at its own section; the reader's onMount already reads `doc` and
 * `section`. A chat note opens the conversation and asks the chat page to jump to the message the
 * note hangs on, which is `anchorKey`; `/` reads `chat` on boot and `item` is the jump. Both
 * carry `note=<id>` as well, which nothing routes on: it is the mark that says this block of the
 * document came from that note, and it is what `transcludedIds` reads back out.
 */
export function sourceOf(note) {
  const conversation = conversationOf(note);
  const kind = conversation ? 'chat' : 'book';
  const title = oneLine(note?.docTitle) || (conversation ? 'chat' : 'untitled');
  const id = encodeURIComponent(String(note?.id || ''));
  let href = null;
  if (conversation) {
    const anchor = note?.anchorKey ? `&item=${encodeURIComponent(note.anchorKey)}` : '';
    href = `/?chat=${encodeURIComponent(conversation)}${anchor}&note=${id}`;
  } else if (note?.docId) {
    const section = Number(note?.sectionIdx || 0) || 0;
    href = `/reader?doc=${encodeURIComponent(note.docId)}&section=${section}&note=${id}`;
  }
  return { kind, title, href, conversation };
}

/** The lines a transcluded note becomes. a reply tophat wrote says so, so the two voices stay
 * apart.
 *
 * Nothing is escaped.
 */
export function transclusionLines(note) {
  const lines = [];
  const quote = oneLine(note?.quote);
  if (quote) lines.push(`> ${quote}`);
  for (const line of bodyLines(note?.note)) lines.push(line);
  for (const reply of note?.replies || []) {
    const text = oneLine(reply?.note);
    if (text) lines.push(reply?.author === 'tophat' ? `- tophat: ${text}` : `- ${text}`);
  }
  const source = sourceOf(note);
  lines.push(source.href ? `from ${source.title} ${source.href}` : `from ${source.title}`);
  return lines;
}

/** Two
 *  blank lines are what ends a block in this document, so a note holding them would otherwise
 *  arrive as two blocks and only the first would carry the backlink.
 */
function bodyLines(text) {
  const rows = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((row) => row.trimEnd());
  const out = [];
  for (const row of rows) {
    if (!row.trim() && !out.at(-1)?.trim()) continue;
    out.push(row);
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  while (out.length && !out[0].trim()) out.shift();
  return out;
}

/**
 * The block the notes store is asked to write: a text block in the future area, which is where
 * what he is working on lives. It is an append and never an edit, so no block of his is touched.
 * A chat note also carries `chatId`, the per-block field the notes page already draws its chat
 * chip from, so the transcluded block opens the conversation in place.
 */
export function transclusionBlock(note, { id }) {
  const source = sourceOf(note);
  return {
    id,
    kind: 'text',
    zone: 'future',
    source: 'import',
    body: transclusionLines(note).join('\n'),
    chatId: source.conversation || null
  };
}

/**
 * The backlink a transcluded block ends on, when it has one. The document renders bold, italic and
 * underline and nothing else, so the link it carries is plain text and nothing can be clicked; the
 * page draws a chip from this instead, beside the chat chip it already draws. The `note=` mark has
 * to be there, so a line he happened to start with "from" is never turned into a link.
 */
const BACKLINK = /^from (.+?) (\/\S*[?&]note=\S+)$/;

export function backlinkOf(body) {
  const rows = String(body ?? '').split('\n');
  const match = BACKLINK.exec((rows.at(-1) || '').trim());
  return match ? { label: match[1], href: match[2] } : null;
}

const NOTE_MARK = /[?&]note=([A-Za-z0-9_.:%-]+)/g;

/** Which notes are already in the document, read back off the backlinks the blocks carry, so the
 *  stream can say "added" instead of letting him paste the same note twice without noticing. */
export function transcludedIds(blocks) {
  const seen = new Set();
  for (const block of blocks || []) {
    const body = String(block?.body ?? '');
    for (const match of body.matchAll(NOTE_MARK)) {
      try { seen.add(decodeURIComponent(match[1])); } catch { seen.add(match[1]); }
    }
  }
  return seen;
}

/** Newest first, by the time the note last changed. The endpoint already promises this order;
 *  sorting again is what keeps the rail right if it ever stops promising it. */
export function sortNotes(notes) {
  return [...(notes || [])].sort((a, b) => String(b?.updatedAt || b?.createdAt || '')
    .localeCompare(String(a?.updatedAt || a?.createdAt || '')));
}

/**
 * How long ago, in the stream's own compact words: now, 7m, 3h, 2d, 5w. The chat sidebar reads a
 * list of times the same way, and a stream of thirty rows cannot afford "2h 14m ago" on each of
 * them. An unparseable time gives the empty string rather than a guess.
 */
export function shortAgo(at, nowMs = Date.now()) {
  const then = typeof at === 'number' ? at : Date.parse(at || '');
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((nowMs - then) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : `${Math.round(days / 7)}w`;
}
