import { newLineId } from '../core/notes-doc.js';

/** Project one editing action, anchored to its known source line, before save debounce.
 * Never match by text: adjacent identical lines are still distinct entities. */
export function editLines(block, body, at, editedIndex = 0, allocate = newLineId) {
  const before = String(block.body ?? '').split('\n');
  const after = body.split('\n');
  const old = before.map((text, i) => ({ ...block.lines?.[i], id: block.lineIds?.[i] ?? block.lines?.[i]?.id ?? (i === 0 ? block.id : allocate()), body: text, createdAt: block.lines?.[i]?.createdAt ?? block.createdAt }));
  const anchor = Math.max(0, Math.min(editedIndex, after.length - 1));
  const delta = after.length - before.length;
  return after.map((text, i) => {
    const previous = i <= anchor ? old[i] : delta > 0 && i <= anchor + delta ? null : old[i - delta];
    return { ...previous, id: previous?.id ?? allocate(), body: text,
      createdAt: previous && (previous.body.trim() || !text.trim()) ? previous.createdAt : at };
  });
}

/** Joining blank space to content never gives that content the blank space's age. */
export function joinedCreatedAt(left, right) {
  const content = [left, right].filter(line => line?.body?.trim());
  return (content.length ? content : [left, right]).map(line => line?.createdAt).filter(Boolean).sort()[0];
}

/** Split by the caret's explicit offset; whole suffix rows retain their entity IDs. */
export function splitLines(block, caret, at, allocate = newLineId) {
  const rows = editLines(block, block.body, at, 0, allocate);
  const head = block.body.slice(0, caret), tail = block.body.slice(caret);
  const index = head.split('\n').length - 1;
  const offset = head.split('\n').at(-1).length;
  const original = rows[index];
  const first = { ...original, body: original.body.slice(0, offset) };
  const second = { ...original, id: allocate(), body: original.body.slice(offset) };
  if (offset === 0 && index > 0) { second.id = original.id; first.id = allocate(); }
  return { before: [...rows.slice(0,index), first], after: [second, ...rows.slice(index+1)] };
}
