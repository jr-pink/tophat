

export const MIN_WIDTH = 0.06;


export const COLLAPSE_AT = MIN_WIDTH * 0.7;


export const RAIL_PX = 34;


// MAX_OPEN is how many panes sit side by side at full width; MAX_PANELS is the backstop on panes kept at all (the rest
// are rails). An explicit split never refuses: past MAX_OPEN the pane farthest from the new one folds to a rail, and
// past MAX_PANELS the farthest rail is dropped (its chat stays in the sidebar).
export const MAX_OPEN = 4;

// The layout is a row of editor groups (VS Code's word; the code and the log still say panels). `panels[i]` is the chat
// the group at i shows, its ACTIVE tab; `tabs[i]` is the group's ordered tab strip (chat ids, no repeats within a
// group, panels[i] among them); `keys[i]` names the group. A chat can sit in two groups only by an explicit split.
export const MAX_PANELS = 12;

export function initial(conversationId = null) {
  if (!conversationId) return { panels: [], tabs: [], keys: [], collapsed: [], widths: [], focused: 0, seq: 0 };
  return { panels: [conversationId], tabs: [[conversationId]], keys: ['p1'], collapsed: [false], widths: [1], focused: 0, seq: 1 };
}

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);

const openCount = (collapsed) => collapsed.filter((shut) => !shut).length;

// Every exported transition is total over whatever a payload carries (a replayed log written by another build, a
// generated test step): an index that is not an integer naming a panel, or an id that is not a non-empty string, is a
// no-op returning the same state, never a throw and never a copy (the kit's validate() checks both laws).
const isPanel = (state, index) => Number.isInteger(index) && index >= 0 && index < state.panels.length;
const isId = (id) => typeof id === 'string' && id.length > 0;
/** Whether any group holds `chat` as a tab. */
export const isOpen = (state, chat) => state.tabs.some((tabs) => tabs.includes(chat));

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
    if (drop < 0) return openTabIn(state, at, conversationId);
    return insertAfter(closeAt(state, drop), drop < at ? at - 1 : at, conversationId, key);
  }
  const from = state.collapsed[at] ? expand(state, at) : state;
  const seq = from.seq + 1;
  const panels = [...from.panels];
  const tabs = [...from.tabs];
  const keys = [...from.keys];
  const collapsed = [...from.collapsed];
  const widths = [...from.widths];
  const donor = widths[at] ?? 1;
  panels.splice(at + 1, 0, conversationId);
  tabs.splice(at + 1, 0, [conversationId]);
  keys.splice(at + 1, 0, key ?? `p${seq}`);
  collapsed.splice(at + 1, 0, false);
  let next;
  if (donor / 2 < MIN_WIDTH) {
    const even = panels.map((_, index) => (collapsed[index] ? 0 : 1));
    next = { panels, tabs, keys, collapsed, widths: normalised(even, collapsed), focused: at + 1, seq };
  } else {
    widths.splice(at + 1, 0, donor / 2);
    widths[at] = donor / 2;
    next = { panels, tabs, keys, collapsed, widths: normalised(widths, collapsed), focused: at + 1, seq };
  }
  // Make room by folding the open pane farthest from the new one, never the new one or the one it split from.
  while (openCount(next.collapsed) > MAX_OPEN) {
    const fold = farthest({ ...next, collapsed: next.collapsed.map((shut, index) => shut || index === at + 1 || index === at) }, at + 1, { openOnly: true });
    if (fold < 0) break;
    next = { ...collapse(next, fold), focused: at + 1 };
  }
  return next;
}

// Make `chat` the active tab of group `at` (it is already one of its tabs) and focus the group, opening it when it was a rail.
function setActive(state, at, chat) {
  if (state.panels[at] === chat) return expand(state, at);
  const panels = [...state.panels];
  panels[at] = chat;
  return expand({ ...state, panels }, at);
}

// Open `chat` as a tab of group `at`, right after the active tab (VS Code), and make it the active one. Already a tab
// of the group: only activate it.
function openTabIn(state, at, chat) {
  const tabs = state.tabs[at];
  if (tabs.includes(chat)) return setActive(state, at, chat);
  const next = [...tabs];
  next.splice(tabs.indexOf(state.panels[at]) + 1, 0, chat);
  const all = [...state.tabs];
  all[at] = next;
  return setActive({ ...state, tabs: all }, at, chat);
}

