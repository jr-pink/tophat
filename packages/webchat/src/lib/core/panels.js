

export const MIN_WIDTH = 0.06;


export const COLLAPSE_AT = MIN_WIDTH * 0.7;


export const RAIL_PX = 34;


// MAX_OPEN is how many panes sit side by side at full width; MAX_PANELS is the backstop on panes kept at all (the rest
// are rails). An explicit split never refuses: past MAX_OPEN the pane farthest from the new one folds to a rail, and
// past MAX_PANELS the farthest rail is dropped (its chat stays in the sidebar).
export const MAX_OPEN = 4;
export const MAX_PANELS = 12;

export function initial(conversationId = null) {
  if (!conversationId) return { panels: [], keys: [], collapsed: [], widths: [], focused: 0, seq: 0 };
  return { panels: [conversationId], keys: ['p1'], collapsed: [false], widths: [1], focused: 0, seq: 1 };
}

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);

const openCount = (collapsed) => collapsed.filter((shut) => !shut).length;

// Every exported transition is total over whatever a payload carries (a replayed log written by another build, a
// generated test step): an index that is not an integer naming a panel, or an id that is not a non-empty string, is a
// no-op returning the same state, never a throw and never a copy (the kit's validate() checks both laws).
const isPanel = (state, index) => Number.isInteger(index) && index >= 0 && index < state.panels.length;
const isId = (id) => typeof id === 'string' && id.length > 0;

function normalised(widths, collapsed) {
  const total = widths.reduce((sum, width, index) => sum + (collapsed[index] ? 0 : width), 0);
  const open = openCount(collapsed);
  if (!(total > 0)) return widths.map((_, index) => (collapsed[index] ? 0 : 1 / Math.max(open, 1)));
  return widths.map((width, index) => (collapsed[index] ? 0 : width / total));
}

// The pane farthest from `at`, rails first (a folded pane is the cheapest to lose), never `at` itself.
function farthest(state, at, { openOnly = false } = {}) {
  let best = -1;
  let bestScore = -1;
  state.panels.forEach((_, index) => {
    if (index === at) return;
    if (openOnly && state.collapsed[index]) return;
    const score = Math.abs(index - at) + (state.collapsed[index] ? 1000 : 0);
    if (score > bestScore) { best = index; bestScore = score; }
  });
  return best;
}

function insertAfter(state, at, conversationId, key = null) {
  if (state.panels.length >= MAX_PANELS) {
    const drop = farthest(state, at);
    if (drop < 0) return replaceAt(state, at, conversationId);
    return insertAfter(closeAt(state, drop), drop < at ? at - 1 : at, conversationId, key);
  }
  const from = state.collapsed[at] ? expand(state, at) : state;
  const seq = from.seq + 1;
  const panels = [...from.panels];
  const keys = [...from.keys];
  const collapsed = [...from.collapsed];
  const widths = [...from.widths];
  const donor = widths[at] ?? 1;
  panels.splice(at + 1, 0, conversationId);
  keys.splice(at + 1, 0, key ?? `p${seq}`);
  collapsed.splice(at + 1, 0, false);
  let next;
  if (donor / 2 < MIN_WIDTH) {
    const even = panels.map((_, index) => (collapsed[index] ? 0 : 1));
    next = { panels, keys, collapsed, widths: normalised(even, collapsed), focused: at + 1, seq };
  } else {
    widths.splice(at + 1, 0, donor / 2);
    widths[at] = donor / 2;
    next = { panels, keys, collapsed, widths: normalised(widths, collapsed), focused: at + 1, seq };
  }
  // Make room by folding the open pane farthest from the new one, never the new one or the one it split from.
  while (openCount(next.collapsed) > MAX_OPEN) {
    const fold = farthest({ ...next, collapsed: next.collapsed.map((shut, index) => shut || index === at + 1 || index === at) }, at + 1, { openOnly: true });
    if (fold < 0) break;
    next = { ...collapse(next, fold), focused: at + 1 };
  }
  return next;
}

function replaceAt(state, at, conversationId) {
  const panels = [...state.panels];
  panels[at] = conversationId;
  
  
  if (state.collapsed[at]) return expand({ ...state, panels }, at);
  return { ...state, panels, focused: at };
}

function closeAt(state, at) {
  
  
  if (state.panels.length <= 1) return state;
  const keep = (_, index) => index !== at;
  const panels = state.panels.filter(keep);
  const keys = state.keys.filter(keep);
  const collapsed = state.collapsed.filter(keep);
  const widths = state.widths.filter(keep);
  const next = {
    panels,
    keys,
    collapsed,
    widths: normalised(widths, collapsed),
    
    
    focused: clamp(at - 1, 0, panels.length - 1),
    seq: state.seq
  };
  
  return collapsed.every(Boolean) ? expand(next, next.focused) : next;
}

