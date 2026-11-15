<script>
  import { onMount, tick, setContext } from 'svelte';
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
  import { documentTitle, automatedTitle } from '$lib/core/title.js';
  import TabStrip from '$lib/ui/TabStrip.svelte';
  import { dropTarget, landingIndex } from '$lib/core/tab-drag.js';
  import { languageOf, warmTokens } from '$lib/core/highlight.js';
  import { groupForks, rankConversations } from '$lib/core/recency.js';
  import { nextAfterArchive } from '$lib/core/archive-select.js';
  import { isMod, isMacTextBinding, isPanePrefix, isStopShortcut, paneChord, transcriptScroll, PANE_CHORDS, chordHint, isApple } from '$lib/core/keys.js';
  import { keyboardDecl } from '$lib/core/keyboard-state.js';
  import { findDecl } from '$lib/core/find-state.js';
  import { prefsDecl } from '$lib/core/prefs-state.js';
  import { provideMenu, SEP } from '$lib/client/context-menu.js';
  import { SEEN_KEY, startsSidebarHidden } from '$lib/core/window-start.js';
  import { resizeDrag, SIDEBAR_MIN_PX, SIDEBAR_MAX_PX, SIDEBAR_DEFAULT_PX } from '$lib/core/sidebar-resize.js';
  import UndoBar from '$lib/ui/UndoBar.svelte';
  import { createUndoStack, isUndoShortcut, watchEditedFields } from '$lib/core/undo.js';
  import { isSpaceKey } from '$lib/services/voice/core/pushtotalk.js';
  import {
    MAX_PANELS, RAIL_PX, neighbour as paneNeighbour, willSplit
  } from '$lib/core/panels.js';
  import { panesDecl, paneGesture } from '$lib/core/panes-state.js';
  import { listenDesktop, tabForDigit } from '$lib/client/desktop-commands.js';
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
  const dragState = $derived($paneStore.drag);
  // Every chat that is a tab of some group (the sidebar marks these as open); `layout.panels` is the active one of each group.
  const openChatIds = $derived(layout.tabs.flat());
  const restored = layout.panels.length > 0;
  // The focused chat is a fact of the pane layout and nothing else: derived, never written.
  const activeId = $derived(layout.panels[layout.focused] ?? null);
  let viewportPx = $state(1400);
  let sidebarOpen = $state(false);
  // The list is collapsed (wide windows): a fact of the sidebar's device state in the kit store, never a bare flag here, so the corner
  // tab, the edge hit area, the resize handle and the first pane's tab strip all read the one value.
  const sidebarHidden = $derived($sidebarStore.hidden);
  const setSidebarHidden = (hidden) => sidebarStore.dispatch('hidden.set', { hidden });
  // Width of the corner tab the collapsed list leaves (measured), so the first pane's tab strip makes room beside it.
  let cornerW = $state(0);
  // Drag the list's right edge to resize it; dragged narrower than SIDEBAR_COLLAPSE_PX it collapses as Cmd-B would, and
  // dragging back out reopens it. Width persists per browser. Device UI state is declared once (core/sidebar-state.js)
  // on the kit's state core, hydrated here synchronously so the first paint already has his width and workspace; the old
  // code read the width in onMount, a frame late.
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
  let sidebarRef = $state(null);
  // The keyboard modes (Ctrl-Q waiting for its second key, the chord list) are kit state (core/keyboard-state.js).
  const keyboardStore = uiApp().use(keyboardDecl);
  const panePrefix = $derived(Boolean($keyboardStore.prefix));
  const chordHelp = $derived($keyboardStore.help);
  
  
  
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
    if (wide) setSidebarHidden(!sidebarHidden);
    else sidebarOpen = !sidebarOpen;
  }

  function sidebarResizeStart(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    sidebarDragging = true;
    // The drag moves the width by the pointer's movement from the width the list has right now (its rendered box, not the stored
    // number and not clientX); see core/sidebar-resize.js. A press that never moves changes nothing.
    const rendered = handle.parentElement?.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect().width;
    const drag = resizeDrag({ startWidth: rendered > 0 ? rendered : sidebarWidth, startX: event.clientX });
    let frame = 0, x = event.clientX;
    const apply = () => {
      frame = 0;
      const next = drag.move(x);
      if (next.hidden) { setSidebarHidden(true); return; }
      if (next.width === null) return;
      setSidebarHidden(false);
      dragWidth = next.width;
    };
    const move = (e) => { x = e.clientX; if (!frame) frame = requestAnimationFrame(apply); };
    const end = () => {
      if (frame) { cancelAnimationFrame(frame); apply(); }
      sidebarDragging = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      const saved = drag.end();
      if (saved !== null) sidebarStore.dispatch('width.set', { px: saved });
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
      setSidebarHidden(false);
      sidebarOpen = true;
    }
    if (id === 'search') searching = true;
    if (id === 'incognito') newIncognitoChat();
    if (id === 'voice') paneRefs[layout.focused]?.openVoice?.();
    if (id === 'onboarding') replayRequest += 1;
  }

  onMount(() => {
    // Read-only views of the page's kit states, for the e2e specs to compare the store with what is drawn (never written through).
    window.__webchatKit = {
      panes: () => paneStore.get(), keyboard: () => keyboardStore.get(), sidebar: () => sidebarStore.get(),
      find: () => uiApp().use(findDecl).get(), prefs: () => uiApp().use(prefsDecl).get()
    };
    try {
      const seen = sessionStorage.getItem(SEEN_KEY) === '1';
      sessionStorage.setItem(SEEN_KEY, '1');
      setSidebarHidden(startsSidebarHidden({
        chatInUrl: new URLSearchParams(location.search).get('chat'), opener: window.opener, seen
      }));
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
      // Nothing is open once boot has settled (the last pane's chat was revoked or is gone): the blank chat, as when the
      // last tab is closed. Never another chat: the open chat changes only on his own action, not because the one he had
      // is missing from a list.
      if (bootSettled && !activeId && wide && !selecting && !transientId) openTransient();
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
    // What boot itself put on screen. The engine can take a minute to answer start() (a wedged disk commit), and he does not wait: a
    // chat he opens or creates meanwhile is his.
    const bootLayout = layout;
    const bootChats = new Set(layout.tabs.flat());
    session.start({ open: fromUrl || (restored ? activeId : null) }).then(() => {
      const untouched = layout === bootLayout;
      // Boot is the one moment the whole chat list is known, so it is where the folds
      // of chats that are gone are dropped. See client/fold-store.js.
      pruneFolds(Object.keys(state.conversations || {}));
      if (restored) {
        // A restored pane whose chat no longer exists is dropped. An empty list is a cold cache with no network, which
        // says nothing about any chat, so nothing is dropped on it. Only chats the window had before it reloaded: one
        // made since is pending creation (the server has not heard of it yet), not gone.
        if (Object.keys(state.conversations || {}).length) {
          const gone = layout.tabs.flat().filter((id) => bootChats.has(id) && !state.conversations[id] && !session.isProvisional(id));
          if (pane('pane.drop', { ids: gone })) settlePanes();
        }
        for (const panel of layout.panels) session.hydrate(panel);
      }
      bootSettled = true;
      if (untouched) {
        if (wantsNew) newChat();
        // A link to a chat already in a restored pane keeps the saved focus: the address bar can lag behind it.
        else if (fromUrl && !(restored && layout.panels.includes(fromUrl))) select(fromUrl);
        else if (restored && activeId) replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
      }
      // The sweep left no pane at all: the blank chat.
      if (!layout.panels.length && wide && !transientId) openTransient();
    });

    window.addEventListener('pointermove', archivePointer);
    window.addEventListener('pointerdown', clearArchivePointer, true);
    window.addEventListener('blur', clearArchivePointer);
    window.addEventListener('keydown', paneChordShortcut, true);
    window.addEventListener('blur', clearPanePrefix);
    window.addEventListener('keydown', archiveShortcut, true);
    window.addEventListener('keydown', paneNavShortcut, true);
    window.addEventListener('keydown', tabShortcut, true);
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
    // The tophat-desktop shell's menu chords (Cmd-1..9, Cmd-W, Ctrl-Tab, Cmd-Opt-Arrow, Cmd-T, Cmd-\); nothing in a browser.
    const offDesktop = listenDesktop(window, desktopCommands);
    return () => {
      offDesktop();
      unwatchFields();
      unsubscribe();
      unsubscribeIncognito();
      media.removeEventListener('change', applyWidth);
      window.visualViewport?.removeEventListener('resize', shiftFloats);
      window.visualViewport?.removeEventListener('scroll', shiftFloats);
      window.removeEventListener('pointermove', archivePointer);
      window.removeEventListener('pointerdown', clearArchivePointer, true);
      window.removeEventListener('blur', clearArchivePointer);
      window.removeEventListener('keydown', paneChordShortcut, true);
      window.removeEventListener('blur', clearPanePrefix);
      clearPanePrefix();
      window.removeEventListener('keydown', archiveShortcut, true);
      window.removeEventListener('keydown', paneNavShortcut, true);
      window.removeEventListener('keydown', tabShortcut, true);
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

  // A browser extension's overlay lives in a shadow root, so its input reaches us retargeted to the host element; look inside.
  function typingInAField(target) {
    let el = target;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el instanceof HTMLElement
      && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
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
  function clearArchivePointer(event) {
    hoveredChat = null;
    // A press anywhere outside the chord list puts it away.
    if (keyboardStore.get().help && !event?.target?.closest?.('[data-testid="chord-help"]')) keyboardStore.dispatch('help.set', { open: false });
  }

  // Archiving the chat on screen leaves the pane holding something he has put away, so selection
  // moves on by itself: to the row his mouse was just over, else to the next chat down the
  // sidebar. The order is read BEFORE the archive lands, while the row is still in place.
  function archiveChat(id, archived) {
    const open = openChatIds.includes(id);
    const next = archived && open
      ? nextAfterArchive(sidebarOrder(), id, { hovered: lastHoveredChat, hoveredAt: lastHoveredAt })
      : null;
    const was = Boolean(state.conversations[id]?.archived);
    session.archive(id, archived);
    if (archived) onboard('chat.archived', { chat: id });
    // Undoing a Done on the chat he was reading puts the chat back AND puts him back in it,
    // because the archive moved the tab off it.
    rememberUndo(id, archived ? 'Done:' : 'Put back:', () => {
      session.archive(id, was);
      if (archived && open) select(id);
    }, { silent: archived });
    lastHoveredChat = null;
    if (!archived || !open) return;
    // With other tabs open, archiving a chat on screen closes its tab. Alone, the chat is replaced by the next one down
    // the sidebar, else the blank chat.
    if (openChatIds.length > 1) { pane('pane.drop', { ids: [id] }); return settlePanes(); }
    if (next) select(next);
    else if (!transientId) openTransient();
    pane('pane.drop', { ids: [id] });
    settlePanes();
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
    // Ctrl-Enter opens the chat under the pointer beside the focused pane, as its row's "Open in new pane" does. The
    // explorer tree takes it for its own cursor row (Sidebar treeKeydown); a text field keeps its own Enter, so a draft is
    // never sent away.
    if (event.key === 'Enter' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.isComposing
        && !searching && !quicklook && !insideModal(event.target) && !typingInAField(event.target)
        && !event.target?.closest?.('[data-testid="chat-list"]') && hoveredChat) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) openFork(hoveredChat);
      hoveredChat = null;
      return;
    }
    const command = event.metaKey && !event.ctrlKey && !event.altKey;
    // Plain E is for the row under the pointer, never for text: in the composer or any other field it is a letter.
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && hoveredChat
      && !typingInAField(event.target);
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

  // Ctrl-Q, then one key, works the panes and their tabs as a tmux prefix does. The key after the prefix is always taken, so
  // it never lands in the composer; the hint bar shows while it waits and it lapses after three seconds. The mode is kit
  // state (keyboard-state.js).
  let panePrefixTimer = 0;
  let armSeq = 0;
  function clearPanePrefix() {
    clearTimeout(panePrefixTimer);
    if (keyboardStore.get().prefix) keyboardStore.dispatch('prefix.clear', {});
  }
  function armPanePrefix() {
    const id = `k${Date.now().toString(36)}-${(armSeq += 1)}`;
    keyboardStore.dispatch('prefix.arm', { id });
    clearTimeout(panePrefixTimer);
    panePrefixTimer = setTimeout(() => keyboardStore.dispatch('prefix.clear', { id }), 3000);
  }

  // The group beside `at` that its tabs join (Ctrl-Q j): the open one to the left, else the one to the right.
  function joinTarget(at) {
    for (const index of [at - 1, at + 1]) if (index >= 0 && index < layout.panels.length) return index;
    return null;
  }
  // Every tab of the focused group moved into its neighbour, the active one last so it stays the one shown; the group,
  // left empty, closes (core/panels.js moveTab). Each move is one absolute tab.move.
  function joinTabs(at) {
    const to = joinTarget(at);
    if (to === null) return;
    const from = layout.keys[at];
    const target = layout.keys[to];
    const active = layout.panels[at];
    const tabs = [...layout.tabs[at].filter((chat) => chat !== active), active];
    for (const chat of tabs) pane('tab.move', { chat, from, to: target, index: (layout.tabs[layout.keys.indexOf(target)] ?? []).length });
    settlePanes();
  }

  function runPaneChord({ chord, n }) {
    const at = layout.focused;
    const group = layout.keys[at];
    const chat = layout.panels[at];
    if (chord === 'help') { keyboardStore.dispatch('help.set', { open: !keyboardStore.get().help }); return; }
    if (chord === 'split') return newChat({ split: true });
    if (chord === 'new') return newChat();
    if (chord === 'search') { searching = true; return; }
    if (chord === 'cycle-list') {
      if (wide && sidebarShown && !sidebarRef?.hasListFocus?.()) { sidebarRef?.focusList?.(); return; }
      tick().then(() => paneRefs[layout.focused]?.focusComposer());
      return;
    }
    if (chord === 'split-tab') splitActiveTab();
    if (chord === 'close' && layout.panels.length > 1) closePane(at);
    if (chord === 'close-tab' && group && chat) closeTab(group, chat);
    if (chord === 'next') focusPane(paneNeighbour(layout, 1) ?? layout.collapsed.indexOf(false));
    if (chord === 'focus-n' && n >= 1 && n <= layout.panels.length) {
      if (layout.collapsed[n - 1]) openRail(n - 1); else focusPane(n - 1);
    }
    if (chord === 'focus-left' || chord === 'focus-right') {
      const to = paneNeighbour(layout, chord === 'focus-left' ? -1 : 1);
      if (to !== null) focusPane(to);
    }
    if (chord === 'next-tab') desktopCommands.next();
    if (chord === 'prev-tab') desktopCommands.prev();
    if (chord === 'move-left' || chord === 'move-right') paneAction(at, chord === 'move-left' ? 'left' : 'right');
    if (chord === 'tab-to-pane' && group && chat) tabCommands.moveToNewGroup(group, chat);
    if (chord === 'pane-to-tabs') joinTabs(at);
    if (chord === 'zoom') { paneGesture(paneStore, 'zoom'); settlePanes(); }
    // tmux's resize: Shift-H moves the focused pane's right divider left, or its left one for the last pane.
    if (chord === 'resize-left' || chord === 'resize-right') {
      paneGesture(paneStore, 'resizeStep', { index: at < layout.panels.length - 1 ? at : at - 1, delta: chord === 'resize-left' ? -0.05 : 0.05 });
    }
    // The pane focused afterwards takes the keyboard, as Ctrl-H and Ctrl-L leave it. A close can leave the focus on a
    // folded pane (a rail), which has no composer: the nearest open pane takes it instead.
    if (layout.panels.length && layout.collapsed[layout.focused]) focusPane(paneNeighbour(layout, 1) ?? paneNeighbour(layout, -1) ?? layout.collapsed.indexOf(false));
    if (wide) tick().then(() => paneRefs[layout.focused]?.focusComposer());
  }

  // The prefix, its second key, Ctrl-Shift-U / Ctrl-Shift-D and a Mac's Ctrl-C, in the capture phase ahead of every other
  // key handler: they work from inside the composer, and the key after the prefix never reaches anything else.
  function paneChordShortcut(event) {
    if (keyboardStore.get().prefix && !MODIFIER_KEYS.has(event.key)) {
      clearPanePrefix();
      event.preventDefault();
      event.stopImmediatePropagation();
      const chord = paneChord(event);
      if (chord && !event.isComposing && !searching && !quicklook && !insideModal(event.target)) runPaneChord(chord);
      return;
    }
    // The chord list is open: Escape (or any key that is not a chord) puts it away.
    if (keyboardStore.get().help && !MODIFIER_KEYS.has(event.key) && !isPanePrefix(event)) {
      keyboardStore.dispatch('help.set', { open: false });
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); return; }
    }
    if (searching || quicklook || insideModal(event.target) || event.isComposing) return;
    if (isPanePrefix(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      armPanePrefix();
      return;
    }
    // Ctrl-Shift-U / Ctrl-Shift-D scroll the focused transcript from the composer too, the draft and caret untouched.
    const scroll = transcriptScroll(event);
    if (scroll) {
      event.preventDefault();
      event.stopImmediatePropagation();
      paneRefs[layout.focused]?.scrollTranscript?.(scroll);
      return;
    }
    // Ctrl-C on a Mac stops the focused chat's turn, through the Stop button's path; with nothing running the key is left alone.
    if (isStopShortcut(event) && !event.repeat && paneRefs[layout.focused]?.stop?.()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function shortcuts(event) {
    if (pushToTalk(event)) return;
    if (!isSpaceKey(event)) paneRefs[layout.focused]?.pushToTalkOther?.(event);
    if (isMacTextBinding(event)) return;
    const meta = isMod(event);
    const key = event.key.toLowerCase();
    if (meta && key === 'k') { event.preventDefault(); searching = true; return; }
    if (meta && key === 'f') { event.preventDefault(); paneRefs[layout.focused]?.openFind(); return; }
    // ⌘A away from a text field selects the focused chat's whole transcript, not the sidebar, header and composer with
    // it. The explorer tree keeps its own ⌘A (select every row; it stops the event first).
    if (meta && key === 'a' && !event.shiftKey && !event.altKey && !event.defaultPrevented && !typingInAField(event.target)
        && !searching && !quicklook && !insideModal(event.target)) {
      event.preventDefault();
      paneRefs[layout.focused]?.selectTranscript?.();
      return;
    }
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
      // An Escape nothing else took (a running turn's stop, a menu, a field of its own, an open sheet) moves the keyboard to
      // the chat list when it is showing; there the arrows walk, Enter opens as a click does (the preview tab) and Ctrl-Enter
      // opens beside. Never on a phone and never reveals a hidden list.
      if (wide && sidebarShown && !event.defaultPrevented && !insideModal(event.target) && !document.querySelector('[aria-modal="true"]')
          && (!typingInAField(event.target) || event.target.matches('[data-testid="composer"]'))) {
        event.preventDefault();
        sidebarRef?.focusList?.();
      }
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !searching && !quicklook
        && event.key.length === 1 && !typingInAField(event.target) && !insideModal(event.target)) {
      paneRefs[layout.focused]?.focusComposer();
    }
  }

  // `preview` (a plain click in the sidebar): the chat opens as the focused group's preview tab, replacing the untouched one
  // there. `selecting`: the blank chat released here publishes while no pane is focused, which would wake the boot fallback
  // above into opening the newest chat as a normal tab ahead of this one (a sidebar click then never opened a preview tab).
  let selecting = false;
  // start() has resolved and its boot decisions are made; until then an empty layout is a pending boot request, not "nothing open".
  let bootSettled = false;
  function select(id, { touch = true, preview = false } = {}) {
    selecting = true;
    try { releaseTransient(id); } finally { selecting = false; }
    if (preview) keepTouchedPreview(id);
    const before = layout.panels[layout.focused];
    pane('pane.activate', preview ? { id, preview: true } : { id });
    const focusedId = layout.panels[layout.focused] ?? null;
    sidebarOpen = false;
    for (const panel of layout.panels) session.hydrate(panel);
    if (touch && focusedId && focusedId !== before) session.touch(focusedId);
    if (focusedId) replaceState(`?chat=${encodeURIComponent(focusedId)}`, {});
  }

  // The focused group's preview tab, kept when he has left something in it that a replacement would hide.
  function keepTouchedPreview(nextId) {
    const at = layout.focused;
    const chat = layout.preview?.[at];
    if (!chat || chat === nextId) return;
    const uploads = layout.panels[at] === chat ? (paneRefs[at]?.stagedUploads?.() ?? []) : [];
    if (String(readDraft(chat) ?? '').trim() || uploads.length) pane('tab.keepPreview', { group: layout.keys[at], chat });
  }
  // He did something with a chat (typed, sent, double-clicked its tab or its sidebar row): every group's preview of it is kept.
  function keepPreview(chat) {
    (layout.preview ?? []).forEach((id, index) => { if (id === chat) pane('tab.keepPreview', { group: layout.keys[index], chat }); });
  }

  function openFork(id, { split = true } = {}) {
    if (releasesTransient(split)) releaseTransient(id);   // a split adds a pane beside the blank one, it never drops it
    sidebarOpen = false;
    // An explicit split is always a new pane, even when the chat is already open in another one.
    if (split === true && layout.panels.length) paneGesture(paneStore, 'split', { chat: id });
    else pane('pane.openFor', { id, split, viewportPx });
    for (const panel of layout.panels) session.hydrate(panel);
    replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
  }

  function focusPane(index) {
    pane('pane.focus', { index });
    if (activeId) replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
  }

  // Closing a group, or one tab, ends any incognito chat it held: nothing from it is saved, so with something in it he is asked.
  function confirmLoss(ids) {
    return !ids.some((id) => isIncognito(id) && incognito.hasContent(id))
      || confirm('Close this incognito chat? Nothing from it is saved anywhere.');
  }

  function closePane(index) {
    if (!confirmLoss(layout.tabs[index] ?? [])) return;
    paneGesture(paneStore, 'close', { index });
    if (activeId) replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
  }

  // One tab closed (its x, a middle click, Cmd-W). The group's last tab takes the group with it; the last tab of the
  // only group leaves the blank new chat, never an empty window.
  function closeTab(group, chat) {
    if (!layout.keys.includes(group) || !confirmLoss([chat])) return;
    const only = layout.panels.length === 1 && layout.tabs[0].length === 1;
    if (only && chat === transientId) return;
    if (only) openTransient();
    else if (chat === transientId) releaseTransient(null);
    pane('tab.close', { group, chat });
    settlePanes();
  }

  // Close several tabs of a group at once (the tab menu: close others, close to the right, close all). `kept` are the chats the
  // group holds afterwards. A blank chat nobody typed in is discarded as it is when he leaves it; a window left with nothing
  // opens the blank chat again, as closing the last tab does.
  function keepTabsOf(group, kept) {
    const at = layout.keys.indexOf(group);
    if (at < 0) return;
    const gone = layout.tabs[at].filter((id) => !kept.includes(id));
    if (!gone.length || !confirmLoss(gone)) return;
    if (transientId && gone.includes(transientId)) releaseTransient(null);
    pane('tab.keep', { group, keep: kept });
    if (!layout.panels.length) openTransient();
    settlePanes();
  }
  // The commands the shared context menu runs on a tab (setContext 'tab-commands'; data-ctx="tab" carries group and chat).
  const tabsOfGroup = (group) => layout.tabs[layout.keys.indexOf(group)] ?? [];
  const tabCommands = {
    closeTab,
    closeOthers: (group, chat) => { if (tabsOfGroup(group).includes(chat)) keepTabsOf(group, [chat]); },
    closeToRight: (group, chat) => { const tabs = tabsOfGroup(group); if (tabs.includes(chat)) keepTabsOf(group, tabs.slice(0, tabs.indexOf(chat) + 1)); },
    closeAll: (group) => keepTabsOf(group, []),
    // the tab shown again in a new group on the right of its group
    splitRight: (group, chat) => { pane('tab.keepPreview', { group, chat }); if (paneGesture(paneStore, 'splitTab', { group, chat })) activateAfter(); },
    // the tab moved out of its group into a new one on the right (a group's only tab has nowhere to move from)
    moveToNewGroup: (group, chat) => {
      if (tabsOfGroup(group).length < 2 || !tabsOfGroup(group).includes(chat)) return;
      if (paneGesture(paneStore, 'dropEdge', { chat, from: group, group, side: 'right' })) { pane('tab.close', { group, chat }); activateAfter(); }
    }
  };
  setContext('tab-commands', tabCommands);

  // The right-click menu of a tab and of a group's tab strip (data-ctx="tab" / "tabstrip"; the shared ContextMenuHost
  // draws it). Each item shows its Ctrl-Q chord where it has one (core/keys.js PANE_CHORDS).
  function tabMenuItems({ group, chat }) {
    const at = layout.keys.indexOf(group);
    if (at < 0) return [];
    const tabs = layout.tabs[at];
    const many = layout.panels.length > 1;
    const zoomed = layout.collapsed.some((shut, i) => i !== at && shut) && !layout.collapsed.some((shut, i) => i !== at && !shut);
    return [
      chat && tabs.includes(chat) && { id: 'close-tab', label: 'Close', keys: chordHint('close-tab'), run: () => closeTab(group, chat) },
      chat && tabs.length > 1 && { id: 'close-others', label: 'Close Others', run: () => tabCommands.closeOthers(group, chat) },
      chat && tabs.indexOf(chat) < tabs.length - 1 && { id: 'close-right', label: 'Close to the Right', run: () => tabCommands.closeToRight(group, chat) },
      { id: 'close-all', label: 'Close All', run: () => tabCommands.closeAll(group) },
      SEP,
      chat && { id: 'split-right', label: 'Split Right', keys: chordHint('split-tab'), run: () => tabCommands.splitRight(group, chat) },
      chat && tabs.length > 1 && { id: 'tab-to-pane', label: 'Move to New Pane', keys: chordHint('tab-to-pane'), run: () => tabCommands.moveToNewGroup(group, chat) },
      many && { id: 'pane-to-tabs', label: 'Join Tabs into Neighbour', keys: chordHint('pane-to-tabs'), run: () => joinTabs(at) },
      many && { id: 'zoom', label: zoomed ? 'Unzoom Pane' : 'Zoom Pane', keys: chordHint('zoom'), run: () => paneAction(at, 'zoom') },
      many && { id: 'close-pane', label: 'Close Pane', keys: chordHint('close'), run: () => closePane(at) },
      SEP,
      { id: 'next-tab', label: 'Next Tab', keys: chordHint('next-tab'), run: () => { focusPane(at); desktopCommands.next(); } },
      { id: 'prev-tab', label: 'Previous Tab', keys: chordHint('prev-tab'), run: () => { focusPane(at); desktopCommands.prev(); } },
      { id: 'chords', label: 'Keyboard Chords…', keys: chordHint('help'), run: () => keyboardStore.dispatch('help.set', { open: true }) }
    ];
  }
  $effect(() => {
    const off = [provideMenu('tab', (ctx) => tabMenuItems(ctx)), provideMenu('tabstrip', (ctx) => tabMenuItems({ group: ctx.group, chat: null }))];
    return () => off.forEach((f) => f());
  });

  function activateTab(group, chat) {
    const before = layout.panels[layout.focused];
    if (!pane('tab.activate', { group, chat })) return;
    settlePanes();
    const now = layout.panels[layout.focused];
    if (now && now !== before) session.touch(now);
    if (wide) tick().then(() => paneRefs[layout.focused]?.focusComposer());
  }

  // Split the active tab into a group on its right (Cmd-\).
  function activateAfter() {
    settlePanes();
    if (wide) tick().then(() => paneRefs[layout.focused]?.focusComposer());
  }
  function splitActiveTab() {
    const group = layout.keys[layout.focused];
    if (group) pane('tab.keepPreview', { group, chat: layout.panels[layout.focused] });
    if (paneGesture(paneStore, 'splitActive')) activateAfter();
  }

  // The desktop shell's commands (client/desktop-commands.js): the same kit actions the tab strip runs. The page itself
  // never binds these chords; only the native menu of tophat-desktop sends them, so a browser keeps its own.
  const desktopCommands = {
    tab: (n) => {
      const group = layout.keys[layout.focused];
      const chat = tabForDigit(layout.tabs[layout.focused], n);
      if (group && chat) activateTab(group, chat);
    },
    close: () => {
      const group = layout.keys[layout.focused];
      const chat = layout.panels[layout.focused];
      if (group && chat) closeTab(group, chat);
    },
    next: () => { if (paneGesture(paneStore, 'nextTab')) activateAfter(); },
    prev: () => { if (paneGesture(paneStore, 'prevTab')) activateAfter(); },
    new: () => newChat(),
    split: () => splitActiveTab()
  };

  // The chord handler for splitting, in the capture phase so a composer or an editor under the pointer does not keep it.
  // Matched on event.key.
  function tabShortcut(event) {
    if (event.isComposing || searching || quicklook || insideModal(event.target)) return;
    const key = String(event.key || '');
    const mod = isMod(event);
    let handled = true;
    if (mod && !event.altKey && !event.shiftKey && key === '\\') splitActiveTab();
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // What a tab shows: the chat's title, with the automated tag the sidebar uses.
  function tabsOf(index) {
    return layout.tabs[index].map((id) => {
      const row = stateFor(id).conversations[id];
      const title = row?.title || 'New chat';
      return { id, title: automatedTitle(title).text || title, automated: Boolean(row?.automated) || automatedTitle(title).automated };
    });
  }

  // Dragging a tab. The pointer moves it; where it would land (core/tab-drag.js, measured from the groups on screen) is
  // kit state (`drag.set`), so the indicator and the edge overlays are projections of it and a drop is one absolute
  // action. A press without a 4 px move is a click: it only activated the tab.
  const DRAG_SLOP = 4;
  let tabPress = null;
  function tabDown(group, chat, event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (layout.panels[layout.keys.indexOf(group)] !== chat || layout.focused !== layout.keys.indexOf(group)) activateTab(group, chat);
    tabPress = { group, chat, x: event.clientX, y: event.clientY, live: false };
    window.addEventListener('pointermove', tabMove);
    window.addEventListener('pointerup', tabUp);
    window.addEventListener('pointercancel', tabCancel);
  }
  function measureGroups() {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    return [...document.querySelectorAll('main [data-testid="pane"][data-group]')].map((el) => {
      const strip = el.querySelector('[data-testid="tabstrip"]');
      return { key: el.dataset.group, rect: rect(el), strip: strip ? rect(strip) : null, tabs: [...el.querySelectorAll('[data-testid="tab"]')].map(rect) };
    });
  }
  function tabMove(event) {
    if (!tabPress) return;
    if (!tabPress.live) {
      if (Math.hypot(event.clientX - tabPress.x, event.clientY - tabPress.y) < DRAG_SLOP) return;
      tabPress.live = true;
      pane('drag.set', { drag: { chat: tabPress.chat, from: tabPress.group, over: null } });
      document.body.style.userSelect = 'none';
    }
    const from = layout.keys.indexOf(tabPress.group);
    const only = from >= 0 && layout.tabs[from].length === 1;
    const over = dropTarget({ x: event.clientX, y: event.clientY, from: tabPress.group, groups: measureGroups(), only });
    pane('drag.set', { drag: { chat: tabPress.chat, from: tabPress.group, over } });
  }
  function tabEnd() {
    window.removeEventListener('pointermove', tabMove);
    window.removeEventListener('pointerup', tabUp);
    window.removeEventListener('pointercancel', tabCancel);
    document.body.style.userSelect = '';
    const press = tabPress;
    tabPress = null;
    return press;
  }
  function tabCancel() {
    const press = tabEnd();
    if (press?.live) pane('drag.set', { drag: null });
  }
  function tabUp() {
    const press = tabEnd();
    const drag = paneStore.get().drag;
    if (!press?.live) return;
    pane('drag.set', { drag: null });
    const over = drag?.over;
    if (!over) return;
    dropTab(press.chat, press.group, over);
  }

  // A drop: one absolute action (two for a split: the new group, then the tab leaving its old one). Each is the same on a repeat.
  function dropTab(chat, from, over) {
    const strip = layout.tabs[layout.keys.indexOf(over.group)] ?? [];
    if (over.kind === 'strip') {
      const index = over.group === from ? landingIndex(strip, chat, over.index) : over.index;
      pane('tab.move', { chat, from, to: over.group, index });
    } else if (over.kind === 'body') {
      pane('tab.move', { chat, from, to: over.group, index: strip.length });
    } else if (over.kind === 'edge') {
      if (paneGesture(paneStore, 'dropEdge', { chat, from, group: over.group, side: over.side })) pane('tab.close', { group: from, chat });
    }
    settlePanes();
  }

  // After a pane action changed the layout: follow the focus, load every open chat, point the address at it.
  function settlePanes() {
    for (const panel of layout.panels) session.hydrate(panel);
    if (activeId) replaceState(`?chat=${encodeURIComponent(activeId)}`, {});
  }

  function paneAction(index, action) {
    if (action === 'duplicate') { paneGesture(paneStore, 'duplicate', { index }); return settlePanes(); }
    if (action === 'left') { paneGesture(paneStore, 'move', { index, delta: -1 }); return settlePanes(); }
    if (action === 'right') { paneGesture(paneStore, 'move', { index, delta: 1 }); return settlePanes(); }
    if (action === 'close') return closePane(index);
    if (action === 'close-tab') return closeTab(layout.keys[index], layout.panels[index]);
    if (action === 'tab-to-pane') return tabCommands.moveToNewGroup(layout.keys[index], layout.panels[index]);
    if (action === 'pane-to-tabs') return joinTabs(index);
    if (action === 'zoom') { focusPane(index); paneGesture(paneStore, 'zoom'); return settlePanes(); }
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

  // A new incognito chat as a tab of the focused group, or in a group beside it. The id is placed in the layout before the chat
  // exists, so the sweep below never sees it outside every tab.
  async function newIncognitoChat({ split = false } = {}) {
    if (transientId) releaseTransient(null);
    await incognito.start();
    const id = incognito.session.newConversationId();
    if (split) pane('pane.openBeside', { id }); else pane('pane.activate', { id });
    sidebarOpen = false;
    incognito.open(id, newChatSettings());
    replaceState(location.pathname, {});
    await tick();
    paneRefs[layout.focused]?.focusComposer();
  }

  // An incognito chat that is in no pane, nor under a chat that is (a fork or side thread of one), is over: the
  // server forgets it and so does this tab.
  $effect(() => {
    const open = new Set(layout.tabs.flat());
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
  {#if panePrefix}
    <div class="pane-prefix" role="status" data-testid="pane-prefix">⌃Q · h new pane · x close · w close tab · o next · n p tabs · ⇧H ⇧L resize · {'{'} {'}'} swap · z zoom · ? all</div>
  {/if}
  {#if chordHelp}
    <div class="chord-help" role="dialog" aria-label="Keyboard chords" data-testid="chord-help">
      <div class="chord-head">Ctrl-Q, then <span>Esc closes</span></div>
      <dl>
        {#each PANE_CHORDS as entry (entry.chord)}
          <dt><kbd>{entry.show ?? entry.key}</kbd></dt><dd>{entry.label}</dd>
        {/each}
      </dl>
      <div class="chord-head">Without the prefix</div>
      <dl>
        <dt><kbd>⌃H ⌃L</kbd></dt><dd>pane to the left, right</dd>
        <dt><kbd>⌃⇧U ⌃⇧D</kbd></dt><dd>scroll the transcript half a screen</dd>
        <dt><kbd>Esc</kbd></dt><dd>to the chat list; ↑ ↓ walk, ↩ opens, ⌃↩ opens beside</dd>
        {#if isApple()}<dt><kbd>⌃C</kbd></dt><dd>stop the focused chat</dd>{/if}
        <dt><kbd>{isApple() ? '⌘' : 'Ctrl-'}A</kbd></dt><dd>select the whole transcript</dd>
        <dt><kbd>{isApple() ? '⌘' : 'Ctrl-'}F</kbd></dt><dd>find in chat</dd>
        <dt><kbd>{isApple() ? '⌘\\' : 'Ctrl-\\'}</kbd></dt><dd>split the tab</dd>
        <dt><kbd>e</kbd></dt><dd>archive the row under the pointer (outside a text field)</dd>
      </dl>
    </div>
  {/if}
  {#if sidebarOpen && !wide}
    <button class="scrim" onclick={() => (sidebarOpen = false)} aria-label="Close chat list"></button>
  {/if}

  {#if wide && sidebarHidden && !sidebarPeek}
    <div class="edge" data-testid="sidebar-edge" aria-hidden="true" onpointerenter={() => (sidebarPeek = true)}></div>
  {/if}
  <div class="peekwrap" class:peeking={sidebarPeek && sidebarHidden} data-testid="sidebar-peek"
    onpointerleave={() => (sidebarPeek = false)}>
  <Sidebar
    bind:this={sidebarRef}
    conversations={state.conversations}
    chatState={state}
    {session}
    {activeId}
    openIds={openChatIds}
    {status}
    open={sidebarShown || (sidebarPeek && sidebarHidden)}
    shownav={navInSidebar}
    {navItems}
    onnavpick={navPick}
    onselect={select}
    onkeep={keepPreview}
    onopenbeside={(id) => openFork(id)}
    onnew={newChat}
    onsearch={() => (searching = true)}
    onpin={pinChat}
    onarchive={archiveChat}
    onaside={asideChat}
    ondefer={deferChat}
    onread={(id, read, opts) => session.markRead(id, read, opts)}
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
      <!-- Wide window, list collapsed: the pill and its menu sit in a small tab in the top-left corner, over the first pane's tab
           strip (which leaves room for it), so the transcript keeps the whole height. A phone keeps the floating pill. -->
      <div class="stagenav" class:corner={wide} data-testid="stage-nav" bind:offsetWidth={cornerW}>
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
          data-group={layout.keys[index]}
          data-focused={index === layout.focused ? 'true' : 'false'}
        >
          {#if wide}
            <TabStrip
              group={layout.keys[index]}
              tabs={tabsOf(index)}
              active={panelId}
              preview={layout.preview?.[index] ?? null}
              focused={index === layout.focused}
              inset={index === 0 && !navInSidebar ? cornerW : 0}
              drag={dragState}
              ondown={(chat, event) => tabDown(layout.keys[index], chat, event)}
              onclose={(chat) => closeTab(layout.keys[index], chat)}
              onnew={() => { focusPane(index); newChat(); }}
              onkeep={(chat) => pane('tab.keepPreview', { group: layout.keys[index], chat })}
            />
          {/if}
          <div class="group-body">
          <ChatPane
            bind:this={paneRefs[index]}
            session={sessionFor(panelId)}
            chatState={stateFor(panelId)}
            status={statusFor(panelId)}
            conversationId={panelId}
            primary={index === layout.focused}
            autofocus={wide && panelId === transientId}
            pane={wide ? { index, count: layout.panels.length, max: MAX_PANELS, tabs: layout.tabs[index].length, zoomed: layout.panels.length > 1 && layout.collapsed.every((shut, i) => i === index || shut) } : null}
            onpane={(action) => paneAction(index, action)}
            onpath={openPath}
            onselect={(id, options) => select(id, options)}
            onforkopen={(id, options) => openFork(id, options)}
            onnewchat={(opts) => newChat(opts)}
            onengage={() => pane('tab.keepPreview', { group: layout.keys[index], chat: panelId })}
            onfocus={() => focusPane(index)}
            onclosepane={layout.panels.length > 1 ? () => closePane(index) : null}
            jump={jump && jump.conversationId === panelId ? jump : null}
          />
          {#if dragState?.over?.group === layout.keys[index] && dragState.over.kind !== 'strip'}
            <div class="drop-zone {dragState.over.kind === 'edge' ? dragState.over.side : 'whole'}" data-testid="drop-zone" data-kind={dragState.over.kind} aria-hidden="true"></div>
          {/if}
          </div>
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
  .stage { position: relative; }
  .stagenav {
    flex: none;
    padding: 20px clamp(12px, 4vw, 20px) 6px;
    padding-top: max(20px, env(safe-area-inset-top));
  }
  /* The collapsed list's tab: hugs the top-left corner, as tall as the tab strip it sits in, only its top-right corner
     rounded (a folder tab), sized to the pill and menu button inside. It takes no height from the transcript. Appears by
     opacity and a short slide on the compositor, one easing; the pill drops its own outline inside it. */
  .stagenav.corner {
    position: absolute; z-index: 6; top: 0; left: 0; padding: 0; height: 28px;
    display: flex; align-items: center; padding: 0 8px 0 4px;
    background: var(--bg-raised); border-right: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft);
    border-radius: 0 10px 0 0;
    animation: corner-in var(--panel) var(--ease);
  }
  .stagenav.corner :global(.pill) { border-color: transparent; background: transparent; padding: 0; }
  .stagenav.corner :global(.pill .tab) { padding: 5px 10px; }
  @keyframes corner-in { from { opacity: 0; transform: translateX(-8px); } }
  @media (prefers-reduced-motion: reduce) { .stagenav.corner { animation: none; } }
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
  /* Ctrl-Q is waiting for its second key: what the common ones do (Ctrl-Q ? lists them all). */
  .pane-prefix, .chord-help {
    position: fixed; left: 50%; transform: translateX(-50%); z-index: 60;
    max-width: calc(100vw - 24px); border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg-raised); color: var(--ink); font: 12px var(--mono);
  }
  .pane-prefix { top: 12px; padding: 8px 12px; pointer-events: none; }
  .chord-help { top: 48px; padding: 12px 16px; max-height: calc(100dvh - 96px); overflow: auto; box-shadow: 0 10px 40px rgb(0 0 0 / 0.35); }
  .chord-head { color: var(--ink-faint); margin: 4px 0 6px; }
  .chord-head span { float: right; margin-left: 24px; }
  .chord-help dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; margin: 0 0 8px; }
  .chord-help dt { text-align: right; }
  .chord-help dd { margin: 0; color: var(--ink-dim); }
  .chord-help kbd { font-family: var(--mono); }
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

  .pane-slot { display: flex; flex-direction: column; min-width: 0; height: 100%; }
  .group-body { position: relative; flex: 1; min-height: 0; min-width: 0; display: flex; }
  /* Where a dragged tab would land: the half of the group a split would take, or all of it for a move into it. */
  .drop-zone {
    position: absolute; top: 0; bottom: 0; z-index: 5; pointer-events: none;
    background: color-mix(in srgb, var(--accent) 14%, transparent); border: 1px solid var(--accent);
  }
  .drop-zone.left { left: 0; width: 50%; }
  .drop-zone.right { right: 0; width: 50%; }
  .drop-zone.whole { left: 0; right: 0; }
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
