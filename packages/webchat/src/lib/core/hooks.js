

// A compaction boundary is never folded under a hook card: it is the marker for where the model's context
// was cut, and hiding it inside something else is the thing the owner was missing in the first place.
const NEVER_FOLDED = new Set(['user', 'error', 'compaction', 'pace']);
// A tool call, a grouped run or a subagent after a hook means the model went back to work rather than just
// answering the hook. Then the whole segment is owner-visible transcript: the text the model said before the
// call, the call and its results, and everything it said after, in order. The card stays as the record that the
// hook fired, with nothing folded under it. A segment where the hook only talked keeps folding as before.
const RESUMED_WORK = new Set(['tool', 'toolrun', 'agent']);

export function groupHooks(rows) {
  if (!rows.some((row) => row.type === 'hook')) return rows;
  const out = [];
  let open = null;
  let segment = [];
  const close = () => {
    if (!open) return;
    // A run of thinking alone is the model thinking, not going back to work.
    if (segment.some((row) => RESUMED_WORK.has(row.type) && !(row.type === 'toolrun' && !row.tools?.length))) {
      open.unfolded = true;
      out.push(...segment);
    } else {
      open.children = segment;
    }
    open = null;
    segment = [];
  };
  for (const row of rows) {
    if (row.type === 'hook') {
      close();
      open = { ...row, children: [] };
      out.push(open);
      continue;
    }
    if (open && !NEVER_FOLDED.has(row.type)) {
      segment.push(row);
      continue;
    }
    close();
    out.push(row);
  }
  close();
  return out;
}

export function hookCount(row) {
  return (row.children || []).filter((child) => child.type !== 'thinking'
    && !(child.type === 'toolrun' && !child.tools?.length)).length;
}


export function hookRunning(row) {
  return (row.children || []).some(
    (child) => child.streaming || (child.type === 'tool' && child.state === 'running')
      || (child.type === 'toolrun' && child.tools?.some((tool) => tool.state === 'running'))
      || (child.type === 'agent' && child.state === 'running'));
}
