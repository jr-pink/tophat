// The notes document: one continuous chronological flow of blocks, oldest first, the live block
// last. Everything here is pure, so the keyboard behaviour is decided in functions a unit test can
// drive and the page only moves the caret and the scroller.
//
// Two kinds of block:
//   break  a page break; it divides the flow and it is what ⌘↵ leaves behind
//
// Order is a float, not a counter. Appending is maxOrd + 1; splitting a block in the middle of
// history is the midpoint of its neighbours, so an insert never renumbers the document.
//
// The list behaviour is the reference app's, which is the app this replaces, taken from its CustomListItem:
// markdown is the storage ("  " per indent level, "- ", "- [ ] ", "- [x] ", "- [-] "), Tab indents
// no deeper than one below the item above, and the marker cycles todo -> done -> dropped ->
// bullet -> todo. the reference app puts that cycle on Mod-Enter; here ⌘↵ is the page break, so the cycle is ⌘.
// and a click on the marker.

import { outline } from '../client/notes-fold.js';

export const ORD_STEP = 1;

export function newBlockId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `b_${Date.now().toString(36)}${rand}`;
}

export const isBreak = (block) => block?.kind === 'break';
export const isText = (block) => !block || block.kind !== 'break';

// The document has three zones. The timeline is what has happened, oldest first, and it ends in
// the empty note he types into. The future area sits under it: its first block is the today block,
// his standing scratchpad, and anything after that is further out. The state area sits under both:
// the system state, written by the builder and by hand, blocks like any other, so
// hand editing, the marker ring, the gutter tick and the soft delete work in it with no new
// machinery. Archiving a future block moves it into the timeline with the time it was archived;
// nothing archives out of the state area, because it is standing text and not a day's flow.
const ZONES = new Set(['past', 'timeline', 'future', 'state']);
export const zoneOf = (block) => (ZONES.has(block?.zone) ? block.zone : 'timeline');
const ZONE_RANK = { past: -1, timeline: 0, future: 1, state: 2 };

/** Blocks as the page shows them: live only, the timeline first, each zone in its own order. */
export function ordered(blocks) {
  return [...blocks]
    .filter((block) => !block.deletedAt)
    .sort((a, b) => ZONE_RANK[zoneOf(a)] - ZONE_RANK[zoneOf(b)] || a.ord - b.ord || (a.id < b.id ? -1 : 1));
}

/** One zone's blocks, in order. */
export function inZone(blocks, zone) {
  return ordered(blocks).filter((block) => zoneOf(block) === zone);
}

/** The today block: the first block of the future area, his standing scratchpad. */
export function todayBlock(blocks) {
  return inZone(blocks, 'future')[0] || null;
}

/** The state area's blocks, in order: the system state sections, under the future area. */
export function stateBlocks(blocks) {
  return inZone(blocks, 'state');
}

/**
 * The sections of the state area, in the order they stand on the page. Revision 1 of the design
 * folded big rocks, inflight, todo and changes into one: they are kinds of line inside a thread
 * now, not headings of their own, because what he wanted to read was one account of what is going
 * on and not four lists to cross-reference.
 */
export const STATE_SECTIONS = ["what's going on", 'context'];

/**
 * Which section a block is: the text of its "## x" heading line, which is its first line. A
 * section is found by its heading and never by its position, so a rewrite that lands the blocks in
 * another order still writes into the section it meant.
 */
export function sectionOf(block) {
  const first = String(block?.body ?? '').split('\n')[0] || '';
  const match = /^##\s+(.+?)\s*$/u.exec(first);
  return match ? match[1] : null;
}

// The builder scores every line it writes and parks the score in a trailing HTML comment: the page
// reads it for the fold rule and the eye never sees it. It is the only machine-readable thing
// allowed inside the text, and it is stripped from anything shown to a person or sent to a model.
const WEIGHT_RE = /\s*<!--\s*w:\s*(-?\d*\.?\d+)\s*-->\s*$/u;

/** The importance the builder gave a line, or null when nobody scored it. */
export function weightOf(body) {
  const found = WEIGHT_RE.exec(String(body ?? ''));
  return found ? Number(found[1]) : null;
}

/** The line as a person reads it: the score comes off before anything is shown or quoted. */
export const stripWeight = (body) => String(body ?? '').replace(WEIGHT_RE, '');

/**
 * The thread a line belongs to: the nearest line above it at the top level. The state area is
 * threads with their details indented under them, so anything that reports one detail has to name
 * the thing it was under, or whoever reads the report cannot tell what was checked off. A line
 * that is itself a thread is under nothing, and a section heading is not a thread.
 */
export function threadOf(bodies, index) {
  const lines = (Array.isArray(bodies) ? bodies : []).map((body) => String(body ?? ''));
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= lines.length) return null;
  if (lineIndent(lines[at]) === 0) return null;
  for (let above = at - 1; above >= 0; above -= 1) {
    const body = lines[above];
    if (body.trim() === '' || lineFields(body).kind === 'heading') continue;
    if (lineIndent(body) === 0) return stripWeight(body);
  }
  return null;
}

/** The line that divides a section's generated lines from the owner's. */
export const STATE_SEPARATOR = '- ---';

/** Nothing of his is ever dropped; that is the ownership rule seen from the writing end, and the
 * store's per-line source is the same rule seen from the row.
 */
export function composeSection(lines, generated = [], { append = false } = {}) {
  const rows = Array.isArray(lines) ? lines : [];
  const heading = rows.length > 0 ? [rows[0].body] : [];
  const rest = rows.slice(1).filter((line) => line.body !== STATE_SEPARATOR);
  const owned = (line) => (line.source || 'type') === 'system';
  const his = rest.filter((line) => !owned(line)).map((line) => line.body);
  const mine = append
    ? [...rest.filter(owned).map((line) => line.body), ...generated]
    : [...generated];
  return [...heading, ...mine, ...(his.length > 0 ? [STATE_SEPARATOR, ...his] : [])].join('\n');
}

