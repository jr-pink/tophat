// The pane layout, kept across a reload.
//
// Nothing wrote the layout anywhere: boot knew only the one chat named by ?chat= (or opened a fresh blank chat), so
// every reload collapsed N panes to one. The layout is now written whenever it changes and read back synchronously
// at boot, before the network, the replica or the URL has been consulted.
//
// Storage is the kit's now. This module is the pure part: what of a layout survives a reload (serializeLayout) and
// what is a valid saved layout (parseLayout, which treats anything that is not exactly this version and a valid
// layout as absent and never throws).
import { MAX_PANELS, MIN_WIDTH, violations } from './panels.js';
import { isIncognito } from './incognito.js';

export const LAYOUT_KEY = 'tophat.panes';
export const LAYOUT_VERSION = 1;

const clean = (value) => typeof value === 'string' && value.length > 0;

// The text to store, or null when there is nothing worth restoring. Panes that cannot exist after a reload
// are left out: an incognito chat lives in memory only, and the transient blank chat was never committed.
export function serializeLayout(layout, { transientId = null } = {}) {
  if (!layout || !Array.isArray(layout.panels) || !layout.panels.length) return null;
  const keep = layout.panels.map((id) => clean(id) && id !== transientId && !isIncognito(id));
  if (!keep.some(Boolean)) return null;
  const at = (list) => list.filter((_, index) => keep[index]);
  const panels = at(layout.panels);
  const collapsed = at(layout.collapsed);
  const open = collapsed.filter((shut) => !shut).length;
  // widths are renormalised over what survived; every pane gone from the row gives its share back
  const widths = at(layout.widths);
  const total = widths.reduce((sum, width, index) => sum + (collapsed[index] ? 0 : width), 0);
  const shares = widths.map((width, index) => (collapsed[index] ? 0 : total > 0 ? width / total : open ? 1 / open : 0));
  const keys = at(layout.keys);
  const focusedKey = layout.keys[layout.focused];
  const focused = Math.max(0, keys.indexOf(focusedKey));
  let value = { panels, keys, collapsed, widths: shares, focused, seq: layout.seq };
  // every pane collapsed once the dropped one is gone: open the focused one rather than store a layout with nothing to read
  if (!open) {
    value = { ...value, collapsed: collapsed.map(() => false), widths: collapsed.map(() => 1 / collapsed.length) };
  }
  return JSON.stringify({ v: LAYOUT_VERSION, layout: value });
}

// A layout from stored text, or null. `exists` (optional) is asked of each chat id; a pane whose chat is
// gone is dropped and the rest keep their sizes, focus moving to a survivor.
export function parseLayout(raw, { exists = null } = {}) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object' || data.v !== LAYOUT_VERSION) return null;
  const saved = data.layout;
  if (!saved || typeof saved !== 'object') return null;
  const { panels, keys, collapsed, widths, focused, seq } = saved;
  if (![panels, keys, collapsed, widths].every(Array.isArray)) return null;
  if (!panels.length || panels.length > MAX_PANELS) return null;
  if (!panels.every(clean) || !keys.every(clean)) return null;
  if (!collapsed.every((shut) => typeof shut === 'boolean')) return null;
  if (!widths.every((width) => typeof width === 'number' && Number.isFinite(width))) return null;
  if (!Number.isInteger(focused) || !Number.isInteger(seq) || seq < 0) return null;
  let layout = { panels, keys, collapsed, widths, focused, seq };
  if (violations(layout).length) return null;
  if (exists) layout = dropMissing(layout, exists);
  return layout && layout.panels.length ? layout : null;
}

function dropMissing(layout, exists) {
  const keep = layout.panels.map((id) => Boolean(exists(id)));
  if (keep.every(Boolean)) return layout;
  if (!keep.some(Boolean)) return null;
  const at = (list) => list.filter((_, index) => keep[index]);
  const panels = at(layout.panels);
  const keys = at(layout.keys);
  let collapsed = at(layout.collapsed);
  let widths = at(layout.widths);
  const focusedKey = layout.keys[layout.focused];
  const focused = Math.max(0, keys.indexOf(focusedKey));
  if (collapsed.every(Boolean)) {
    collapsed = collapsed.map((shut, index) => (index === focused ? false : shut));
    widths = widths.map((_, index) => (index === focused ? 1 : 0));
  }
  const open = collapsed.filter((shut) => !shut).length;
  let total = widths.reduce((sum, width, index) => sum + (collapsed[index] ? 0 : width), 0);
  let next = widths.map((width, index) => (collapsed[index] ? 0 : total > 0 ? width / total : 1 / open));
  if (next.some((width, index) => !collapsed[index] && width < MIN_WIDTH - 1e-9)) {
    next = collapsed.map((shut) => (shut ? 0 : 1 / open));
  }
  return { panels, keys, collapsed, widths: next, focused, seq: layout.seq };
}
