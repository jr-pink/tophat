

export const MIN_RUN = 3;

const finished = (item) => item.type === 'tool' && (item.state === 'completed' || item.state === 'failed');
// Settled thinking rides in a run with the finished calls around it. Streaming thinking never folds,
// like a running call. Thinking counts toward MIN_RUN: any three or more finished items in a row,
// thinking and calls combined, fold into one run, three thinking blocks with no call among them
// included.
const settledThinking = (item) => item.type === 'thinking' && item.streaming !== true;

/** The one-line preview a collapsed thinking card shows: the first non-empty line, markdown
 * emphasis and heading marks stripped (summaries often open with a bold title). */
export function thinkingSummary(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.replace(/^#+\s*/u, '').replace(/\*\*|__/gu, '').trim();
}

export function summarize(tools) {
  const failures = tools.filter((t) => t.state === 'failed').length;
  const start = Math.min(...tools.map((t) => Date.parse(t.at)).filter(Number.isFinite));
  const end = Math.max(...tools.map((t) => Date.parse(t.endedAt || t.at)).filter(Number.isFinite));
  const ms = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0;
  return {
    count: tools.length,
    results: tools.length - failures,
    failures,
    ms,
    
    
    failed: tools.filter((t) => t.state === 'failed').map((t) => t.tool),
    
    
    
    kinds: [...new Set(tools.map((t) => t.tool))]
  };
}

export function groupToolRuns(items, { min = MIN_RUN, keep = null } = {}) {
  const rows = [];
  let run = [];
  const flush = () => {
    const tools = run.filter((item) => item.type === 'tool');
    if (run.length >= min && !(keep && run.some((t) => keep.has(t.id)))) {
      // `tools` stays the calls alone (summary, hooks); `items` is every card in order, thinking
      // included, which is what the open run draws. The id and fold key come from the first call
      // when there is one, so runs he opened before thinking joined them stay open; a run of
      // thinking alone keys on its first block.
      const thinking = run.length - tools.length;
      const anchor = tools[0] || run[0];
      rows.push({ type: 'toolrun', id: `run:${anchor.id}`, at: run[0].at, cursor: run[0].cursor, tools, items: run, thinking, ...summarize(tools) });
    } else rows.push(...run);
    run = [];
  };
  for (const item of items) {
    if (finished(item) || settledThinking(item)) { run.push(item); continue; }
    flush();
    rows.push(item);
  }
  flush();
  return rows;
}

export function formatDuration(ms) {
  if (!ms) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}

/** The ids a run's fold is keyed on: its calls, or its thinking blocks when it has no call. */
export function runFoldIds(run) {
  const list = run.tools?.length ? run.tools : run.items || [];
  return list.map((item) => item.id);
}

const runAnchor = (row) => runFoldIds(row)[0];

export function foldedRunIds(rows) {
  const ids = new Set();
  for (const row of rows) if (row.type === 'toolrun' && runAnchor(row)) ids.add(runAnchor(row));
  return ids;
}

export function heldFolds(rows, already) {
  const held = [];
  for (const row of rows) {
    if (row.type !== 'toolrun' || !runAnchor(row)) continue;
    if (!already.has(runAnchor(row))) held.push(runAnchor(row));
  }
  return held;
}
