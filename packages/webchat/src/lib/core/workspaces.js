// Workspaces: named, foldable groups a thing is filed under, so that while he is focused on one
// the rest of the list folds away. like tabgroups, folds down, named...
//
// Deliberately not chat-specific: an item is anything with an `id` and a `workspace` field (a
// chat today; a reader document or a doc later). The workspace's name is its identity, carried
// on each item, so every device sees the same groups with no second table to sync; a workspace
// with nothing in it yet lives in this device's list until the first item lands in it. Which
// workspace he is in is per device. No link to the memory store's entities yet, on purpose.

export const MAX_NAME = 60;

/** A workspace name as stored: trimmed, single-spaced, bounded; empty is "unfiled" (null). */
export function normalizeWorkspace(name) {
  if (typeof name !== 'string') return null;
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return clean || null;
}

const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// The catch-all fold. Unfiled chats and chats whose workspace is "Inbox" are one set, shown in one
// fold labelled CATCHALL_LABEL; it is never a folder a chat is filed into, and nothing creates it.
// The stored workspace on old chats is left as it was (append-only events); it is only read as
// unfiled.
export const CATCHALL_LABEL = 'Inbox';
export const isCatchAll = (name) => sameName(normalizeWorkspace(name), CATCHALL_LABEL);

/** A workspace name to store or compare: normalized, with the catch-all's name read as unfiled (null). */
export function canonicalWorkspace(name) {
  const clean = normalizeWorkspace(name);
  return clean && !isCatchAll(clean) ? clean : null;
}

/**
 * Every workspace, in a stable order: the ones this device created (in creation order), then any
 * other name found on an item, alphabetically.
 */
export function listWorkspaces(items, local = []) {
  const out = [];
  const seen = new Set();
  const add = (name) => {
    const clean = canonicalWorkspace(name);
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    out.push(clean);
  };
  for (const name of local) add(name);
  const found = [];
  for (const item of Object.values(items || {})) if (item?.workspace) found.push(item.workspace);
  found.sort((a, b) => a.localeCompare(b));
  for (const name of found) add(name);
  return out;
}

/** Whether an item is in the named workspace; `null` asks for the unfiled ones. */
export function inWorkspace(item, name) {
  const own = canonicalWorkspace(item?.workspace);
  const want = canonicalWorkspace(name);
  if (!want) return !own;
  return sameName(own, want);
}

// Folder layout. A device-local tree over the workspace names plus "Everything else" (the unfiled
// chats): `order` is every folder key in his order, `parent` maps a key to the folder it sits
// inside. Keys are lowercased names; UNFILED is Everything else, which can be moved but never
// nested.
export const UNFILED = '\u0000unfiled';
export const ROOT = '';
export const folderKey = (name) => (name ? String(name).toLowerCase() : UNFILED);

export function emptyLayout() { return { order: [], parent: {} }; }

export function cleanLayout(layout) {
  const order = Array.isArray(layout?.order) ? layout.order.filter((k) => typeof k === 'string') : [];
  const parent = {};
  if (layout?.parent && typeof layout.parent === 'object') {
    for (const [k, v] of Object.entries(layout.parent)) if (typeof v === 'string' && k !== UNFILED) parent[k] = v;
  }
  return { order, parent };
}

/** The tree resolver: keys in display order, each key's parent, children of a key. */
export function folderTree(names = [], layout = emptyLayout()) {
  const { order, parent } = cleanLayout(layout);
  const all = [...names.map(folderKey), UNFILED];
  const known = new Set(all);
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length + all.indexOf(k) : i; };
  const raw = (k) => (k !== UNFILED && parent[k] && known.has(parent[k]) ? parent[k] : ROOT);
  const parentOf = (k) => {
    const p = raw(k);
    if (p === ROOT) return ROOT;
    // A cycle (hand-edited storage, a rename collision) puts the folder back at the top.
    const seen = new Set([k]);
    for (let cur = p; cur !== ROOT; cur = raw(cur)) {
      if (seen.has(cur)) return ROOT;
      seen.add(cur);
    }
    return p;
  };
  const children = (k) => all.filter((c) => parentOf(c) === k).sort((a, b) => rank(a) - rank(b));
  const isWithin = (k, ancestor) => { for (let cur = k; cur && cur !== ROOT; cur = parentOf(cur)) if (cur === ancestor) return true; return false; };
  return { all, parentOf, children, isWithin };
}

