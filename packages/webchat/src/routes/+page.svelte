<script>
  import { onMount, tick } from 'svelte';
  import { afterNavigate, replaceState as navReplaceState } from '$app/navigation';
  import Nav from '$lib/ui/Nav.svelte';
  import BackgroundChat from '$lib/ui/BackgroundChat.svelte';
  import Sidebar from '$lib/ui/Sidebar.svelte';
  import ChatPane from '$lib/ui/ChatPane.svelte';
  import Quicklook from '$lib/ui/Quicklook.svelte';
  import SearchPalette from '$lib/ui/SearchPalette.svelte';
  import Onboarding from '$lib/ui/Onboarding.svelte';
  import { onboard } from '$lib/client/onboarding.js';
  import { createSession } from '$lib/client/session.js';
  import { conversationItems, emptyState } from '$lib/core/reducer.js';
  import { reusableBlankChat, releasesTransient } from '$lib/core/newchat.js';
  import { transientFate } from '$lib/core/transient.js';
  import { readDraft } from '$lib/core/attachments.js';
  import { newChatSettings } from '$lib/client/agent-preference.js';
  import { scopeForNewChat } from '$lib/core/scopes.svelte.js';
  import { pruneFolds } from '$lib/client/fold-store.js';
  import { documentTitle } from '$lib/core/title.js';
  import { languageOf, warmTokens } from '$lib/core/highlight.js';
  import { groupForks, rankConversations } from '$lib/core/recency.js';
  import { nextAfterArchive } from '$lib/core/archive-select.js';
  import { isMod, isMacTextBinding } from '$lib/core/keys.js';
  import { SEEN_KEY, startsSidebarHidden } from '$lib/core/window-start.js';
  import UndoBar from '$lib/ui/UndoBar.svelte';
  import { createUndoStack, isUndoShortcut, watchEditedFields } from '$lib/core/undo.js';
  import { isSpaceKey } from '$lib/services/voice/core/pushtotalk.js';
  import {
    MAX_PANELS, RAIL_PX, neighbour as paneNeighbour, willSplit
  } from '$lib/core/panels.js';
  import { panesDecl, paneGesture } from '$lib/core/panes-state.js';
  import { createIncognitoSession } from '$lib/client/incognito.js';
  import { isIncognito } from '$lib/core/incognito.js';
  import { sidebarDecl } from '$lib/core/sidebar-state.js';
  import { uiApp } from '$lib/client/ui-app.js';

  const session = createSession();

  // Incognito chats (core/incognito.js): a second session over an in-memory replica, talking to the server's
  // in-memory store. A pane holding one gets this session and its state; nothing else on the page sees them.
  const incognito = createIncognitoSession();
  let incognitoState = $state.raw(emptyState());
  let incognitoStatus = $state({ online: true, connected: false, cached: false });
  const sessionFor = (id) => (isIncognito(id) ? incognito.session : session);
  const stateFor = (id) => (isIncognito(id) ? incognitoState : state);
  const statusFor = (id) => (isIncognito(id) ? incognitoStatus : status);

  // An incognito chat never gets an address: the URL bar and the history would keep its id.
  function replaceState(url, routeState) {
    const id = new URLSearchParams(String(url).split('?')[1] || '').get('chat');
    navReplaceState(isIncognito(id) ? location.pathname : url, routeState);
  }

  let state = $state.raw(emptyState());
  let status = $state({ online: true, connected: false, cached: false });
  // The panes are declared once (core/panes-state.js) on the kit's state core over this tab's storage and hydrated
  // here synchronously, so the very first render already has the panes this window had before it reloaded and
  // every change is saved by the kit. An explicit ?new or ?incognito is a request for something else: it starts empty.
  const paneStore = uiApp().use(panesDecl);
  const pane = paneStore.dispatch; // returns the logged action when it changed something, else null
  const bootParams = new URLSearchParams(location.search);
  if (bootParams.has('new') || bootParams.has('incognito')) pane('pane.reset');
  const layout = $derived($paneStore.layout);
  const transientId = $derived($paneStore.transient);
  const restored = layout.panels.length > 0;
  let activeId = $state(layout.panels[layout.focused] ?? null);
  let viewportPx = $state(1400);
  let sidebarOpen = $state(false);
  let sidebarHidden = $state(false);
  // Drag the list's right edge to resize it; dragged narrower than SIDEBAR_COLLAPSE_PX it collapses as
  // Cmd-B would, and dragging back out reopens it. Width persists per browser.
  const SIDEBAR_MIN_PX = 200, SIDEBAR_MAX_PX = 560, SIDEBAR_COLLAPSE_PX = 140, SIDEBAR_DEFAULT_PX = 280;
  // Device UI state is declared once (core/sidebar-state.js) on the kit's state core, hydrated here synchronously so the
  // first paint already has his width and workspace; the old code read the width in onMount, a frame late.
  const sidebarStore = uiApp().use(sidebarDecl);
  let dragWidth = $state(null);
  const sidebarWidth = $derived(dragWidth ?? ($sidebarStore.width >= SIDEBAR_MIN_PX && $sidebarStore.width <= SIDEBAR_MAX_PX ? $sidebarStore.width : SIDEBAR_DEFAULT_PX));
  let sidebarDragging = $state(false);
  // Hovering the left edge of a window whose list is hidden shows it as an overlay until the pointer leaves.
  let sidebarPeek = $state(false);
  let searching = $state(false);
  let quicklook = $state(null);
  let quicklookLoading = $state(false);
  let quicklookError = $state(null);
  let wide = $state(true);
  let paneRefs = $state([]);
  
  
  
  let keyboardInset = $state(0);

  const prefetched = new Map();

  // Undo for what he does to a row: Done (archive), set aside, defer, pin. The bar names the
  // last one and Cmd-Z walks the last few back, newest first; the reader shelf carries the same
  // stack. core/undo.js.
  //
  // Each entry puts back only the field its own action changed, so a Done on a chat that was
  // already set aside lands back in the set-aside tray rather than on the live list. Mark unread
  // is not on the stack: reading is a cursor the server moves, not a flag this can hand back.
  let undoLabel = $state(null);
  let undoId = null;
  const undoStack = createUndoStack({
    onchange: (view) => { undoLabel = view.toast?.label || null; undoId = view.toast?.id || null; }
  });
  const titleOf = (id) => state.conversations[id]?.title || 'that chat';

  // `silent` records the action for Cmd-Z without showing a bar.
  function rememberUndo(id, label, put, { silent = false } = {}) {
    undoStack.push({ label: `${label} ${titleOf(id)}`, undo: () => put(), silent });
  }

  function undoNow() {
    undoStack.undo(undoId);
  }

  // Set aside and defer go through here rather than straight to the session, so the row the
  // gesture moved can be put back exactly where it was.
  function asideChat(id, aside) {
    const was = Boolean(state.conversations[id]?.aside);
    session.setAside(id, aside);
    rememberUndo(id, aside ? 'Set aside:' : 'Put back:', () => session.setAside(id, was));
  }

  function deferChat(id, when) {
    const row = state.conversations[id];
    const was = { until: row?.deferUntil || null, condition: row?.deferCondition || null };
    session.defer(id, when);
    const set = Boolean(when?.until || when?.condition);
    rememberUndo(id, set ? 'Deferred:' : 'Put back:', () => session.defer(id, was));
  }

  function pinChat(id, pinned) {
    const was = Boolean(state.conversations[id]?.pinned);
    session.pin(id, pinned);
    rememberUndo(id, pinned ? 'Pinned:' : 'Unpinned:', () => session.pin(id, was));
  }

  const sidebarShown = $derived(wide ? !sidebarHidden : sidebarOpen);
  const navInSidebar = $derived(wide && sidebarShown);
  const navItems = $derived([
    { id: 'chatlist', label: sidebarShown ? 'Hide chat list' : 'Show chat list' },
    { id: 'search', label: 'Search everything' },
    { id: 'incognito', label: 'Incognito chat' },
    
    { id: 'voice', label: 'Voice mode' },
    { id: 'onboarding', label: 'Replay tour' }
  ]);
  let replayRequest = $state(0);

  function toggleSidebar() {
    sidebarPeek = false;
    if (wide) sidebarHidden = !sidebarHidden;
    else sidebarOpen = !sidebarOpen;
  }

  function sidebarResizeStart(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    sidebarDragging = true;
    let frame = 0, x = event.clientX;
    const apply = () => {
      frame = 0;
      if (x < SIDEBAR_COLLAPSE_PX) { sidebarHidden = true; return; }
      sidebarHidden = false;
      dragWidth = Math.round(Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, x)));
    };
    const move = (e) => { x = e.clientX; if (!frame) frame = requestAnimationFrame(apply); };
    const end = () => {
      if (frame) { cancelAnimationFrame(frame); apply(); }
      sidebarDragging = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      if (dragWidth !== null) sidebarStore.dispatch('width.set', { px: dragWidth });
      dragWidth = null;
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function sidebarResizeReset() {
    sidebarStore.dispatch('width.set', { px: null });
  }

  function navPick(id) {
    if (id === 'chatlist') toggleSidebar();
    if (id === 'show-chatlist') {
      sidebarHidden = false;
      sidebarOpen = true;
    }
    if (id === 'search') searching = true;
    if (id === 'incognito') newIncognitoChat();
    if (id === 'voice') paneRefs[layout.focused]?.openVoice?.();
    if (id === 'onboarding') replayRequest += 1;
  }

  onMount(() => {
    try {
      const seen = sessionStorage.getItem(SEEN_KEY) === '1';
      sessionStorage.setItem(SEEN_KEY, '1');
      sidebarHidden = startsSidebarHidden({
        chatInUrl: new URLSearchParams(location.search).get('chat'), opener: window.opener, seen
      });
    } catch { /* storage refused: the list stays where it was */ }
    const unsubscribeIncognito = incognito.session.subscribe((next, nextStatus) => {
      incognitoState = next;
      incognitoStatus = nextStatus;
    });
    const unsubscribe = session.subscribe((next, nextStatus) => {
      state = next;
      status = nextStatus;
      if (nextStatus.readyMs !== undefined) {
        window.__webchatBoot = { firstPaintMs: nextStatus.firstPaintMs, readyMs: nextStatus.readyMs, cached: nextStatus.cached };
      }
      if (!activeId && wide) {
        const first = rankConversations(next.conversations, { now: Date.now() })[0];
        if (first) select(first.id, { touch: false });
      }
    });

    
    
    
    const shiftFloats = () => {
      const view = window.visualViewport;
      keyboardInset = Math.max(0, window.innerHeight - (view?.height ?? window.innerHeight) - (view?.offsetTop ?? 0));
    };
    shiftFloats();
    window.visualViewport?.addEventListener('resize', shiftFloats);
    window.visualViewport?.addEventListener('scroll', shiftFloats);

    const media = window.matchMedia('(min-width: 861px)');
    const applyWidth = () => {
      wide = media.matches;
      sidebarOpen = wide ? false : !activeId;
    };
    applyWidth();
    media.addEventListener('change', applyWidth);

    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('chat');
    const wantsNew = params.has('new');
    const wantsItem = params.get('item');
    if (fromUrl && wantsItem) wantedItem = { conversationId: fromUrl, itemId: wantsItem };
    // `restored` (above): the panes this window had before it reloaded, hydrated before first render.
    const wantsIncognito = params.has('incognito');
    // Opening the app lands in a chat that does not exist yet, so the composer is there to type
    // into before anything has loaded, and nothing is left behind if he goes somewhere else. A
    // link that names a chat, and the explicit ?new, both still win.
    if (!restored && !fromUrl && !wantsNew && !wantsIncognito) openTransient();
    if (wantsIncognito) newIncognitoChat();
    session.start({ open: fromUrl || (restored ? activeId : null) }).then(() => {
      // Boot is the one moment the whole chat list is known, so it is where the folds
      // of chats that are gone are dropped. See client/fold-store.js.
      pruneFolds(Object.keys(state.conversations || {}));
      if (restored) {
        // A pane whose chat no longer exists is dropped. An empty list is a cold cache with no network, which
        // says nothing about any chat, so nothing is dropped on it.
        if (Object.keys(state.conversations || {}).length) {
          if (pane('pane.drop', { ids: layout.panels.filter((id) => !state.conversations[id]) })) settlePanes();
        }
        for (const panel of layout.panels) session.hydrate(panel);
      }
      if (wantsNew) newChat();
      // A link to a chat already in a restored pane keeps the saved focus: the address bar can lag behind it.
      else if (fromUrl && !(restored && layout.panels.includes(fromUrl))) select(fromUrl);
      else if (restored && activeId) replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
    });

    window.addEventListener('pointermove', archivePointer);
    window.addEventListener('pointerdown', clearArchivePointer, true);
    window.addEventListener('blur', clearArchivePointer);
    window.addEventListener('keydown', archiveShortcut, true);
    window.addEventListener('keydown', paneNavShortcut, true);
    window.addEventListener('keydown', shortcuts);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', releaseHold);
    window.addEventListener('contextmenu', releaseHold);
    window.addEventListener('pagehide', releaseHold);
    document.addEventListener('visibilitychange', releaseHold);
    window.addEventListener('dragover', strayDragOver);
    window.addEventListener('drop', strayDrop);
    // The composer he has typed into keeps its own Cmd-Z, even after he clears it; one that
    // merely autofocused does not. See core/undo.js.
    const unwatchFields = watchEditedFields(document);
    return () => {
      unwatchFields();
      unsubscribe();
      unsubscribeIncognito();
      media.removeEventListener('change', applyWidth);
      window.visualViewport?.removeEventListener('resize', shiftFloats);
      window.visualViewport?.removeEventListener('scroll', shiftFloats);
      window.removeEventListener('pointermove', archivePointer);
      window.removeEventListener('pointerdown', clearArchivePointer, true);
      window.removeEventListener('blur', clearArchivePointer);
      window.removeEventListener('keydown', archiveShortcut, true);
      window.removeEventListener('keydown', paneNavShortcut, true);
      window.removeEventListener('keydown', shortcuts);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', releaseHold);
      window.removeEventListener('contextmenu', releaseHold);
      window.removeEventListener('pagehide', releaseHold);
      document.removeEventListener('visibilitychange', releaseHold);
      window.removeEventListener('dragover', strayDragOver);
      window.removeEventListener('drop', strayDrop);
    };
  });

  const carriesFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  function strayDragOver(event) {
    if (carriesFiles(event)) event.preventDefault();
  }
  function strayDrop(event) {
    if (event.defaultPrevented || !carriesFiles(event)) return;
    event.preventDefault();
    paneRefs[layout.focused]?.attachFiles(event.dataTransfer?.files);
  }

  function typingInAField(target) {
    return target instanceof HTMLElement
      && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  }

  










  function insideModal(target) {
    return Boolean(target instanceof HTMLElement && target.closest('[aria-modal="true"], [role="dialog"]'));
  }

  function step(delta) {
    const ranked = rankConversations(state.conversations, { now: Date.now() });
    if (!ranked.length) return;
    const at = ranked.findIndex((c) => c.id === activeId);
    const next = ranked[Math.min(ranked.length - 1, Math.max(0, (at === -1 ? 0 : at) + delta))];
    if (next) select(next.id);
  }

  












  function pushToTalk(event) {
    if (!isSpaceKey(event)) return false;
    const decision = paneRefs[layout.focused]?.pushToTalkDown?.(event) ?? 'pass';
    if (decision === 'pass') return false;
    event.preventDefault();
    return true;
  }

  







  function releaseHold() {
    for (const pane of paneRefs) pane?.pushToTalkUp?.();
  }

  function keyup(event) {
    if (isSpaceKey(event)) releaseHold();
  }

  let hoveredChat = null;
  // Where the mouse last was over a sidebar row, kept with its time even after the pointer leaves
  // the row: archiving sends the view to the chat he was already looking at. See
  // core/archive-select.js.
  let lastHoveredChat = null;
  let lastHoveredAt = 0;
  function archivePointer(event) {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    hoveredChat = event.target.closest?.('[data-testid="sidebar"] [data-chat]')?.dataset.chat || null;
    if (hoveredChat) { lastHoveredChat = hoveredChat; lastHoveredAt = Date.now(); }
  }
  function clearArchivePointer() { hoveredChat = null; }

  // Archiving the chat on screen leaves the pane holding something he has put away, so selection
  // moves on by itself: to the row his mouse was just over, else to the next chat down the
  // sidebar. The order is read BEFORE the archive lands, while the row is still in place.
  function archiveChat(id, archived) {
    const open = layout.panels.includes(id);
    const next = archived && open
      ? nextAfterArchive(sidebarOrder(), id, { hovered: lastHoveredChat, hoveredAt: lastHoveredAt })
      : null;
    const was = Boolean(state.conversations[id]?.archived);
    session.archive(id, archived);
    if (archived) onboard('chat.archived', { chat: id });
    // Undoing a Done on the chat he was reading puts the chat back AND puts him back in it,
    // because the archive moved the pane off it.
    rememberUndo(id, archived ? 'Done:' : 'Put back:', () => {
      session.archive(id, was);
      if (archived && open) select(id);
    }, { silent: archived });
    lastHoveredChat = null;
    if (!archived || !open) return;
    // In multi-pane mode archiving a chat on screen closes its pane rather than refilling it.
    if (layout.panels.length > 1) return closePane(layout.panels.indexOf(id));
    if (next) select(next);
    else if (!transientId) openTransient();
  }

  function sidebarOrder() {
    return groupForks(rankConversations(state.conversations, { now: Date.now() }))
      .flatMap((row) => [row.id, ...row.forks.map((fork) => fork.id)]);
  }
  // Holding a modifier is not "he has moved on". Cmd-E reaches the page as a Meta keydown and
  // then an E keydown, and clearing the hover on the first of those sent Done to the chat on
  // screen instead of the row under the pointer. Only a substantive key ends a hover.
  const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS']);

  function archiveShortcut(event) {
    if (MODIFIER_KEYS.has(event.key)) return;
    const command = event.metaKey && !event.ctrlKey && !event.altKey;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && hoveredChat;
    if (event.key.toLowerCase() === 'e' && (command || plain) && !event.isComposing
        && !searching && !quicklook && !insideModal(event.target)) {
      const id = hoveredChat || activeId;
      if (!id || state.conversations[id]?.archived) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) archiveChat(id, true);
      hoveredChat = null;
      return;
    }
    // Cmd-U parks the chat: set aside, not done. Archive (Cmd-E) means finished; set aside means
    // put down with the work still open. Same target rule as Cmd-E: the row under the pointer, else
    // the chat on screen; on a chat already set aside it puts it back.
    if (event.key.toLowerCase() === 'u' && command && !event.shiftKey && !event.isComposing
        && !searching && !quicklook && !insideModal(event.target)) {
      const id = hoveredChat || activeId;
      const row = id && state.conversations[id];
      if (!row || row.archived) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) asideChat(id, !row.aside);
      hoveredChat = null;
      return;
    }
    hoveredChat = null;
  }

  // Ctrl-H and Ctrl-L step the focus one pane left and right, from inside a composer too. Matched
  // on event.key, never event.code, so a non-QWERTY layout lands on the letters pressed. On a Mac Ctrl-H is
  // also the text field's backspace, so this runs in the capture phase, before the field and
  // before isMacTextBinding, and takes the chord whether or not there is a pane to move to.
  function paneNavShortcut(event) {
    if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
    const key = String(event.key || '').toLowerCase();
    if (key !== 'h' && key !== 'l') return;
    if (searching || quicklook || insideModal(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const to = paneNeighbour(layout, key === 'h' ? -1 : 1);
    if (to === null) return;
    focusPane(to);
    tick().then(() => paneRefs[to]?.focusComposer());
  }

  function shortcuts(event) {
    if (pushToTalk(event)) return;
    if (!isSpaceKey(event)) paneRefs[layout.focused]?.pushToTalkOther?.(event);
    if (isMacTextBinding(event)) return;
    const meta = isMod(event);
    const key = event.key.toLowerCase();
    if (meta && key === 'k') { event.preventDefault(); searching = true; return; }
    if (meta && key === 'f') { event.preventDefault(); paneRefs[layout.focused]?.openFind(); return; }
    if (meta && (key === 'n' || (event.shiftKey && key === 'o'))) { event.preventDefault(); newChat(); return; }
    if (meta && event.key === 'Enter' && !typingInAField(event.target)) {
      event.preventDefault();
      newChat({ split: event.shiftKey });
      return;
    }
    if (meta && key === 'b') { event.preventDefault(); toggleSidebar(); return; }
    // Cmd-Z takes back the last row gesture. A composer he has typed into keeps its own undo,
    // and so does any editor; an empty composer, which takes the caret by itself in a new chat,
    // does not. Nothing on the stack means the browser keeps the key (core/undo.js).
    if (isUndoShortcut(event) && undoStack.size && !searching && !insideModal(event.target)) {
      event.preventDefault();
      undoStack.undo();
      return;
    }
    if (meta && (key === '[' || key === ']')) { event.preventDefault(); step(key === '[' ? -1 : 1); return; }
    if (event.key === 'Escape') {
      if (quicklook || quicklookLoading) { quicklook = null; quicklookError = null; return; }
      if (searching) { searching = false; return; }
      sidebarOpen = false;
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !searching && !quicklook
        && event.key.length === 1 && !typingInAField(event.target) && !insideModal(event.target)) {
      paneRefs[layout.focused]?.focusComposer();
    }
  }

  function select(id, { touch = true } = {}) {
    if (!leaveIncognito(id)) return;
    releaseTransient(id);
    const before = layout.panels[layout.focused];
    pane('pane.activate', { id });
    const focusedId = layout.panels[layout.focused] ?? null;
    activeId = focusedId;
    sidebarOpen = false;
    for (const panel of layout.panels) session.hydrate(panel);
    if (touch && focusedId && focusedId !== before) session.touch(focusedId);
    if (focusedId) replaceState(`?chat=${encodeURIComponent(focusedId)}`, {});
  }

  function openFork(id, { split = true } = {}) {
    if (!willSplit(layout, split, viewportPx) && !leaveIncognito(id)) return;
    if (releasesTransient(split)) releaseTransient(id);   // a split adds a pane beside the blank one, it never drops it
    sidebarOpen = false;
    // An explicit split is always a new pane, even when the chat is already open in another one.
    if (split === true && layout.panels.length) paneGesture(paneStore, 'split', { chat: id });
    else pane('pane.openFor', { id, split, viewportPx });
    activeId = layout.panels[layout.focused] ?? id;
    for (const panel of layout.panels) session.hydrate(panel);
    replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
  }

  function focusPane(index) {
    pane('pane.focus', { index });
    activeId = layout.panels[layout.focused] ?? null;
    if (activeId) replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
  }

  function closePane(index) {
    const closing = layout.panels[index];
    if (isIncognito(closing) && incognito.hasContent(closing)
        && !confirm('Close this incognito chat? Nothing from it is saved anywhere.')) return;
    paneGesture(paneStore, 'close', { index });
    activeId = layout.panels[layout.focused] ?? null;
    if (activeId) replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
  }

  // After a pane action changed the layout: follow the focus, load every open chat, point the address at it.
  function settlePanes() {
    activeId = layout.panels[layout.focused] ?? null;
    for (const panel of layout.panels) session.hydrate(panel);
    if (activeId) replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
  }

  function paneAction(index, action) {
    if (action === 'duplicate') { paneGesture(paneStore, 'duplicate', { index }); return settlePanes(); }
    if (action === 'left') { paneGesture(paneStore, 'move', { index, delta: -1 }); return settlePanes(); }
    if (action === 'right') { paneGesture(paneStore, 'move', { index, delta: 1 }); return settlePanes(); }
    if (action === 'close') return closePane(index);
  }

  function openRail(index) {
    pane('pane.toggle', { index });
    settlePanes();
  }

  // Dragging a divider. Panes re-wrap live, but only the bottom LIVE_SCREENS screens of each
  // transcript (plus whatever is on screen if he is scrolled up): re-wrapping every row at every
  // intermediate width is what made the drag lag (measured: 60 pointer moves cost 38k layouts and 4.2s
  // of layout). Older rows get content-visibility:hidden for the drag (no layout, they keep their last
  // size) and re-wrap once, when he lets go.
  let dragging = $state(null);
  let dragFromX = 0;
  function startDrag(index, event) {
    dragFromX = event.clientX;
    dragging = index;
    event.preventDefault();
  }
  $effect(() => {
    if (dragging === null) return;
    const index = dragging;
    const LIVE_SCREENS = 2;
    const skipped = [];
    for (const scroller of document.querySelectorAll('main .scroller.transcript')) {
      const view = scroller.clientHeight;
      const rows = scroller.querySelectorAll('.vrow');
      const bottomEdge = scroller.scrollHeight - LIVE_SCREENS * view;
      const viewTop = scroller.scrollTop - view / 2;
      const viewBottom = scroller.scrollTop + view * 1.5;
      for (const row of rows) {
        const top = row.offsetTop;
        const end = top + row.offsetHeight;
        const nearBottom = end >= bottomEdge;
        const onScreen = end >= viewTop && top <= viewBottom;
        if (nearBottom || onScreen) continue;
        row.style.containIntrinsicSize = `auto ${Math.max(1, Math.round(row.offsetHeight))}px`;
        row.style.contentVisibility = 'hidden';
        skipped.push(row);
      }
    }
    document.querySelector('main')?.classList.add('resizing');
    let lastX = dragFromX;
    let pending = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (pending === null) return;
      const width = document.querySelector('main')?.clientWidth || viewportPx;
      paneGesture(paneStore, 'resizeBy', { index, delta: (pending - lastX) / width });
      lastX = pending;
      pending = null;
    };
    const onMove = (event) => {
      pending = event.clientX;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const onUp = () => { cancelAnimationFrame(frame); flush(); dragging = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      cancelAnimationFrame(frame);
      document.querySelector('main')?.classList.remove('resizing');
      for (const row of skipped) { row.style.contentVisibility = ''; }
    };
  });

  // A chat that moved to a scope this account cannot open disappears from this tab, pane included.
  $effect(() => {
    void state.rev;
    if (!Object.values(state.conversations || {}).some((c) => c.revoked)) return;
    const gone = new Set(session.dropRevoked());
    if (!gone.size) return;
    if (pane('pane.drop', { ids: [...gone] })) settlePanes();
    activeId = layout.panels[layout.focused] ?? null;
  });

  let lastNewChatId = $state(null);

  // A new chat is created in the scope selected now: the scope of the chat in focus (its dropdown), when this
  // account may still open it. Cmd-Enter, Cmd-Shift-Enter and the new-chat button all come through here. The
  // workspace he is in (Sidebar owns the device-local half).
  const currentWorkspace = $derived($sidebarStore.current);
  // workspaceDefault: the folder is where he happened to be, not a choice about this chat, so the
  // auto-router may still move it (server/autoroute.js defaultPlaced).
  const workspacePayload = () => (currentWorkspace ? { workspace: currentWorkspace, workspaceDefault: true } : {});

  function scopePayload(fromId = layout.panels[layout.focused] ?? activeId) {
    const scope = scopeForNewChat(state.conversations[fromId]?.scope ?? null);
    return scope ? { scope } : {};
  }

  function openTransient() {
    const inheritedScope = scopePayload();
    const id = session.newConversationId();
    pane('transient.set', { id });
    lastNewChatId = id;
    // Focused first, created second. createProvisional publishes, and a publish with no pane
    // focused wakes the boot fallback below, which selects the newest chat and calls
    // replaceState from inside onMount, before SvelteKit's router exists.
    pane('pane.activate', { id });
    activeId = layout.panels[layout.focused] ?? id;
    sidebarOpen = false;
    session.createProvisional(id, { title: 'New chat', ...newChatSettings(), ...inheritedScope, ...workspacePayload() });
  }

  // SvelteKit's router ends its first navigation by resetting focus to the body, which lands
  // after the composer has autofocused itself. So the cursor is claimed again once the router
  // is done: landing in this chat is only useful if he can type into it straight away.
  afterNavigate(() => {
    if (!transientId || !wide) return;
    tick().then(() => paneRefs[layout.focused]?.focusComposer());
  });

  // Leaving the transient chat for any other chat ends it. Empty, it is dropped and no server
  // ever hears of it. See core/transient.js.
  function releaseTransient(nextId = null) {
    const id = transientId;
    if (!id || id === nextId) return;
    const focusedTransient = (layout.panels[layout.focused] ?? activeId) === id;
    const fate = transientFate({
      turns: conversationItems(state, id),
      draft: readDraft(id),
      uploads: focusedTransient ? (paneRefs[layout.focused]?.stagedUploads?.() ?? []) : [],
      awaitingFirstToken: state.conversations[id]?.awaitingFirstToken
    });
    pane('transient.set', { id: null });
    if (fate === 'keep') {
      session.commitProvisional(id);
      return;
    }
    if (lastNewChatId === id) lastNewChatId = null;
    pane('pane.drop', { ids: [id] });
    session.discardProvisional(id);
    if (activeId === id) activeId = layout.panels[layout.focused] ?? null;
  }

  // The first send commits it behind the composer's back, so the pane itself notices and the
  // chat stops being transient: from here it is an ordinary chat, with an address.
  $effect(() => {
    const id = transientId;
    if (!id) return;
    void state.rev;
    if (session.isProvisional(id)) return;
    pane('transient.set', { id: null });
    if (activeId === id) replaceState(`?chat=${encodeURIComponent(id)}`, {});
  });

  // Whether the focused pane may be replaced by `nextId`. An incognito chat with something in it is asked about
  // first, because replacing it ends it: there is nowhere it could be reopened from.
  function leaveIncognito(nextId = null) {
    const leaving = layout.panels[layout.focused];
    if (!isIncognito(leaving) || leaving === nextId || layout.panels.includes(nextId)) return true;
    if (!incognito.hasContent(leaving)) return true;
    return confirm('Leave this incognito chat? Nothing from it is saved anywhere.');
  }

  // A new incognito chat in place of the focused pane, or beside it. The id is placed in the layout before the chat
  // exists, so the sweep below never sees it outside every pane.
  async function newIncognitoChat({ split = false } = {}) {
    if (!split && !leaveIncognito(null)) return;
    if (transientId) releaseTransient(null);
    await incognito.start();
    const id = incognito.session.newConversationId();
    if (split) pane('pane.openBeside', { id }); else pane('pane.activate', { id });
    activeId = layout.panels[layout.focused] ?? id;
    sidebarOpen = false;
    incognito.open(id, newChatSettings());
    replaceState(location.pathname, {});
    await tick();
    paneRefs[layout.focused]?.focusComposer();
  }

  // An incognito chat that is in no pane, nor under a chat that is (a fork or side thread of one), is over: the
  // server forgets it and so does this tab.
  $effect(() => {
    const open = new Set(layout.panels);
    const conversations = incognitoState.conversations || {};
    const rootOf = (id) => {
      let at = conversations[id];
      for (let hops = 0; at?.parentId && conversations[at.parentId] && hops < 32; hops += 1) at = conversations[at.parentId];
      return at?.id ?? id;
    };
    for (const [id, conversation] of Object.entries(conversations)) {
      if (!isIncognito(id) || conversation.archived) continue;
      if (open.has(id) || open.has(rootOf(id))) continue;
      incognito.discard(id);
    }
  });

  async function newChat({ split = false } = {}) {
    const beside = willSplit(layout, split, viewportPx);
    if (!beside && !leaveIncognito(null)) return;
    const focusedId = layout.panels[layout.focused] ?? activeId;
    // Pressing new chat while sitting in the untouched transient chat is the same intent twice: reusableBlankChat focuses this
    // one instead of stacking another (core/newchat.js). An explicit split never drops the blank transient chat sitting in
    // another pane: that dropped a pane, so the new one looked like a replacement.
    if (releasesTransient(split) && transientId && transientId !== focusedId) releaseTransient(null);
    const reuse = split === true ? null : reusableBlankChat({
      lastCreatedId: lastNewChatId,
      focusedId,
      conversation: state.conversations[lastNewChatId],
      turns: conversationItems(state, lastNewChatId),
      draft: readDraft(lastNewChatId),
      uploads: paneRefs[layout.focused]?.stagedUploads?.() ?? []
    });
    if (reuse) {
      await tick();
      paneRefs[layout.focused]?.focusComposer();
      return;
    }
    const id = session.newConversationId();
    lastNewChatId = id;
    // The agent is the one he last used (agent-preference.js); nothing stored leaves the default.
    session.create(id, { title: 'New chat', ...newChatSettings(), ...scopePayload(focusedId), ...workspacePayload() });
    pane('pane.openFor', { id, split, viewportPx });
    onboard('chat.created', { chat: id, split });
    activeId = layout.panels[layout.focused] ?? id;
    sidebarOpen = false;
    replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
    await tick();
    paneRefs[layout.focused]?.focusComposer();
  }

  let quicklookTrail = $state([]);

  function quicklookBack() {
    const previous = quicklookTrail.at(-2);
    if (!previous) return;
    quicklookTrail = quicklookTrail.slice(0, -2);
    openPath({ path: previous });
  }

  async function openPath({ path, prefetch = false }) {
    const key = `${activeId}::${path}`;
    if (prefetch) {
      if (prefetched.has(key)) return;
      const pending = session.file(path, { conversationId: activeId }).catch(() => null);
      pending.then((value) => {
        if (value && !value.binary && typeof value.text === 'string') {
          warmTokens(value.text, languageOf(value.path));
        }
      });
      prefetched.set(key, pending);
      return;
    }
    if (quicklookTrail.at(-1) !== path) quicklookTrail = [...quicklookTrail, path];
    quicklookError = null;
    const warm = prefetched.get(key);
    if (warm) {
      const value = await warm;
      if (value) { quicklook = value; return; }
    }
    quicklookLoading = true;
    quicklook = null;
    try {
      quicklook = await session.file(path, { conversationId: activeId });
    } catch (cause) {
      quicklookError = `Could not open ${path}: ${cause.message}`;
      quicklook = { name: path, path };
    } finally {
      quicklookLoading = false;
    }
  }

  function download(path) {
    const params = new URLSearchParams({ path, download: '1' });
    if (activeId) params.set('conversation', activeId);
    location.href = `/api/file?${params}`;
  }

  let jump = $state(null);
  let jumpSeq = 0;
  // A link into one message of a chat: `/?chat=<id>&item=<item id>`. The notes stream writes those
  // for a note taken on a chat message, where the note's anchor is the message's item id. The pane
  // already knows how to scroll to an item, but it is told by cursor, so the id is resolved against
  // the transcript here and handed over as exactly the `jump` an in-chat search result makes. The
  // effect keeps waiting while the transcript hydrates and spends itself the moment it lands; a
  // message too far back to be hydrated simply leaves the chat open at the bottom.
  let wantedItem = $state(null);        // { conversationId, itemId }
  $effect(() => {
    if (!wantedItem) return;
    const item = conversationItems(state, wantedItem.conversationId).find((row) => row.id === wantedItem.itemId);
    if (!item || !Number.isSafeInteger(item.cursor)) return;
    jumpSeq += 1;
    jump = { conversationId: wantedItem.conversationId, cursor: item.cursor, seq: jumpSeq };
    wantedItem = null;
  });
  function openResult(result) {
    searching = false;
    if (Number.isSafeInteger(result.cursor)) {
      jumpSeq += 1;
      jump = { conversationId: result.conversationId, cursor: result.cursor, seq: jumpSeq };
    }
    select(result.conversationId);
  }

  const focusedChatId = $derived(layout.panels[layout.focused] ?? activeId);
  const windowTitle = $derived(documentTitle(state.conversations[focusedChatId]?.title));
</script>

<svelte:head><title>{windowTitle}</title></svelte:head>

<div class="app" class:resizing={sidebarDragging} style:--keyboard-inset={`${keyboardInset}px`} style:--sidebar-w={`${sidebarWidth}px`}>
  {#if sidebarOpen && !wide}
    <button class="scrim" onclick={() => (sidebarOpen = false)} aria-label="Close chat list"></button>
  {/if}

  {#if wide && sidebarHidden && !sidebarPeek}
    <div class="edge" data-testid="sidebar-edge" aria-hidden="true" onpointerenter={() => (sidebarPeek = true)}></div>
  {/if}
  <div class="peekwrap" class:peeking={sidebarPeek && sidebarHidden} data-testid="sidebar-peek"
    onpointerleave={() => (sidebarPeek = false)}>
  <Sidebar
    conversations={state.conversations}
    chatState={state}
    {session}
    {activeId}
    openIds={layout.panels}
    {status}
    open={sidebarShown || (sidebarPeek && sidebarHidden)}
    shownav={navInSidebar}
    {navItems}
    onnavpick={navPick}
    onselect={select}
    onopenbeside={(id) => openFork(id)}
    onnew={newChat}
    onsearch={() => (searching = true)}
    onpin={pinChat}
    onarchive={archiveChat}
    onaside={asideChat}
    ondefer={deferChat}
    onread={(id, read) => session.markRead(id, read)}
    onclose={() => (sidebarOpen = false)}
    onworkspace={(id, name) => session.setWorkspace(id, name)}
  />
  </div>
  {#if wide && (sidebarShown || sidebarDragging)}
    <div class="sidebar-resize" class:active={sidebarDragging} data-testid="sidebar-resize"
      style:left={`${sidebarHidden ? 0 : sidebarWidth}px`}
      role="separator" aria-orientation="vertical" aria-label="Resize chat list" title="Drag to resize; drag far left to hide; double-click to reset"
      onpointerdown={sidebarResizeStart} ondblclick={sidebarResizeReset}></div>
  {/if}

  <div class="stage">
    {#if !navInSidebar}
      
      <div class="stagenav" data-testid="stage-nav">
        <Nav current="chats" items={navItems} drop={wide ? 'down' : 'up'} align={wide ? 'left' : 'right'}
          onpick={navPick} onactivate={() => navPick('show-chatlist')} />
      </div>
    {/if}
    <main bind:clientWidth={viewportPx}>
    {#if layout.panels.length}
      
      
      {#each layout.panels as panelId, index (layout.keys[index])}
        {#if index > 0 && !layout.collapsed[index] && !layout.collapsed[index - 1]}
          <div
            class="divider"
            class:dragging={dragging === index - 1}
            data-testid="pane-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panels"
            tabindex="0"
            onpointerdown={(event) => startDrag(index - 1, event)}
            onkeydown={(event) => {
              if (event.key === 'ArrowLeft') { event.preventDefault(); paneGesture(paneStore, 'resizeBy', { index: index - 1, delta: -0.02 }); }
              if (event.key === 'ArrowRight') { event.preventDefault(); paneGesture(paneStore, 'resizeBy', { index: index - 1, delta: 0.02 }); }
            }}
          ></div>
        {/if}
        {#if layout.collapsed[index]}
          
          <button
            class="rail press focus-ring"
            style:flex="0 0 {RAIL_PX}px"
            onclick={() => openRail(index)}
            data-testid="pane-rail"
            data-chat={panelId}
            title={state.conversations[panelId]?.title || 'Chat'}
            aria-label="Open {state.conversations[panelId]?.title || 'chat'}"
          >
            <span class="rail-label">{state.conversations[panelId]?.title || 'Chat'}</span>
          </button>
        {:else}
        <div
          class="pane-slot"
          style:flex="{layout.widths[index]} 1 0%"
          data-testid="pane"
          data-focused={index === layout.focused ? 'true' : 'false'}
        >
          <ChatPane
            bind:this={paneRefs[index]}
            session={sessionFor(panelId)}
            chatState={stateFor(panelId)}
            status={statusFor(panelId)}
            conversationId={panelId}
            primary={index === layout.focused}
            autofocus={wide && panelId === transientId}
            pane={wide ? { index, count: layout.panels.length, max: MAX_PANELS } : null}
            onpane={(action) => paneAction(index, action)}
            onpath={openPath}
            onselect={(id, options) => select(id, options)}
            onforkopen={(id, options) => openFork(id, options)}
            onnewchat={(opts) => newChat(opts)}
            onfocus={() => focusPane(index)}
            onclosepane={layout.panels.length > 1 ? () => closePane(index) : null}
            jump={jump && jump.conversationId === panelId ? jump : null}
          />
        </div>
        {/if}
      {/each}
    {:else}
      <div class="blank">
        <p>No chat open.</p>
        <button class="start press focus-ring" onclick={newChat} data-testid="start-first">Start one</button>
      </div>
    {/if}
    </main>
  </div>

  <BackgroundChat {session} online={status.online !== false && !status.offline} onnewchat={newChat} />

  <Onboarding conversations={state.conversations} {status} workspaceNames={$sidebarStore.names} {replayRequest} />

  <UndoBar label={undoLabel} onundo={undoNow} variant="float" testid="chat-undo" />

  {#if searching}
    <SearchPalette chatState={state} {session} onopen={openResult} onclose={() => (searching = false)} />
  {/if}

  {#if quicklook || quicklookLoading}
    <Quicklook
      file={quicklook}
      loading={quicklookLoading}
      error={quicklookError}
      conversationId={activeId}
      onclose={() => { quicklook = null; quicklookError = null; quicklookTrail = []; }}
      ondownload={download}
      onpath={openPath}
      onback={quicklookTrail.length > 1 ? quicklookBack : null}
    />
  {/if}
</div>

<style>
  .app { display: flex; height: 100dvh; overflow: hidden; }
  .peekwrap { display: contents; }
  .peekwrap.peeking {
    display: block; position: fixed; inset: 0 auto 0 0; z-index: 40;
    box-shadow: 0 0 40px rgb(0 0 0 / 0.4);
  }
  .sidebar-resize {
    position: fixed; top: 0; bottom: 0; width: 7px; margin-left: -4px; z-index: 35;
    cursor: col-resize; touch-action: none;
  }
  .sidebar-resize::after {
    content: ''; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px;
    background: transparent; transition: background-color 120ms var(--ease);
  }
  .sidebar-resize:hover::after, .sidebar-resize.active::after { background: var(--accent); }
  .app.resizing { cursor: col-resize; user-select: none; }
  .app.resizing :global(main) { pointer-events: none; }
  .edge { position: fixed; inset: 0 auto 0 0; width: 8px; z-index: 39; }
  .stage { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .stagenav {
    flex: none;
    padding: 20px clamp(12px, 4vw, 20px) 6px;
    padding-top: max(20px, env(safe-area-inset-top));
  }
  /* A phone is held at the bottom, so the chat list lives within thumb reach there.
     It floats over the transcript rather than taking a bar out of it: a bar of its own
     cost 43px of reading space and made the pill look like part of the new-chat button's
     row. --pane-chrome-h is the focused pane's composer height, published by ChatPane,
     so the pill rides above the composer as the draft grows; --keyboard-inset lifts it
     with the on-screen keyboard the same way the new-chat button is lifted. --notif-lift is
     the height of whatever bar is currently talking to him (UndoBar publishes it): a notice
     takes the band above the composer and pushes the pill up, never covers it. */
  @media (max-width: 860px) {
    .stagenav {
      position: fixed;
      z-index: 30;
      right: clamp(12px, 4vw, 20px);
      bottom: calc(var(--pane-chrome-h, 0px) + 18px + var(--notif-lift, 0px) + var(--keyboard-inset, 0px));
      padding: 0;
      display: flex;
      justify-content: flex-end;
      
      pointer-events: none;
    }
    .stagenav :global(.pill) {
      pointer-events: auto;
      box-shadow: 0 6px 20px rgb(0 0 0 / 0.32);
    }
  }
  main { flex: 1; min-width: 0; min-height: 0; display: flex; }
  .scrim { position: fixed; inset: 0; background: rgb(0 0 0 / 0.42); z-index: 35; border: none; }
  .blank {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; color: var(--ink-faint);
  }
  .start {
    border: 1px solid var(--line); border-radius: 9px; padding: 8px 16px;
    color: var(--ink); font-size: 13.5px;
  }
  .start:hover { border-color: var(--accent); color: var(--accent); }

  .pane-slot { display: flex; min-width: 0; height: 100%; }
  main:global(.resizing) .pane-slot { overflow: hidden; }
  
  .rail {
    display: flex; align-items: center; justify-content: center;
    height: 100%; min-width: 0;
    background: var(--bg-sunken);
    border: none;
    border-right: 1px solid var(--line-soft);
    color: var(--ink-dim);
    overflow: hidden;
  }
  .rail:hover { background: color-mix(in srgb, var(--ink) 7%, var(--bg-sunken)); color: var(--ink); }
  .rail-label {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 11.5px;
    max-height: calc(100% - 24px);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  
  .divider {
    flex: 0 0 5px; cursor: col-resize; background: var(--line-soft);
    border: 0; padding: 0;
    transition: background var(--tap) var(--ease);
  }
  .divider:hover, .divider.dragging, .divider:focus-visible { background: var(--accent); }
</style>