function closeAt(state, at) {
  
  
  if (state.panels.length <= 1) return state;
  const keep = (_, index) => index !== at;
  const panels = state.panels.filter(keep);
  const tabs = state.tabs.filter(keep);
  const keys = state.keys.filter(keep);
  const collapsed = state.collapsed.filter(keep);
  const widths = state.widths.filter(keep);
  const next = {
    panels,
    tabs,
    keys,
    collapsed,
    widths: normalised(widths, collapsed),
    
    
    // closing the focused one moves left, where the eye already is; closing another leaves the focus where it was
    focused: at === state.focused ? clamp(at - 1, 0, panels.length - 1) : state.focused > at ? state.focused - 1 : state.focused,
    seq: state.seq
  };
  
  return collapsed.every(Boolean) ? expand(next, next.focused) : next;
}

// Opening a chat from the list (VS Code's open-editor): already a tab of the focused group, activate it there; the
// active tab of another group, or a tab in one, focus it there rather than showing the chat twice; otherwise a new
// tab in the focused group.
export function activate(state, conversationId) {
  if (!isId(conversationId)) return state;
  if (!state.panels.length) return initial(conversationId);
  if (state.tabs[state.focused].includes(conversationId)) return setActive(state, state.focused, conversationId);
  const active = state.panels.indexOf(conversationId);
  if (active !== -1) return expand(state, active);
  const holder = state.tabs.findIndex((tabs) => tabs.includes(conversationId));
  if (holder !== -1) return setActive(state, holder, conversationId);
  return openTabIn(state, state.focused, conversationId);
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
  if (isOpen(state, conversationId)) return activate(state, conversationId);
  return splitFits(state, viewportPx, { comfortable })
    ? insertAfter(state, state.focused, conversationId)
    : openTabIn(state, state.focused, conversationId);
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
  if (isOpen(state, conversationId)) return activate(state, conversationId);
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


// A new panel with its own id, showing `chat`, right after the panel `after` (or right before the panel `before`: a
// drop on a group's left edge). Absolute: the id already there, or a missing anchor is a no-op (same state).
export function addPanel(state, p) {
  const { id, chat, after, before } = p ?? {};
  if (!isId(id) || !isId(chat) || state.keys.includes(id)) return state;
  const anchor = isId(before) ? before : after;
  const at = state.keys.indexOf(anchor);
  if (at < 0) return state;
  const added = insertAfter(state, at, chat, id);
  if (!isId(before)) return added;
  const index = added.keys.indexOf(id);
  return movePanel(added, index, -1);
}

// One tab of a group, closed. The group's last tab takes the group with it; the last tab of the only group leaves
// nothing open (the page opens the blank chat). A tab the group does not hold, or a group that is gone, is a no-op.
export function closeTab(state, group, chat) {
  const at = state.keys.indexOf(group);
  if (at < 0 || !isId(chat)) return state;
  const tabs = state.tabs[at];
  const index = tabs.indexOf(chat);
  if (index < 0) return state;
  if (tabs.length === 1) return state.panels.length > 1 ? closeAt(state, at) : initial(null);
  const rest = tabs.filter((tab) => tab !== chat);
  const all = [...state.tabs];
  all[at] = rest;
  if (state.panels[at] !== chat) return { ...state, tabs: all };
  // the tab that takes its place, else the one on its left
  const panels = [...state.panels];
  panels[at] = rest[Math.min(index, rest.length - 1)];
  return { ...state, tabs: all, panels };
}

// `chat` opened as a tab of group `group`, at position `at` (default: right after the active tab), and made active. Already
// a tab of that group: only activated, where it is.
export function openTab(state, group, chat, at) {
  const index = state.keys.indexOf(group);
  if (index < 0 || !isId(chat)) return state;
  if (state.tabs[index].includes(chat) || !Number.isInteger(at)) return openTabIn(state, index, chat);
  const next = [...state.tabs[index]];
  next.splice(clamp(at, 0, next.length), 0, chat);
  const all = [...state.tabs];
  all[index] = next;
  return setActive({ ...state, tabs: all }, index, chat);
}

// Group `group` keeps only the tabs listed in `keep` (those it holds); the others close. A group left with none is closed, the
// only group leaves nothing open. An active tab that closed gives way to the kept tab nearest its place. Absolute: a repeat
// finds nothing left to close. (Close others, close to the right, close all.)
export function keepTabs(state, group, keep) {
  const at = state.keys.indexOf(group);
  if (at < 0 || !Array.isArray(keep)) return state;
  const tabs = state.tabs[at];
  const kept = tabs.filter((tab) => keep.includes(tab));
  if (kept.length === tabs.length) return state;
  if (!kept.length) return state.panels.length > 1 ? closeAt(state, at) : initial(null);
  const all = [...state.tabs];
  all[at] = kept;
  if (kept.includes(state.panels[at])) return { ...state, tabs: all };
  const place = tabs.indexOf(state.panels[at]);
  const panels = [...state.panels];
  panels[at] = kept.find((tab) => tabs.indexOf(tab) > place) ?? kept.at(-1);
  return { ...state, tabs: all, panels };
}

export function activateTab(state, group, chat) {
  const at = state.keys.indexOf(group);
  if (at < 0 || !isId(chat) || !state.tabs[at].includes(chat)) return state;
  return setActive(state, at, chat);
}

// A tab moved to position `index` of group `to` (clamped), out of group `from`: a reorder when they are the same group.
// The moved tab becomes the destination's active tab and the destination is focused; a source left with no tab is closed.
// Absolute: once the tab has left `from` (or sits at `index`) a repeat finds nothing to do.
export function moveTab(state, { chat, from, to, index } = {}) {
  const f = state.keys.indexOf(from);
  const t = state.keys.indexOf(to);
  if (f < 0 || t < 0 || !isId(chat) || !state.tabs[f].includes(chat)) return state;
  const wanted = (length) => clamp(Number.isInteger(index) ? index : length, 0, length);
  if (f === t) {
    const tabs = state.tabs[f];
    const target = wanted(tabs.length - 1);
    if (tabs.indexOf(chat) === target) return state;
    const rest = tabs.filter((tab) => tab !== chat);
    rest.splice(target, 0, chat);
    const all = [...state.tabs];
    all[f] = rest;
    return { ...state, tabs: all };
  }
  const source = state.tabs[f].filter((tab) => tab !== chat);
  const dest = state.tabs[t].filter((tab) => tab !== chat);
  dest.splice(wanted(dest.length), 0, chat);
  const all = [...state.tabs];
  all[f] = source;
  all[t] = dest;
  const panels = [...state.panels];
  panels[t] = chat;
  if (state.panels[f] === chat && source.length) panels[f] = source[Math.min(state.tabs[f].indexOf(chat), source.length - 1)];
  let next = { ...state, tabs: all, panels };
  if (!source.length) next = closeAt(next, f);
  return expand(next, next.keys.indexOf(to));
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
    tabs: swap(state.tabs),
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

// Every group forgets the tabs `exists` refuses; a group left with none goes; a group whose active tab went shows the one
// that took its place.
export function prune(state, exists) {
  if (!state.panels.length) return state;
  const kept = state.tabs.map((tabs) => tabs.filter((id) => exists(id)));
  if (kept.every((tabs, index) => tabs.length === state.tabs[index].length)) return state;
  const keep = kept.map((tabs) => tabs.length > 0);
  if (!keep.some(Boolean)) return initial(null);
  const at = (list) => list.filter((_, index) => keep[index]);
  const active = state.panels.map((id, index) => {
    if (kept[index].includes(id)) return id;
    return kept[index][Math.min(state.tabs[index].indexOf(id), kept[index].length - 1)];
  });
  const panels = at(active);
  const tabs = at(kept);
  const collapsed = at(state.collapsed);
  const keys = at(state.keys);
  const stillThere = keys.indexOf(state.keys[state.focused]);
  const next = {
    panels,
    tabs,
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
  if (!Array.isArray(state.panels) || !Array.isArray(state.widths) || !Array.isArray(state.tabs)
      || !Array.isArray(state.keys) || !Array.isArray(state.collapsed)) return ['not a panel state'];
  const sameLength = [state.tabs, state.keys, state.collapsed, state.widths]
    .every((list) => list.length === state.panels.length);
  if (!sameLength) out.push('a panel missing its tabs, key, width or rail state');
  state.tabs.forEach((tabs, index) => {
    if (!Array.isArray(tabs) || !tabs.length || !tabs.every(isId)) out.push(`group ${index} without a valid tab list`);
    else if (new Set(tabs).size !== tabs.length) out.push(`group ${index} holds a tab twice`);
    else if (!tabs.includes(state.panels[index])) out.push(`group ${index} shows a chat that is not one of its tabs`);
  });
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