/**
 * Move folder `drag` before, after or inside `target`. Returns the new layout, or the old one
 * unchanged when the move is impossible (onto itself, into its own subtree, Everything else
 * nested inside something).
 */
export function moveFolder(names, layout, drag, target, where) {
  const tree = folderTree(names, layout);
  const base = cleanLayout(layout);
  if (!tree.all.includes(drag) || drag === target) return layout;
  if (target !== ROOT && !tree.all.includes(target)) return layout;
  if (target !== ROOT && tree.isWithin(target, drag)) return layout;
  const newParent = where === 'inside' ? target : target === ROOT ? ROOT : tree.parentOf(target);
  if (drag === UNFILED && newParent !== ROOT) return layout;
  // Full order as currently displayed (depth first), then splice the dragged key in.
  const flat = [];
  const walk = (k) => { for (const c of tree.children(k)) { flat.push(c); walk(c); } };
  walk(ROOT);
  const order = flat.filter((k) => k !== drag);
  if (where === 'inside' || target === ROOT) {
    const sibs = order.filter((k) => (k === drag ? false : (newParent === ROOT ? tree.parentOf(k) === ROOT : tree.parentOf(k) === newParent)));
    const last = sibs.length ? order.indexOf(sibs[sibs.length - 1]) + 1 : (newParent === ROOT ? order.length : order.indexOf(newParent) + 1);
    order.splice(last, 0, drag);
  } else {
    const at = order.indexOf(target);
    order.splice(where === 'before' ? at : at + 1, 0, drag);
  }
  const parent = { ...base.parent };
  if (newParent === ROOT) delete parent[drag]; else parent[drag] = newParent;
  return { order, parent };
}

/** The layout after a folder is renamed: its key and every reference to it follow. */
export function renamedLayout(layout, from, to) {
  const a = folderKey(from), b = folderKey(to);
  const { order, parent } = cleanLayout(layout);
  const swap = (k) => (k === a ? b : k);
  const next = {};
  for (const [k, v] of Object.entries(parent)) next[swap(k)] = swap(v);
  return { order: order.map(swap), parent: next };
}

/** The layout after a folder is removed: its children move up to its parent. */
export function removedLayout(layout, name) {
  const gone = folderKey(name);
  const { order, parent } = cleanLayout(layout);
  const up = parent[gone];
  const next = {};
  for (const [k, v] of Object.entries(parent)) {
    if (k === gone) continue;
    if (v === gone) { if (up) next[k] = up; } else next[k] = v;
  }
  return { order: order.filter((k) => k !== gone), parent: next };
}

/**
 * Split ranked rows for the sidebar. `current` is the workspace he is in (null: none, which is
 * the same as being in Everything else). `main` is that folder's own rows, `inner` its subfolders
 * (shown folded at the head of the main list), and `groups` the rest of the tree, folded, in his
 * order; each group carries its own `children`. A search shows everything.
 */
export function partitionByWorkspace(rows, { current = null, names = [], searching = false, layout = emptyLayout() } = {}) {
  if (searching) return { main: rows, groups: [], inner: [] };
  const tree = folderTree(names, layout);
  const nameOf = new Map(names.map((n) => [folderKey(n), n]));
  const here = current ? folderKey(current) : UNFILED;
  const node = (k) => {
    const name = k === UNFILED ? null : nameOf.get(k);
    return { name, key: k, rows: rows.filter((row) => inWorkspace(row, name)), children: tree.children(k).filter((c) => c !== here).map(node) };
  };
  const main = rows.filter((row) => inWorkspace(row, current));
  const inner = tree.children(here).map(node);
  const groups = tree.children(ROOT).filter((k) => k !== here).map(node);
  return { main, groups, inner };
}

/** The workspace a new item opens in: the one he is in (the default router), else none. */
export function workspaceForNew({ current = null } = {}) {
  return normalizeWorkspace(current);
}

/** Add a name to the local list (no duplicate by case); returns the new list. */
export function withName(names, name) {
  const clean = normalizeWorkspace(name);
  if (!clean || names.some((n) => sameName(n, clean))) return names;
  return [...names, clean];
}

export function withoutName(names, name) {
  return names.filter((n) => !sameName(n, name));
}

export function renamedIn(names, from, to) {
  const clean = normalizeWorkspace(to);
  if (!clean) return names;
  const at = names.findIndex((n) => sameName(n, from));
  if (at < 0) return withName(names, clean);
  const next = names.filter((n, i) => i === at || !sameName(n, clean));
  return next.map((n) => (sameName(n, from) ? clean : n));
}
