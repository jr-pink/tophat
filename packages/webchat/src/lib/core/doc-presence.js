// Other people's cursors in a public document: ephemeral presence, never stored in the document.
// A tab sends where its caret and selection are (block id, line id, offsets in the line, and the
// same two ends as Automerge cursors on the block's text) over the live channel; every other tab
// resolves the Automerge cursors against its own copy of the block, so a caret stays on the
// character it was on while text shifts around it, and falls back to line id + offset when the
// character has not reached it yet.

/** A hue (0-359) from a name, the same on every device; the avatar and the caret share it. */
export function hueOf(name) {
  return [...String(name || '')].reduce((sum, ch) => (sum * 31 + ch.codePointAt(0)) % 360, 7);
}
export const colorOf = (name, lightness = 50) => `hsl(${hueOf(name)} 70% ${lightness}%)`;

/** After this long without a move the name flag fades; after IDLE_HIDE_MS the caret goes too. */
export const IDLE_FLAG_MS = 2_500;
export const IDLE_HIDE_MS = 120_000;

const ID = /^[A-Za-z0-9_:.-]{1,80}$/u;
const int = (value) => (Number.isInteger(value) && value >= 0 && value < 10_000_000 ? value : null);
const curs = (value) => (value && typeof value === 'object' && typeof value.cursor === 'string' && value.cursor.length <= 200
  ? { cursor: value.cursor, line: typeof value.line === 'string' && ID.test(value.line) ? value.line : null } : null);

/**
 * A cursor as a stranger sent it, reduced to the shape the others are told, or null. Bounded and
 * typed field by field: nothing else a client puts in it is passed on.
 */
export function cleanCursor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const block = typeof raw.block === 'string' && ID.test(raw.block) ? raw.block : null;
  const line = typeof raw.line === 'string' && ID.test(raw.line) ? raw.line : null;
  if (!block || !line) return null;
  const out = { block, line, la: int(raw.la) ?? 0, lh: int(raw.lh) ?? int(raw.la) ?? 0, hl: typeof raw.hl === 'string' && ID.test(raw.hl) ? raw.hl : line };
  const start = curs(raw.cursors?.start);
  const end = curs(raw.cursors?.end);
  if (start && end) out.cursors = { start, end };
  out.backward = raw.backward === true;
  return out;
}

/** Whether two cursors put the caret in the same place (a presence echo that moved nothing). */
export function sameCursor(a, b) {
  if (!a || !b) return a === b;
  return a.block === b.block && a.line === b.line && a.la === b.la && a.lh === b.lh && a.hl === b.hl
    && a.cursors?.start?.cursor === b.cursors?.start?.cursor && a.cursors?.end?.cursor === b.cursors?.end?.cursor;
}