export function activate(state, conversationId) {
  if (!isId(conversationId)) return state;
  if (!state.panels.length) return initial(conversationId);
  const at = state.panels.indexOf(conversationId);
  if (at !== -1) return expand(state, at);
  return replaceAt(state, state.focused, conversationId);
}

export const COMFORTABLE_PX = 480;


export function panelPx(state, index, viewportPx) {
  if (!Number.isFinite(viewportPx) || viewportPx <= 0) return 0;
  if (index < 0 || index >= state.panels.length) return 0;
  if (state.collapsed[index]) return RAIL_PX;
  const rails = state.collapsed.filter(Boolean).length * RAIL_PX;
  return Math.max(0, viewportPx - rails) * state.widths[index];
}

export function splitFits(state, viewportPx, { comfortable = COMFORTABLE_PX } = {}) {
  if (!Number.isFinite(viewportPx) || viewportPx <= 0) return false;
  if (!state.panels.length) return false;
  if (openCount(state.collapsed) >= MAX_OPEN) return false;
  return panelPx(state, state.focused, viewportPx) / 2 >= comfortable;
}

export function openContextual(state, conversationId, { viewportPx, comfortable } = {}) {
  if (!isId(conversationId)) return state;
  if (!state.panels.length) return initial(conversationId);
  if (state.panels.includes(conversationId)) return activate(state, conversationId);
  return splitFits(state, viewportPx, { comfortable })
    ? insertAfter(state, state.focused, conversationId)
    : replaceAt(state, state.focused, conversationId);
}

// Whether a gesture lands beside the focused panel. `true` is him asking outright (⇧⌘↵); 'fit'
// is ⌘↵, which splits when the focused panel can spare the width and replaces it when not;
// anything else replaces.
export function willSplit(state, split, viewportPx) {
  if (!state.panels.length) return false;
  if (split === true) return true;
  return split === 'fit' && splitFits(state, viewportPx);
}

export function openFor(state, conversationId, { split = false, viewportPx } = {}) {
  if (!isId(conversationId)) return state;
  if (split === true) return openBeside(state, conversationId);
  if (split === 'fit') return openContextual(state, conversationId, { viewportPx });
  return activate(state, conversationId);
}

export function openBeside(state, conversationId) {
  if (!isId(conversationId)) return state;
  if (!state.panels.length) return initial(conversationId);
  if (state.panels.includes(conversationId)) return activate(state, conversationId);
  return insertAfter(state, state.focused, conversationId);
}

export function focusPanel(state, index) {
  if (!state.panels.length || !Number.isInteger(index)) return state;
  const focused = clamp(index, 0, state.panels.length - 1);
  return focused === state.focused ? state : { ...state, focused };
}

// The pane Ctrl-H (delta -1) or Ctrl-L (delta +1) lands on: the next open pane in tree order,
// which for this flat layout is left to right. A collapsed pane is a rail, not a place to type,
// so it is stepped over. Null when there is nowhere to go (the ends do not wrap, like vim).
export function neighbour(state, delta) {
  let at = state.focused + delta;
  while (at >= 0 && at < state.panels.length) {
    if (!state.collapsed[at]) return at;
    at += delta;
  }
  return null;
}

export function closePanel(state, index) {
  if (!isPanel(state, index)) return state;
  return closeAt(state, index);
}

export function collapse(state, index) {
  if (!isPanel(state, index)) return state;
  if (state.collapsed[index]) return state;
  if (openCount(state.collapsed) <= 1) return state;
  const collapsed = [...state.collapsed];
  collapsed[index] = true;
  const widths = [...state.widths];
  widths[index] = 0;
  return { ...state, collapsed, widths: normalised(widths, collapsed) };
}

export function expand(state, index) {
  if (!isPanel(state, index)) return state;
  if (!state.collapsed[index]) return state.focused === index ? state : { ...state, focused: index };
  const collapsed = [...state.collapsed];
  collapsed[index] = false;
  const open = openCount(collapsed);
  const share = 1 / open;
  let widths = state.widths.map((width, at) => {
    if (collapsed[at]) return 0;
    return at === index ? share : width * (1 - share);
  });
  
  
  
  
  
  if (widths.some((width, at) => !collapsed[at] && width < MIN_WIDTH)) {
    widths = collapsed.map((shut) => (shut ? 0 : 1 / open));
  }
  return { ...state, collapsed, widths: normalised(widths, collapsed), focused: index };
}


export function togglePanel(state, index) {
  if (!isPanel(state, index)) return state;
  return state.collapsed[index] ? expand(state, index) : focusPanel(state, index);
}

