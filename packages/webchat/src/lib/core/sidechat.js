

// Select-to-comment, off. Selecting text in the transcript now does nothing but select; the pill,
// the shift-enter / cmd-enter selection shortcuts and the type-over-a-selection fork are all gated
// on this one flag, so putting the gesture back is flipping it to true.
export const SELECT_GESTURES = false;

// The pill, back on its own, without the gestures above. sidechat... A selection shows Quote /
// Sidechat / Fork and stays until the selection goes away; typing, Shift-Enter and Cmd-Enter over a
// selection still do nothing (SELECT_GESTURES).
export const SELECT_PILL = true;

export const RAIL_WIDTH = 320;
// The rail grows with the pane: a third of it, between 320px and 520px.
export const RAIL_MAX_WIDTH = 520;
export function railWidthFor(paneWidth) {
  const width = Math.round((Number(paneWidth) || 0) / 3);
  return Math.max(RAIL_WIDTH, Math.min(RAIL_MAX_WIDTH, width));
}
export const RAIL_MIN_PANE = 900;


export const GAP = 12;

export function makeAnchor(itemId, text, start, end) {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(String(text).length, Math.max(start, end));
  return { itemId, start: from, end: to, quote: String(text).slice(from, to) };
}


const flat = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();

export function resolveAnchor(anchor, text) {
  const body = String(text ?? '');
  const quote = String(anchor?.quote ?? '');
  const start = Number(anchor?.start) || 0;
  if (!quote) return { start: 0, end: 0, state: 'orphaned' };
  if (body.slice(start, start + quote.length) === quote) {
    return { start, end: start + quote.length, state: 'exact' };
  }
  
  
  
  let best = -1;
  for (let at = body.indexOf(quote); at !== -1; at = body.indexOf(quote, at + 1)) {
    if (best === -1 || Math.abs(at - start) < Math.abs(best - start)) best = at;
  }
  if (best !== -1) return { start: best, end: best + quote.length, state: 'moved' };
  
  
  
  const needle = flat(quote);
  if (needle) {
    const flatBody = flat(body);
    const at = flatBody.indexOf(needle);
    if (at !== -1) {
      const mapped = mapFlatOffset(body, at);
      if (mapped !== -1) return { start: mapped, end: mapped + quote.length, state: 'moved' };
    }
  }
  return { start: 0, end: 0, state: 'orphaned' };
}


function mapFlatOffset(body, target) {
  let seen = 0;
  let space = true; 
  for (let at = 0; at < body.length; at += 1) {
    const isSpace = /\s/u.test(body[at]);
    if (isSpace) { space = true; continue; }
    if (space && seen > 0) seen += 1; 
    if (seen === target) return at;
    space = false;
    seen += 1;
  }
  return -1;
}

export function abbreviate(quote, { head = 6, tail = 6 } = {}) {
  const words = flat(quote).split(' ').filter(Boolean);
  
  if (words.length <= head + tail + 2) return words.join(' ');
  return `${words.slice(0, head).join(' ')} … ${words.slice(-tail).join(' ')}`;
}


export function quoteLine(quote) {
  const body = abbreviate(quote);
  return body ? `> ${body}\n\n` : '';
}

const byAnchor = (a, b) => a.anchorTop - b.anchorTop || String(a.id).localeCompare(String(b.id));

export function layout(threads, { focusedId = null, gap = GAP, minTop = 0 } = {}) {
  const ordered = [...threads].sort(byAnchor);
  if (!ordered.length) return [];

  const tops = ordered.map((thread) => thread.anchorTop);
  const at = ordered.findIndex((thread) => thread.id === focusedId);
  const pivot = at === -1 ? 0 : at;

  for (let index = pivot - 1; index >= 0; index -= 1) {
    tops[index] = Math.min(tops[index], tops[index + 1] - ordered[index].height - gap);
  }
  for (let index = pivot + 1; index < ordered.length; index += 1) {
    tops[index] = Math.max(tops[index], tops[index - 1] + ordered[index - 1].height + gap);
  }

  
  
  
  
  const overshoot = minTop - tops[0];
  if (overshoot > 0) for (let index = 0; index < tops.length; index += 1) tops[index] += overshoot;

  return ordered.map((thread, index) => ({
    id: thread.id,
    top: tops[index],
    anchorTop: thread.anchorTop,
    offset: tops[index] - thread.anchorTop
  }));
}

const EPSILON = 1e-6;