/** The order value for a block appended to the end of a zone. */
export function appendOrd(blocks, zone = 'timeline') {
  const live = inZone(blocks, zone);
  return live.length === 0 ? ORD_STEP : live[live.length - 1].ord + ORD_STEP;
}

/**
 * Archiving: the block leaves the future area for the end of the timeline, stamped with the time
 * it was archived, which is what makes the future area a place things leave rather than pile up.
 */
export function archive(blocks, id, at = new Date().toISOString()) {
  const block = ordered(blocks).find((entry) => entry.id === id);
  if (!block || zoneOf(block) !== 'future') return null;
  // It lands before the empty note he is typing in, so archiving does not interrupt the caret.
  const timeline = inZone(blocks, 'timeline');
  const tailEmpty = timeline[timeline.length - 1];
  const landing = tailEmpty && isText(tailEmpty) && tailEmpty.body.trim() === ''
    ? ordBetween(timeline[timeline.length - 2] || null, tailEmpty)
    : appendOrd(blocks, 'timeline');
  return { id, zone: 'timeline', ord: landing, createdAt: at };
}

/** Move a block one place up or down within its own zone; nothing crosses a zone by moving. */
export function moveBlock(blocks, id, direction) {
  const zone = zoneOf(ordered(blocks).find((entry) => entry.id === id));
  const siblings = inZone(blocks, zone);
  const index = siblings.findIndex((entry) => entry.id === id);
  if (index < 0) return null;
  const target = index + (direction < 0 ? -1 : 1);
  if (target < 0 || target >= siblings.length) return null;
  const ord = direction < 0
    ? ordBetween(siblings[target - 1] || null, siblings[target])
    : ordBetween(siblings[target], siblings[target + 1] || null);
  return { id, ord };
}

/** The order value for a block that lands between two neighbours, either of which may be absent. */
export function ordBetween(before, after) {
  if (!before && !after) return ORD_STEP;
  if (!before) return after.ord - ORD_STEP;
  if (!after) return before.ord + ORD_STEP;
  return (before.ord + after.ord) / 2;
}

/**
 * A block and the blocks either side of it, within its own zone. Zone-scoped on purpose: the last
 * note of the timeline and the today block sit next to each other on screen, and an insert or a
 * merge that crossed between them would put a line in the wrong half of the document.
 */
export function neighbours(blocks, id) {
  const self = ordered(blocks).find((block) => block.id === id);
  const live = self ? inZone(blocks, zoneOf(self)) : [];
  const index = live.findIndex((block) => block.id === id);
  if (index < 0) return { index: -1, before: null, block: null, after: null };
  return { index, before: live[index - 1] || null, block: live[index], after: live[index + 1] || null };
}

// --- the caret ----------------------------------------------------------------------------------

/** Text before and after the caret, which is what ↵ splits a paragraph into. */
export function splitAt(body, caret) {
  const at = Math.max(0, Math.min(caret ?? 0, body.length));
  return [body.slice(0, at), body.slice(at)];
}

/** Is the caret on the first logical line of the body? Only then does ↑ leave the block. */
export function onFirstLine(body, caret) {
  return !body.slice(0, Math.max(0, caret)).includes('\n');
}

/** Is the caret on the last logical line? Only then does ↓ leave the block. */
export function onLastLine(body, caret) {
  return !body.slice(Math.max(0, caret)).includes('\n');
}

/** The caret's column within its logical line, so vertical motion keeps its place. */
export function column(body, caret) {
  const before = body.slice(0, Math.max(0, Math.min(caret ?? 0, body.length)));
  const start = before.lastIndexOf('\n');
  return before.length - (start + 1);
}

/** Where a caret arriving from above (edge "top") or below (edge "bottom") lands, at that column. */
export function caretForColumn(body, wanted, edge = 'bottom') {
  const lines = body.split('\n');
  const line = edge === 'top' ? lines[0] : lines[lines.length - 1];
  const within = Math.min(wanted, line.length);
  if (edge === 'top') return within;
  return body.length - line.length + within;
}

/** Which logical line the caret is on, and where that line starts in the body. */
export function lineAt(body, caret) {
  const at = Math.max(0, Math.min(caret ?? 0, body.length));
  const before = body.slice(0, at);
  const index = before.split('\n').length - 1;
  const start = before.lastIndexOf('\n') + 1;
  return { index, start, offset: at - start };
}

// --- lists, exactly as the reference app writes them ----------------------------------------------------------

// the reference app requires the space after the dash for a bullet ("- ", not "-"), and accepts every spacing
// variant of a checkbox ("-[]", "- []", "- [ ] ").
export const LIST_RE = /^(\s*)-(?:[ \t]*(\[([ xX-]?)\])[ \t]*|[ \t]+)/;
export const INDENT = '  ';

// The fifth marker, his: a todo parked on a condition, "- [await: CONDITION] text". Everything but
// a closing bracket is allowed inside, which is what keeps commas and colons in the condition.
export const AWAIT_RE = /^(\s*)-[ \t]*\[await:([^\]]*)\][ \t]*/u;

/**
 * Read one line as a list item. the reference app's parseMarkdownListItem: two spaces to an indent level,
 * "x" done, "-" dropped, anything else todo, no brackets a plain bullet. An await line is read
 * first, because the reference app's grammar would otherwise take "- [await: x] y" for a bullet whose text
 * happens to start with a bracket. Only an await item carries `awaitCondition`, so the shape of
 * every other item is untouched.
 */
