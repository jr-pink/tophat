// What each zone of the notes document is and what it can do, in one table, so the page renders every
// zone through ONE path and asks this table, never a zone name, whether a capability applies.
//
// A zone differs from another in four ways only, and each is a column here:
//   label        the era heading over the section
//   archive      its lines can be moved to the Past. The store's archiveTrees moves lines out of the
//                timeline (NOW) and the future (NEXT); a line already in the Past is already there,
//                and the state area is standing text the builder writes, which nothing archives out
//                of. This one flag decides the row menu's "archive" item AND the rule that a root
//                line marked done goes to the Past once the caret leaves it.
//   pageBreak    ⇧↵ draws a page break. A page break clears the screen of the PRESENT, and the
//                present is the end of the timeline (pageBreak() in notes-doc.js always makes the
//                break there), so in any other zone ⇧↵ stays a plain newline.
//   stateData    its blocks carry the builder's state data: ## headings, per-line check reporting,
//                the section comment. These are capabilities of the data, not of a layout, so the
//                same row renders them wherever a block has it.
// Everything else (find, gaps, breaks, elision, retired 2pt closed lines, drag, move, fold, select,
// delete, undo) is the same in every zone and is deliberately not a column.

export const ZONE_CAPS = Object.freeze({
  past: Object.freeze({ label: 'PAST', archive: false, pageBreak: false, stateData: false }),
  timeline: Object.freeze({ label: 'NOW', archive: true, pageBreak: true, stateData: false }),
  future: Object.freeze({ label: 'NEXT', archive: true, pageBreak: false, stateData: false }),
  state: Object.freeze({ label: 'SYSTEM STATE', archive: false, pageBreak: false, stateData: true })
});

export const zoneCaps = (zone) => ZONE_CAPS[zone] || ZONE_CAPS.timeline;
export const canArchive = (zone) => zoneCaps(zone).archive;
export const canPageBreak = (zone) => zoneCaps(zone).pageBreak;
export const carriesState = (zone) => zoneCaps(zone).stateData;

/** The row menu's items for a zone, in order: the same list everywhere, minus what does not apply. */
export function menuItems(zone) {
  return ['move up', 'move down', ...(canArchive(zone) ? ['archive'] : []), 'delete line'];
}
