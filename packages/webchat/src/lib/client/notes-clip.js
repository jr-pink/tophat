// Whole rows on the clipboard. same for delete... These are the pure parts: which rows a
// selection stands for, what text goes on the clipboard for them, and what a paste of that text
// is.
import { parseListItem } from '$lib/core/notes-doc.js';

/**
 * The rows a selection takes whole, or null when it is partial. `rows` are the drawn rows from the
 * selection's first end to its last (hidden ones between put back), `first` and `last` its two
 * ends as { offset } in each line's words, `lastLength` the length of the last row's words.
 * A selection owns the first row when it starts at or before that row's first character, and the
 * last row when it ends at or after the last character; a selection that only reaches the start
 * of the last row (the newline it carries) leaves that row out, as VS Code's line commands do.
 */
export function wholeRowSpan(rows, first, last, lastLength) {
  if (!rows || !rows.length || first.offset > 0) return null;
  if (rows.length > 1 && last.offset === 0) return rows.slice(0, -1);
  if (last.offset < lastLength || lastLength === 0) return null;
  return rows;
}

/** The clipboard text for whole rows: their raw lines, one per row, ending in a newline. */
export const rowsClipText = (raws) => `${raws.join('\n')}\n`;

/** An empty bullet is stored trimmed as "-"; the editor reads it back as an empty item. */
const asItem = (line) => (/^\s*-$/.test(line) ? `${line} ` : line);

/**
 * The raw lines of a clipboard text that is whole list rows (every line a bullet or a todo, indent
 * and state as written), else null. Plain text, prose lines, and blank lines in between are not
 * rows, so a paste of them is the browser's own. One trailing newline is the row clip's mark; the
 * second element says whether it was there.
 */
export function rowClip(text) {
  if (typeof text !== 'string' || !text) return null;
  const flat = text.replace(/\r\n?/g, '\n');
  const newline = /\n$/.test(flat);
  const lines = (newline ? flat.slice(0, -1) : flat).split('\n');
  if (!lines.length || !lines.every((line) => line.trim() !== '' && parseListItem(`${line} `))) return null;
  return { lines: lines.map(asItem), newline };
}

/**
 * What a paste of `clip` does at a caret whose line has `caret`: { empty: the line has no words,
 * item: the line is a bullet or todo }. 'replace' swaps an empty bullet for the rows; 'above' puts
 * them over the caret's line as a whole-line paste does; null leaves the paste to the browser (a
 * single line without its newline, pasted into a line that has words, is text being typed).
 */
export function rowPastePlan(clip, caret) {
  if (!clip) return null;
  if (caret.empty && caret.item) return 'replace';
  if (clip.lines.length > 1 || clip.newline) return 'above';
  return caret.empty ? 'replace' : null;
}