export function parseListItem(line) {
  const waiting = AWAIT_RE.exec(line);
  if (waiting) {
    return {
      listType: 'checkbox',
      indent: Math.floor(waiting[1].length / 2),
      checkboxState: 'await',
      awaitCondition: waiting[2].trim(),
      content: line.slice(waiting[0].length),
      prefix: waiting[0].length
    };
  }
  const match = LIST_RE.exec(line);
  if (!match) return null;
  const indent = Math.floor(match[1].length / 2);
  const content = line.slice(match[0].length);
  if (!match[2]) return { listType: 'bullet', indent, checkboxState: null, content, prefix: match[0].length };
  const char = match[3];
  const checkboxState = char === 'x' || char === 'X' ? 'done' : char === '-' ? 'dropped' : 'todo';
  return { listType: 'checkbox', indent, checkboxState, content, prefix: match[0].length };
}

/**
 * Write a list item back out; the reference app's serializeCustomListItem. An await box is written with exactly
 * one space after the colon and the condition trimmed, which is the canonical form `parseListItem`
 * reads back byte for byte, an empty condition ("- [await: ] text") included.
 */
export function serializeListItem({ listType, indent = 0, checkboxState = 'todo', content = '', awaitCondition = '' }) {
  const pad = INDENT.repeat(Math.max(0, indent));
  if (listType === 'bullet') return `${pad}- ${content}`;
  if (checkboxState === 'await') return `${pad}- [await: ${String(awaitCondition ?? '').trim()}] ${content}`;
  const box = checkboxState === 'done' ? '[x]' : checkboxState === 'dropped' ? '[-]' : '[ ]';
  return `${pad}- ${box} ${content}`;
}

/** The marker states, in the order the toggle walks them. Await sits straight after done, so the
 * chord he already uses to say "finished" carries one more press to say "not yet, and here is what
 * I am waiting on", before the press that drops the item.
 */
export const CYCLE = ['todo', 'done', 'await', 'dropped', 'bullet'];

/** The state after this one in the ring; a bullet re-enters at todo. */
export function nextListState(state) {
  const at = CYCLE.indexOf(state === null || state === undefined ? 'bullet' : state);
  return CYCLE[(at < 0 ? CYCLE.length - 1 : at + 1) % CYCLE.length];
}

/**
 * the reference app's toggleCheckbox, one state longer: todo -> done -> await -> dropped -> bullet, and a bullet
 * becomes a todo. Cycling into await keeps the line's words and leaves the condition empty, which
 * is the textbox the page then drops the caret into.
 */
export function cycleListItem(line) {
  const item = parseListItem(line);
  if (!item) return serializeListItem({ listType: 'checkbox', indent: 0, checkboxState: 'todo', content: line.trimStart() });
  const state = nextListState(item.listType === 'bullet' ? 'bullet' : item.checkboxState);
  if (state === 'bullet') return serializeListItem({ ...item, listType: 'bullet', checkboxState: null });
  return serializeListItem({ ...item, listType: 'checkbox', checkboxState: state, awaitCondition: state === 'await' ? item.awaitCondition || '' : '' });
}

/** Set one state outright, which is what a click on a rail checkbox asks for. */
export function setListState(line, state, awaitCondition = null) {
  const item = parseListItem(line);
  if (!item) return line;
  if (state === 'bullet') return serializeListItem({ ...item, listType: 'bullet', checkboxState: null });
  if (state === 'await') {
    const condition = awaitCondition === null ? item.awaitCondition || '' : awaitCondition;
    return serializeListItem({ ...item, listType: 'checkbox', checkboxState: 'await', awaitCondition: condition });
  }
  return serializeListItem({ ...item, listType: 'checkbox', checkboxState: state });
}

/**
 * How deep Tab may go on this line: the reference app allows one level below the list item above it, and no
 * indent at all when nothing above is a list.
 */
export function maxIndentFor(lines, index) {
  for (let above = index - 1; above >= 0; above -= 1) {
    const item = parseListItem(lines[above]);
    if (item) return item.indent + 1;
    if (lines[above].trim() !== '') return 0;
  }
  return 0;
}

/**
 * Tab and ⇧Tab on the caret's line. Only a list item indents; on anything else Tab is not ours,
 * so the caller lets the key through. Returns the new body and how far the caret moved.
 */
export function indentLine(body, caret, direction, { above = [] } = {}) {
  const lines = body.split('\n');
  const { index } = lineAt(body, caret);
  const item = parseListItem(lines[index]);
  if (!item) return null;
  const wanted = item.indent + direction;
  // The ceiling is read from the document, not from the block: a block boundary is a derived
  // thing the eye cannot see, so the item above a block's first line still decides how deep Tab
  // may go. `above` is the lines standing above this body in the document; with none it is the
  // body alone, which is what a caller that has no document context passes.
  const ceiling = maxIndentFor([...above, ...lines], above.length + index);
  // Tab never OUTDENTS.
  const limit = Math.max(ceiling, direction > 0 ? item.indent : 0);
  const indent = Math.max(0, Math.min(wanted, Math.max(limit, 0)));
  if (indent === item.indent) return null;
  const rewritten = serializeListItem({ ...item, indent });
  const delta = rewritten.length - lines[index].length;
  lines[index] = rewritten;
  return { body: lines.join('\n'), delta };
}

/**
 * Tab and ⇧Tab over a run of selected lines, lines `from`..`to` of this body inclusive. The run
 * moves as one, the way an outliner or VS Code indents a selection: Tab is allowed only if the
 * first list item in the run may go one deeper (its ceiling read from the document above), and
 * then every list item in the run goes one deeper together, so the run's own shape is kept.
 * ⇧Tab brings every list item in the run out one level, each stopping at zero. Lines that are not
 * list items stay where they are. Null when nothing would move.
 */
