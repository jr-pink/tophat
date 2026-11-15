<script>
  import { chatSpan } from '../core/chat-span.js';
  import { automatedTitle } from '$lib/core/title.js';
  import { plainText } from '$lib/core/summary.js';
  import { indicatorOf, unreadOf } from '$lib/core/rowstate.js';
  import Icon from './Icon.svelte';
  import Nav from './Nav.svelte';
  import SwipeRow from './SwipeRow.svelte';
  import Tray from './Tray.svelte';
  import DeferSheet from './DeferSheet.svelte';
  import { groupForks, rankConversations, trayCounts } from '$lib/core/recency.js';
  import { deferLabel } from '$lib/core/defer.js';
  import { CACHED_LIMIT, mergeResults, rankByHits, searchCachedChats, searchStages } from '$lib/core/search.js';
  import { isListDown, isListUp } from '$lib/core/keys.js';
  import { listedConversations, stableListing } from '$lib/core/transient.js';
  // what the host page keeps out of the lists (core/transient.js unlistedByHost); none on the owner's own app
  const hostUnlisted = () => (typeof window === 'undefined' ? null : window.__tophatUnlisted || null);
  import { isMuted as folderMuted, queueArchive, queueEdit as queueDescription, queueMute, queueParent, readCached as readCachedDescs, sync as syncDescriptions } from '$lib/core/folder-descs.js';
  import { CATCHALL_LABEL, ROOT, UNFILED, canonicalWorkspace, chatsUnder, effectiveLayout, explorerKey, explorerRows, folderKey, folderTree, inSubtree, listWorkspaces, moveFolder, normalizeWorkspace, pathTo } from '$lib/core/workspaces.js';
  import { sidebarDecl, openKey } from '$lib/core/sidebar-state.js';
  import { uiApp } from '$lib/client/ui-app.js';
  import HostMenu from './HostMenu.svelte';
  import InfoTip from './InfoTip.svelte';
  import DescEditor from './DescEditor.svelte';
  import { hostState, refreshHosts } from '$lib/core/hosts.svelte.js';
  import { provideMenu, SEP } from '$lib/client/context-menu.js';
  import { extStore, refreshContributions, runExtCommand } from '$lib/client/extensions.js';
  import { menusOf } from '$lib/core/ext-state.js';
  import { createDeadlineFetch } from '../../../../runner/tools/docstore-kit/lib/engine/deadline.js';
  const net = createDeadlineFetch();

  let {
    conversations = {},
    chatState = null,
    session = null,
    activeId = null,
    openIds = [],
    onselect = () => {},
    onkeep = () => {},
    onopenbeside = () => {},
    onnew = () => {},
    onsearch = () => {},
    onpin = () => {},
    onarchive = () => {},
    onaside = () => {},
    ondefer = () => {},
    onread = () => {},
    status = {},
    open = true,
    onclose = () => {},
    shownav = true,
    navItems = [],
    onnavpick = () => {},
    // Optional: enter this workspace at construction (tests, deep links). The live value is the store's `current`.
    workspace: enterAtStart = null,
    onworkspace = () => {}
  } = $props();

  // Workspaces: named folded groups. Everything he sets on this device (folders made, which are open, layout, the
  // one he is in, Inbox folded, list width) is ONE declaration (core/sidebar-state.js) on the kit's state core:
  // hydrated synchronously here, so the first paint is already right; saved by the kit, not by this component.
  // Membership rides on each chat (conversation.workspace).
  const sb = uiApp().use(sidebarDecl);
  // Extension menu items for a chat row (slot ui.sidebar.chatMenu): data from the server, run by command name.
  const extUi = extStore();
  let descs = $state(readCachedDescs());
  if (enterAtStart && !sb.get().current) sb.dispatch('workspace.enter', { name: enterAtStart });
  const workspace = $derived($sb.current);
  // The tree is drawn from the shared folder places (server folder metadata, the tree the router files into), with this
  // device's old local parents only for folders that have none yet (core/workspaces.js effectiveLayout).
  const wsLayout = $derived(effectiveLayout($sb.layout, descs));
  // Inbox's open state is the old main-fold flag, so what he had folded stays folded.
  const isOpen = (key) => (key === UNFILED ? !$sb.mainFolded : Boolean($sb.open[key]));
  const setOpen = (key, open) => (key === UNFILED ? sb.dispatch('main.fold', { folded: !open }) : sb.dispatch('folder.open', { key, open }));
  // ⌥-click on a folder's arrow, VS Code's: the folder and every folder under it open or close together.
  function setOpenDeep(key, open) {
    const t = folderTree(allWorkspaces, wsLayout);
    const walk = (k) => { setOpen(k, open); for (const c of t.children(k)) walk(c); };
    walk(key);
  }
  function collapseAll() {
    for (const k of Object.keys($sb.open)) if ($sb.open[k]) sb.dispatch('folder.open', { key: k, open: false });
  }
  const enter = (name) => sb.dispatch('workspace.enter', { name });
  // The catch-all (Inbox, once called Everything else) folds too at the top level. Per device, beside the rest of the folder
  // state. Folder descriptions (his edits are source "manual", authoritative for the router and never regenerated; the rest are
  // rewritten daily). Offline first: core/folder-descs.js keeps a device cache and a persisted outbox, so an edit shows at once
  // and is sent when the server is reachable.
  const descOf = (name) => (name ? descs[String(name).toLowerCase()]?.text || '' : '');
  const descSource = (name) => (name ? descs[String(name).toLowerCase()]?.source || '' : '');
  async function syncDescs() { descs = await syncDescriptions(); }
  $effect(() => {
    syncDescs();
    const again = () => syncDescs();
    globalThis.addEventListener?.('online', again);
    return () => globalThis.removeEventListener?.('online', again);
  });
  // One-time upload of this device's old local nesting into the shared folder places, so the router files into those
  // subfolders too: every local parent the server has no place for is sent once, as his edit. Re-runs are no-ops (the
  // place then exists).
  $effect(() => {
    const local = $sb.layout?.parent || {};
    let sent = false;
    for (const [k, p] of Object.entries(local)) {
      if (!p || typeof descs[k]?.parentAt === 'string') continue;
      const name = allWorkspaces.find((n) => folderKey(n) === k);
      if (!name) continue;
      queueParent(name, p);
      sent = true;
    }
    if (sent) { descs = readCachedDescs(); syncDescs(); }
  });
  // The host menu (HostMenu.svelte): the peers a chat can run on, whether the router may pick each, and what to send there.
  $effect(() => {
    let stopped = false, timer = null;
    const loop = async () => { await refreshHosts(); if (!stopped) timer = setTimeout(loop, 20_000); };
    loop();
    return () => { stopped = true; clearTimeout(timer); };
  });
  // Open state of the hosts dropdown and the description being edited are kit state (core/sidebar-state.js hostMenu,
  // descAt, descDraft). A description edit folds down under its row and writes nothing until Save; an empty Save hands
  // the folder back to the daily generator, and saving an auto-written one makes it his.
  const openHostMenu = () => sb.dispatch('hostmenu.open', { open: !$sb.hostMenu });
  const descEditing = $derived($sb.descAt?.startsWith('f:') ? $sb.descAt.slice(2) : null);
  function editDesc(name) {
    if (!name) return;
    if (descEditing === name) { sb.dispatch('desc.close', {}); return; }
    sb.dispatch('desc.open', { at: `f:${name}`, text: descOf(name) });
  }
  function saveDesc(name, text) {
    sb.dispatch('desc.close', {});
    listEl?.focus();
    descs = queueDescription(name, text);
    syncDescs();
  }
  function cancelDesc() { sb.dispatch('desc.close', {}); listEl?.focus(); }
  // Folder drag: which folder is moving and where it would land ({ key, where }).
  let folderDrag = $state(null);
  let folderDrop = $state(null);
  // The folder being renamed in place, as a name (kit state `renaming` holds its key).
  const wsRenaming = $derived($sb.renaming ? nameForKey($sb.renaming) : null);
  const startRename = (name) => { if (name) sb.dispatch('rename.at', { key: folderKey(name) }); };
  let moveFor = $state(null);
  let movePos = $state({ x: 0, y: 0 });
  let dropTarget = $state(undefined);

  // listedConversations returns an id-keyed map, not an array.
  const allWorkspaces = $derived(listWorkspaces(Object.values(listedConversations(conversations, session?.isProvisional, hostUnlisted())).filter((c) => !c.archived), $sb.names));

  function createWorkspace(name, { enter: enterNow = true, file = null } = {}) {
    // Inbox is the catch-all, not a folder to make: filing a chat there is unfiling it.
    const clean = canonicalWorkspace(name);
    if (!clean) { if (file && normalizeWorkspace(name)) onworkspace(file, null); return null; }
    sb.dispatch('folder.create', { name: clean });
    if (file) onworkspace(file, clean);
    if (enterNow) enter(clean);
    return clean;
  }
  function renameWorkspace(from, to) {
    const clean = normalizeWorkspace(to);
    sb.dispatch('rename.at', { key: null });
    listEl?.focus();
    if (!clean || clean === from) return;
    for (const c of Object.values(conversations)) if (c.workspace && c.workspace.toLowerCase() === from.toLowerCase()) onworkspace(c.id, clean);
    // The shared tree follows the name: the folder keeps its place and description, its subfolders stay inside it.
    const tree = folderTree(allWorkspaces, wsLayout), k = folderKey(from);
    const parent = tree.parentOf(k);
    queueParent(clean, parent === ROOT ? '' : parent);
    if (descSource(from) === 'manual') queueDescription(clean, descOf(from));
    for (const child of tree.children(k)) queueParent(nameForKey(child) ?? child, clean);
    // Its Mute When Collapsed flag moves with it: set under the new name, cleared (tombstoned) under the old.
    if (folderMuted(descs, k)) { queueMute(clean, true); queueMute(from, false); }
    descs = readCachedDescs();
    sb.dispatch('folder.rename', { from, to: clean });
    syncDescs();
  }
  function deleteWorkspace(name) {
    const members = Object.values(conversations).filter((c) => c.workspace && c.workspace.toLowerCase() === name.toLowerCase());
    if (members.length && !confirm(`Remove the workspace "${name}"? Its ${members.length} chat${members.length === 1 ? '' : 's'} go back to the main list; nothing is deleted.`)) return;
    for (const c of members) onworkspace(c.id, null);
    // Its subfolders move up to its parent, in the shared tree too.
    const tree = folderTree(allWorkspaces, wsLayout), k = folderKey(name), up = tree.parentOf(k);
    for (const child of tree.children(k)) queueParent(nameForKey(child) ?? child, up === ROOT ? '' : up);
    // A removed folder takes its mute with it, so a folder made later under the same name starts loud.
    if (folderMuted(descs, k)) queueMute(name, false);
    descs = readCachedDescs();
    sb.dispatch('folder.remove', { name });
    syncDescs();
  }
  function openMove(event, id) {
    const box = event.currentTarget.getBoundingClientRect();
    const root = rootEl.getBoundingClientRect();
    movePos = { x: Math.max(8, Math.min(box.right - root.left - 200, root.width - 208)), y: box.bottom - root.top + 4 };
    moveFor = id;
  }
  function moveTo(name) {
    const id = moveFor;
    moveFor = null;
    if (id) onworkspace(id, name);
  }
  function dragStart(event, id) {
    event.dataTransfer?.setData('application/x-tophat-chat', id);
  }
  function dropOn(event, name) {
    const id = event.dataTransfer?.getData('application/x-tophat-chat');
    dropTarget = undefined;
    if (!id) return;
    event.preventDefault();
    onworkspace(id, name);
  }
  const dragOver = (event, key) => {
    if (folderDrag) return;
    if (!event.dataTransfer?.types?.includes('application/x-tophat-chat')) return;
    event.preventDefault();
    if (dropTarget !== key) springOpen(key);
    dropTarget = key;
  };
  // VS Code's spring-loaded folders: hovering a drag over a closed folder for 600 ms opens it.
  let springTimer = null;
  function springOpen(key) {
    clearTimeout(springTimer);
    if (!key || isOpen(key)) return;
    springTimer = setTimeout(() => { if (dropTarget === key || folderDrop?.key === key) setOpen(key, true); }, 600);
  }
  // Folders move by dragging their header: the top third of another header drops before it, the
  // bottom third after it, the middle inside it. Inbox moves but never nests.
  function folderDragStart(event, key) {
    event.stopPropagation();
    folderDrag = key;
    event.dataTransfer?.setData('application/x-tophat-folder', key);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }
  function folderDragOver(event, key) {
    if (!folderDrag) return;
    const box = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - box.top) / Math.max(1, box.height);
    let where = y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
    if (folderDrag === UNFILED && where === 'inside') where = y < 0.5 ? 'before' : 'after';
    const next = moveFolder(allWorkspaces, wsLayout, folderDrag, key, where);
    if (next === wsLayout) { folderDrop = null; return; }
    event.preventDefault();
    if (where === 'inside' && folderDrop?.key !== key) springOpen(key);
    folderDrop = { key, where };
  }
  function folderDropOn(event, key) {
    if (!folderDrag || !folderDrop || folderDrop.key !== key) return;
    event.preventDefault();
    moveShared(folderDrag, key, folderDrop.where);
    if (folderDrop.where === 'inside') setOpen(key, true);
    folderDragEnd();
  }
  // The same moves from a menu, for touch screens where a header cannot be dragged.
  let folderMenu = $state(null);
  let folderMenuPos = $state({ x: 0, y: 0 });
  function openFolderMenu(event, key) {
    const box = event.currentTarget.getBoundingClientRect();
    const root = rootEl.getBoundingClientRect();
    folderMenuPos = { x: Math.max(8, Math.min(box.right - root.left - 200, root.width - 208)), y: box.bottom - root.top + 4 };
    folderMenu = key;
  }
  const folderSiblings = (key) => { const t = folderTree(allWorkspaces, wsLayout); return t.children(t.parentOf(key)); };
  function folderMenuMove(target, where) {
    const key = folderMenu;
    folderMenu = null;
    if (key) moveShared(key, target, where);
  }
  // New Folder, VS Code's: one editable row in the tree, first inside the target folder, its name selected for typing.
  // The target is the folder given (a row's + or its menu), else the selected folder, else the selected chat's folder,
  // else the folder in focus, else the top level. Kit state `newIn` holds where it goes; Enter makes it, Esc drops it.
  function newFolder(parentKey) {
    let k = parentKey;
    if (k === undefined) {
      const it = navItems2.find((x) => x.id === cursor);
      if (it?.kind === 'folder' && it.key !== UNFILED) k = it.key;
      else if (it?.kind === 'misc') k = it.parent;
      else if (it?.kind === 'chat' && canonicalWorkspace(it.row.workspace)) k = folderKey(canonicalWorkspace(it.row.workspace));
      else k = focusKey ?? ROOT;
    }
    if (k === UNFILED) k = ROOT;
    if (k !== ROOT) setOpen(k, true);
    sb.dispatch('newfolder.at', { parent: k });
  }
  function commitNewFolder(text) {
    const parentKey = $sb.newIn, name = canonicalWorkspace(text);
    sb.dispatch('newfolder.at', { parent: null });
    if (!name || parentKey === null) return;
    sb.dispatch('folder.create', { name });
    if (parentKey) { descs = queueParent(name, parentKey); syncDescs(); }
    sb.dispatch('cursor.set', { addr: `f:${folderKey(name)}` });
    listEl?.focus();
  }
  const selectAll = (node) => { node.focus(); node.select(); };
  // A folder move: the order is this device's (the kit's layout), the place is shared (folder metadata, read by the router).
  function moveShared(drag, target, where) {
    const next = moveFolder(allWorkspaces, wsLayout, drag, target, where);
    if (next === wsLayout) return;
    sb.dispatch('folder.move', { all: allWorkspaces, drag, target, where });
    const before = wsLayout.parent[drag] || '', after = next.parent[drag] || '';
    if (drag !== UNFILED && before !== after) { descs = queueParent(nameForKey(drag) ?? drag, after); syncDescs(); }
  }
  function folderDragEnd() { folderDrag = null; folderDrop = null; }
  const nameForKey = (key) => (key === UNFILED ? null : allWorkspaces.find((n) => folderKey(n) === key) ?? null);
  // The current-workspace strip takes a folder dropped on it as "inside the folder I am in".
  function stripFolderDrop(event) {
    if (!folderDrag) return;
    const here = workspace ? folderKey(workspace) : UNFILED;
    const next = moveFolder(allWorkspaces, wsLayout, folderDrag, here, 'inside');
    if (next !== wsLayout) { event.preventDefault(); moveShared(folderDrag, here, 'inside'); }
    folderDragEnd();
  }


  let filter = $state('');
  // Archived chats live in a collapsed section pinned to the foot of the sidebar, not a separate
  // view and not at the end of the scrolling list: with 110 live chats that header was 5,000px
  // down the drawer and unreachable on a phone. Open, they scroll inside their own band.
  // Archiving does not touch a run, so an archived chat can still be live; the section header says
  // how many are.
  let archivedOpen = $state(false);
  // Two quieter trays above the archive, both folded until he opens them. From the foot up: archived,
  // set aside, deferred.
  let asideOpen = $state(false);
  let deferredOpen = $state(false);
  // Recents: a transcluded view of the newest live chats from every folder. It moves nothing: each chat
  // keeps its folder and also shows here, above Set aside.
  const RECENTS_LIMIT = 8;
  let recentsOpen = $state(false);
  // The defer sheet: which row he is parking, and the words in the field. A time or a condition,
  // the same as an await todo; the clock half is decided in core/defer.js and waits on nobody.
  let deferFor = $state(null);
  let now = $state(Date.now());
  let serverHits = $state([]);
  let requestId = 0;

  $effect(() => {
    const timer = setInterval(() => { now = Date.now(); }, 60_000);
    return () => clearInterval(timer);
  });

  const cachedHits = $derived(
    filter.trim() && chatState ? searchCachedChats(chatState, filter, { limit: CACHED_LIMIT }) : []);
  const hits = $derived(filter.trim() ? mergeResults(serverHits, cachedHits) : []);
  const match = $derived(filter.trim() ? new Set(hits.map((hit) => hit.conversationId)) : null);
  const excerpts = $derived(new Map(hits.map((hit) => [hit.conversationId, hit.excerpt])));

  $effect(() => {
    const value = filter;
    if (!value.trim() || !session) { serverHits = []; return; }
    const id = ++requestId;
    const timer = setTimeout(async () => {
      try {
        await searchStages(session, value, (body) => {
          if (id !== requestId) return false;
          serverHits = body.results;
          return true;
        });
      } catch {  }
    }, 90);
    return () => clearTimeout(timer);
  });

  // The chat the app opens into has no row here until it is committed, which is the first
  // thing he types or sends in it (core/transient.js). chatState.rev is read so the row appears
  // on that keystroke rather than on the next unrelated state change.
  // Same chats, same object: a keystroke bumps rev but changes no chat, so nothing below re-ranks.
  let lastListed = null;
  const listed = $derived.by(() => {
    void chatState?.rev;
    lastListed = stableListing(lastListed, listedConversations(conversations, session?.isProvisional, hostUnlisted()));
    return lastListed;
  });

  // While a search is typed the rows follow the search's own ranking (exact, prefix, substring, smart), not
  // recency; with no search `hits` is empty and nothing changes.
  const ordering = $derived(groupForks(rankByHits(rankConversations(listed, { now, match }), hits)));
  // A shut tray is only counted; its rows are ranked when it is open or a search may open it.
  const searchingTrays = $derived(Boolean(filter.trim()));
  const trays = $derived(trayCounts(listed, { now, match }));
  const archivedRows = $derived(archivedOpen || searchingTrays ? rankByHits(rankConversations(listed, { now, match, onlyArchived: true }), hits) : []);
  const asideRows = $derived(asideOpen || searchingTrays ? rankByHits(rankConversations(listed, { now, match, onlyAside: true }), hits) : []);
  const deferredRows = $derived(deferredOpen || searchingTrays ? rankByHits(rankConversations(listed, { now, match, onlyDeferred: true }), hits) : []);
  const recentsAll = $derived(recentsOpen
    ? rankConversations(listed, { now, match, sorted: false, includeArchived: true })
        .sort((a, b) => String(b.activeAt || b.updatedAt).localeCompare(String(a.activeAt || a.updatedAt)) || a.id.localeCompare(b.id))
        .slice(0, RECENTS_LIMIT)
    : []);
  const recentsCount = $derived(recentsOpen ? recentsAll.length : Math.min(RECENTS_LIMIT, Object.values(listed).filter((c) => !c.sidechat && !c.aside).length));
  let rows = $state([]);
  $effect(() => {
    const next = ordering;
    if (!status.syncing) { rows = next; return; }
    const timer = setTimeout(() => { rows = next; }, 180);
    return () => clearTimeout(timer);
  });

  const marksRead = (row) => Boolean(row.unread) || row.indicator === 'live';
  // Folder Mark Read: the unread chats in a folder and everything under it (a running chat with nothing unread is not
  // "unread"; its finish stays loud). `unreadUnder` takes folder keys and chat ids, so one list serves the folder menu and
  // the multi-select menu.
  const unreadUnder = (keys, ids = []) => {
    const all = Object.values(listed), seen = new Set(), out = [];
    const take = (c) => { if (!seen.has(c.id) && unreadOf(c)) { seen.add(c.id); out.push(c.id); } };
    for (const k of keys) for (const c of chatsUnder(all, k, { names: allWorkspaces, layout: wsLayout })) take(c);
    for (const id of ids) { const c = conversations[id]; if (c) take(c); }
    return out;
  };
  const markAllRead = (ids) => { for (const id of ids) onread(id, true, { mute: false }); };

  const wsKey = openKey;
  const searching = $derived(Boolean(filter.trim()));
  const tree = $derived(folderTree(allWorkspaces, wsLayout));
  // Folder archive (a flag in the shared folder metadata, orthogonal to place): an archived folder and its subtree are hidden
  // unless the kit's `showArchived` is on. `hiddenFolder` is what a menu should not offer as a destination.
  const isArchivedFolder = (k) => k !== UNFILED && descs[k]?.archived === true;
  const hiddenFolder = (k) => !$sb.showArchived && pathTo(tree, k).some(isArchivedFolder);
  // The folder made primary (double-click, or its focus button): only its subtree shows, trays included; the breadcrumbs
  // above the list lead back up. A focus naming a folder that no longer exists shows everything.
  const focusKey = $derived(workspace && tree.all.includes(folderKey(workspace)) ? folderKey(workspace) : null);
  const crumbs = $derived(focusKey ? pathTo(tree, focusKey).filter((k) => k !== UNFILED) : []);
  const inFocus = (row) => !focusKey || inSubtree(row, workspace, tree);
  // Demo page only: tophat.md's reset script sets this so a folder's own chats sit directly under it, above its subfolders, with no Misc row.
  const demoInlineOwn = typeof localStorage !== 'undefined' && localStorage.getItem('tophat-demo-inline-own') === '1';
  const items = $derived(explorerRows(searching ? rows : rows.filter(inFocus), { names: allWorkspaces, layout: wsLayout, focus: focusKey ? workspace : null, isOpen, searching, newIn: searching ? null : $sb.newIn, isArchived: isArchivedFolder, showArchived: $sb.showArchived, inlineOwn: demoInlineOwn, isMuted: (k) => folderMuted(descs, k) }));
  const focusCount = $derived(focusKey ? rows.filter((row) => canonicalWorkspace(row.workspace) && folderKey(canonicalWorkspace(row.workspace)) === focusKey).length : 0);
  // Keyboard order follows what is on screen: the tree, then the open trays.
  const trayItems = $derived([...(deferredOpen ? deferredRows : []), ...(asideOpen ? asideRows : []), ...(archivedOpen ? archivedRows : [])]
    .filter((row) => searching || inFocus(row)).map((row) => ({ kind: 'chat', id: `c:${row.id}`, row, depth: 0, fork: false })));
  const navItems2 = $derived([...items.map((it) => (it.kind === 'chat' ? { ...it, id: `c:${it.id}` } : it)), ...trayItems]);
  // The cursor keys walk from: the explicit one (keys, folder click, multi-select), else the focused chat (Page's layout).
  // Only the explicit one draws `.sel`; the focused chat draws `.active` from the layout, so one row is never marked twice.
  const cursor = $derived($sb.cursor ?? (activeId ? `c:${activeId}` : null));
  let listEl = $state(null);
  let rootEl = $state(null);
  // A chat gaining focus by any route (tab, search, ⌘1..9, split, link) takes the cursor off a chat row, so the `.sel` bar
  // never stays on a row the focus left while `.active` marks another. Folder cursors are untouched.
  let lastActive = activeId;
  $effect(() => {
    const now = activeId;
    if (now === lastActive) return;
    lastActive = now;
    if ($sb.cursor?.startsWith('c:')) sb.dispatch('cursor.set', { addr: null });
  });

  let lastFilter = '';
  $effect(() => {
    const value = filter.trim();
    if (value === lastFilter) return;
    lastFilter = value;
    if (value && archivedRows.length) archivedOpen = true;
    if (value && asideRows.length) asideOpen = true;
    if (value && deferredRows.length) deferredOpen = true;
  });
  $effect(() => {
    if (!cursor || !rootEl) return;
    // The cursor row anywhere in the sidebar (the trays sit outside the list's scroller) is kept in view.
    rootEl?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  });

  // The explorer keys, VS Code's tree: arrows walk the visible rows, right/left open/close or step into/out of a folder,
  // Enter opens a chat or toggles a folder, Space toggles. Every move is one kit action (cursor.set, folder.open).
  function treeStep(name) {
    const r = explorerKey(navItems2, cursor, name);
    if (!r) return false;
    if (r.open) setOpen(r.open.key, r.open.open);
    if (r.cursor !== cursor) sb.dispatch('cursor.set', { addr: r.cursor });
    return true;
  }
  function activate() {
    const it = navItems2.find((x) => x.id === cursor) || navItems2.find((x) => x.kind === 'chat');
    if (!it) return false;
    if (it.kind === 'chat') { sb.dispatch('cursor.set', { addr: null }); onselect(it.row.id, { preview: true }); } else setOpen(it.key, !it.open);
    return true;
  }
  const NAV = { ArrowDown: 'down', ArrowUp: 'up', ArrowRight: 'right', ArrowLeft: 'left', Home: 'home', End: 'end' };
  // ---- selection (VS Code's): a plain click selects one row, ⌘-click toggles one, ⇧-click selects the range from the
  // cursor. Kit state `selection`; the cursor row always counts as selected.
  const selected = $derived(new Set([...$sb.selection, ...(cursor ? [cursor] : [])]));
  const isSel = (addr) => selected.has(addr);
  function pick(addr, event) {
    if (event?.metaKey || event?.ctrlKey) {
      const set = new Set(selected);
      if (set.has(addr)) set.delete(addr); else set.add(addr);
      sb.dispatch('selection.set', { addrs: [...set] });
      sb.dispatch('cursor.set', { addr: set.has(addr) ? addr : [...set].pop() ?? null });
      return 'multi';
    }
    if (event?.shiftKey && cursor) {
      const ids = navItems2.map((x) => x.id), a = ids.indexOf(cursor), b = ids.indexOf(addr);
      if (a >= 0 && b >= 0) { sb.dispatch('selection.set', { addrs: ids.slice(Math.min(a, b), Math.max(a, b) + 1) }); return 'multi'; }
    }
    sb.dispatch('selection.set', { addrs: [] });
    // A chat opened by a plain click is the focused chat: the layout holds it, the cursor goes back to following it.
    sb.dispatch('cursor.set', { addr: addr.startsWith('c:') ? null : addr });
    return 'one';
  }
  const chatOfAddr = (addr) => (addr?.startsWith('c:') ? conversations[addr.slice(2)] : null);
  const keyOfAddr = (addr) => (addr?.startsWith('f:') ? addr.slice(2) : null);
  // What an action applies to: the whole selection when the row is in it, else that row alone.
  const targetsOf = (addr) => (selected.has(addr) && selected.size > 1 ? [...selected] : [addr]);

  // ---- commands, shared by keys and menus
  function archiveChats(addrs) { for (const a of addrs) { const c = chatOfAddr(a); if (c) onarchive(c.id, !c.archived); } }
  function moveItems(addrs, folderKeyOrNull) {
    const name = folderKeyOrNull ? nameForKey(folderKeyOrNull) : null;
    for (const a of addrs) {
      const c = chatOfAddr(a);
      if (c) onworkspace(c.id, name);
      const k = keyOfAddr(a);
      if (k && k !== UNFILED && k !== folderKeyOrNull) moveShared(k, folderKeyOrNull ?? ROOT, 'inside');
    }
  }
  function paste(intoKey) {
    const clip = $sb.clip;
    if (!clip) return;
    moveItems([clip], intoKey === UNFILED ? null : intoKey);
    sb.dispatch('clip.set', { addr: null });
  }
  async function resort(addrs, { label = '' } = {}) {
    const ids = [], folders = [];
    for (const a of addrs || []) { const c = chatOfAddr(a); if (c) ids.push(c.id); const k = keyOfAddr(a); if (k && k !== UNFILED) folders.push(nameForKey(k) ?? k); if (k === UNFILED) ids.push(...rows.filter((r) => !canonicalWorkspace(r.workspace)).map((r) => r.id)); }
    sb.dispatch('notice.set', { text: `Re-sorting ${label || 'with the folder descriptions'}…` });
    try {
      const body = addrs ? { ids, folders } : {};
      const r = await net.fetchWithin('send', '/api/refile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json();
      if (!r.ok) throw new Error(out?.error || `HTTP ${r.status}`);
      sb.dispatch('notice.set', { text: `Re-sorted ${out.asked} chat${out.asked === 1 ? '' : 's'}: ${out.moved.length} moved${out.moved.length ? ` (${out.moved.slice(0, 4).map((m) => `${m.title || m.id} → ${m.to ?? CATCHALL_LABEL}`).join('; ')}${out.moved.length > 4 ? '; …' : ''})` : ''}` });
    } catch (cause) {
      sb.dispatch('notice.set', { text: `Re-sort failed: ${cause?.message || cause}` });
    }
  }
  // Archive or restore folders: one shared flag per folder, nothing moves (parent, order and chats stay), so the reverse is exact.
  function archiveFolders(addrs, archived) {
    for (const a of addrs) {
      const k = keyOfAddr(a);
      if (!k || k === UNFILED) continue;
      const name = nameForKey(k);
      if (!name) continue;
      descs = queueArchive(name, archived);
      // Focus on a folder that is about to disappear steps up to the archived folder's parent.
      if (archived && !$sb.showArchived && focusKey && tree.isWithin(focusKey, k)) enter(tree.parentOf(k) === ROOT ? null : nameForKey(tree.parentOf(k)));
    }
    syncDescs();
  }
  function removeFolders(addrs) { for (const a of addrs) { const k = keyOfAddr(a); if (k && k !== UNFILED) deleteWorkspace(nameForKey(k)); } }
  function expandAllUnder(key, open) { setOpenDeep(key, open); }

  // ---- the right-click menus (kit ContextMenu via client/context-menu.js)
  const moveMenu = (addrs) => {
    const movingFolders = addrs.map(keyOfAddr).filter(Boolean);
    const ok = (k) => !movingFolders.some((m) => tree.isWithin(k, m)) && !hiddenFolder(k);
    return [
      { id: 'mv-inbox', label: movingFolders.length ? 'Top Level' : CATCHALL_LABEL, run: () => moveItems(addrs, null) },
      SEP,
      ...tree.all.filter((k) => k !== UNFILED && ok(k)).map((k) => ({ id: `mv-${k}`, label: `${'  '.repeat(pathTo(tree, k).length - 1)}${nameForKey(k)}`, run: () => moveItems(addrs, k) })),
      SEP,
      { id: 'mv-new', label: 'New Folder…', run: () => newFolder() }
    ];
  };
  function bulkMenu(addrs) {
    const chats = addrs.filter((a) => chatOfAddr(a)).length, folders = addrs.filter((a) => keyOfAddr(a) && keyOfAddr(a) !== UNFILED).length;
    const what = [chats && `${chats} chat${chats === 1 ? '' : 's'}`, folders && `${folders} folder${folders === 1 ? '' : 's'}`].filter(Boolean).join(', ');
    const unread = unreadUnder(addrs.map(keyOfAddr).filter((k) => k != null), addrs.map((a) => chatOfAddr(a)?.id).filter(Boolean));
    return [
      { id: 'resort', label: `Re-sort ${what} with Descriptions`, run: () => resort(addrs, { label: what }) },
      { id: 'move', label: `Move ${what} to`, children: moveMenu(addrs) },
      SEP,
      unread.length > 0 && { id: 'read', label: 'Mark Read', run: () => markAllRead(unread) },
      chats && { id: 'aside', label: `Set Aside ${chats} chat${chats === 1 ? '' : 's'}`, run: () => { for (const a of addrs) { const c = chatOfAddr(a); if (c) onaside(c.id, true); } } },
      chats && { id: 'archive', label: `Archive ${chats} chat${chats === 1 ? '' : 's'}`, keys: '⌘⌫', run: () => archiveChats(addrs) },
      folders && { id: 'archive-folders', label: `Archive ${folders} folder${folders === 1 ? '' : 's'}`, run: () => archiveFolders(addrs, true) },
      folders && { id: 'remove', label: `Remove ${folders} folder${folders === 1 ? '' : 's'}`, danger: true, run: () => removeFolders(addrs) },
      SEP,
      { id: 'clear', label: 'Clear Selection', keys: 'Esc', run: () => sb.dispatch('selection.set', { addrs: [] }) }
    ];
  }
  function folderMenuItems(key) {
    const addr = `f:${key}`;
    if (selected.has(addr) && selected.size > 1) return bulkMenu([...selected]);
    pick(addr);
    const name = nameForKey(key), named = key !== UNFILED && name;
    const sibs = folderSiblings(key), at = sibs.indexOf(key), open = isOpen(key);
    const unread = unreadUnder([key]), muted = folderMuted(descs, key);
    return [
      named && { id: 'new-chat', label: 'New Chat in Folder', run: () => { enter(name); onnew(); } },
      { id: 'new-folder', label: 'New Folder…', run: () => newFolder(named ? key : ROOT) },
      SEP,
      workspace && focusKey === key && { id: 'up', label: 'Show Parent', keys: 'Esc', run: () => enter(tree.parentOf(key) === ROOT ? null : nameForKey(tree.parentOf(key))) },
      { id: 'toggle', label: open ? 'Collapse' : 'Expand', keys: open ? '←' : '→', run: () => setOpen(key, !open) },
      named && tree.children(key).length && { id: 'expand-all', label: 'Expand All Inside', keys: '⌥-click', run: () => expandAllUnder(key, true) },
      named && tree.children(key).length && { id: 'collapse-all', label: 'Collapse All Inside', run: () => expandAllUnder(key, false) },
      SEP,
      // Owner request, 2026-11-11 22:20 PST: "lets add mark as read and mute-when-closed options to the right click menu".
      // Mark Read reads every unread chat in the folder and its subfolders; Mute When Collapsed is a standing flag that keeps
      // the folder's dot quiet while it is collapsed (nothing is read; expanding brings the dot back).
      unread.length > 0 && { id: 'read', label: 'Mark Read', run: () => markAllRead(unread) },
      { id: 'mute-collapsed', label: muted ? 'Unmute When Collapsed' : 'Mute When Collapsed', run: () => { descs = queueMute(name ?? key, !muted); syncDescs(); } },
      SEP,
      named && { id: 'rename', label: 'Rename…', keys: '↩', run: () => startRename(name) },
      named && { id: 'desc', label: 'Edit Description…', run: () => editDesc(name) },
      named && { id: 'move', label: 'Move to', children: moveMenu([addr]) },
      at > 0 && { id: 'move-up', label: 'Move Up', run: () => moveShared(key, sibs[at - 1], 'before') },
      at >= 0 && at < sibs.length - 1 && { id: 'move-down', label: 'Move Down', run: () => moveShared(key, sibs[at + 1], 'after') },
      SEP,
      { id: 'resort', label: 'Re-sort Chats with Descriptions', run: () => resort([addr], { label: `${name ?? CATCHALL_LABEL}` }) },
      named && { id: 'cut', label: 'Cut', keys: '⌘X', run: () => sb.dispatch('clip.set', { addr }) },
      $sb.clip && $sb.clip !== addr && { id: 'paste', label: 'Paste', keys: '⌘V', run: () => paste(key) },
      named && { id: 'copy-name', label: 'Copy Name', run: () => navigator.clipboard?.writeText(name) },
      named && SEP,
      named && { id: 'archive-folder', label: isArchivedFolder(key) ? 'Unarchive Folder' : 'Archive Folder', run: () => archiveFolders([addr], !isArchivedFolder(key)) },
      named && { id: 'remove', label: 'Remove Folder', keys: '⌘⌫', danger: true, run: () => deleteWorkspace(name) }
    ];
  }
  function chatMenuItems(id) {
    const addr = `c:${id}`, c = conversations[id];
    if (!c) return [];
    if (selected.has(addr) && selected.size > 1) return bulkMenu([...selected]);
    pick(addr);
    return [
      { id: 'open', label: 'Open', keys: '↩', run: () => onselect(id) },
      { id: 'open-side', label: 'Open to the Side', keys: '⌃↩', run: () => onopenbeside(id) },
      SEP,
      { id: 'move', label: 'Move to Folder', children: moveMenu([addr]) },
      { id: 'resort', label: 'Re-sort with Descriptions', run: () => resort([addr], { label: c.title || 'this chat' }) },
      SEP,
      { id: 'pin', label: c.pinned ? 'Unpin' : 'Pin', run: () => onpin(id, !c.pinned) },
      // Mark Read reads to now and leaves a live run loud (its finish shows unread); Mute When Closed reads it and keeps the
      // run's finish quiet (mutedRun), offered only while the chat is running.
      marksRead(c) ? { id: 'read', label: 'Mark Read', run: () => onread(id, true, { mute: false }) }
        : { id: 'unread', label: 'Mark Unread', run: () => onread(id, false) },
      indicatorOf(c) === 'live' && { id: 'mute', label: 'Mute When Closed', run: () => onread(id, true, { mute: true }) },
      { id: 'aside', label: c.aside ? 'Put Back' : 'Set Aside', keys: '⌘U', run: () => onaside(id, !c.aside) },
      { id: 'defer', label: 'Defer…', run: () => openDefer(id) },
      { id: 'archive', label: c.archived ? 'Unarchive' : 'Archive', keys: '⌘⌫', run: () => onarchive(id, !c.archived) },
      SEP,
      { id: 'cut', label: 'Cut', keys: '⌘X', run: () => sb.dispatch('clip.set', { addr }) },
      { id: 'copy-link', label: 'Copy Link', run: () => navigator.clipboard?.writeText(`${location.origin}/?chat=${encodeURIComponent(id)}`) },
      { id: 'copy-title', label: 'Copy Title', run: () => navigator.clipboard?.writeText(automatedTitle(c.title).text || c.title || '') },
      ...extChatItems(id)
    ];
  }
  function extChatItems(id) {
    const items = menusOf(extUi.get(), 'ui.sidebar.chatMenu');
    if (!items.length) return [];
    return [SEP, ...items.map((m) => ({ id: `ext:${m.command}`, label: m.title, run: () => runExtCommand(m.command, { id }) }))];
  }
  function explorerMenuItems() {
    return [
      { id: 'new-folder', label: 'New Folder…', run: () => newFolder(focusKey ?? ROOT) },
      { id: 'new-chat', label: 'New Chat', run: () => onnew() },
      SEP,
      workspace && { id: 'show-all', label: 'Show All Folders', run: () => enter(null) },
      { id: 'collapse-all', label: 'Collapse All Folders', keys: '⌘←', run: collapseAll },
      { id: 'show-archived', label: $sb.showArchived ? 'Hide Archived Folders' : 'Show Archived Folders', run: () => sb.dispatch('archived.show', { show: !$sb.showArchived }) },
      $sb.clip && { id: 'paste', label: 'Paste', keys: '⌘V', run: () => paste(focusKey ?? UNFILED) },
      SEP,
      { id: 'resort-all', label: workspace ? `Re-sort Everything in ${workspace}` : 'Re-sort All Chats with Descriptions', run: () => (workspace ? resort([`f:${focusKey}`], { label: workspace }) : resort(null, { label: 'every chat' })) }
    ];
  }
  $effect(() => {
    refreshContributions();
    const off = [
      provideMenu('folder', (ctx) => (ctx.key ? folderMenuItems(ctx.key) : explorerMenuItems())),
      provideMenu('chat', (ctx) => chatMenuItems(ctx.id)),
      provideMenu('explorer', () => explorerMenuItems())
    ];
    return () => off.forEach((f) => f());
  });

  // ---- keys (VS Code's explorer on a Mac): arrows walk, ⇧-arrows extend the selection, ↩ / F2 renames a folder and opens
  // a chat, Space toggles a folder or opens a chat, ⌘↓ opens, ⌘⌫ removes the folder or archives the chat (all selected),
  // ⌘X / ⌘V cut and paste into the folder under the cursor, ⌘A selects every visible row, ⌘← collapses all, Esc clears
  // the selection or the cut, then leaves the focused folder; a letter jumps to the next row starting with it.
  const labelOf = (it) => (it.kind === 'misc' ? it.name : it.kind === 'folder' ? nameForKey(it.key) ?? CATCHALL_LABEL : automatedTitle(it.row?.title).text || it.row?.title || '');
  function treeKeydown(event) {
    if (event.target !== listEl) return;
    const mod = event.metaKey || event.ctrlKey;
    const it = navItems2.find((x) => x.id === cursor);
    const name = NAV[event.key];
    if (name && !mod && !event.altKey) {
      event.preventDefault();
      const from = cursor;
      treeStep(name);
      if (event.shiftKey && (name === 'up' || name === 'down') && from) sb.dispatch('selection.set', { addrs: [...new Set([...selected, from])] });
      else if (!event.shiftKey) sb.dispatch('selection.set', { addrs: [] });
      return;
    }
    const hit = (fn) => { event.preventDefault(); event.stopPropagation(); fn(); };
    if (mod && event.key === 'ArrowDown') return hit(activate);
    if (mod && event.key === 'ArrowLeft') return hit(collapseAll);
    if (mod && (event.key === 'Backspace' || event.key === 'Delete')) return hit(() => { const t = targetsOf(cursor); archiveChats(t); removeFolders(t); });
    if (mod && event.key.toLowerCase() === 'x' && cursor) return hit(() => sb.dispatch('clip.set', { addr: cursor }));
    if (mod && event.key.toLowerCase() === 'v' && $sb.clip) return hit(() => paste(it?.kind === 'misc' ? it.parent : it?.kind === 'folder' ? it.key : (it?.kind === 'chat' && canonicalWorkspace(it.row.workspace) ? folderKey(canonicalWorkspace(it.row.workspace)) : focusKey ?? UNFILED)));
    if (mod && event.key.toLowerCase() === 'a') return hit(() => sb.dispatch('selection.set', { addrs: navItems2.map((x) => x.id) }));
    // ⌃↩ opens the cursor's chat in a new pane beside the focused one, as the row's split button does (tophat#4).
    if (event.key === 'Enter' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && it?.kind === 'chat') {
      return hit(() => { sb.dispatch('cursor.set', { addr: null }); onopenbeside(it.row.id); });
    }
    if (mod || event.altKey) return;
    if (event.key === 'Enter' || event.key === 'F2') {
      if (it?.kind === 'folder' && it.key !== UNFILED) return hit(() => startRename(nameForKey(it.key)));
      if (event.key === 'Enter') return hit(activate);
      return;
    }
    if (event.key === ' ') return hit(() => { if (it?.kind === 'folder' || it?.kind === 'misc') setOpen(it.key, !it.open); else activate(); });
    if (event.key === 'Escape') {
      if ($sb.selection.length) return hit(() => sb.dispatch('selection.set', { addrs: [] }));
      if ($sb.clip) return hit(() => sb.dispatch('clip.set', { addr: null }));
      if (workspace) return hit(() => enter(tree.parentOf(focusKey) === ROOT ? null : nameForKey(tree.parentOf(focusKey))));
      return;
    }
    if (event.key.length === 1 && /\S/u.test(event.key)) {
      const k = event.key.toLowerCase(), n = navItems2.length, at = navItems2.findIndex((x) => x.id === cursor);
      for (let s = 1; s <= n; s += 1) { const x = navItems2[(at + s + n) % n]; if (labelOf(x).toLowerCase().startsWith(k)) return hit(() => sb.dispatch('cursor.set', { addr: x.id })); }
    }
  }

  // Escape from a pane, or Ctrl-Q Tab, puts the keyboard here: the tree, its cursor on the open chat's row (a null cursor
  // follows the focused chat). From there the explorer keys walk (↑ ↓), ↩ opens the chat as a plain click does (the
  // preview tab) and ⌃↩ opens it in a pane beside.
  export function focusList() {
    if ($sb.cursor?.startsWith('c:')) sb.dispatch('cursor.set', { addr: null });
    listEl?.focus({ preventScroll: true });
  }
  export const hasListFocus = () => Boolean(listEl && globalThis.document?.activeElement === listEl);

  function filterKeydown(event) {
    if (isListDown(event)) { event.preventDefault(); treeStep('down'); return; }
    if (isListUp(event)) { event.preventDefault(); treeStep('up'); return; }
    if (event.key === 'Enter') { if (activate()) event.preventDefault(); return; }
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (filter) filter = '';
      else onclose();
    }
  }

  function rowClick(event, id) {
    if (event.button !== 0) return;
    // ⌘-click and ⇧-click select (VS Code); a middle-click still opens the link in a browser tab.
    if (pick(`c:${id}`, event) === 'multi') { event.preventDefault(); return; }
    if (event.altKey) return;
    event.preventDefault();
    // A plain click opens the chat as the focused group's preview tab (VS Code); a double click keeps it (rowDblClick).
    onselect(id, { preview: true });
  }
  function rowDblClick(event, id) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    onkeep(id);
  }

  // Deferring a chat. The sheet is the shared one, so a chat and a document are parked by the
  // same control and read by the same parser.
  function openDefer(id) {
    deferFor = id;
  }

  function commitDefer(parsed) {
    const id = deferFor;
    deferFor = null;
    if (!id || (!parsed.until && !parsed.condition)) return;
    ondefer(id, parsed);
    deferredOpen = true;
  }

  function clearDefer(id) {
    deferFor = null;
    ondefer(id, { until: null, condition: null });
  }

  function ago(iso) {
    const then = Date.parse(iso || '');
    if (!Number.isFinite(then)) return '';
    const minutes = Math.round((now - then) / 60_000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.round(hours / 24);
    return days < 7 ? `${days}d` : `${Math.round(days / 7)}w`;
  }
</script>

<aside class="sidebar" class:open data-testid="sidebar" bind:this={rootEl}>
  <header>
    <div class="title">
      
      {#if shownav}<Nav current="chats" items={navItems} onpick={onnavpick} onactivate={() => onnavpick('show-chatlist')} />{/if}
      <span class="conn" class:live={status.connected} class:offline={!status.online || status.offline}
            data-testid="conn" data-offline={status.offline ? 'true' : 'false'}
            title={!status.online ? 'offline' : status.offline ? 'server unreachable; showing what this device saved' : (status.connected ? 'streaming' : 'reconnecting')}></span>
      {#if status.offline}<span class="offline-note" data-testid="offline-note">offline</span>{/if}
    </div>
    <button class="icon-btn press focus-ring" onclick={onclose} aria-label="Close chat list"><Icon name="close" /></button>
  </header>

  <div class="tools">
    <input
      class="filter focus-ring"
      bind:value={filter}
      onkeydown={filterKeydown}
      placeholder="Search chats"
      data-testid="sidebar-filter"
      aria-label="Search chats"
    />
    <button class="search press focus-ring" onclick={() => { moveFor = null; newFolder(); }} data-testid="new-workspace" title="New folder (inside the selected folder)" aria-label="New folder"><Icon name="folder" /></button>
    {#if hostState.list.length > 1}
      <span class="hostwrap">
        <button class="search press focus-ring" class:on={$sb.hostMenu} onclick={openHostMenu} data-testid="host-menu-button" title="Hosts" aria-label="Hosts" aria-haspopup="menu" aria-expanded={$sb.hostMenu}><Icon name="server" /></button>
        {#if $sb.hostMenu}<HostMenu onclose={() => sb.dispatch('hostmenu.open', { open: false })} />{/if}
      </span>
    {/if}
  </div>


  {#if $sb.notice}
    <div class="sbnotice" data-testid="sidebar-notice" role="status"><span>{$sb.notice}</span><button class="icon-btn press" onclick={() => sb.dispatch('notice.set', { text: null })} aria-label="Dismiss"><Icon name="close" size={11} /></button></div>
  {/if}
  {#if workspace}
    <!-- Breadcrumbs: the folder he made primary (double-click a folder, or its focus button) is the root of the list and
         everything outside it is hidden; each crumb above it makes that folder the root, the first shows everything. -->
    <nav class="crumbs" data-ctx="folder" data-ctx-key={focusKey ?? ''} data-testid="current-workspace" aria-label="Folder path"
      ondragover={(e) => { if (!folderDrag) dragOver(e, wsKey(workspace)); }} ondragleave={() => (dropTarget = undefined)}
      ondrop={(e) => { if (!folderDrag) dropOn(e, workspace); }} class:drop={dropTarget === wsKey(workspace)}>
      <button class="crumb press focus-ring" onclick={() => enter(null)} data-testid="leave-workspace" title="Show every folder">All</button>
      {#each crumbs as k, i (k)}
        <span class="crumbsep" aria-hidden="true">›</span>
        {#if i === crumbs.length - 1}
          <span class="crumb here" title={nameForKey(k)}>{nameForKey(k)}</span>
          <span class="count">{focusCount}</span>
          {#if descOf(nameForKey(k))}<InfoTip testid="crumb-info" label="Description of {nameForKey(k)}" text={descOf(nameForKey(k))} onclick={() => editDesc(workspace)} />{/if}
        {:else}
          <button class="crumb press focus-ring" onclick={() => enter(nameForKey(k))} title={nameForKey(k)}>{nameForKey(k)}</button>
        {/if}
      {/each}
      <span class="crumbacts">
        <button class="icon-btn press" onclick={() => newFolder(focusKey)} title="New subfolder" aria-label="New subfolder" data-testid="new-subfolder-here"><Icon name="plus" size={12} /></button>
      </span>
    </nav>
    {#if descEditing === workspace}<div class="crumbedit">{@render descEditor(workspace)}</div>{/if}
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="scroller list" data-testid="chat-list" bind:this={listEl} tabindex="0" data-ctx="explorer" role="tree" aria-label="Chats" onkeydown={treeKeydown}>
    {#each items as item (item.id)}
      {#if item.kind === 'folder'}
        {@render folderRow(item)}
      {:else if item.kind === 'misc'}
        {@render miscRow(item)}
      {:else if item.kind === 'new'}
        <form class="wsnew sub" style="--depth:{item.depth}" data-testid="new-folder-row" onsubmit={(event) => { event.preventDefault(); commitNewFolder(event.currentTarget.elements[0].value); }}>
          <span class="caret none"><Icon name="chevron" size={11} /></span>
          <Icon name="folder" size={12} />
          <input class="filter focus-ring" value="New folder" use:selectAll aria-label="New folder name" data-testid="workspace-name"
            onblur={(event) => commitNewFolder(event.currentTarget.value === 'New folder' ? '' : event.currentTarget.value)}
            onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); sb.dispatch('newfolder.at', { parent: null }); listEl?.focus(); } }} />
        </form>
      {:else}
        <div class="group" class:dim={item.dim} style="--depth:{item.depth}">{@render chatRow(item.row, item.fork)}</div>
      {/if}
    {/each}
    {#if !items.length}
      <p class="empty">{filter ? 'No chat matches that.' : workspace ? 'Empty' : 'No chats yet.'}</p>
    {/if}
  </div>

  <!-- The three folded trays, deferred on top and archived at the foot, each one the shared
       Tray component so the reader stacks the same thing over its shelf. -->
  <Tray
    label="Deferred"
    icon="clock"
    count={trays.deferred}
    open={deferredOpen}
    onopen={(next) => (deferredOpen = next)}
    testid="deferred-section"
    toggletestid="toggle-deferred"
    listtestid="deferred-list"
  >
    {#each deferredRows as row (row.id)}
      {@render chatRow(row, false)}
    {/each}
  </Tray>

  <Tray
    label="Recents"
    icon="clock"
    count={recentsCount}
    open={recentsOpen}
    onopen={(next) => (recentsOpen = next)}
    testid="recents-section"
    toggletestid="toggle-recents"
    listtestid="recents-list"
  >
    {#each recentsAll as row (row.id)}
      <div class:dim={row.archived}>{@render chatRow(row, false, true)}</div>
    {/each}
  </Tray>

  <Tray
    label="Set aside"
    icon="tray"
    count={trays.aside}
    open={asideOpen}
    onopen={(next) => (asideOpen = next)}
    testid="aside-section"
    toggletestid="toggle-aside"
    listtestid="aside-list"
  >
    {#each asideRows as row (row.id)}
      {@render chatRow(row, false)}
    {/each}
  </Tray>

  <Tray
    label="Archived"
    icon="archive"
    count={trays.archived}
    countWhenClosed={false}
    open={archivedOpen}
    onopen={(next) => (archivedOpen = next)}
    note={trays.archivedLive ? `${trays.archivedLive} still running` : null}
    testid="archived-section"
    toggletestid="toggle-archived"
    listtestid="archived-list"
  >
    {#each archivedRows as row (row.id)}
      {@render chatRow(row, false)}
    {/each}
  </Tray>

  {#if moveFor}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="wsscrim" onclick={() => (moveFor = null)}></div>
    <div class="wsmenu" style="left:{movePos.x}px; top:{movePos.y}px" data-testid="workspace-menu" role="menu">
      <div class="wsmenuhead">Move to workspace</div>
      {#each allWorkspaces as name (name)}
        <button class="press" role="menuitem" class:on={conversations[moveFor]?.workspace === name} onclick={() => moveTo(name)}><Icon name="folder" size={12} /> {name}</button>
      {/each}
      <button class="press" role="menuitem" class:on={!canonicalWorkspace(conversations[moveFor]?.workspace)} onclick={() => moveTo(null)}><Icon name="tray" size={12} /> {CATCHALL_LABEL}</button>
      <form onsubmit={(event) => { event.preventDefault(); const name = event.currentTarget.elements[0].value; const id = moveFor; moveFor = null; createWorkspace(name, { enter: false, file: id }); }}>
        <input class="filter focus-ring" placeholder="New workspace…" aria-label="New workspace name" data-testid="workspace-menu-new"
          onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); moveFor = null; } }} />
      </form>
    </div>
  {/if}

  {#if folderMenu}
    {@const sibs = folderSiblings(folderMenu)}
    {@const at = sibs.indexOf(folderMenu)}
    {@const tree = folderTree(allWorkspaces, wsLayout)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="wsscrim" onclick={() => (folderMenu = null)}></div>
    <div class="wsmenu" style="left:{folderMenuPos.x}px; top:{folderMenuPos.y}px" data-testid="folder-menu" role="menu">
      <div class="wsmenuhead">Move {nameForKey(folderMenu) ?? CATCHALL_LABEL}</div>
      {#if at > 0}<button class="press" role="menuitem" onclick={() => folderMenuMove(sibs[at - 1], 'before')}>Up</button>{/if}
      {#if at >= 0 && at < sibs.length - 1}<button class="press" role="menuitem" onclick={() => folderMenuMove(sibs[at + 1], 'after')}>Down</button>{/if}
      {#if tree.parentOf(folderMenu) !== ROOT}<button class="press" role="menuitem" onclick={() => folderMenuMove(ROOT, 'inside')}>To the top level</button>{/if}
      {#if nameForKey(folderMenu)}
        <button class="press" role="menuitem" onclick={() => { const n = nameForKey(folderMenu); folderMenu = null; if (n) editDesc(n); }}>Edit description</button>
      {/if}
      {#if folderMenu !== UNFILED}
        <div class="wsmenuhead">Put inside</div>
        {#each tree.all.filter((k) => k !== folderMenu && !tree.isWithin(k, folderMenu) && tree.parentOf(folderMenu) !== k) as k (k)}
          <button class="press" role="menuitem" onclick={() => folderMenuMove(k, 'inside')}><Icon name={k === UNFILED ? 'tray' : 'folder'} size={12} /> {nameForKey(k) ?? CATCHALL_LABEL}</button>
        {/each}
      {/if}
    </div>
  {/if}

  {#if deferFor}
    <DeferSheet
      title={conversations[deferFor]?.title || ''}
      value={conversations[deferFor]?.deferCondition || ''}
      deferred={Boolean(conversations[deferFor]?.deferUntil || conversations[deferFor]?.deferCondition)}
      oncommit={commitDefer}
      onclear={() => clearDefer(deferFor)}
      onclose={() => (deferFor = null)}
      testid="chat-defer"
    />
  {/if}

  {#snippet descEditor(name)}
    <DescEditor value={$sb.descDraft} label="Description of {name}" oninput={(text) => sb.dispatch('desc.draft', { text })}
      onsave={(text) => saveDesc(name, text)} oncancel={cancelDesc} />
  {/snippet}


  <!-- Misc: virtual (never stored), the last child of a folder that has subfolders; it holds the chats filed directly in that
       folder. Not renamable, removable, draggable or describable; a chat dropped on it is filed into the parent folder. -->
  {#snippet miscRow(item)}
    {@const parentName = nameForKey(item.parent)}
    <div class="wsgroup misc" class:dim={item.archived} data-testid="misc-group" data-workspace={parentName ?? ''} style="--depth:{item.depth}">
      <div class="wshead" role="treeitem" aria-expanded={item.open} aria-selected={$sb.cursor === item.id} aria-level={item.depth + 1}
        class:sel={$sb.cursor === item.id} class:picked={isSel(item.id) && selected.size > 1}
        class:drop={dropTarget === item.key}
        ondragover={(e) => dragOver(e, item.key)}
        ondragleave={() => { dropTarget = undefined; }}
        ondrop={(e) => dropOn(e, parentName)}
        title="Chats filed in {parentName} that fit none of its subfolders">
        <button class="wstoggle press" tabindex="-1" onclick={(e) => { if (pick(item.id, e) === 'multi') return; setOpen(item.key, !item.open); }}
          aria-expanded={item.open} data-testid="toggle-misc">
          <span class="caret" class:down={item.open} class:none={!item.hasChildren}><Icon name="chevron" size={11} /></span>
          <Icon name={item.open ? 'folder-open' : 'folder'} size={12} />
          <span class="wsname">{item.name}</span>
          {#if item.count}<span class="count">{item.count}</span>{/if}
          {#if item.live}<span class="dot unread-dot" title="live or unread inside"></span>{/if}
        </button>
      </div>
    </div>
  {/snippet}

  {#snippet folderRow(item)}
    {@const key = item.key}
    {@const name = item.name}
    <div class="wsgroup" class:dim={item.archived} class:mutedfolder={item.muted} data-muted={item.muted ? 'true' : null} data-archived={item.archived ? 'true' : null} data-testid={key === UNFILED ? 'everything-else' : 'workspace-group'} data-catchall={key === UNFILED ? 'true' : null} data-workspace={name ?? ''} style="--depth:{item.depth}">
      <div class="wshead" data-ctx="folder" data-ctx-key={key} role="treeitem" aria-expanded={item.open} aria-selected={$sb.cursor === item.id} aria-level={item.depth + 1}
        class:sel={$sb.cursor === item.id} class:picked={isSel(item.id) && selected.size > 1}
        class:cut={$sb.clip === item.id}
        class:drop={dropTarget === key || (folderDrop?.key === key && folderDrop.where === 'inside')}
        class:dropbefore={folderDrop?.key === key && folderDrop.where === 'before'}
        class:dropafter={folderDrop?.key === key && folderDrop.where === 'after'}
        class:dragging={folderDrag === key}
        draggable={wsRenaming !== name}
        ondragstart={(e) => folderDragStart(e, key)}
        ondragend={folderDragEnd}
        ondragover={(e) => { if (folderDrag) folderDragOver(e, key); else dragOver(e, key); }}
        ondragleave={() => { dropTarget = undefined; if (folderDrop?.key === key) folderDrop = null; }}
        ondrop={(e) => { if (folderDrag) folderDropOn(e, key); else dropOn(e, name); }}
>
        {#if wsRenaming === name && name}
          <form class="wsrename" onsubmit={(event) => { event.preventDefault(); renameWorkspace(name, event.currentTarget.elements[0].value); }}>
            <!-- svelte-ignore a11y_autofocus -->
            <input class="filter focus-ring" value={name} aria-label="Rename workspace"
              onblur={(event) => renameWorkspace(name, event.currentTarget.value)}
              use:selectAll onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); sb.dispatch('rename.at', { key: null }); listEl?.focus(); } }} />
          </form>
        {:else}
          <button class="wstoggle press" tabindex="-1" onclick={(e) => { if (pick(item.id, e) === 'multi') return; if (e.altKey) setOpenDeep(key, !item.open); else setOpen(key, !item.open); }}
            ondblclick={() => { if (name) enter(name); }}
            aria-expanded={item.open} data-testid={key === UNFILED ? 'toggle-everything-else' : 'toggle-workspace'}>
            <span class="caret" class:down={item.open} class:none={!item.hasChildren && key !== UNFILED}><Icon name="chevron" size={11} /></span>
            <Icon name={name ? (item.open ? 'folder-open' : 'folder') : 'tray'} size={12} />
            <span class="wsname">{name ?? CATCHALL_LABEL}</span>
            {#if item.archivedOwn}<span class="archtag" data-testid="archived-marker">archived</span>{:else if item.archived}<span class="archtag">in archived</span>{/if}
            {#if item.count}<span class="count">{item.count}</span>{/if}
            {#if item.live}<span class="dot unread-dot" title="live or unread inside"></span>{/if}
          </button>
          {#if name && descOf(name)}<span class="wsinfo"><InfoTip testid="folder-info" label="Description of {name}" text={descOf(name)} onclick={() => editDesc(name)} /></span>{/if}
          <span class="wsacts">
            {#if name}
              <button class="icon-btn press" tabindex="-1" onclick={() => newFolder(key)} title="New subfolder" aria-label="New subfolder" data-testid="new-subfolder"><Icon name="plus" size={12} /></button>
              <button class="icon-btn press" tabindex="-1" onclick={() => startRename(name)} title="Rename" aria-label="Rename workspace" data-testid="rename-workspace"><Icon name="write" size={12} /></button>
            {/if}
            <button class="icon-btn press" tabindex="-1" onclick={(e) => openFolderMenu(e, key)} title="Move folder" aria-label="Move folder" data-testid="move-folder"><Icon name="more" size={12} /></button>
          </span>
        {/if}
      </div>
      {#if name && descEditing === name}<div class="wsdescedit">{@render descEditor(name)}</div>{/if}
    </div>
  {/snippet}

{#snippet chatRow(row, isFork, spanned = false)}
    <!-- Two-finger swipe left archives and swipe right pins, and the same buttons appear on
         hover; the reader library rows are the same component, where right stars instead. -->
    <div class="rowwrap" class:fork={isFork} class:cut={$sb.clip === `c:${row.id}`} data-ctx="chat" data-ctx-id={row.id}>
      <SwipeRow
        archived={row.archived}
        onarchive={() => onarchive(row.id, !row.archived)}
        testid={row.archived ? 'unarchive' : 'archive'}
        starred={Boolean(row.pinned)}
        starLabel={row.pinned ? 'Unpin' : 'Pin'}
        starIcon="pin"
        starIconOn="pin"
        startestid="pin"
        starbutton={false}
        onstar={() => onpin(row.id, !row.pinned)}
      >
        {#snippet actions()}
          
          
          <button
            class="icon-btn press"
            onclick={() => onread(row.id, marksRead(row))}
            title={marksRead(row) ? 'Mark read' : 'Mark unread'}
            aria-label={marksRead(row) ? 'Mark read' : 'Mark unread'}
            data-testid="mark-read"
          ><Icon name={marksRead(row) ? 'check' : 'circle'} size={13} /></button>
          <button
            class="icon-btn press"
            onclick={(event) => openMove(event, row.id)}
            title={canonicalWorkspace(row.workspace) ? `Workspace: ${canonicalWorkspace(row.workspace)}` : 'Move to workspace'}
            aria-label="Move to workspace"
            data-testid="move-workspace"
          ><Icon name="folder" size={13} /></button>
          <button
            class="icon-btn press"
            onclick={() => onaside(row.id, !row.aside)}
            title={row.aside ? 'Put it back (⌘U)' : 'Set aside (⌘U)'}
            aria-label={row.aside ? 'Put it back' : 'Set aside'}
            data-testid="set-aside"
          ><Icon name={row.aside ? 'aside-back' : 'aside'} size={13} /></button>
        {/snippet}
        {#snippet trailing()}
          <button
            class="icon-btn press"
            onclick={() => openDefer(row.id)}
            title={deferLabel(row, now) ? `Deferred: ${deferLabel(row, now)}` : 'Defer until'}
            aria-label="Defer until"
            data-testid="defer"
          ><Icon name="clock" size={13} /></button>
          <button
            class="icon-btn press"
            onclick={() => onopenbeside(row.id)}
            title="Open in new pane (⌃↵)"
            aria-label="Open in new pane"
            data-testid="open-pane"
          ><Icon name="split" size={13} /></button>
        {/snippet}
      <a
        class="chat press focus-ring"
        class:active={row.id === activeId}
        class:inpane={row.id !== activeId && openIds.includes(row.id)}
        class:muted={row.indicator === 'live-muted' && row.id !== activeId}
        class:sel={$sb.cursor === `c:${row.id}`} class:picked={isSel(`c:${row.id}`) && selected.size > 1}
        href="?chat={encodeURIComponent(row.id)}"
        onclick={(event) => rowClick(event, row.id)}
        ondblclick={(event) => rowDblClick(event, row.id)}
        data-testid="chat-row"
        data-chat={row.id}
        draggable="true"
        ondragstart={(event) => dragStart(event, row.id)}
      >
        {#if isFork}<span class="branch">↳</span>{/if}
        <span class="text">
          <span class="name">{#if row.automated || automatedTitle(row.title).automated}<span class="auto" title="Opened by an automated event, not by the owner" data-testid="automated-tag">auto</span>{/if}{automatedTitle(row.title).text || row.title}</span>
          <span class="preview">
            {#if deferLabel(row, now)}<span class="until">{deferLabel(row, now)}</span>{:else}{plainText(excerpts.get(row.id) || row.preview) || '—'}{/if}
          </span>
        </span>
        <span class="meta">
          
          <span class="mark" data-indicator={row.indicator}>
            {#if row.indicator === 'live'}<span class="dot live-dot"></span>
            {:else if row.indicator === 'unread'}<span class="dot unread-dot"></span>
            {:else}<span class="time">{spanned || filter.trim() ? chatSpan(row.createdAt, row.activeAt || row.updatedAt, now) : ago(row.activeAt || row.updatedAt)}</span>{/if}
          </span>
          {#if row.pinned}<span class="pinmark" title="Pinned"><Icon name="pin" size={11} /></span>{/if}
          {#if row.turns > 6}<span class="turns" title="{row.turns} turns">{row.turns}</span>{/if}
        </span>
      </a>
      </SwipeRow>
    </div>
  {/snippet}

</aside>

<style>
  .sidebar {
    width: 280px;
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--bg-sunken);
    border-right: 1px solid var(--line-soft);
    position: relative;
    height: 100%;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    
    
    padding: 20px clamp(12px, 4vw, 20px) 6px;
    padding-top: max(20px, env(safe-area-inset-top));
  }
  /** Mute When Closed: no dot, and the row a touch grayer, until the run ends or the chat is opened. */
  :global(.muted[data-testid="chat-row"]) { opacity: 0.6; }
  .auto { display: inline-block; margin-right: 5px; padding: 0 4px; border-radius: 3px; font-size: 10px; font-weight: 500; letter-spacing: 0.02em; vertical-align: 1px; color: var(--muted, #888); border: 1px solid currentColor; opacity: 0.8; }
  .title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; letter-spacing: 0.01em; }
  .conn { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-faint); transition: background-color var(--panel) var(--ease); }
  .conn.live { background: var(--live); }
  .conn.offline { background: var(--warn); }
  .offline-note { font-size: 11px; color: var(--muted, #888); margin-left: 6px; letter-spacing: 0.02em; }
  header .icon-btn { display: none; }
  .tools { display: flex; align-items: stretch; gap: 6px; padding: 4px 12px 8px; }
  /* The trays themselves live in Tray.svelte; the sidebar only says where the stack sits and
     how much room it may take. */
  :global(.sidebar > .tray:last-of-type) { padding-bottom: env(safe-area-inset-bottom); }
  /* What a deferred row says instead of its last message: when it comes back, or what it is
     waiting on. */
  .until { color: var(--ink-faint); font-style: italic; }
  .pinmark { display: inline-flex; color: var(--ink-faint); }
  .filter {
    flex: 1; min-width: 0;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px 10px;
    color: var(--ink);
    font-size: 13px;
    outline: none;
    transition: border-color var(--tap) var(--ease);
  }
  .filter:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .search {
    width: 32px; flex: none;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink-dim);
    font-size: 12px;
  }
  .search:hover { color: var(--ink); border-color: var(--ink-faint); }
  .list { flex: 1; min-height: 0; padding: 0 8px 84px; }
  .group { margin-bottom: 1px; }
  .dim { opacity: 0.5; }
  .mutedfolder > .wshead { opacity: 0.5; }
  .archtag { font-size: 10px; color: var(--ink-faint); border: 1px solid color-mix(in srgb, var(--ink) 18%, transparent); border-radius: 4px; padding: 0 4px; margin-left: 4px; }
  .rowwrap { position: relative; --swipe-bg: var(--bg-sunken); }
  /* Group hover: the row keeps its hover colour while the pointer is on its buttons (they sit beside the link, not in it),
     and the buttons' left fade is that same colour, so the fade hides the text with no visible box edge.
     Each highlight is a tint over the sidebar's --bg-sunken, so the opaque fade colour is the same mix over it.
     :global(.chat) because Svelte would scope a `> *` step to this component and never match inside SwipeRow
     (the owner 11-11 17:37: "it needs to match the actual bg color . which is usually a hover or active/selected color" [;] "there needs to be a group hover") */
  .rowwrap:hover { --rowactions-bg: color-mix(in srgb, var(--ink) 5%, var(--bg-sunken)); }
  .rowwrap:has(:global(.chat.sel)) { --rowactions-bg: color-mix(in srgb, var(--accent) 7%, var(--bg-sunken)); }
  .rowwrap:has(:global(.chat.inpane)) { --rowactions-bg: color-mix(in srgb, var(--accent) 20%, var(--bg-sunken)); }
  .rowwrap:has(:global(.chat.active)) { --rowactions-bg: color-mix(in srgb, var(--accent) 30%, var(--bg-sunken)); }
  .chat {
    display: flex; align-items: center; gap: 8px;
    width: 100%; text-align: left;
    padding: 8px 10px;
    border-radius: 8px;
    min-height: 46px;
    
    color: inherit; text-decoration: none; cursor: pointer;
  }
  .rowwrap:hover .chat:not(.active):not(.inpane):not(.sel) { background: color-mix(in srgb, var(--ink) 5%, transparent); }
  .chat.active { background: color-mix(in srgb, var(--accent) 30%, transparent); }
  .chat.inpane { background: color-mix(in srgb, var(--accent) 20%, transparent); }
  
  .chat.sel { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .fork .chat { margin-left: 14px; width: calc(100% - 14px); }
  .branch { color: var(--ink-faint); font-size: 12px; flex: none; }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview { font-size: 11.5px; color: var(--ink-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: flex; align-items: center; gap: 6px; flex: none; }
  .time { font-size: 10.5px; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
  .turns { font-size: 9.5px; color: var(--ink-faint); border: 1px solid var(--line); border-radius: 999px; padding: 0 4px; }
  .dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--accent); }
  
  .mark { display: inline-flex; align-items: center; justify-content: flex-end; min-width: 30px; }
  /* The hover cluster, the swipe strip and the touch-screen rule all live in SwipeRow now; the
     buttons passed into it still take .icon-btn from here. */
  @media (hover: none) and (pointer: coarse) {
    .rowwrap .icon-btn { width: 30px; height: 30px; }
  }
  /* Five buttons on an unread row (mark unread, open in new pane, set aside, defer, archive) at
     26px reached past the middle of the 280px row, so a click on its middle hit a button instead
     of opening the chat. At 22px the cluster stays in the right half. */
  @media (hover: hover) and (pointer: fine) {
    .rowwrap .icon-btn { width: 22px; height: 22px; }
    /* Six buttons in one line (unread, folder, set aside, archive, defer, split) still spanned
       142px and covered the middle of a 264px row again, so Mark unread took clicks meant for the
       chat. Two rows of three fit the 46px row height and keep the cluster to the right 76px,
       whatever the sidebar width. Order stays left to right, top row first. */
    .rowwrap :global(.rowactions) {
      display: grid;
      grid-template-columns: repeat(3, 22px);
      grid-auto-rows: 22px;
      gap: 2px;
    }
  }
  .icon-btn {
    width: 26px; height: 26px; border-radius: 6px;
    display: grid; place-items: center;
    color: var(--ink-faint); font-size: 12px;
  }
  .icon-btn:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 8%, transparent); }
  .empty { color: var(--ink-faint); font-size: 12.5px; padding: 12px 10px; }
  /* Workspaces: folded groups at the head of the list; the one he is in is the strip above it. */
  .wsnew { padding: 0 12px 8px; display: flex; }
  .wscur {
    display: flex; align-items: center; gap: 6px; margin: 0 12px 6px; padding: 5px 6px 5px 10px;
    border: 1px solid var(--line); border-radius: 8px; color: var(--ink); font-size: 12.5px; font-weight: 500;
  }
  .wscur .wsname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wscur .leave { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 5px; color: var(--ink-faint); }
  .wscur .leave:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 8%, transparent); }
  .count { font-size: 10.5px; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
  /* The explorer (VS Code's tree): every row indents by its depth, with one faint guide line per level. */
  .wsgroup, .group, .wsnew.sub { --indent: 12px; padding-left: calc(var(--depth, 0) * var(--indent));
    background-image: repeating-linear-gradient(to right, transparent 0 7px, var(--line-soft, var(--line)) 7px 8px, transparent 8px var(--indent));
    background-size: calc(var(--depth, 0) * var(--indent)) 100%; background-repeat: no-repeat; }
  .wshead.sel { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .list:focus { outline: none; }
  .list:focus-visible .sel { box-shadow: inset 0 0 0 1px var(--accent); }
  .caret.none { visibility: hidden; }
  .chat.picked, .wshead.picked { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .wshead.cut, .rowwrap.cut { opacity: 0.5; }
  .sbnotice { display: flex; align-items: flex-start; gap: 6px; margin: 0 12px 6px; padding: 5px 4px 5px 8px; font-size: 11.5px; line-height: 1.35; color: var(--ink-dim); border: 1px solid var(--line-soft, var(--line)); border-radius: 7px; }
  .sbnotice span { flex: 1; min-width: 0; }
  .sbnotice .icon-btn { width: 18px; height: 18px; flex: none; }
  .wsnew.sub { display: flex; align-items: center; gap: 6px; padding-top: 2px; padding-bottom: 2px; padding-right: 4px; color: var(--ink-faint); }
  .wsnew.sub .filter { padding: 3px 8px; font-size: 12.5px; }
  .crumbs { display: flex; align-items: center; gap: 2px; margin: 0 12px 6px; padding: 3px 4px 3px 6px; min-width: 0;
    border-bottom: 1px solid var(--line-soft, var(--line)); font-size: 12.5px; color: var(--ink-dim); overflow-x: auto; white-space: nowrap; scrollbar-width: none; }
  .crumbs.drop { box-shadow: inset 0 0 0 1px var(--accent); }
  .crumb { border: 0; background: none; color: inherit; font: inherit; padding: 2px 5px; border-radius: 5px; cursor: pointer; max-width: 12em; overflow: hidden; text-overflow: ellipsis; }
  button.crumb:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 7%, transparent); }
  .crumb.here { color: var(--ink); font-weight: 500; cursor: default; }
  .crumbsep { color: var(--ink-faint); padding: 0 1px; }
  .crumbs .count { margin-left: 4px; }
  .crumbacts { margin-left: auto; display: flex; gap: 2px; padding-left: 6px; }
  .crumbacts .icon-btn { width: 22px; height: 22px; }
  .wshead { position: relative; display: flex; align-items: center; border-radius: 7px; }
  .wshead:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
  .wshead.drop, .wscur.drop { box-shadow: inset 0 0 0 1px var(--accent); }
  .wstoggle {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 3px 6px; min-height: 24px;
    border: 0; background: none; color: var(--ink-dim); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
  }
  .wstoggle .wsname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .caret { display: inline-flex; color: var(--ink-faint); transition: transform var(--tap, 120ms) var(--ease, ease); }
  .caret.down { transform: rotate(90deg); }
  .wsacts { position: absolute; right: 0; top: 0; bottom: 0; align-items: center; display: flex; gap: 2px; padding: 0 4px 0 14px; opacity: 0; pointer-events: none; border-radius: 0 7px 7px 0; background: linear-gradient(to right, transparent, var(--bg-sunken) 14px); }
  .wshead:hover .wsacts, .wshead:focus-within .wsacts { opacity: 1; pointer-events: auto; }
  @media (hover: none) { .wsacts { opacity: 1; pointer-events: auto; position: static; background: none; padding: 0 4px 0 0; } }
  .wsacts .icon-btn { width: 22px; height: 22px; }
  .wsrename { flex: 1; padding: 3px 4px; display: flex; }
  .wsbody { padding-left: 10px; }
  .wsdescedit { margin: 2px 4px 6px 22px; }
  .crumbedit { margin: 0 12px 8px; }
  .wsinfo { display: flex; opacity: 0; }
  .wshead:hover .wsinfo, .wshead.sel .wsinfo, .wshead:focus-within .wsinfo, .wsinfo:has(:focus-visible) { opacity: 1; }
  @media (hover: none) { .wsinfo { opacity: 1; } }
  .crumbs :global(.info) { width: 20px; height: 20px; opacity: 0.8; }
  .hostwrap { position: relative; display: flex; }
  .wsinner { margin: 0 0 4px; }
  .wshead[draggable='true'] { cursor: grab; }
  .wshead.dragging { opacity: 0.45; }
  .wshead.dropbefore { box-shadow: inset 0 2px 0 var(--accent); }
  .wshead.dropafter { box-shadow: inset 0 -2px 0 var(--accent); }
  .wsscrim { position: absolute; inset: 0; z-index: 50; }
  .wsmenu {
    position: absolute; z-index: 51; width: 200px; padding: 4px; display: flex; flex-direction: column;
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.25);
  }
  .wsmenuhead { font-size: 11px; color: var(--ink-faint); padding: 4px 8px; }
  .wsmenu button {
    display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 0; border-radius: 6px; background: none;
    color: var(--ink); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
  }
  .wsmenu button:hover { background: color-mix(in srgb, var(--ink) 7%, transparent); }
  .wsmenu button.on { color: var(--accent); }
  .wsmenu form { display: flex; padding: 4px 2px 2px; }

  
  
  @media (min-width: 861px) {
    .sidebar { width: var(--sidebar-w, 280px); }
    .sidebar:not(.open) { display: none; }
  }

  @media (max-width: 860px) {
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      width: min(86vw, 340px);
      z-index: 40;
      transform: translateX(-100%);
      transition: transform var(--panel) var(--ease);
      box-shadow: 0 0 40px rgb(0 0 0 / 0.4);
    }
    .sidebar.open { transform: none; }
    /** A bar talking to him floats over the band above the composer, and the composer is behind
     *       this drawer, so with the drawer out that band lands in the middle of the list. The list
     *       gives up its foot for as long as the bar stands rather than letting it cover rows and
     *       of the row at y 755 and a corner of the Done button at y 714. --notif-floor is published
     *       by UndoBar and removed with it.
     */
    .sidebar { padding-bottom: var(--notif-floor, 0px); }
    header .icon-btn { display: grid; }
  }
</style>
