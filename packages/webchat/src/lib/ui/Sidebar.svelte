<script>
  import { automatedTitle } from '$lib/core/title.js';
  import Icon from './Icon.svelte';
  import Nav from './Nav.svelte';
  import SwipeRow from './SwipeRow.svelte';
  import Tray from './Tray.svelte';
  import DeferSheet from './DeferSheet.svelte';
  import { groupForks, rankConversations, trayCounts } from '$lib/core/recency.js';
  import { deferLabel } from '$lib/core/defer.js';
  import { CACHED_LIMIT, mergeResults, searchCachedChats, searchStages } from '$lib/core/search.js';
  import { isListDown, isListUp } from '$lib/core/keys.js';
  import { listedConversations, stableListing } from '$lib/core/transient.js';
  // what the host page keeps out of the lists (core/transient.js unlistedByHost); none on the owner's own app
  const hostUnlisted = () => (typeof window === 'undefined' ? null : window.__tophatUnlisted || null);
  import { queueEdit as queueDescription, readCached as readCachedDescs, sync as syncDescriptions } from '$lib/core/folder-descs.js';
  import { CATCHALL_LABEL, ROOT, UNFILED, canonicalWorkspace, folderKey, folderTree, listWorkspaces, moveFolder, normalizeWorkspace, partitionByWorkspace } from '$lib/core/workspaces.js';
  import { sidebarDecl, openKey } from '$lib/core/sidebar-state.js';
  import { uiApp } from '$lib/client/ui-app.js';
  import HostMenu from './HostMenu.svelte';
  import { hostState, refreshHosts } from '$lib/core/hosts.svelte.js';

  let {
    conversations = {},
    chatState = null,
    session = null,
    activeId = null,
    openIds = [],
    onselect = () => {},
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
  if (enterAtStart && !sb.get().current) sb.dispatch('workspace.enter', { name: enterAtStart });
  const workspace = $derived($sb.current);
  const wsLayout = $derived($sb.layout);
  const isOpen = (key) => Boolean($sb.open[key]);
  const enter = (name) => sb.dispatch('workspace.enter', { name });
  // The catch-all (Inbox, once called Everything else) folds too at the top level. Per device, beside the rest of the folder
  // state. Folder descriptions (his edits are source "manual", authoritative for the router and never regenerated; the rest are
  // rewritten daily). Offline first: core/folder-descs.js keeps a device cache and a persisted outbox, so an edit shows at once
  // and is sent when the server is reachable.
  let descs = $state(readCachedDescs());
  const descOf = (name) => (name ? descs[String(name).toLowerCase()]?.text || '' : '');
  const descSource = (name) => (name ? descs[String(name).toLowerCase()]?.source || '' : '');
  async function syncDescs() { descs = await syncDescriptions(); }
  $effect(() => {
    syncDescs();
    const again = () => syncDescs();
    globalThis.addEventListener?.('online', again);
    return () => globalThis.removeEventListener?.('online', again);
  });
  // The host menu (HostMenu.svelte): the peers a chat can run on, whether the router may pick each, and what to send there.
  $effect(() => {
    let stopped = false, timer = null;
    const loop = async () => { await refreshHosts(); if (!stopped) timer = setTimeout(loop, 20_000); };
    loop();
    return () => { stopped = true; clearTimeout(timer); };
  });
  let hostMenuY = $state(null);
  function openHostMenu(event) {
    const box = event.currentTarget.getBoundingClientRect();
    hostMenuY = box.bottom - rootEl.getBoundingClientRect().top + 4;
  }
  let descEditing = $state(null);
  let descDraft = $state('');
  function editDesc(name) { descEditing = name; descDraft = descOf(name); }
  function saveDesc(name, text) {
    descEditing = null;
    descs = queueDescription(name, text);
    syncDescs();
  }
  const mainFolded = $derived($sb.mainFolded);
  // Folder drag: which folder is moving and where it would land ({ key, where }).
  let folderDrag = $state(null);
  let folderDrop = $state(null);
  let wsCreating = $state(false);
  let wsDraft = $state('');
  let wsRenaming = $state(null);
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
  function commitCreate() {
    const name = wsDraft;
    wsDraft = '';
    wsCreating = false;
    createWorkspace(name, { enter: true, file: moveFor });
    moveFor = null;
  }
  function renameWorkspace(from, to) {
    const clean = normalizeWorkspace(to);
    wsRenaming = null;
    if (!clean || clean === from) return;
    for (const c of Object.values(conversations)) if (c.workspace && c.workspace.toLowerCase() === from.toLowerCase()) onworkspace(c.id, clean);
    sb.dispatch('folder.rename', { from, to: clean });
  }
  function deleteWorkspace(name) {
    const members = Object.values(conversations).filter((c) => c.workspace && c.workspace.toLowerCase() === name.toLowerCase());
    if (members.length && !confirm(`Remove the workspace "${name}"? Its ${members.length} chat${members.length === 1 ? '' : 's'} go back to the main list; nothing is deleted.`)) return;
    for (const c of members) onworkspace(c.id, null);
    sb.dispatch('folder.remove', { name });
  }
  const toggleWs = (key) => sb.dispatch('folder.open', { key, open: !isOpen(key) });
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
    dropTarget = key;
  };
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
    folderDrop = { key, where };
  }
  function folderDropOn(event, key) {
    if (!folderDrag || !folderDrop || folderDrop.key !== key) return;
    event.preventDefault();
    sb.dispatch('folder.move', { all: allWorkspaces, drag: folderDrag, target: key, where: folderDrop.where });
    if (folderDrop.where === 'inside') sb.dispatch('folder.open', { key: openKey(nameForKey(key)), open: true });
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
    if (key) sb.dispatch('folder.move', { all: allWorkspaces, drag: key, target, where });
  }
  function folderDragEnd() { folderDrag = null; folderDrop = null; }
  const nameForKey = (key) => (key === UNFILED ? null : allWorkspaces.find((n) => folderKey(n) === key) ?? null);
  // The current-workspace strip takes a folder dropped on it as "inside the folder I am in".
  function stripFolderDrop(event) {
    if (!folderDrag) return;
    const here = workspace ? folderKey(workspace) : UNFILED;
    const next = moveFolder(allWorkspaces, wsLayout, folderDrag, here, 'inside');
    if (next !== wsLayout) { event.preventDefault(); sb.dispatch('folder.move', { all: allWorkspaces, drag: folderDrag, target: here, where: 'inside' }); }
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

  const ordering = $derived(groupForks(rankConversations(listed, { now, match })));
  // A shut tray is only counted; its rows are ranked when it is open or a search may open it.
  const searchingTrays = $derived(Boolean(filter.trim()));
  const trays = $derived(trayCounts(listed, { now, match }));
  const archivedRows = $derived(archivedOpen || searchingTrays ? rankConversations(listed, { now, match, onlyArchived: true }) : []);
  const asideRows = $derived(asideOpen || searchingTrays ? rankConversations(listed, { now, match, onlyAside: true }) : []);
  const deferredRows = $derived(deferredOpen || searchingTrays ? rankConversations(listed, { now, match, onlyDeferred: true }) : []);
  let rows = $state([]);
  $effect(() => {
    const next = ordering;
    if (!status.syncing) { rows = next; return; }
    const timer = setTimeout(() => { rows = next; }, 180);
    return () => clearTimeout(timer);
  });

  const marksRead = (row) => Boolean(row.unread) || row.indicator === 'live';

  const parts = $derived(partitionByWorkspace(rows, { current: workspace, names: allWorkspaces, searching: Boolean(filter.trim()), layout: wsLayout }));
  const mainRows = $derived(parts.main);
  const wsGroups = $derived(parts.groups);
  const wsInner = $derived(parts.inner || []);
  const wsKey = openKey;
  // The header shows when there is something to focus on instead: at the top level with folders.
  const mainFoldable = $derived(!workspace && !filter.trim() && (wsGroups.length > 0));
  const mainHidden = $derived(mainFoldable && mainFolded);
  // Keyboard order follows what is on screen: open folders depth first, subfolders before rows.
  const openRows = (groups) => groups.filter((g) => isOpen(wsKey(g.name))).flatMap((g) => [...openRows(g.children || []), ...g.rows.flatMap((row) => [row, ...row.forks])]);
  const flat = $derived([
    ...openRows(wsGroups),
    ...openRows(wsInner),
    ...(mainHidden ? [] : mainRows.flatMap((row) => [row, ...row.forks])),
    ...(deferredOpen ? deferredRows : []),
    ...(asideOpen ? asideRows : []),
    ...(archivedOpen ? archivedRows : [])
  ]);
  let selected = $state(-1);
  let listEl = $state(null);
  let rootEl = $state(null);

  $effect(() => { filter; selected = -1; });
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
    if (selected < 0 || !rootEl) return;
    // The archived rows sit outside the list's scroller now, so keyboard selection looks for the
    // row anywhere in the sidebar.
    rootEl?.querySelector('.chat.sel')?.scrollIntoView({ block: 'nearest' });
  });

  function filterKeydown(event) {
    if (isListDown(event)) {
      event.preventDefault();
      selected = Math.min(selected + 1, flat.length - 1);
      return;
    }
    if (isListUp(event)) {
      event.preventDefault();
      selected = Math.max(selected - 1, 0);
      return;
    }
    if (event.key === 'Enter') {
      const row = flat[selected] || flat[0];
      if (row) { event.preventDefault(); onselect(row.id); }
      return;
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (filter) filter = '';
      else onclose();
    }
  }

  function rowClick(event, id) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onselect(id);
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
    <button class="search press focus-ring" onclick={() => { wsCreating = !wsCreating; moveFor = null; }} data-testid="new-workspace" title="New workspace" aria-label="New workspace"><Icon name="folder" /></button>
    {#if hostState.list.length > 1}<button class="search press focus-ring" class:on={hostMenuY !== null} onclick={openHostMenu} data-testid="host-menu-button" title="Hosts: which machines chats run on" aria-label="Hosts" aria-haspopup="menu" aria-expanded={hostMenuY !== null}><Icon name="server" /></button>{/if}
  </div>

  {#if wsCreating}
    <form class="wsnew" onsubmit={(event) => { event.preventDefault(); commitCreate(); }}>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="filter focus-ring" bind:value={wsDraft} placeholder="Workspace name" aria-label="Workspace name" data-testid="workspace-name" autofocus
        onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); wsCreating = false; wsDraft = ''; } }} />
    </form>
  {/if}

  {#if workspace}
    <div class="wscur" data-testid="current-workspace" ondragover={(e) => { if (folderDrag) e.preventDefault(); else dragOver(e, wsKey(workspace)); }} ondragleave={() => (dropTarget = undefined)} ondrop={(e) => { if (folderDrag) stripFolderDrop(e); else dropOn(e, workspace); }} class:drop={dropTarget === wsKey(workspace)} role="group">
      <Icon name="folder" size={12} />
      <span class="wsname">{workspace}</span>
      <span class="count">{mainRows.length}</span>
      <button class="leave press focus-ring" onclick={() => enter(null)} data-testid="leave-workspace" title="Leave this workspace" aria-label="Leave workspace"><Icon name="close" size={11} /></button>
    </div>
  {/if}

  <div class="scroller list" data-testid="chat-list" bind:this={listEl}>
    {#if wsGroups.length}
      <div class="wsgroups" data-testid="workspace-groups">
        {#each wsGroups as group (wsKey(group.name))}{@render folderNode(group)}
        {/each}
      </div>
    {/if}
    {#if mainFoldable}
      <!-- Inbox: unfiled chats and chats stored under the name Inbox are one set (core/workspaces.js),
           and they sit inside this fold like every other folder's chats, never loose in the list. -->
      <div class="wsgroup" data-testid="everything-else" data-catchall="true">
        <div class="wshead" role="group"
          class:drop={dropTarget === wsKey(null) || (folderDrop?.key === UNFILED && folderDrop.where === 'inside')}
          class:dropbefore={folderDrop?.key === UNFILED && folderDrop.where === 'before'}
          class:dropafter={folderDrop?.key === UNFILED && folderDrop.where === 'after'}
          class:dragging={folderDrag === UNFILED}
          draggable="true"
          ondragstart={(e) => folderDragStart(e, UNFILED)}
          ondragend={folderDragEnd}
          ondragover={(e) => { if (folderDrag) folderDragOver(e, UNFILED); else dragOver(e, wsKey(null)); }}
          ondragleave={() => { dropTarget = undefined; if (folderDrop?.key === UNFILED) folderDrop = null; }}
          ondrop={(e) => { if (folderDrag) folderDropOn(e, UNFILED); else dropOn(e, null); }}
          title="Chats that are in no folder. Drop a folder on the middle to put it inside Inbox">
          <button class="wstoggle press focus-ring" onclick={() => sb.dispatch('main.fold', { folded: !mainFolded })} aria-expanded={!mainFolded} data-testid="toggle-everything-else">
            <span class="caret" class:down={!mainFolded}><Icon name="chevron" size={11} /></span>
            <Icon name="tray" size={12} />
            <span class="wsname">{CATCHALL_LABEL}</span>
            <span class="count">{mainRows.length}</span>
            {#if mainHidden && mainRows.some((row) => row.indicator === 'live' || row.indicator === 'unread')}<span class="dot unread-dot" title="live or unread inside"></span>{/if}
          </button>
        </div>
        {#if !mainHidden}
          <div class="wsbody" data-testid="inbox-body">
            {#if wsInner.length}
              <div class="wsinner" data-testid="workspace-inner">
                {#each wsInner as group (wsKey(group.name))}{@render folderNode(group)}{/each}
              </div>
            {/if}
            {#each mainRows as row (row.id)}
              <div class="group">
                {@render chatRow(row, false)}
                {#each row.forks as fork (fork.id)}
                  {@render chatRow(fork, true)}
                {/each}
              </div>
            {/each}
            {#if !mainRows.length && !wsInner.length}<p class="empty">Nothing here: every chat is in a folder.</p>{/if}
          </div>
        {/if}
      </div>
    {:else}
      {#if wsInner.length}
        <div class="wsinner" data-testid="workspace-inner">
          {#each wsInner as group (wsKey(group.name))}{@render folderNode(group)}{/each}
        </div>
      {/if}
      {#each mainRows as row (row.id)}
        <div class="group">
          {@render chatRow(row, false)}
          {#each row.forks as fork (fork.id)}
            {@render chatRow(fork, true)}
          {/each}
        </div>
      {/each}
    {/if}
    {#if !mainRows.length && !mainFoldable}
      <p class="empty">{filter ? 'No chat matches that.' : workspace ? 'Nothing in this workspace yet. New chats you start here land in it.' : 'No chats yet.'}</p>
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

  {#if hostMenuY !== null}
    <HostMenu top={hostMenuY} onclose={() => (hostMenuY = null)} />
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

  {#snippet folderNode(group)}
    {@const key = wsKey(group.name)}
    {@const live = group.rows.filter((row) => row.indicator === 'live' || row.indicator === 'unread').length}
    <div class="wsgroup" data-testid="workspace-group" data-workspace={group.name ?? ''}>
      <div class="wshead" class:drop={dropTarget === key || (folderDrop?.key === group.key && folderDrop.where === 'inside')}
        class:dropbefore={folderDrop?.key === group.key && folderDrop.where === 'before'}
        class:dropafter={folderDrop?.key === group.key && folderDrop.where === 'after'}
        class:dragging={folderDrag === group.key}
        draggable={wsRenaming !== group.name}
        ondragstart={(e) => folderDragStart(e, group.key)}
        ondragend={folderDragEnd}
        ondragover={(e) => { if (folderDrag) folderDragOver(e, group.key); else dragOver(e, key); }}
        ondragleave={() => { dropTarget = undefined; if (folderDrop?.key === group.key) folderDrop = null; }}
        ondrop={(e) => { if (folderDrag) folderDropOn(e, group.key); else dropOn(e, group.name); }}
        title={descOf(group.name) || "Drag to reorder, or onto the middle of another folder to put it inside"}
        role="group">
        {#if wsRenaming === group.name && group.name}
          <form class="wsrename" onsubmit={(event) => { event.preventDefault(); renameWorkspace(group.name, event.currentTarget.elements[0].value); }}>
            <!-- svelte-ignore a11y_autofocus -->
            <input class="filter focus-ring" value={group.name} autofocus aria-label="Rename workspace"
              onblur={(event) => renameWorkspace(group.name, event.currentTarget.value)}
              onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); wsRenaming = null; } }} />
          </form>
        {:else}
          <button class="wstoggle press focus-ring" onclick={() => toggleWs(key)} aria-expanded={isOpen(key)} data-testid="toggle-workspace">
            <span class="caret" class:down={isOpen(key)}><Icon name="chevron" size={11} /></span>
            <Icon name={group.name ? 'folder' : 'tray'} size={12} />
            <span class="wsname">{group.name ?? CATCHALL_LABEL}</span>
            <span class="count">{group.rows.length}</span>
            {#if live}<span class="dot unread-dot" title="{live} live or unread"></span>{/if}
          </button>
          <span class="wsacts">
            <button class="icon-btn press" onclick={(e) => openFolderMenu(e, group.key)} title="Move folder" aria-label="Move folder" data-testid="move-folder"><Icon name="folder" size={12} /></button>
            {#if group.name}
              <button class="icon-btn press" onclick={() => editDesc(group.name)} title="Edit description" aria-label="Edit description" data-testid="edit-description"><Icon name="note" size={12} /></button>
              <button class="icon-btn press" onclick={() => (wsRenaming = group.name)} title="Rename" aria-label="Rename workspace" data-testid="rename-workspace"><Icon name="write" size={12} /></button>
              <button class="icon-btn press" onclick={() => deleteWorkspace(group.name)} title="Remove workspace (chats go back to the main list)" aria-label="Remove workspace" data-testid="remove-workspace"><Icon name="close" size={12} /></button>
            {/if}
            <button class="icon-btn press" onclick={() => enter(group.name)} title={group.name ? `Work in ${group.name}` : 'Leave workspace'} aria-label="Enter workspace" data-testid="enter-workspace"><Icon name="chevron" size={12} /></button>
          </span>
        {/if}
      </div>
      {#if group.name && descEditing === group.name}
        <form class="wsdescedit" data-testid="description-editor" onsubmit={(event) => { event.preventDefault(); saveDesc(group.name, descDraft); }}>
          <label for="desc-{key.replace(/[^a-z0-9]+/g, '-')}">What belongs in {group.name} <span class="wsdescsrc">{descSource(group.name) === 'manual' ? '(your words; the router treats this as the definition)' : descSource(group.name) === 'auto' ? '(auto-written; saving makes it yours)' : '(none yet)'}</span></label>
          <!-- svelte-ignore a11y_autofocus -->
          <textarea id="desc-{key.replace(/[^a-z0-9]+/g, '-')}" class="filter focus-ring" rows="4" maxlength="300" bind:value={descDraft} autofocus data-testid="description-text"
            onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); descEditing = null; } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveDesc(group.name, descDraft); } }}></textarea>
          <div class="wsdescbtns">
            <button type="submit" class="press" data-testid="description-save">Save</button>
            <button type="button" class="press" onclick={() => (descEditing = null)}>Cancel</button>
            {#if descSource(group.name) === 'manual'}<button type="button" class="press" onclick={() => saveDesc(group.name, '')} title="Hand the folder back to the daily generator" data-testid="description-reset">Back to auto</button>{/if}
          </div>
        </form>
      {/if}
      {#if isOpen(key)}
        <div class="wsbody">
          {#each group.children || [] as child (wsKey(child.name))}{@render folderNode(child)}{/each}
          {#each group.rows as row (row.id)}
            <div class="group">
              {@render chatRow(row, false)}
              {#each row.forks as fork (fork.id)}{@render chatRow(fork, true)}{/each}
            </div>
          {/each}
          {#if !group.rows.length && !(group.children || []).length}<p class="empty">Empty. Drag a chat here, or use its folder button.</p>{/if}
        </div>
      {/if}
    </div>
{/snippet}

{#snippet chatRow(row, isFork)}
    <!-- Two-finger swipe left archives and swipe right pins, and the same buttons appear on
         hover; the reader library rows are the same component, where right stars instead. -->
    <div class="rowwrap" class:fork={isFork}>
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
          
          {#if !marksRead(row)}
            <!-- Mark unread only: marking read IS Done (Cmd-E), so the check half of this toggle went. -->
            <button class="icon-btn press" onclick={() => onread(row.id, false)} title="Mark unread" aria-label="Mark unread" data-testid="mark-read"><Icon name="circle" size={13} /></button>
          {/if}
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
            title="Open in new pane"
            aria-label="Open in new pane"
            data-testid="open-pane"
          ><Icon name="split" size={13} /></button>
        {/snippet}
      <a
        class="chat press focus-ring"
        class:active={row.id === activeId}
        class:inpane={row.id !== activeId && openIds.includes(row.id)}
        class:sel={flat[selected]?.id === row.id}
        href="?chat={encodeURIComponent(row.id)}"
        onclick={(event) => rowClick(event, row.id)}
        data-testid="chat-row"
        data-chat={row.id}
        draggable="true"
        ondragstart={(event) => dragStart(event, row.id)}
      >
        {#if isFork}<span class="branch">↳</span>{/if}
        <span class="text">
          <span class="name">{#if row.automated || automatedTitle(row.title).automated}<span class="auto" title="Opened by an automated event, not by the owner" data-testid="automated-tag">auto</span>{/if}{automatedTitle(row.title).text || row.title}</span>
          <span class="preview">
            {#if deferLabel(row, now)}<span class="until">{deferLabel(row, now)}</span>{:else}{excerpts.get(row.id) || row.preview || '—'}{/if}
          </span>
        </span>
        <span class="meta">
          
          <span class="mark" data-indicator={row.indicator}>
            {#if row.indicator === 'live'}<span class="dot live-dot"></span>
            {:else if row.indicator === 'live-muted'}<span class="dot live-dot muted-dot"></span>
            {:else if row.indicator === 'unread'}<span class="dot unread-dot"></span>
            {:else}<span class="time">{ago(row.activeAt || row.updatedAt)}</span>{/if}
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
  .rowwrap { position: relative; --swipe-bg: var(--bg-sunken); }
  .chat {
    display: flex; align-items: center; gap: 8px;
    width: 100%; text-align: left;
    padding: 8px 10px;
    border-radius: 8px;
    min-height: 46px;
    
    color: inherit; text-decoration: none; cursor: pointer;
  }
  .chat:hover { background: color-mix(in srgb, var(--ink) 5%, transparent); }
  .chat.active { background: var(--accent-soft); }
  .chat.inpane { background: color-mix(in srgb, var(--ink) 7%, transparent); }
  
  .chat.sel { background: color-mix(in srgb, var(--ink) 9%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
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
  .wsgroups { margin: 0 0 6px; padding-bottom: 6px; border-bottom: 1px solid var(--line-soft); }
  .wshead { display: flex; align-items: center; border-radius: 7px; }
  .wshead:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
  .wshead.drop, .wscur.drop { box-shadow: inset 0 0 0 1px var(--accent); }
  .wstoggle {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 6px 8px;
    border: 0; background: none; color: var(--ink-dim); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
  }
  .wstoggle .wsname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .caret { display: inline-flex; color: var(--ink-faint); transition: transform var(--tap, 120ms) var(--ease, ease); }
  .caret.down { transform: rotate(90deg); }
  .wsacts { display: flex; gap: 2px; padding-right: 4px; opacity: 0; }
  .wshead:hover .wsacts, .wshead:focus-within .wsacts { opacity: 1; }
  @media (hover: none) { .wsacts { opacity: 1; } }
  .wsacts .icon-btn { width: 22px; height: 22px; }
  .wsrename { flex: 1; padding: 3px 4px; display: flex; }
  .wsbody { padding-left: 10px; }
  .wsdesc { display: block; width: 100%; text-align: left; margin: 0 0 2px; padding: 0 8px 3px 30px; border: 0; background: none; color: var(--ink-faint); font: inherit; font-size: 11.5px; line-height: 1.3; cursor: text; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .wsdesc[data-source='auto'] { font-style: italic; }
  .wsdescedit { display: flex; flex-direction: column; gap: 5px; margin: 2px 4px 6px 10px; }
  .wsdescedit label { font-size: 11.5px; color: var(--ink-soft, var(--ink-faint)); }
  .wsdescsrc { color: var(--ink-faint); }
  .wsdescedit textarea { resize: vertical; min-height: 64px; font-size: 12.5px; line-height: 1.35; }
  .wsdescbtns { display: flex; gap: 6px; }
  .wsdescbtns button { padding: 3px 9px; border-radius: 6px; border: 1px solid var(--line-soft); background: none; color: var(--ink); font: inherit; font-size: 12px; cursor: pointer; }
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
