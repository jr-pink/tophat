import { parseListItem, sortLines, zoneOf } from './notes-doc.js';

// A bullet adds a level beneath prose at the same indentation.
export function treeEnd(lines, start) {
  const depth = line => {
    const lead = /^[\t ]*/u.exec(line.body)[0];
    return (lead.match(/\t/gu) || []).length + Math.floor(lead.replace(/\t/gu, '').length / 2) + (parseListItem(line.body) ? 1 : 0);
  };
  let end = start + 1;
  while (end < lines.length && !lines[end - 1].gapAfter && lines[end].kind !== 'break' &&
    lines[end].body.trim() && depth(lines[end]) > depth(lines[start])) end += 1;
  return end;
}

/** The gesture on a block's first line takes all of it. */
export function blockEnd(lines, start) {
  let end = start + 1;
  while (end < lines.length && !lines[end - 1].gapAfter && lines[end].kind !== 'break') end += 1;
  return end;
}

/** Where a block's run begins, counting back from any line inside it. */
export function blockStart(lines, at) {
  let start = at;
  while (start > 0 && !lines[start - 1].gapAfter && lines[start].kind !== 'break') start -= 1;
  return start;
}

/**
 * Reorder a complete subtree, retaining identities, contents and block boundaries. With `whole`
 * the unit is the block the line opens rather than the line and its descendants, and the landing
 * is snapped to a block boundary so a block dropped on another one lands beside it instead of
 * splicing itself into the middle of its words.
 */
export function reorderTree(input, id, target, after = false, { whole = false } = {}) {
  const live = sortLines(input);
  const self = live.find(line => line.id === id);
  const destination = live.find(line => line.id === target);
  if (!self || !destination || self.kind === 'break' || destination.kind === 'break') return [];
  // A drop in another area is the same gesture, and it is the one he reaches for most: a thing that
  // happened today becomes a thing to do next.
  if (zoneOf(self) !== zoneOf(destination)) return acrossZones(live, self, destination, after, whole);
  const lines = live.filter(line => zoneOf(line) === zoneOf(self));
  const start = lines.findIndex(line => line.id === id);
  const end = whole ? blockEnd(lines, start) : treeEnd(lines, start);
  const at = lines.findIndex(line => line.id === target);
  if (at >= start && at < end) return [];
  const insertion = whole
    ? (after ? blockEnd(lines, at) : blockStart(lines, at))
    : (after ? treeEnd(lines, at) : at);
  if (insertion === start || insertion === end) return [];
  const moving = lines.slice(start, end).map(line => ({ ...line }));
  const rest = lines.filter((_, index) => index < start || index >= end).map(line => ({ ...line }));
  if (moving.at(-1).gapAfter && start > 0 && !lines[start - 1].gapAfter) rest[start - 1].gapAfter = true;
  const position = insertion > end ? insertion - moving.length : insertion;
  if (whole) {
    // A block stays a block on both sides of the landing: the run keeps its own closing gap and
    // the line it now follows keeps one too, so nothing is merged by the move.
    moving.at(-1).gapAfter = true;
    if (position > 0) rest[position - 1].gapAfter = true;
  } else {
    moving.at(-1).gapAfter = after ? Boolean(rest[position - 1]?.gapAfter) : false;
    if (after && position > 0) rest[position - 1].gapAfter = false;
  }
  rest.splice(position, 0, ...moving);
  // Renumber this zone to avoid fractional-order exhaustion after repeated moves.
  const originals = new Map(lines.map(line => [line.id, line]));
  return rest.flatMap((line, index) => {
    const old = originals.get(line.id);
    const ord = index + 1;
    return old.ord === ord && Boolean(old.gapAfter) === Boolean(line.gapAfter) ? [] : [{ id: line.id, ord, gapAfter: Boolean(line.gapAfter) }];
  });
}

/**
 * The same move, landing in another zone. The run keeps its identities and its shape; what
 * changes is the zone it belongs to and the order on both sides of the move. Both zones are
 * renumbered, so repeated cross-zone moves cannot exhaust the fractional order either.
 */
function acrossZones(live, self, destination, after, whole) {
  const fromZone = zoneOf(self);
  const toZone = zoneOf(destination);
  const source = live.filter(line => zoneOf(line) === fromZone);
  const into = live.filter(line => zoneOf(line) === toZone);
  const start = source.findIndex(line => line.id === self.id);
  const end = whole ? blockEnd(source, start) : treeEnd(source, start);
  const at = into.findIndex(line => line.id === destination.id);
  if (start < 0 || at < 0) return [];
  const insertion = whole
    ? (after ? blockEnd(into, at) : blockStart(into, at))
    : (after ? treeEnd(into, at) : at);
  const moving = source.slice(start, end).map(line => ({ ...line, zone: toZone }));
  const rest = source.filter((_, index) => index < start || index >= end).map(line => ({ ...line }));
  // The run took its closing gap with it; the line it left behind closes that block now.
  if (moving.at(-1).gapAfter && start > 0 && !source[start - 1].gapAfter) rest[start - 1].gapAfter = true;
  const landing = into.map(line => ({ ...line }));
  if (whole) {
    moving.at(-1).gapAfter = true;
    if (insertion > 0) landing[insertion - 1].gapAfter = true;
  } else {
    moving.at(-1).gapAfter = after ? Boolean(landing[insertion - 1]?.gapAfter) : false;
    if (after && insertion > 0) landing[insertion - 1].gapAfter = false;
  }
  landing.splice(insertion, 0, ...moving);
  const originals = new Map(live.map(line => [line.id, line]));
  const patches = [];
  for (const [zone, rows] of [[fromZone, rest], [toZone, landing]]) {
    rows.forEach((line, index) => {
      const old = originals.get(line.id);
      const ord = index + 1;
      const moved = zoneOf(old) !== zone;
      if (!moved && old.ord === ord && Boolean(old.gapAfter) === Boolean(line.gapAfter)) return;
      patches.push(moved
        ? { id: line.id, ord, gapAfter: Boolean(line.gapAfter), zone }
        : { id: line.id, ord, gapAfter: Boolean(line.gapAfter) });
    });
  }
  return patches;
}