export function indentRange(body, from, to, direction, { above = [] } = {}) {
  const lines = body.split('\n');
  const first = Math.max(0, Math.min(from, to)), last = Math.min(lines.length - 1, Math.max(from, to));
  const items = [];
  for (let index = first; index <= last; index += 1) {
    const item = parseListItem(lines[index]);
    if (item) items.push({ index, item });
  }
  if (!items.length) return null;
  if (direction > 0) {
    const lead = items[0];
    const ceiling = maxIndentFor([...above, ...lines], above.length + lead.index);
    if (lead.item.indent + 1 > ceiling) return null;
  }
  let changed = false;
  for (const { index, item } of items) {
    const indent = Math.max(0, item.indent + direction);
    if (indent === item.indent) continue;
    lines[index] = serializeListItem({ ...item, indent });
    changed = true;
  }
  return changed ? { body: lines.join('\n') } : null;
}

/**
 * ↵ on a list line. the reference app: an empty item outdents a level, and at the top level it stops being a
 * list item; a full one starts a fresh item of the same kind, always todo.
 */
export function enterOnList(body, caret) {
  const lines = body.split('\n');
  const { index, start, offset } = lineAt(body, caret);
  const item = parseListItem(lines[index]);
  if (!item) return null;

  if (item.content.trim() === '') {
    if (item.indent > 0) {
      const rewritten = serializeListItem({ ...item, indent: item.indent - 1 });
      const delta = rewritten.length - lines[index].length;
      lines[index] = rewritten;
      return { body: lines.join('\n'), caret: Math.max(start, caret + delta), sameBlock: true };
    }
    lines[index] = '';
    return { body: lines.join('\n'), caret: start, sameBlock: true };
  }

  // The caret splits the item: what is to its right starts the new one.
  const within = Math.max(0, offset - item.prefix);
  const head = item.content.slice(0, within);
  const tail = item.content.slice(within);
  lines[index] = serializeListItem({ ...item, content: head });
  const fresh = serializeListItem({
    listType: item.listType,
    indent: item.indent,
    checkboxState: item.listType === 'checkbox' ? 'todo' : null,
    content: tail
  });
  return { prefix: lines.slice(0, index + 1).join('\n'), line: fresh, caretInNew: fresh.length - tail.length, sameBlock: false, rest: lines.slice(index + 1) };
}

/**
 * ⌫ at the head of a list line's content: outdent, then drop the marker, before anything merges.
 * the reference app does this at parentOffset 0; here the marker counts as the head too.
 */
export function backspaceOnList(body, caret) {
  const lines = body.split('\n');
  const { index, start, offset } = lineAt(body, caret);
  const item = parseListItem(lines[index]);
  if (!item || offset > item.prefix) return null;
  if (item.indent > 0) {
    const rewritten = serializeListItem({ ...item, indent: item.indent - 1 });
    lines[index] = rewritten;
    return { body: lines.join('\n'), caret: start + rewritten.length - item.content.length };
  }
  lines[index] = item.content;
  return { body: lines.join('\n'), caret: start };
}

// --- editing ------------------------------------------------------------------------------------

/**
 * ↵ at the caret. Returns the body to keep and the block to create after it; on a list line the
 * new block carries the marker the reference app would have carried.
 */
export function enter(blocks, id, caret) {
  const { block, after } = neighbours(blocks, id);
  if (!block) return null;

  // ↵ inserts exactly one line and never anything else. It used to read two blank lines in a row
  // as "end this block", which silently swallowed both of them and created a block in their
  // place, so one keypress after a heading produced three blank rows and a ghost block. A
  // boundary is the gap flag, set deliberately, and nothing about typing infers one.

  // Inside a block ↵ is a line, and on a list line it is the reference app's next item.
  const list = enterOnList(block.body, caret);
  if (list && list.sameBlock) return { keep: list.body, caret: list.caret };
  if (list) {
    const body = [list.prefix, [list.line, ...list.rest].join('\n')].join('\n');
    return { keep: body, caret: list.prefix.length + 1 + list.caretInNew };
  }
  const [head, tail] = splitAt(block.body, caret);
  return { keep: `${head}\n${tail}`, caret: caret + 1 };
}

/** ⌥↵: the one deliberate way to start a new block. ↵ never makes one any more. */
export function splitBlock(blocks, id, caret) {
  const { block, after } = neighbours(blocks, id);
  if (!block) return null;
  const [head, tail] = splitAt(block.body, caret);
  return {
    keep: head,
    create: { body: tail, ord: ordBetween(block, after), kind: 'text', zone: zoneOf(block) },
    caretInNew: 0
  };
}

/**
 * ⌘↵: a page break, then an empty line under it to write on. Refuses to stack a second break on
 * a present that is already empty, so leaning on the chord cannot fill the document with rules.
 */
export function pageBreak(blocks, { id = null, caret = null } = {}) {
  const live = ordered(blocks);
  const current = id ? live.find((block) => block.id === id) || null : live[live.length - 1] || null;

  const present = presentSlice(blocks);
  const emptyPresent = present.length > 0 && present.every((block) => isText(block) && block.body.trim() === '');
  if (emptyPresent && live.some(isBreak)) return { focus: present[present.length - 1]?.id || null };

  const carried = current && isText(current) && caret !== null && caret < current.body.length
    ? splitAt(current.body, caret)
    : null;

  const breakOrd = appendOrd(blocks, 'timeline');
  return {
    keep: carried ? { id: current.id, body: carried[0] } : null,
    create: [
      { kind: 'break', body: '', ord: breakOrd, zone: 'timeline' },
      { kind: 'text', body: carried ? carried[1] : '', ord: breakOrd + ORD_STEP, zone: 'timeline' }
    ]
  };
}

/**
 * ⌫ at the head of a block. A break above is removed on its own, so a page break he did not mean
 * costs one keystroke; otherwise the block merges into the text above, caret at the seam.
 */
