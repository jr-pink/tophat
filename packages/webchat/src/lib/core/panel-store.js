// The pane layout, kept across a reload.
//
// Nothing wrote the layout anywhere: boot knew only the one chat named by ?chat= (or opened a fresh blank chat), so every
// reload collapsed N panes to one. The layout is now written whenever it changes and read back synchronously at boot,
// before the network, the replica or the URL has been consulted.
//
// Storage is the kit's now. This module is the pure part: what of a layout survives a reload (serializeLayout) and what is
// a valid saved layout (parseLayout, which treats anything that is not a version it knows and a valid layout as absent and
// never throws).
//
// Version 2: each pane is an editor group with an ordered list of tabs (`tabs`), `panels[i]` being its active tab. A
// version-1 layout (one chat per pane) upgrades to groups with one tab each (upgradeLayout), through the kit's migration
// of the saved record and through the old `tophat.panes` import.
import { MAX_PANELS, MIN_WIDTH, violations } from './panels.js';
import { isIncognito } from './incognito.js';

export const LAYOUT_KEY = 'tophat.panes';
export const LAYOUT_VERSION = 2;

const clean = (value) => typeof value === 'string' && value.length > 0;

// A version-1 layout (no tabs) as groups with one tab each; anything else comes back as it is.
export function upgradeLayout(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout.tabs) || !Array.isArray(layout.panels)) return layout;
  return { ...layout, tabs: layout.panels.map((id) => [id]) };
}

// The layout with only the tabs `keepTab` accepts: a group left with none is gone, a group whose active tab went shows
// the one that took its place, widths are renormalised over the groups that survived (every group gone from the row
// gives its share back) and focus stays on its group, else the first. Null when nothing is left.
function keepTabs(layout, keepTab) {
  const kept = layout.tabs.map((tabs) => tabs.filter(keepTab));
  const keep = kept.map((tabs) => tabs.length > 0);
  if (!keep.some(Boolean)) return null;
  const at = (list) => list.filter((_, index) => keep[index]);
  const active = layout.panels.map((id, index) => (kept[index].includes(id)
    ? id
    : kept[index][Math.min(layout.tabs[index].indexOf(id), kept[index].length - 1)]));
  const keys = at(layout.keys);
  const focused = Math.max(0, keys.indexOf(layout.keys[layout.focused]));
  return { panels: at(active), tabs: at(kept), keys, collapsed: at(layout.collapsed), widths: at(layout.widths), focused, seq: layout.seq };
}

// Open widths over the groups that are left: each keeps its share of what remains; if none had any, they share evenly.
const shared = (widths, collapsed) => {
  const open = collapsed.filter((shut) => !shut).length;
  const total = widths.reduce((sum, width, index) => sum + (collapsed[index] ? 0 : width), 0);
  return widths.map((width, index) => (collapsed[index] ? 0 : total > 0 ? width / total : open ? 1 / open : 0));
};

// The text to store, or null when there is nothing worth restoring. Tabs that cannot exist after a reload
// are left out: an incognito chat lives in memory only, and the transient blank chat was never committed.
export function serializeLayout(layout, { transientId = null } = {}) {
  if (!layout || !Array.isArray(layout.panels) || !layout.panels.length || !Array.isArray(layout.tabs)) return null;
  const kept = keepTabs(layout, (id) => clean(id) && id !== transientId && !isIncognito(id));
  if (!kept) return null;
  let value = { ...kept, widths: shared(kept.widths, kept.collapsed) };
  // every group collapsed once the dropped one is gone: open them rather than store a layout with nothing to read
  if (value.collapsed.every(Boolean)) {
    value = { ...value, collapsed: value.collapsed.map(() => false), widths: value.collapsed.map(() => 1 / value.collapsed.length) };
  }
  return JSON.stringify({ v: LAYOUT_VERSION, layout: value });
}

// A layout from stored text, or null. `exists` (optional) is asked of each chat id; a tab whose chat is
// gone is dropped and the rest keep their sizes, focus moving to a survivor.
export function parseLayout(raw, { exists = null } = {}) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object' || (data.v !== LAYOUT_VERSION && data.v !== 1)) return null;
  const saved = data.v === 1 ? upgradeLayout(data.layout) : data.layout;
  if (!saved || typeof saved !== 'object') return null;
  const { panels, tabs, keys, collapsed, widths, focused, seq } = saved;
  if (![panels, tabs, keys, collapsed, widths].every(Array.isArray)) return null;
  if (!panels.length || panels.length > MAX_PANELS) return null;
  if (!panels.every(clean) || !keys.every(clean)) return null;
  if (!tabs.every((list) => Array.isArray(list) && list.length > 0 && list.every(clean))) return null;
  if (!collapsed.every((shut) => typeof shut === 'boolean')) return null;
  if (!widths.every((width) => typeof width === 'number' && Number.isFinite(width))) return null;
  if (!Number.isInteger(focused) || !Number.isInteger(seq) || seq < 0) return null;
  let layout = { panels, tabs, keys, collapsed, widths, focused, seq };
  if (violations(layout).length) return null;
  if (exists) layout = dropMissing(layout, exists);
  return layout && layout.panels.length ? layout : null;
}

function dropMissing(layout, exists) {
  if (layout.tabs.every((tabs) => tabs.every((id) => exists(id)))) return layout;
  const kept = keepTabs(layout, (id) => Boolean(exists(id)));
  if (!kept) return null;
  let { collapsed, widths } = kept;
  if (collapsed.every(Boolean)) {
    collapsed = collapsed.map((shut, index) => (index === kept.focused ? false : shut));
    widths = widths.map((_, index) => (index === kept.focused ? 1 : 0));
  }
  const open = collapsed.filter((shut) => !shut).length;
  let next = shared(widths, collapsed);
  if (next.some((width, index) => !collapsed[index] && width < MIN_WIDTH - 1e-9)) {
    next = collapsed.map((shut) => (shut ? 0 : 1 / open));
  }
  return { ...kept, collapsed, widths: next };
}
