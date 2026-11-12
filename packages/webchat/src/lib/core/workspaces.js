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
  // The dragged folder moves with its whole subtree as one block, so the order stays depth first and a repeated move is
  // the same order.
  const block = flat.filter((k) => tree.isWithin(k, drag));
  const order = flat.filter((k) => !tree.isWithin(k, drag));
  let at;
  if (where === 'inside' || target === ROOT) {
    // Last among its new siblings: after the parent's whole subtree.
    at = newParent === ROOT ? order.length : order.indexOf(newParent) + 1;
    if (newParent !== ROOT) for (let i = 0; i < order.length; i += 1) if (tree.isWithin(order[i], newParent)) at = i + 1;
  } else if (where === 'before') {
    at = order.indexOf(target);
  } else {
    at = order.indexOf(target) + 1;
    while (at < order.length && tree.isWithin(order[at], target)) at += 1;
  }
  order.splice(at, 0, ...block);
  const parent = { ...base.parent };
  if (newParent === ROOT) delete parent[drag]; else parent[drag] = newParent;
  return { order, parent };
}

/** The layout after a folder is renamed: its key and every reference to it follow. */
export function renamedLayout(layout, from, to) {
  const a = folderKey(from), b = folderKey(to);
  const { order, parent } = cleanLayout(layout);
  // Nothing to rename (same key, or the key is nowhere in the layout): the same layout back, so the reducer is a no-op.
  if (a === b || (!order.includes(a) && !(a in parent) && !Object.values(parent).includes(a))) return layout;
  const swap = (k) => (k === a ? b : k);
  const next = {};
  for (const [k, v] of Object.entries(parent)) next[swap(k)] = swap(v);
  return { order: order.map(swap), parent: next };
}

/** The layout after a folder is removed: its children move up to its parent. */
export function removedLayout(layout, name) {
  const gone = folderKey(name);
  const { order, parent } = cleanLayout(layout);
  // Nothing names the folder: the same layout back, so a reducer removing an absent folder is a no-op (same reference).
  if (!order.includes(gone) && !(gone in parent) && !Object.values(parent).includes(gone)) return layout;
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
  const next = names.filter((n) => !sameName(n, name));
  return next.length === names.length ? names : next;
}

export function renamedIn(names, from, to) {
  const clean = normalizeWorkspace(to);
  if (!clean) return names;
  const at = names.findIndex((n) => sameName(n, from));
  if (at < 0) return withName(names, clean);
  const next = names.filter((n, i) => i === at || !sameName(n, clean)).map((n) => (sameName(n, from) ? clean : n));
  return next.length === names.length && next.every((n, i) => n === names[i]) ? names : next;
}

// --------------------------------------------------------------------------------------------------------------- The
// explorer. One flat list of visible rows, VS Code's tree model: each row a folder or a chat with its depth, so the
// list renders as one {#each}, indents by depth, and the keyboard walks it in order.

/**
 * The parent map the tree is drawn with: the shared place of each folder (server folder metadata, `parent` + `parentAt`,
 * the same tree the router reads) wins; a folder with no shared place yet keeps this device's old local parent.
 */
export function effectiveLayout(layout, descs = {}) {
  const base = cleanLayout(layout);
  const parent = { ...base.parent };
  for (const [k, d] of Object.entries(descs || {})) {
    if (typeof d?.parentAt !== 'string') continue;
    if (d.parent) parent[k] = d.parent; else delete parent[k];
  }
  return { order: base.order, parent };
}

/** The chain of folder keys from the top down to `key` (inclusive); [] for the top level. */
export function pathTo(tree, key) {
  const out = [];
  for (let cur = key; cur && cur !== ROOT; cur = tree.parentOf(cur)) out.unshift(cur);
  return out;
}

// Misc. Misc is virtual, never stored: a folder that has subfolders draws a last child row 'Misc' that holds the chats filed
// directly in that folder, so those chats sit apart from the subfolders; a folder with no subfolders shows its chats directly.
// Its open state is the kit's `open` flag under miscKey(folder).
export const MISC_LABEL = 'Misc';
export const miscKey = (folder) => `misc:${folder}`;

/** Visible rows, depth first. `focus` is the folder made primary (its subtree only, nothing else shown); null shows the whole
 * tree with Inbox as one top-level node. `isOpen(key)` says which folders are expanded. A search lists every matching chat flat.
 * Inside a folder: subfolders first (his order), then its chats (ranked), each followed by its forks; a folder with subfolders
 * puts its own chats under a last 'misc' row instead. `inlineOwn` lists a folder's own chats directly under it, above its
 * subfolders, with no Misc row; off by default. Folder archive: `isArchived(key)` is a folder's own flag; an archived folder and
 * its subtree are not drawn unless `showArchived`, when they draw dimmed (`archived` on the row; `archivedOwn` when it is the
 * flagged folder itself). Nothing about parent, order or membership changes, so clearing the flag restores exactly what was
 * there. `isMuted(key)` is the folder's Mute When Collapsed flag: while it is collapsed its row and its ancestors' rows show
 * no live/unread dot for anything inside it.
 */