export function backspaceAtHead(blocks, id) {
  const { before, block } = neighbours(blocks, id);
  if (!block || !before) return null;
  if (isBreak(before)) return { removeBreak: before.id, focus: block.id, caret: 0 };
  return { mergeInto: before.id, body: before.body + block.body, caret: before.body.length, remove: block.id };
}

/** ⌦ at the tail of a block: the same seam, pulled the other way. */
export function deleteAtTail(blocks, id) {
  const { block, after } = neighbours(blocks, id);
  if (!block || !after) return null;
  if (isBreak(after)) return { removeBreak: after.id, focus: block.id, caret: block.body.length };
  return { mergeInto: block.id, body: block.body + after.body, caret: block.body.length, remove: after.id };
}

// --- the present --------------------------------------------------------------------------------

/** Everything in the timeline after the last page break: the present, for the scroller and ⌘↵. */
export function presentSlice(blocks) {
  const live = inZone(blocks, 'timeline');
  let start = 0;
  for (let index = live.length - 1; index >= 0; index -= 1) {
    if (isBreak(live[index])) { start = index + 1; break; }
  }
  return live.slice(start);
}

/** Where the caret goes when he opens the app or presses Escape: the empty note ending the timeline. */
export function liveBlock(blocks) {
  const live = inZone(blocks, 'timeline');
  for (let index = live.length - 1; index >= 0; index -= 1) {
    if (isText(live[index])) return live[index];
  }
  return null;
}

/**
 * The document always ends in a text block, so there is always somewhere to type. Returns the
 * block to create, or null when the tail is already writable.
 */
export function tailGap(blocks) {
  const live = inZone(blocks, 'timeline');
  const last = live[live.length - 1] || null;
  if (last && isText(last) && last.body.trim() === '') return null;
  return { kind: 'text', body: '', zone: 'timeline', ord: appendOrd(blocks, 'timeline') };
}

/** A block does not begin or end with blank lines: the two blank lines between blocks are the page's
 * drawing, not stored text. A block that is blank all through is left exactly as it is, because that
 * is the empty line he types in.
 */
export function trimBlankEdges(body) {
  const lines = String(body ?? '').split('\n');
  if (lines.every((line) => line.trim() === '')) return String(body ?? '');
  let start = 0;
  let end = lines.length - 1;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end].trim() === '') end -= 1;
  return lines.slice(start, end + 1).join('\n');
}

/** The future area always has a today block, so there is always a scratchpad under the present. */
export function todayGap(blocks) {
  if (todayBlock(blocks)) return null;
  return { kind: 'text', body: '', zone: 'future', ord: ORD_STEP };
}

// --- todos --------------------------------------------------------------------------------------

/**
 * Every checkbox in the document, in document order, with where it lives so a click can jump to
 * it. Bullets are not todos; dropped ones are kept, because the rail shows what he let go.
 */
export function todos(blocks, { state = null } = {}) {
  const out = [];
  for (const block of ordered(blocks)) {
    if (isBreak(block)) continue;
    const lines = block.body.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const item = parseListItem(lines[index]);
      if (!item || item.listType !== 'checkbox') continue;
      if (state && item.checkboxState !== state) continue;
      out.push({
        blockId: block.id,
        line: index,
        text: item.content,
        state: item.checkboxState,
        indent: item.indent,
        at: block.lines?.[index]?.createdAt || block.createdAt,
        zone: zoneOf(block)
      });
    }
  }
  return out;
}

/** Cycle the marker on one line of a block. */
export function cycleTodo(body, lineIndex) {
  const lines = body.split('\n');
  if (lines[lineIndex] === undefined) return body;
  lines[lineIndex] = cycleListItem(lines[lineIndex]);
  return lines.join('\n');
}

/** ⌘. on the caret's line: the cycle, and a plain line becomes a todo. */
export function cycleAtCaret(body, caret) {
  const lines = body.split('\n');
  const { index, start, offset } = lineAt(body, caret);
  const before = lines[index];
  lines[index] = cycleListItem(before);
  const delta = lines[index].length - before.length;
  return { body: lines.join('\n'), caret: Math.max(start, start + offset + delta) };
}

/**
 * Dictated words land at the caret, with one space in front of them when the caret is mid
 * sentence and none when it sits at the start of a line or after a space he already typed.
 */
export function insertSpoken(body, caret, text) {
  const words = String(text || '').trim();
  if (!words) return { body, caret };
  const at = Math.max(0, Math.min(caret ?? body.length, body.length));
  const before = body.slice(0, at);
  const after = body.slice(at);
  const spacer = before && !/\s$/.test(before) ? ' ' : '';
  return { body: `${before}${spacer}${words}${after}`, caret: before.length + spacer.length + words.length };
}

// --- the gutter ---------------------------------------------------------------------------------

export const GUTTER_GAP_MS = 20 * 60 * 1000;

/**
 * The time a block's gutter tick speaks for: the created_at of its first line, which is the line
 * he started the block with. The block does not carry a time of its own any more; its lines do.
 */
export const blockStampAt = (block) => block?.lines?.[0]?.createdAt || block?.createdAt || '';

/** the reference app's day boundary: the day turns over at 4am, not at midnight. */
export function dayKey(at, { boundaryHour = 4 } = {}) {
  const date = new Date(at);
  const shifted = new Date(date.getTime() - boundaryHour * 60 * 60 * 1000);
  return `${shifted.getFullYear()}-${shifted.getMonth() + 1}-${shifted.getDate()}`;
}

/**
 * Which blocks carry a time in the left gutter: the first of a day, the first after a page break,
 * and anything written more than twenty minutes after the line above it. A stamp on every line is
 * noise; these are the ones that say where he is.
 */
