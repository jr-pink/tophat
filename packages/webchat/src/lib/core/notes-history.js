// History stores row deltas, not document snapshots: unrelated edits survive undo.
const value = line => line && !line.deletedAt ? JSON.stringify([
  line.id, line.kind, line.body, line.ord, line.indent, line.gapAfter,
  line.zone, line.createdAt, line.source, line.chatId
]) : null;
export function historyDelta(before, after) {
  const old = new Map(before.map(line => [line.id, line]));
  const next = new Map(after.map(line => [line.id, line]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .filter(id => value(old.get(id)) !== value(next.get(id)))
    .map(id => ({ before: old.get(id) || null, after: next.get(id) || null }));
}
export function historyPatches(delta, current, redo = false, at = new Date().toISOString()) {
  const rows = new Map(current.map(line => [line.id, line]));
  return delta.map(change => {
    const expected = redo ? change.before : change.after;
    const desired = redo ? change.after : change.before;
    const id = (expected || desired).id;
    if (value(rows.get(id)) !== value(expected)) throw new Error('This edit changed elsewhere; undo would overwrite it.');
    return desired || { ...rows.get(id), deletedAt: at };
  });
}