export function duplicatePanel(state, index) {
  if (!isPanel(state, index)) return state;
  if (state.panels.length >= MAX_PANELS) return state;
  return insertAfter(state, index, state.panels[index]);
}


// A new panel with its own id, showing `chat`, right after the panel `after`. Absolute: the id already there, or a
// missing anchor is a no-op (same state).
export function addPanel(state, { id, chat, after } = {}) {
  if (!isId(id) || !isId(chat) || state.keys.includes(id)) return state;
  const at = state.keys.indexOf(after);
  if (at < 0) return state;
  return insertAfter(state, at, chat, id);
}

export function movePanel(state, index, delta) {
  if (!isPanel(state, index) || !Number.isInteger(delta) || delta === 0) return state;
  const to = index + delta;
  if (to < 0 || to >= state.panels.length) return state;
  const swap = (list) => {
    const next = [...list];
    [next[index], next[to]] = [next[to], next[index]];
    return next;
  };
  return {
    panels: swap(state.panels),
    keys: swap(state.keys),
    collapsed: swap(state.collapsed),
    widths: swap(state.widths),
    
    focused: state.focused === index ? to : state.focused === to ? index : state.focused,
    seq: state.seq
  };
}

export function resize(state, index, delta) {
  if (!isPanel(state, index) || !Number.isFinite(delta) || delta === 0) return state;
  return resizeTo(state, index, state.widths[index] + delta);
}

// The divider left of panel `index + 1` put where the panel at `index` is `wanted` wide (a fraction of the open
// width): the clamp and the collapse threshold of `resize`, from an absolute target, so the logged action is the same
// on a repeat (a second identical `pane.resize` finds the width already there, or the panel already a rail).
export function resizeTo(state, index, wanted) {
  if (!isPanel(state, index) || index >= state.panels.length - 1) return state;
  if (!Number.isFinite(wanted) || wanted === state.widths[index]) return state;
  if (state.collapsed[index] || state.collapsed[index + 1]) return state;
  const widths = [...state.widths];
  const pair = widths[index] + widths[index + 1];
  if (wanted < COLLAPSE_AT) return collapse(state, index);
  if (pair - wanted < COLLAPSE_AT) return collapse(state, index + 1);
  const next = clamp(wanted, MIN_WIDTH, pair - MIN_WIDTH);
  if (next === widths[index]) return state;
  widths[index] = next;
  widths[index + 1] = pair - next;
  return { ...state, widths };
}

export function prune(state, exists) {
  if (!state.panels.length) return state;
  const keep = state.panels.map((id) => exists(id));
  if (keep.every(Boolean)) return state;
  const at = (list) => list.filter((_, index) => keep[index]);
  const panels = at(state.panels);
  if (!panels.length) return initial(null);
  const collapsed = at(state.collapsed);
  const keys = at(state.keys);
  const stillThere = keys.indexOf(state.keys[state.focused]);
  const next = {
    panels,
    keys,
    collapsed,
    widths: normalised(at(state.widths), collapsed),
    focused: stillThere === -1 ? 0 : stillThere,
    seq: state.seq
  };
  return collapsed.every(Boolean) ? expand(next, next.focused) : next;
}


export function violations(state) {
  const out = [];
  if (!Array.isArray(state.panels) || !Array.isArray(state.widths)
      || !Array.isArray(state.keys) || !Array.isArray(state.collapsed)) return ['not a panel state'];
  const sameLength = [state.keys, state.collapsed, state.widths]
    .every((list) => list.length === state.panels.length);
  if (!sameLength) out.push('a panel missing its key, width or rail state');
  if (state.panels.length > MAX_PANELS) out.push(`${state.panels.length} panels, over the cap`);
  
  
  
  if (new Set(state.keys).size !== state.keys.length) out.push('two panels with the same key');
  if (state.panels.length) {
    if (!Number.isInteger(state.focused) || state.focused < 0 || state.focused >= state.panels.length) {
      out.push(`focus ${state.focused} is not a panel`);
    }
    const open = openCount(state.collapsed);
    if (!open) out.push('every panel collapsed, nothing to read');
    const total = state.widths.reduce((sum, width, index) => sum + (state.collapsed[index] ? 0 : width), 0);
    if (open && Math.abs(total - 1) > 1e-9) out.push(`open widths sum to ${total}, not 1`);
    if (state.widths.some((width, index) => state.collapsed[index] && width !== 0)) {
      out.push('a collapsed panel holding a width');
    }
    
    
    if (state.widths.some((width, index) => !state.collapsed[index] && width < MIN_WIDTH - 1e-9)) {
      out.push('an open panel narrower than the minimum');
    }
  } else if (state.focused !== 0) {
    out.push('focus without panels');
  }
  return out;
}