export function gutterStamps(blocks, { gap = GUTTER_GAP_MS } = {}) {
  const live = ordered(blocks);
  const stamps = new Map();
  let previous = null;
  let afterBreak = true;
  for (const block of live) {
    if (isBreak(block)) { afterBreak = true; continue; }
    const at = Date.parse(blockStampAt(block));
    if (!Number.isFinite(at)) { previous = null; continue; }
    const newDay = !previous || dayKey(previous) !== dayKey(at);
    if (newDay || afterBreak || at - previous > gap) stamps.set(block.id, { at, newDay });
    previous = at;
    afterBreak = false;
  }
  return stamps;
}

export const LINE_GAP_MS = 60 * 1000;

/** The same ruler, per line. A line is an entity with its own created_at, so every line can say when
 * it was written and not only the block it opens: the map is keyed `<block id>#<index>`, and a tick
 * is loud -- on screen without being asked for -- when it opens a day, follows a page break, or was
 * written more than a minute after the line above it. (like > 1 minute).
 */
export function lineStamps(blocks, { gap = LINE_GAP_MS } = {}) {
  const live = ordered(blocks);
  const stamps = new Map();
  let previous = null;
  let afterBreak = true;
  for (const block of live) {
    if (isBreak(block)) { afterBreak = true; continue; }
    // A block typed a moment ago has no line rows back from the store yet; its own created_at
    // stands in for its first line until the save answers.
    const rows = block.lines?.length ? block.lines : [{ createdAt: blockStampAt(block) }];
    for (let index = 0; index < rows.length; index += 1) {
      const at = Date.parse(rows[index]?.createdAt || '');
      if (!Number.isFinite(at)) continue;
      const newDay = previous === null || dayKey(previous) !== dayKey(at);
      const loud = newDay || afterBreak || at - previous > gap;
      stamps.set(`${block.id}#${index}`, { at, newDay, loud });
      previous = at;
      afterBreak = false;
    }
  }
  return stamps;
}

// --- lines: the thing that carries a timestamp and can move ---------------------------------------
//
// A LINE is the entity now. It has its own id, created_at, updated_at, order (a float), indent, a
// marker state re-parsed from its text, and a soft delete. A block -- the chunk he types in, ended
// by two blank lines -- is derived from the lines and their gap flags; it is not stored.
//
// The rules are the ones the docstore notes app settled on (apps/notesapp/app.py), kept verbatim
// where they apply:
//   - order is a float; a line inserted between neighbours takes the midpoint, before+1 with only
//     a line above, after-1 with only a line below, 0 with neither.
//   - the sort key is the pair (order, id).
//   - kind and todo_done are DERIVED by re-parsing the markdown body; the body is the checkbox.
//   - a block ends at a line whose gap flag is set.
//   - setting a field to what it already holds is a true no-op: no updated_at, no delta. That rule
//     lives in the store, which is where the write happens.
//
// One deliberate divergence: docstore ends a block at an empty line (kind "gap") as well. Here a
// single blank line is air inside a block and two blank lines end it, so the boundary is the gap
// flag the second blank line leaves behind, and an empty line keeps its "gap" kind without ending
// anything by itself.

export function newLineId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `l_${Date.now().toString(36)}${rand}`;
}

/** docstore's order for a line landing between two neighbours, either of which may be absent. */
export function lineOrdBetween(before, after) {
  const b = before === null || before === undefined || !Number.isFinite(Number(before)) ? null : Number(before);
  const a = after === null || after === undefined || !Number.isFinite(Number(after)) ? null : Number(after);
  if (b === null && a === null) return 0;
  if (a === null) return b + 1;
  if (b === null) return a - 1;
  return b + (a - b) / 2;
}

/** A new line's default order is the action's epoch seconds, as in the notes app. */
export const defaultLineOrd = (at = Date.now()) => at / 1000;

/**
 * Everything the body says about the line, re-parsed on every write: docstore's
 * _parse_paragraph_body, with the reference app's list grammar for the markers so "-[x]" counts as a checkbox.
 */
export function lineFields(body) {
  const text = String(body ?? '');
  const item = parseListItem(text);
  const trimmed = text.trim();
  const kind = trimmed === '' ? 'gap'
    : item && item.listType === 'checkbox' ? 'todo'
      : item ? 'bullet'
        : trimmed.startsWith('#') ? 'heading'
          : 'text';
  const todoDone = kind === 'todo' ? item.checkboxState === 'done' : null;
  const indent = item ? item.indent
    : trimmed === '' ? 0
      : Math.floor((text.length - text.trimStart().length) / 2);
  return { kind, todoDone, indent };
}
export const lineKind = (body) => lineFields(body).kind;
export const lineIndent = (body) => lineFields(body).indent;

/** Live lines, the timeline before the future area, each zone by (order, id). */
export function sortLines(lines) {
  return [...lines]
    .filter((line) => !line.deletedAt)
    .sort((a, b) => ZONE_RANK[zoneOf(a)] - ZONE_RANK[zoneOf(b)] || a.ord - b.ord || (a.id < b.id ? -1 : 1));
}

/**
 * The blocks, derived: a run of lines that ends at a line whose gap flag is set, at a page break,
 * or at the end of its zone. A block is named by its first line, which is what keeps a block id
 * stable for the page, the chat chip and the DOM while the text inside it is line rows.
 */
export function blocksFromLines(lines) {
  const live = sortLines(lines);
  const blocks = [];
  let current = [];
  const close = () => {
    if (current.length === 0) return;
    const head = current[0];
    blocks.push({
      id: head.id,
      kind: head.kind === 'break' ? 'break' : 'text',
      body: current.map((line) => line.body).join('\n'),
      ord: head.ord,
      zone: zoneOf(head),
      createdAt: head.createdAt,
      updatedAt: current.reduce((latest, line) => (line.updatedAt > latest ? line.updatedAt : latest), head.updatedAt),
      deletedAt: null,
      source: head.source || 'type',
      chatId: current.find((line) => line.chatId)?.chatId || null,
      lines: current
    });
    current = [];
  };
  for (const line of live) {
    if (current.length > 0 && (zoneOf(current[0]) !== zoneOf(line) || line.kind === 'break')) close();
    current.push(line);
    if (line.gapAfter || line.kind === 'break') close();
  }
  close();
  return blocks;
}

