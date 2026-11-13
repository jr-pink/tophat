// The marks taken on a chat transcript (a colored highlight, or a note) as ONE declaration on the docstore kit core. what
// a pane paints is a projection of this state, and clicking a painted mark, the delete button's first press and its second
// are actions here, never component fields.
//
// notes     per document, the rows last seen (the offline paint: a reload with the server down shows the same marks).
//           A row made here and not yet confirmed carries `pending`, so a server load that has not heard of it yet does
//           not wipe it.
// gone      ids deleted on this device whose delete the server may not have heard (the reader op log, client/reader-
//           offline.js, delivers it). A server load drops these rows, so a mark never comes back before the delete lands;
//           a load that no longer lists the id retires the entry.
// peek      the card open on one mark: which pane opened it, the mark, and where (viewport point). ephemeral.
// armed     the mark whose Delete was pressed once; the second press deletes. ephemeral.
//
// scope 'local', crossTab: another tab on this device adopts a change at once. Every action is absolute and idempotent:
// deleting an id twice, or one that is not there, changes nothing the second time.
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { field, scratch } from '../../../../runner/tools/docstore-kit/lib/schema.js';

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');
const DOC_CAP = 40, ROW_CAP = 400, GONE_CAP = 200;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** The fields a pane paints and lists from; anything else a row carries (replies, timestamps) is the reader's. */
export const cleanRow = (r) => {
  const row = plain(r);
  if (!isId(row.id)) return null;
  return {
    id: row.id, anchorKey: str(row.anchorKey) || null, kind: str(row.kind) || 'highlight', color: str(row.color) || 'yellow',
    quote: str(row.quote).slice(0, 2000), start: Number.isFinite(row.start) ? row.start : null, note: str(row.note).slice(0, 4000),
    author: str(row.author) || null, ...(row.pending ? { pending: true } : {})
  };
};
const cleanRows = (v) => (Array.isArray(v) ? v.map(cleanRow).filter(Boolean).slice(0, ROW_CAP) : []);
const cleanNotes = (v) => Object.fromEntries(Object.entries(plain(v)).filter(([d]) => isId(d)).map(([d, rows]) => [d, cleanRows(rows)]).slice(-DOC_CAP));
const cleanGone = (v) => Object.fromEntries(Object.entries(plain(v)).filter(([id, on]) => isId(id) && on).map(([id]) => [id, true]).slice(-GONE_CAP));
const cleanPeek = (v) => {
  const p = plain(v);
  if (!isId(p.doc) || !isId(p.id) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { pane: str(p.pane), doc: p.doc, id: p.id, x: p.x, y: p.y, below: Boolean(p.below) };
};

const withRows = (s, doc, rows) => ({ ...s, notes: { ...s.notes, [doc]: rows } });

export const chatNotesDecl = declare({
  name: 'chat-notes',
  scope: 'local',
  crossTab: true,
  fields: {
    notes: field({}, cleanNotes),
    gone: field({}, cleanGone),
    peek: scratch(null),
    armed: scratch(null)
  },
  actions: {
    // The server's rows for one document. Rows deleted here come out, rows made here and still unconfirmed stay.
    'notes.load': (s, { doc, rows } = {}) => {
      if (!isId(doc)) return s;
      const incoming = cleanRows(rows);
      const ids = new Set(incoming.map((r) => r.id));
      const gone = Object.fromEntries(Object.entries(s.gone).filter(([id]) => ids.has(id)));
      const kept = incoming.filter((r) => !gone[r.id]);
      const mine = (s.notes[doc] || []).filter((r) => r.pending && !ids.has(r.id) && !s.gone[r.id]);
      const next = withRows({ ...s, gone: Object.keys(gone).length === Object.keys(s.gone).length ? s.gone : gone }, doc, [...kept, ...mine]);
      return JSON.stringify(next) === JSON.stringify(s) ? s : next;
    },
    // A mark made on this device (or the row the server answered with). `pending` until the server has it.
    'note.add': (s, { doc, row } = {}) => {
      const clean = cleanRow(row);
      if (!isId(doc) || !clean) return s;
      const have = s.notes[doc] || [];
      const same = have.find((r) => r.id === clean.id);
      if (same && JSON.stringify(same) === JSON.stringify(clean)) return s;
      const { [clean.id]: _undeleted, ...gone } = s.gone;
      return withRows({ ...s, gone }, doc, [...have.filter((r) => r.id !== clean.id), clean]);
    },
    // Delete: the mark leaves every pane at once and the id is held until the server has heard. A repeat is a no-op.
    'note.delete': (s, { doc, id } = {}) => {
      if (!isId(id)) return s;
      const have = isId(doc) ? s.notes[doc] || [] : [];
      const inDoc = have.some((r) => r.id === id);
      const next = { ...s };
      if (inDoc) next.notes = { ...s.notes, [doc]: have.filter((r) => r.id !== id) };
      if (!s.gone[id]) next.gone = { ...s.gone, [id]: true };
      if (s.peek?.id === id) next.peek = null;
      if (s.armed === id) next.armed = null;
      return next.notes === s.notes && next.gone === s.gone && next.peek === s.peek && next.armed === s.armed ? s : next;
    },
    // The server has the delete: the id no longer needs holding.
    'note.settled': (s, { id } = {}) => {
      if (!s.gone[id]) return s;
      const { [id]: _done, ...gone } = s.gone;
      return { ...s, gone };
    },
    'peek.open': (s, p = {}) => {
      const peek = cleanPeek(p);
      if (!peek) return s;
      return JSON.stringify(peek) === JSON.stringify(s.peek) && s.armed === null ? s : { ...s, peek, armed: null };
    },
    'peek.close': (s) => (s.peek === null && s.armed === null ? s : { ...s, peek: null, armed: null }),
    'delete.arm': (s, { id } = {}) => (isId(id) && s.armed !== id ? { ...s, armed: id } : s),
    'delete.disarm': (s) => (s.armed === null ? s : { ...s, armed: null })
  }
});

/** The marks of one document as the pane shows them. */
export const notesOf = (state, doc) => (doc ? state.notes[doc] || [] : []);

/** What pressing Delete does now: the first press arms it, the second (same mark) deletes. */
export const deletePress = (state, id) => (state.armed === id ? 'delete' : 'arm');

/** The mark under a viewport point and the line rectangle the point is on (the last painted wins, as it is on top). */
export function markHit(painted, x, y, pad = 1) {
  let hit = null;
  for (const { id, range } of painted || []) {
    let rects;
    try { rects = range.getClientRects(); } catch { continue; }
    for (const r of rects) {
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) { hit = { id, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }; break; }
    }
  }
  return hit;
}

export const markAtPoint = (painted, x, y, pad = 1) => markHit(painted, x, y, pad)?.id ?? null;

/**
 * Where the card goes so it never covers the line that was clicked: its bottom edge a gap above that line, or its top edge
 * a gap below it, whichever side has room for a card of `height` inside the pane (`top`..`bottom`); above is preferred.
 * Returns the edge to anchor to and which side it hangs on.
 */
export function cardSide(line, pane, { height = 170, gap = 8 } = {}) {
  const roomAbove = line.top - pane.top - gap >= height;
  const roomBelow = pane.bottom - line.bottom - gap >= height;
  if (roomAbove || !roomBelow) return { below: false, y: line.top - gap };
  return { below: true, y: line.bottom + gap };
}