export function layoutViolations(placed, threads, { gap = GAP, minTop = 0, focusedId = null, clamped = true } = {}) {
  const bad = [];
  const heights = new Map(threads.map((thread) => [thread.id, thread.height]));
  const anchors = new Map(threads.map((thread) => [thread.id, thread.anchorTop]));
  if (placed.length !== threads.length) bad.push(`placed ${placed.length} of ${threads.length} threads`);

  for (let index = 1; index < placed.length; index += 1) {
    const above = placed[index - 1];
    const below = placed[index];
    if (below.top + EPSILON < above.top + heights.get(above.id) + gap) {
      bad.push(`${above.id} and ${below.id} overlap: ${above.top}+${heights.get(above.id)} vs ${below.top}`);
    }
    
    if (byAnchor({ id: above.id, anchorTop: anchors.get(above.id) },
                 { id: below.id, anchorTop: anchors.get(below.id) }) > 0) {
      bad.push(`${above.id} and ${below.id} are out of reading order`);
    }
  }
  if (clamped) {
    for (const card of placed) {
      if (card.top + EPSILON < minTop) bad.push(`${card.id} sits above the content at ${card.top}`);
    }
  } else if (focusedId && placed.some((card) => card.id === focusedId)) {
    const focused = placed.find((card) => card.id === focusedId);
    if (Math.abs(focused.offset) > EPSILON) bad.push(`focused ${focusedId} is ${focused.offset}px off its anchor`);
  }
  return bad;
}

export function initialRail() {
  return { focused: null, collapsed: [] };
}

export function focusThread(rail, id) {
  if (!id) return rail.focused === null ? rail : { ...rail, focused: null };
  const collapsed = rail.collapsed.filter((other) => other !== id);
  if (rail.focused === id && collapsed.length === rail.collapsed.length) return rail;
  return { focused: id, collapsed };
}

export function collapseThread(rail, id) {
  if (rail.collapsed.includes(id)) return rail;
  return { focused: rail.focused === id ? null : rail.focused, collapsed: [...rail.collapsed, id] };
}

export function expandThread(rail, id) {
  return focusThread(rail, id);
}


export function pruneRail(rail, ids) {
  const live = new Set(ids);
  const collapsed = rail.collapsed.filter((id) => live.has(id));
  const focused = rail.focused && live.has(rail.focused) ? rail.focused : null;
  if (focused === rail.focused && collapsed.length === rail.collapsed.length) return rail;
  return { focused, collapsed };
}

export function railViolations(rail, ids) {
  const live = new Set(ids);
  const bad = [];
  if (rail.focused && !live.has(rail.focused)) bad.push(`focused ${rail.focused} does not exist`);
  if (rail.focused && rail.collapsed.includes(rail.focused)) bad.push(`focused ${rail.focused} is also collapsed`);
  if (new Set(rail.collapsed).size !== rail.collapsed.length) bad.push('a thread is collapsed twice');
  for (const id of rail.collapsed) if (!live.has(id)) bad.push(`collapsed ${id} does not exist`);
  return bad;
}

const RUNNING = new Set(['queued', 'starting', 'thinking', 'running']);

export function isAbandoned(thread, { turns = [], draft = '' } = {}) {
  if (!thread) return false;
  if (thread.hydrated !== true) return false;
  if (RUNNING.has(thread.runState)) return false;
  if (String(draft ?? '').trim()) return false;
  return !turns.some((item) => item?.type === 'user' && String(item.text ?? '').trim());
}

export function threadDigest(thread, items, { since = 0 } = {}) {
  const fresh = items
    .filter((item) => (item.cursor ?? 0) > since)
    .filter((item) => item.type === 'user' || item.type === 'assistant')
    .filter((item) => !item.agentId && String(item.text || '').trim());
  if (!fresh.length) return null;
  const lines = fresh.map((item) => `${item.type === 'user' ? 'User' : 'You'}: ${String(item.text).trim()}`);
  const quote = flat(thread.sidechat?.quote).slice(0, 220);
  return `── side thread on: "${quote}"\n${lines.join('\n')}`;
}

export function spliceBlock(digests) {
  const parts = digests.filter(Boolean);
  if (!parts.length) return '';
  return [
    '<side-threads>',
    'While reading your last message User opened side threads on specific passages.',
    'They were answered separately and are not in this transcript. They are here so',
    'you have the context; do not answer them again, and do not mention this block.',
    '',
    parts.join('\n\n'),
    '</side-threads>',
    ''
  ].join('\n');
}