/** The lines of one derived block, or [] when no block starts at that id. */
export function linesOfBlock(lines, id) {
  return blocksFromLines(lines).find((block) => block.id === id)?.lines || [];
}

/**
 * What a block's new text does to the lines it already has. Lines that did not change keep their
 * row, and so keep their created_at; a line he retyped is an update of that row, not a new line;
 * only text that is genuinely new is an insert, and only text that is gone is archived.
 */
export function diffLines(oldBodies, newBodies) {
  const olds = [...oldBodies];
  const news = [...newBodies];
  const ops = [];
  let i = 0;
  let j = 0;
  const drain = (untilOld, untilNew) => {
    while (i < untilOld || j < untilNew) {
      if (i < untilOld && j < untilNew) { ops.push({ op: 'update', from: i, body: news[j] }); i += 1; j += 1; }
      else if (j < untilNew) { ops.push({ op: 'insert', body: news[j] }); j += 1; }
      else { ops.push({ op: 'archive', from: i }); i += 1; }
    }
  };
  for (const [ai, aj] of commonLines(olds, news)) {
    drain(ai, aj);
    ops.push({ op: 'keep', from: i, body: news[j] });
    i += 1;
    j += 1;
  }
  drain(olds.length, news.length);
  return ops;
}

/** The longest run of lines the two versions share, as pairs of indexes: a plain LCS. */
function commonLines(olds, news) {
  if (olds.length === 0 || news.length === 0) return [];
  if (olds.length * news.length > 250_000) return [];       // too much text to align; pair in place
  const table = Array.from({ length: olds.length + 1 }, () => new Uint32Array(news.length + 1));
  for (let a = olds.length - 1; a >= 0; a -= 1) {
    for (let b = news.length - 1; b >= 0; b -= 1) {
      table[a][b] = olds[a] === news[b] ? table[a + 1][b + 1] + 1 : Math.max(table[a + 1][b], table[a][b + 1]);
    }
  }
  const pairs = [];
  let a = 0;
  let b = 0;
  while (a < olds.length && b < news.length) {
    if (olds[a] === news[b]) { pairs.push([a, b]); a += 1; b += 1; }
    else if (table[a + 1][b] >= table[a][b + 1]) a += 1;
    else b += 1;
  }
  return pairs;
}

/**
 * One line up or down. It moves within its block until it reaches the edge of it, and then across
 * the boundary into the block above or below: the order is all that moves, so where the gap flags
 * sit decides which block it has landed in.
 */
export function moveLine(lines, id, direction) {
  const live = sortLines(lines);
  const self = live.find((line) => line.id === id);
  if (!self) return null;
  const siblings = live.filter((line) => zoneOf(line) === zoneOf(self));
  const index = siblings.findIndex((line) => line.id === id);
  const target = index + (direction < 0 ? -1 : 1);
  if (target < 0 || target >= siblings.length) return null;
  const ord = direction < 0
    ? lineOrdBetween(siblings[target - 1]?.ord ?? null, siblings[target].ord)
    : lineOrdBetween(siblings[target].ord, siblings[target + 1]?.ord ?? null);
  return { id, ord };
}


// --- waiting on a condition -----------------------------------------------------------------------
//
// and the nightly push gains a section where it updates deferres to todos if it matches the condition
// (llm does a little compute). The condition is prose and the judgement is the nightly model's; the
// only thing decided here is the date, because a date is the half of the condition that does not need a
// model and because the deferred items have to be put in an order the eye can read.