export function explorerRows(rows, { names = [], layout = emptyLayout(), focus = null, isOpen = () => false, searching = false, newIn = null, isArchived = () => false, showArchived = false, inlineOwn = false, isMuted = () => false } = {}) {
  const out = [];
  const pushChats = (list, depth, dim = false) => {
    for (const row of list) {
      out.push({ kind: 'chat', id: row.id, row, depth, fork: false, dim });
      for (const fork of row.forks || []) out.push({ kind: 'chat', id: fork.id, row: fork, depth: depth + 1, fork: true, dim });
    }
  };
  if (searching) { pushChats(rows, 0); return out; }
  const tree = folderTree(names, layout);
  const nameOf = new Map(names.map((n) => [folderKey(n), n]));
  const members = new Map();
  for (const row of rows) {
    const own = canonicalWorkspace(row.workspace);
    const k = own ? folderKey(own) : UNFILED;
    const key = k === UNFILED || nameOf.has(k) ? k : UNFILED;
    if (!members.has(key)) members.set(key, []);
    members.get(key).push(row);
  }
  const live = (row) => row.indicator === 'live' || row.indicator === 'unread';
  const shown = (k) => k === UNFILED || showArchived || !isArchived(k);
  const subs = (k) => tree.children(k).filter(shown);
  // Mute When Collapsed: a muted folder that is collapsed is quiet, its whole subtree with it (its chats are hidden, and so
  // is anything inside it that an open subfolder would otherwise show). Nothing is read or changed; expanding the folder
  // makes the dot count again. A muted folder that is open counts as usual, its collapsed subfolders by their own rules.
  const quiet = (k) => isMuted(k) && !isOpen(k);
  const subtreeLive = (k) => !quiet(k) && ((members.get(k) || []).some(live) || subs(k).some(subtreeLive));
  // A folder's own chats: directly under it, or, when it has subfolders, under its last 'misc' row.
  const pushOwn = (k, depth, dim) => {
    const own = members.get(k) || [];
    if (inlineOwn || k === UNFILED || !subs(k).length) { pushChats(own, depth, dim); return; }
    const open = isOpen(miscKey(k));
    out.push({ kind: 'misc', id: miscKey(k), key: miscKey(k), parent: k, name: MISC_LABEL, depth, count: own.length, open, hasChildren: own.length > 0, live: !open && own.some(live), archived: dim });
    if (open) pushChats(own, depth + 1, dim);
  };
  // A folder being created is an editable row, first among the children of the folder it goes in.
  const walk = (parentKey, depth, dim) => {
    if (newIn !== null && newIn === parentKey) out.push({ kind: 'new', id: 'new', parent: parentKey, depth });
    for (const k of tree.children(parentKey)) {
      if (!shown(k)) continue;
      const own = members.get(k) || [];
      const open = isOpen(k);
      const mine = k !== UNFILED && isArchived(k), gone = dim || mine;
      out.push({ kind: 'folder', id: `f:${k}`, key: k, name: k === UNFILED ? null : nameOf.get(k) ?? null, depth, count: own.length, open,
        hasChildren: own.length > 0 || subs(k).length > 0, live: !open && subtreeLive(k), archived: gone, archivedOwn: mine });
      if (open || newIn === k) {
        if (inlineOwn) { pushOwn(k, depth + 1, gone); walk(k, depth + 1, gone); } else { walk(k, depth + 1, gone); pushOwn(k, depth + 1, gone); }
      }
    }
  };
  const root = focus ? folderKey(focus) : ROOT;
  if (root !== ROOT && !tree.all.includes(root)) { pushChats(members.get(root) || [], 0); return out; }
  walk(root, 0, false);
  if (root !== ROOT) pushOwn(root, 0, false);
  return out;
}

/**
 * The chats in a folder and everything under it: each row's folder is read as explorerRows reads it (an unknown or empty
 * name is the Inbox), then kept when that folder is `key` or lies inside it. Archived chats are not in the folder's list.
 */
export function chatsUnder(rows, key, { names = [], layout = emptyLayout() } = {}) {
  const tree = folderTree(names, layout);
  const known = new Set(names.map(folderKey));
  return rows.filter((row) => {
    if (row.archived) return false;
    const own = canonicalWorkspace(row.workspace);
    const k = own ? folderKey(own) : UNFILED;
    return tree.isWithin(known.has(k) || k === UNFILED ? k : UNFILED, key);
  });
}

/** Whether a chat sits in the focused folder's subtree (null focus: everything). */
export function inSubtree(row, focus, tree) {
  if (!focus) return true;
  const own = canonicalWorkspace(row?.workspace);
  if (!own) return false;
  return tree.isWithin(folderKey(own), folderKey(focus));
}

/**
 * The keyboard over the explorer, VS Code's: up/down move, right opens a folder or steps to its first child, left closes
 * an open folder or steps to the parent folder row. Returns { cursor, open?: {key, open} } or null when nothing moves.
 */
export function explorerKey(items, cursor, key) {
  if (!items.length) return null;
  const at = items.findIndex((it) => it.id === cursor);
  const cur = at >= 0 ? items[at] : null;
  if (key === 'down') return { cursor: items[Math.min(items.length - 1, at + 1)].id };
  if (key === 'up') return { cursor: items[Math.max(0, at < 0 ? 0 : at - 1)].id };
  if (key === 'home') return { cursor: items[0].id };
  if (key === 'end') return { cursor: items[items.length - 1].id };
  if (!cur) return { cursor: items[0].id };
  if (key === 'right') {
    if (cur.kind !== 'folder' && cur.kind !== 'misc') return null;
    if (!cur.open) return cur.hasChildren ? { cursor: cur.id, open: { key: cur.key, open: true } } : null;
    const next = items[at + 1];
    return next && next.depth > cur.depth ? { cursor: next.id } : null;
  }
  if (key === 'left') {
    if ((cur.kind === 'folder' || cur.kind === 'misc') && cur.open) return { cursor: cur.id, open: { key: cur.key, open: false } };
    for (let i = at - 1; i >= 0; i -= 1) if ((items[i].kind === 'folder' || items[i].kind === 'misc') && items[i].depth < cur.depth) return { cursor: items[i].id };
    return null;
  }
  return null;
}