const MONTH_NAMES = [
  ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'], ['may'],
  ['june', 'jun'], ['july', 'jul'], ['august', 'aug'], ['september', 'sept', 'sep'],
  ['october', 'oct'], ['november', 'nov'], ['december', 'dec']
];
// Spelled out rather than matched as a prefix, so "augment" is not read as August.
const MONTH_RE = new RegExp(
  `\\b(${MONTH_NAMES.flat().join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'u'
);
const MONTH_INDEX = new Map(MONTH_NAMES.flatMap((names, month) => names.map((name) => [name, month])));

const WEEKDAY_NAMES = [
  ['sunday', 'sun'], ['monday', 'mon'], ['tuesday', 'tues', 'tue'], ['wednesday', 'weds', 'wed'],
  ['thursday', 'thurs', 'thur', 'thu'], ['friday', 'fri'], ['saturday', 'sat']
];
const WEEKDAY_RE = new RegExp(`\\b(${WEEKDAY_NAMES.flat().join('|')})\\b`, 'u');
const WEEKDAY_INDEX = new Map(WEEKDAY_NAMES.flatMap((names, day) => names.map((name) => [name, day])));

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Midnight of the day `now` falls on, in UTC, which is the whole calendar this file works in. */
function dayStart(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** The date an await condition points at, as "YYYY-MM-DD", or null when it names no date. Small and
 * dependency-free on purpose: the nightly push reads the same function, so what the editor sorts by
 * and what the model is told has passed are the one rule.
 *
 * A month and day with no year mean the next time that date comes round, so "oct 20" written on
 * October 6th is this year and "oct 5" is next year. A weekday means the coming one, never today.
 * Everything is UTC, which is a day boundary a nightly job can agree with; nothing here needs to be
 * right to the hour.
 */
export function awaitDeadline(condition, now = new Date()) {
  const text = String(condition ?? '').toLowerCase();
  const base = dayStart(now);
  if (base === null || text.trim() === '') return null;

  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/u.exec(text);
  if (iso) return isoDay(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));

  const named = MONTH_RE.exec(text);
  if (named) {
    const month = MONTH_INDEX.get(named[1]);
    const day = Number(named[2]);
    if (named[3]) return isoDay(Date.UTC(Number(named[3]), month, day));
    const year = new Date(base).getUTCFullYear();
    const thisYear = Date.UTC(year, month, day);
    return isoDay(thisYear >= base ? thisYear : Date.UTC(year + 1, month, day));
  }

  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/u.exec(text);
  if (slash) {
    const month = Number(slash[1]) - 1;
    const day = Number(slash[2]);
    if (slash[3]) {
      const year = Number(slash[3]);
      return isoDay(Date.UTC(year < 100 ? 2000 + year : year, month, day));
    }
    const year = new Date(base).getUTCFullYear();
    const thisYear = Date.UTC(year, month, day);
    return isoDay(thisYear >= base ? thisYear : Date.UTC(year + 1, month, day));
  }

  const ahead = /\bin\s+(\d{1,3})\s+(day|week|month)s?\b/u.exec(text);
  if (ahead) {
    const count = Number(ahead[1]);
    if (ahead[2] === 'day') return isoDay(base + count * DAY_MS);
    if (ahead[2] === 'week') return isoDay(base + count * 7 * DAY_MS);
    const start = new Date(base);
    return isoDay(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + count, start.getUTCDate()));
  }

  if (/\btomorrow\b/u.test(text)) return isoDay(base + DAY_MS);
  if (/\btoday\b/u.test(text)) return isoDay(base);
  if (/\bnext\s+week\b/u.test(text)) return isoDay(base + 7 * DAY_MS);
  if (/\bnext\s+month\b/u.test(text)) {
    const start = new Date(base);
    return isoDay(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()));
  }

  const weekday = WEEKDAY_RE.exec(text);
  if (weekday) {
    const wanted = WEEKDAY_INDEX.get(weekday[1]);
    const ahead_days = (wanted - new Date(base).getUTCDay() + 7) % 7 || 7;
    return isoDay(base + ahead_days * DAY_MS);
  }

  return null;
}

/** Undated items sort last, which is what this sentinel buys without a branch at every comparison. */
const NO_DEADLINE = '\uffff';

/** Where a line goes the moment he defers it. (parse timestamps and insertion sort?) only when i defer
 * it. So this is called by the deferral and by nothing else.
 *
 * The rules as implemented: the line takes everything indented under it; it never leaves the block
 * and never leaves its own sibling level; the first line of the block does not move at all, because
 * moving it would take the block's identity with it; it lands after the last of its siblings, except
 * that the trailing run of siblings which are themselves await items is kept sorted by the date in
 * their conditions, earliest first and undated last, so the one coming back soonest sits at the top
 * of the parked run.
 *
 * Returns the new body and the line's new index, or null when nothing moves.
 */
export function deferToEnd(body, index, { now = new Date() } = {}) {
  const lines = String(body ?? '').split('\n');
  const at = Number(index);
  if (!Number.isInteger(at) || at <= 0 || at >= lines.length) return null;

  const nodes = outline(lines);
  const self = nodes[at];
  if (!self || String(lines[at]).trim() === '') return null;
  const end = at + self.descendants;
  const scopeEnd = self.parent === null ? lines.length - 1 : self.parent + nodes[self.parent].descendants;
  const scopeStart = self.parent === null ? 0 : self.parent + 1;

  // Only the family around the line counts: the run of siblings it sits in, cut at a blank line, an
  // empty bullet, or (at the top level) a line that is not a bullet.
  const breaksFamily = (node) => {
    const text = String(node.text ?? '');
    if (text.trim() === '') return true;
    const item = parseListItem(text);
    if (!item) return self.depth === 0;
    return String(item.content ?? '').trim() === '';
  };
  let family = [];
  let siblings = [];
  for (let node = scopeStart; node <= scopeEnd && node < nodes.length; node += 1) {
    const other = nodes[node];
    if (String(lines[node]).trim() === '' || (other.depth === self.depth && other.parent === self.parent && node !== at && breaksFamily(other))) {
      if (family.includes(at)) break;
      family = [];
      continue;
    }
    if (other.depth !== self.depth || other.parent !== self.parent) continue;
    family.push(node);
    if (node === at) siblings = family;
  }
  if (!family.includes(at)) return null;
  siblings = family.filter((node) => node !== at).map((node) => {
    const other = nodes[node];
    const item = parseListItem(other.text);
    return {
      start: node,
      end: node + other.descendants,
      waiting: item?.checkboxState === 'await',
      key: item?.checkboxState === 'await' ? (awaitDeadline(item.awaitCondition, now) || NO_DEADLINE) : NO_DEADLINE
    };
  });
  if (siblings.length === 0) return null;

  // The run of parked items at the end of the level is the only part that is sorted.
  let run = siblings.length;
  while (run > 0 && siblings[run - 1].waiting) run -= 1;

  const mine = parseListItem(lines[at]);
  const key = mine?.checkboxState === 'await' ? (awaitDeadline(mine.awaitCondition, now) || NO_DEADLINE) : NO_DEADLINE;
  const landing = siblings.slice(run).find((sibling) => sibling.key > key);
  const target = landing ? landing.start : siblings[siblings.length - 1].end + 1;
  if (target === at || target === end + 1) return null;

  const moving = lines.slice(at, end + 1);
  const rest = [...lines.slice(0, at), ...lines.slice(end + 1)];
  const landingIndex = target > end ? target - moving.length : target;
  rest.splice(landingIndex, 0, ...moving);
  return { body: rest.join('\n'), index: landingIndex };
}
