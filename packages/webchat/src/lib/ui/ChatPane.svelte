<script>
  import { setContext, tick, untrack } from 'svelte';
  import { onboard } from '$lib/client/onboarding.js';
  import ChatHeader from './ChatHeader.svelte';
  import FindBar from './FindBar.svelte';
  import Transcript from './Transcript.svelte';
  import Composer from './Composer.svelte';
  import RejectedNotice, { dismiss, rejectedFor } from './RejectedNotice.svelte';
  import RetryNotice, { retryingNote } from './RetryNotice.svelte';
  import SkippedNotice from './SkippedNotice.svelte';
  import TranscriptError, { transcriptFailed } from './TranscriptError.svelte';
  import DictationMic from '../services/voice/ui/DictationMic.svelte';
  import { HOLD_ARM_MS, contextFor, interruptAction, pushToTalkDecision, releaseAction } from '$lib/services/voice/core/pushtotalk.js';
  import { createInputProvenance } from '$lib/client/input-provenance-recorder.js';
  import { observeInteraction } from '$lib/client/interaction.js';
  import { rememberAgent } from '$lib/client/agent-preference.js';
  import VoiceOrb from '../services/voice/ui/VoiceOrb.svelte';
  import SideThread from './SideThread.svelte';
  import SideThreads from './SideThreads.svelte';
  import { isOpen, toggleOpen } from './disclosure.svelte.js';
  import { conversationItems, forksOf, sidechatsOf } from '$lib/core/reducer.js';
  import { bottomIsAbout, unreadOf } from '$lib/core/rowstate.js';
  import { busyStretch, isLive } from '$lib/core/activity.js';
  import { readDraft, writeDraft } from '$lib/core/attachments.js';
  import { isMacTextBinding, isMod } from '$lib/core/keys.js';
  import { RAIL_MIN_PANE, railWidthFor, SELECT_GESTURES, SELECT_PILL, isAbandoned, quoteLine } from '$lib/core/sidechat.js';
  import { blockAt, offsetsOfNode, offsetsOfRange } from '$lib/core/textrange.js';
  import { makeAnchor } from '$lib/core/sidechat.js';
  import { resolveAnchor as resolveChatAnchor } from '$lib/core/sidechat.js';
  import { emptyGroups, paintRanges, rangeFor, textIndex } from '$lib/client/reader-dom.js';
  import { isIncognito } from '$lib/core/incognito.js';
  import { prefsDecl } from '$lib/core/prefs-state.js';
  import { findDecl } from '$lib/core/find-state.js';
  import { collapsedOf, sidechatDecl } from '$lib/core/sidechat-state.js';
  import { highlightsFor, threadFocus } from '../../../../runner/tools/docstore-kit/lib/intent.js';
  import { intentStore } from '$lib/client/intent.js';
  import { uiApp } from '$lib/client/ui-app.js';
  import { cardSide, chatNotesDecl, deletePress, markHit, notesOf } from '$lib/core/chat-notes-state.js';
  import { createChatNotes } from '$lib/client/chat-notes.js';
  import { readerReplica } from '$lib/client/reader-offline.js';

  let {
    session,
    chatState,
    status,
    conversationId,
    pane = null,
    // The pane group's key in the layout: the address focus is kept under (kit intent record).
    groupKey = null,
    onpane = () => {},
    onpath = () => {},
    onselect = () => {},
    onnewchat = () => {},
    // He did something in this chat (typed in the composer, sent): the page keeps a preview tab (core/panels.js).
    onengage = () => {},
    autofocus = false,
    primary = true,
    onfocus = () => {},
    onclosepane = null,
    onforkopen = null,
    jump = null
  } = $props();

  let measuredBottom = $state(false);
  let bottomOf = $state(null);
  const atBottom = $derived(bottomIsAbout({
    measured: measuredBottom,
    measuredIn: bottomOf,
    conversationId,
    hydrated: Boolean(chatState.conversations[conversationId]?.hydrated)
  }));
  // Find in chat is kit state (core/find-state.js): open, query, current match and the history-loading status, per chat, so
  // a reload or a second pane on the same chat reads the same thing and nothing here can drift from it.
  const findStore = uiApp().use(findDecl);
  const finding = $derived(Boolean(conversationId && $findStore.open[conversationId]));
  const findStatus = $derived(conversationId ? $findStore.status[conversationId] : undefined);
  const setFinding = (open) => { if (conversationId) findStore.dispatch('find.open', { chat: conversationId, open }); };
  let composer = $state(null);
  let notesOpen = $state(false);
  let highlightItemId = $state(null);
  let scrollToItemId = $state(null);

  let paneEl = $state(null);
  
  
  
  
  let chromeEl = $state(null);
  $effect(() => {
    if (!primary || !chromeEl || typeof document === 'undefined') return;
    const root = document.documentElement;
    const report = () => root.style.setProperty('--pane-chrome-h', `${Math.round(chromeEl.getBoundingClientRect().height)}px`);
    report();
    const watch = new ResizeObserver(report);
    watch.observe(chromeEl);
    return () => { watch.disconnect(); root.style.removeProperty('--pane-chrome-h'); };
  });
  $effect(() => {
    if (!paneEl || !conversationId) return;
    const capture = observeInteraction(paneEl, { conversation: conversationId });
    return () => capture.destroy();
  });
  let dropping = $state(false);
  let paneWidth = $state(1200);
  let railRef = $state(null);
  // Focus is the kit intent record's (tools/docstore-kit/lib/intent.js, one owner for every pane, side thread and document): which
  // thread holds the caret, whether this pane is the active one and what the passage highlight paints are projections of it. The
  // rail's folds are kit state too (core/sidechat-state.js). Nothing here focuses an element or keeps a focus flag of its own.
  const intent = intentStore();
  setContext('focus-pane', () => focusKey);
  const sideStore = uiApp().use(sidechatDecl);
  const focusKey = $derived(groupKey || `chat:${conversationId}`);
  const collapsedThreads = $derived(conversationId ? collapsedOf($sideStore, conversationId) : []);
  const focusedThread = $derived(threadFocus($intent, focusKey));
  const rail = $derived({ focused: focusedThread, collapsed: collapsedThreads });
  const sideDo = (type, payload = {}) => { if (conversationId) sideStore.dispatch(type, { key: conversationId, ...payload }); };
  const composerAt = { kind: 'composer', id: null };
  const focusComposerNow = () => intent.dispatch('focus', { pane: focusKey, at: composerAt });
  const focusThreadNow = (id) => { sideDo('thread.expand', { id }); intent.dispatch('openThread', { pane: focusKey, id }); };
  let hovered = $state(null);

  const threads = $derived(
    conversationId ? sidechatsOf(chatState, conversationId).filter((thread) => !thread.archived) : []
  );
  const openThreads = $derived(threads.filter((thread) => !rail.collapsed.includes(thread.id)));
  const wideEnough = $derived(paneWidth >= RAIL_MIN_PANE);
  const railOpen = $derived(wideEnough && openThreads.length > 0);
  const railWidth = $derived(railWidthFor(paneWidth));
  const highlights = $derived(highlightsFor($intent, focusKey, threads.map((thread) => thread.id), { fallback: primary }));
  const sheet = $derived(!wideEnough ? openThreads.find((thread) => thread.id === rail.focused) || null : null);

  $effect(() => {
    const ids = threads.map((thread) => thread.id);
    untrack(() => sideDo('thread.prune', { ids }));
  });

  $effect(() => {
    for (const thread of openThreads) session.hydrate(thread.id);
  });

  function transcriptEl() {
    return paneEl?.querySelector('[data-testid="transcript"]') || null;
  }

  
  function rowOf(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const row = element?.closest?.('[data-item]');
    const transcript = transcriptEl();
    return row && transcript?.contains(row) ? row : null;
  }

  
  function anchorFromSelection() {
    if (!SELECT_GESTURES) return null;
    return selectedAnchor();
  }

  /** The live selection as an anchor, for the pill; the keyboard gestures go through the gated one above. */
  function selectedAnchor() {
    if (!SELECT_PILL) return null;
    const selection = globalThis.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const row = rowOf(range.startContainer);
    if (!row || !row.contains(range.endContainer)) return null;
    const offsets = offsetsOfRange(row, range);
    if (!offsets || offsets.end <= offsets.start) return null;
    return makeAnchor(row.dataset.item, row.textContent || '', offsets.start, offsets.end);
  }

  
  function anchorFromBlock(block) {
    const row = rowOf(block);
    if (!row) return null;
    const offsets = offsetsOfNode(row, blockAt(row, block));
    if (!offsets || offsets.end <= offsets.start) return null;
    return makeAnchor(row.dataset.item, row.textContent || '', offsets.start, offsets.end);
  }

  function openThread(anchor, { seed = '' } = {}) {
    if (!anchor || !conversationId) return null;
    // The anchor usually arrives as a reactive proxy (it lives in `selection`); the engine posts
    // it across a MessagePort, which refuses a proxy (DataCloneError), so hand it a plain copy.
    anchor = $state.snapshot(anchor);
    const id = session.newConversationId();
    if (seed) writeDraft(id, seed);
    const label = String(anchor.quote).replace(/\s+/gu, ' ').trim().slice(0, 48);
    // a side chat is a quick margin question: the parent's model on the fast path at low effort
    const settings = { ...($state.snapshot(conversation?.settings) || {}), fastMode: true, reasoningEffort: 'low' };
    session.fork(id, { parentId: conversationId, title: `↳ ${label}`, sidechat: anchor, settings });
    const leaving = rail.focused;
    focusThreadNow(id);
    if (leaving && leaving !== id) discardIfAbandoned(leaving);
    globalThis.getSelection?.()?.removeAllRanges();
    return id;
  }

  let selection = $state(null);
  // Icons only (Quote, Sidechat, Fork) at 36px each plus the pill's padding.
  const PILL_WIDTH = 124 + 4 * 18 + 36 + 7;
  const PILL_HEIGHT = 44;
  const touchScreen = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(hover: none)')?.matches);

  function refreshSelection() {
    // Gesture off: a selection is for copying, nothing floats over it. See SELECT_GESTURES.
    if (!SELECT_PILL) { if (selection) selection = null; return; }
    const scroller = transcriptEl();
    const anchor = scroller ? selectedAnchor() : null;
    if (!anchor) { if (selection) selection = null; return; }

    // On a phone the pill docks at the bottom of the screen, as the reader's does, clear of the
    // iOS Copy/Look Up callout; it needs no coordinates.
    // It stands just above whatever already floats at the foot of the screen (the composer, the
    // nav pill, the new-chat button), never over the message box.
    if (touchScreen()) {
      const floor = Math.min(globalThis.innerHeight, ...[...document.querySelectorAll('[data-testid="composer"], [data-testid="nav-pill"], [data-testid="new-chat"]')]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.height > 0 && r.top > globalThis.innerHeight / 2)
        .map((r) => r.top));
      selection = { anchor, docked: true, dockBottom: Math.round(globalThis.innerHeight - floor + 10), top: 0, left: 0 };
      return;
    }

    // On a desktop it sits just past the selection's last character, level with that line, so the
    // pointer barely moves to reach it.
    const range = globalThis.getSelection().getRangeAt(0);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    const end = rects.at(-1) || range.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    const mid = Math.round((end.top + end.bottom) / 2 - box.top + scroller.scrollTop);
    selection = {
      anchor,
      docked: false,
      top: Math.max(0, mid - PILL_HEIGHT / 2),
      left: Math.max(0, Math.min(
        Math.round(end.right - box.left) + 8,
        scroller.clientWidth - PILL_WIDTH - 4))
    };
  }

  
  function selectionInTranscript() {
    if (!SELECT_GESTURES) return false;
    const current = globalThis.getSelection?.();
    if (!current || current.isCollapsed || !current.rangeCount) return false;
    const transcript = transcriptEl();
    return Boolean(transcript && transcript.contains(current.getRangeAt(0).startContainer));
  }

  






















  $effect(() => {
    if (typeof document === 'undefined') return;
    let frame = 0;
    const onchange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refreshSelection);
    };
    // While the button is down the selection is still being dragged out: the pill waits for the
    // release instead of flickering in and out under the pointer on every selectionchange.
    let dragging = false;
    const down = (event) => {
      if (event.button !== 0 || event.target?.closest?.('[data-sidechat], [data-reader-pop]')) return;
      if (!transcriptEl()?.contains(event.target)) return;
      dragging = true;
      if (selection) selection = null;
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refreshSelection);
    };
    // Pressing on already-selected text starts the browser's text drag, which floats a ghost copy
    // of the selection under the pointer (the doubled text in the recording); nothing here takes
    // a dropped passage, so a drag that starts on text is cancelled.
    const dragstart = (event) => {
      if (transcriptEl()?.contains(event.target) && !event.target?.closest?.('img, a, [draggable="true"]')) event.preventDefault();
    };
    const wrapped = () => { if (dragging) return; onchange(); };
    document.addEventListener('selectionchange', wrapped);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    document.addEventListener('dragstart', dragstart, true);
    return () => {
      document.removeEventListener('selectionchange', wrapped);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      document.removeEventListener('dragstart', dragstart, true);
      cancelAnimationFrame(frame);
    };
  });

  









  function quoteIntoMain(anchor) {
    if (!anchor) return;
    const scroller = transcriptEl();
    const held = scroller?.scrollTop ?? null;
    composer?.insert(quoteLine(anchor.quote));
    if (scroller && held !== null) restoreScroll(scroller, held);
    globalThis.getSelection?.()?.removeAllRanges();
    selection = null;
  }

  // The reader's gesture, in the transcript. A passage plus a box over it, and what he writes
  // either lands in Notes or goes into this chat as a message.
  const QUICK_WIDTH = 320;
  let quick = $state(null);   // { mode, anchor, quote, top, left, busy, error }

  function openQuick(mode) {
    const open = selection;
    if (!open?.anchor) return;
    const scroller = transcriptEl();
    const room = scroller ? scroller.clientWidth : QUICK_WIDTH;
    // The pill is right-aligned on the selection and 66px wide; the box is wider, so it is
    // placed from the same right edge and then kept inside the pane.
    const left = Math.max(4, Math.min(open.left + PILL_WIDTH - QUICK_WIDTH, room - QUICK_WIDTH - 4));
    quick = {
      mode,
      anchor: open.anchor,
      quote: String(open.anchor.quote || '').replace(/\s+/gu, ' ').trim(),
      top: open.top,
      left,
      text: '',
      busy: false,
      error: null
    };
    selection = null;
    // Focusing the box collapses the browser's selection anyway; dropping it here keeps the
    // transcript's selectionchange handler from reopening the pill underneath the box.
    globalThis.getSelection?.()?.removeAllRanges();
  }

  function closeQuick() {
    quick = null;
    globalThis.getSelection?.()?.removeAllRanges();
  }

  let quickBox = $state(null);
  function growQuick() {
    if (!quickBox) return;
    quickBox.style.height = 'auto';
    quickBox.style.height = `${Math.min(200, Math.max(26, quickBox.scrollHeight))}px`;
  }
  $effect(() => {
    if (!quick || !quickBox) return;
    intent.dispatch('focus', { pane: focusKey, at: { kind: 'note', id: null } });
    growQuick();
  });

  /** The box owns the keyboard while it is open; Escape puts it away, Enter commits. */
  function quickKey(event) {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); closeQuick(); return; }
    if (event.key !== 'Enter' || event.isComposing) { allowBreak = false; return; }
    if (event.shiftKey) { allowBreak = true; return; }   // a deliberate newline, desktop only
    event.preventDefault();
    submitQuick();
  }

  // On a phone the keyboard's checkmark is the way out of this box, and it arrives as a line
  // break on beforeinput rather than as a keydown of Enter, so without this it wrote a newline
  // and he had to reach for the Reply button.
  let allowBreak = false;

  function quickBeforeInput(event) {
    if (event.inputType !== 'insertLineBreak' && event.inputType !== 'insertParagraph') return;
    if (allowBreak) { allowBreak = false; return; }   // Shift+Enter already said newline
    event.preventDefault();
    submitQuick();
  }

  async function submitQuick() {
    const open = quick;
    const text = String(open?.text || '').trim();
    if (!open) return;
    if (!text) { closeQuick(); return; }
    const scroller = transcriptEl();
    // Only hold the view when he is reading back up the transcript. At the end of the chat the
    // ordinary follow should carry him with his own message, as a send always has.
    const held = scroller && !atBottom ? scroller.scrollTop : null;

    if (open.mode === 'reply') {
      send(`${quoteLine(open.anchor.quote)}${text}`);
      quick = null;
      if (scroller && held !== null) restoreScroll(scroller, held);
      return;
    }

    quick = { ...open, busy: true, error: null };
    try {
      await saveChatMark(open.anchor, { kind: 'note', color: open.color || 'yellow', note: text });
      quick = null;
    } catch (cause) {
      quick = { ...open, busy: false, error: cause?.message || 'could not save that note' };
      return;
    }
    if (scroller && held !== null) restoreScroll(scroller, held);
  }

  /** One row in the reader's note store for words in this transcript: a highlight, or a note. */
  async function saveChatMark(anchor, { kind = 'highlight', color = 'yellow', note = '' } = {}) {
    try {
      return await chatNotes.save(chatDoc, {
        docTitle: conversation?.title || 'Chat',
        sectionIdx: 0,
        anchorKey: anchor.itemId,
        kind,
        color,
        quote: anchor.quote,
        start: anchor.start,
        end: anchor.end,
        note
      });
    } catch (cause) {
      throw new Error(`the note store refused it (${cause?.message || cause})`);
    }
  }

  async function highlightSelection(color) {
    const anchor = selection?.anchor ? $state.snapshot(selection.anchor) : null;
    if (!anchor || !chatDoc) return;
    selection = null;
    globalThis.getSelection?.()?.removeAllRanges();
    try { await saveChatMark(anchor, { kind: 'highlight', color }); }
    catch (cause) { console.warn('chat highlight not saved', cause); }
  }

  // --- the notes taken on this transcript ------------------------------------------------------
  // A chat is a document in the reader's store, so these are the same rows a book's notes are,
  // and they are painted by the same module with the same styles. Offsets are counted inside ONE
  // MESSAGE rather than the whole transcript, because the transcript grows underneath a note.

  const chatDoc = $derived(conversationId ? `chat:${conversationId}` : null);
  // The marks live in the kit state (core/chat-notes-state.js): the rows last seen, kept on this device, with the
  // click-to-delete card's open and armed state beside them. Writes go through the reader's op log
  // (client/chat-notes.js), so a highlight or a delete made offline survives a reload and syncs later.
  const chatNotesStore = uiApp().use(chatNotesDecl);
  const replica = typeof window === 'undefined' ? null : readerReplica();
  const noReplica = { api: async () => ({}), writeNote: async () => { throw new Error('the reader store is not available here'); }, deleteNote: async () => ({ queued: true }), flush: async () => {} };
  const chatNotes = createChatNotes({ store: chatNotesStore, replica: replica || noReplica, flush: () => (replica || noReplica).flush() });
  const paneKey = Math.random().toString(36).slice(2);
  const notes = $derived(notesOf($chatNotesStore, chatDoc));
  let notesFor = null;

  $effect(() => {
    const doc = chatDoc;
    if (!doc || notesFor === doc) return;
    notesFor = doc;
    chatNotes.load(doc);
  });

  $effect(() => {
    if (typeof window === 'undefined') return;
    return chatNotes.follow(() => (chatDoc ? [chatDoc] : []));
  });

  // The card opened on one painted mark (kit state `peek`); this pane shows it only when this pane opened it.
  const peekHere = $derived($chatNotesStore.peek?.pane === paneKey && $chatNotesStore.peek?.doc === chatDoc ? $chatNotesStore.peek : null);
  const peekNote = $derived(peekHere ? notes.find((n) => n.id === peekHere.id) || null : null);
  let painted = [];

  function closePeek() { chatNotesStore.dispatch('peek.close'); }

  /** Click on words that carry a mark: open its card. Returns true when it did. */
  function peekAt(event) {
    if (!chatDoc || event.button > 0) return false;
    if (event.target?.closest?.('a[href], button, summary, input, textarea, [data-sidechat]')) return false;
    const hit = markHit(painted, event.clientX, event.clientY);
    if (!hit) return false;
    // Centred on the click, pulled back inside the transcript so it never hangs over the sidebar or the rail, and
    // above or below the clicked line (never over it) on whichever side has room.
    const box = transcriptEl()?.getBoundingClientRect();
    const half = Math.min(280, (box?.width ?? 400) - 16) / 2;
    const x = box ? Math.max(box.left + 8 + half, Math.min(box.right - 8 - half, event.clientX)) : event.clientX;
    const side = cardSide(hit.rect, box || { top: 0, bottom: globalThis.innerHeight });
    chatNotesStore.dispatch('peek.open', { pane: paneKey, doc: chatDoc, id: hit.id, x: Math.round(x), y: Math.round(side.y), below: side.below });
    return true;
  }

  function pressDelete() {
    const id = peekNote?.id;
    if (!id) return;
    if (deletePress($chatNotesStore, id) === 'arm') { chatNotesStore.dispatch('delete.arm', { id }); return; }
    chatNotes.remove(chatDoc, id);
  }

  // A first press that is not followed through lapses on its own, so Delete is never left armed behind him.
  $effect(() => {
    const id = $chatNotesStore.armed;
    if (!id) return;
    const timer = setTimeout(() => chatNotesStore.dispatch('delete.disarm'), 4000);
    return () => clearTimeout(timer);
  });

  // While the card is open: Escape, a press anywhere outside it, or scrolling the transcript puts it away.
  $effect(() => {
    if (!peekHere) return;
    const key = (event) => { if (event.key === 'Escape') { event.stopPropagation(); closePeek(); } };
    const away = (event) => { if (!event.target?.closest?.('[data-testid="chat-mark-peek"]')) closePeek(); };
    const scroller = transcriptEl();
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', away, true);
    scroller?.addEventListener('scroll', closePeek, { passive: true });
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', away, true);
      scroller?.removeEventListener('scroll', closePeek);
    };
  });

  /**
   * Put the marks back on the words. A note names its message by item id and its words by an
   * offset into that message's text, so each one is resolved inside its own row; resolveAnchor
   * finds the quote again when the row's text has shifted, and a note whose row is not rendered
   * simply is not painted this pass.
   */
  function repaintNotes() {
    const scroller = transcriptEl();
    if (!scroller) return;
    const groups = emptyGroups();
    const hits = [];
    for (const note of notes) {
      if (!note.anchorKey) continue;
      const row = scroller.querySelector(`[data-item="${CSS.escape(note.anchorKey)}"]`);
      if (!row) continue;
      const resolved = resolveChatAnchor({ quote: note.quote, start: note.start }, row.textContent || '');
      if (resolved.state === 'orphaned') continue;
      const index = textIndex(row);
      const range = rangeFor(index, resolved.start, resolved.end);
      if (!range) continue;
      hits.push({ id: note.id, range });
      const colour = `reader-${note.color || 'yellow'}`;
      (groups.get(colour) || groups.get('reader-yellow')).push(range);
      if (note.note) groups.get('reader-note').push(range);
      if (note.author === 'tophat') groups.get('reader-tophat').push(range);
    }
    painted = hits;
    paintRanges(groups);
  }

  $effect(() => {
    notes; items;                                   // repaint when either the marks or the rows move
    if (typeof window === 'undefined') return;
    const frame = requestAnimationFrame(repaintNotes);
    return () => cancelAnimationFrame(frame);
  });

  















  function restoreScroll(scroller, held) {
    const put = () => { if (scroller.scrollTop !== held) scroller.scrollTop = held; };
    scroller.style.overflowAnchor = 'none';
    const observer = new ResizeObserver(put);
    observer.observe(scroller);
    const done = () => {
      observer.disconnect();
      scroller.style.overflowAnchor = '';
      for (const type of ['wheel', 'touchstart', 'pointerdown']) scroller.removeEventListener(type, done);
    };
    for (const type of ['wheel', 'touchstart', 'pointerdown']) scroller.addEventListener(type, done, { passive: true });
    setTimeout(done, 500);
    tick().then(() => {
      put();
      requestAnimationFrame(() => {
        put();
        requestAnimationFrame(put);
      });
    });
  }

  













  function discardIfAbandoned(id) {
    if (!id) return false;
    const thread = threads.find((other) => other.id === id);
    if (!thread) return false;
    if (!isAbandoned(thread, { turns: conversationItems(chatState, id), draft: readDraft(id) })) return false;
    writeDraft(id, '');
    session.archive(id, true);
    return true;
  }

  function focusThreadAt(x, y) {
    const id = railRef?.threadAtPoint(x, y);
    if (!id) return false;
    focusThreadNow(id);
    return true;
  }

  function transcriptClick(event) {
    if (event.detail >= 3) cancelPendingThread();
    const selection = globalThis.getSelection?.();
    if (selection && !selection.isCollapsed) return;
    if (peekAt(event)) return;
    if (focusThreadAt(event.clientX, event.clientY)) return;
    // A press outside the card is a `press` on the intent record (its pointerdown listener), which takes the thread's focus away.
  }

  






  // Leaving a thread INSIDE this pane (a press on the transcript, another box focused) discards one he opened and never wrote in,
  // as it always did (the old leaveThread). Focus moving to another pane or out of every pane takes the colour away and nothing else:
  // the card stays where it is.
  let lastThread = null;
  $effect(() => {
    const now = focusedThread;
    const before = lastThread;
    lastThread = now;
    if (!before || before === now) return;
    const here = untrack(() => $intent);
    if (here.pane === focusKey && here.at && here.at.kind !== 'chrome') untrack(() => discardIfAbandoned(before));
  });

  function dismissThread(id) {
    if (!discardIfAbandoned(id)) sideDo('thread.collapse', { id });
    globalThis.getSelection?.()?.removeAllRanges();
    selection = null;
    // Putting a thread away hands the caret to the composer: one transition, applied by the kit's effect once the card is gone.
    intent.dispatch('blurThread', { pane: focusKey, id });
  }

  const TRIPLE_CLICK_MS = 450;
  let openTimer = 0;
  let opened = null;

  function cancelPendingThread() {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = 0;
    }
    if (!opened) return;
    const stale = Date.now() - opened.at > TRIPLE_CLICK_MS * 3;
    const id = opened.id;
    opened = null;
    if (stale) return;
    if (String(readDraft(id) ?? '').trim()) return;
    if (conversationItems(chatState, id).some((item) => item?.type === 'user' && String(item.text ?? '').trim())) return;
    if (rail.focused === id) intent.dispatch('blurThread', { pane: focusKey, id });
    writeDraft(id, '');
    session.archive(id, true);
  }

  function transcriptDblClick(event) {
    if (!SELECT_GESTURES) return;
    if (focusThreadAt(event.clientX, event.clientY)) return;
    const anchor = anchorFromBlock(event.target);
    if (!anchor) return;
    cancelPendingThread();
    openTimer = setTimeout(() => {
      openTimer = 0;
      const id = openThread(anchor);
      opened = id ? { id, at: Date.now() } : null;
    }, TRIPLE_CLICK_MS);
  }

  // `hovered` is still what the rail's comment button points at: he can put the pointer on a
  // paragraph and press the button with no other ceremony. It no longer arms the keyboard.
  function transcriptPointerMove(event) {
    const row = rowOf(event.target);
    const block = row ? blockAt(row, event.target) : null;
    if (block !== hovered) hovered = block;
  }

  function composerIsEmpty() {
    return !readDraft(conversationId).trim();
  }

  // A browser extension's overlay lives in a shadow root, so its input reaches us retargeted to the host element; look inside.
  function typingInAField(target) {
    let el = target;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el instanceof HTMLElement
      && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  function paneKeydown(event) {
    if (!primary || !conversationId) return;
    if (isMacTextBinding(event)) return;
    // The selection box owns the keyboard while it is open; it stops its own keys, so anything
    // arriving here came from outside it and must not open a second surface over it.
    if (quick) { if (event.key === 'Escape') { event.preventDefault(); closeQuick(); } return; }

    const onPassage = selectionInTranscript();
    const focused = globalThis.document?.activeElement;
    const focusedEmpty = !String(focused?.value || '').trim();
    const inField = typingInAField(event.target) && !(onPassage && focusedEmpty);

    if (event.key === 'Enter' && event.shiftKey && !isMod(event) && (onPassage || !inField)) {
      const anchor = anchorFromSelection();
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      openThread(anchor);
      return;
    }

    if (event.key === 'Enter' && isMod(event) && !event.shiftKey && (onPassage || !inField)) {
      const anchor = anchorFromSelection();
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      quoteIntoMain(anchor);
      return;
    }

  }

  $effect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', paneKeydown, true);
    return () => window.removeEventListener('keydown', paneKeydown, true);
  });

  const conversation = $derived(chatState.conversations[conversationId] || null);
  const items = $derived(conversationId ? conversationItems(chatState, conversationId) : []);

  // The four failure states the session publishes and nothing used to read.
  //
  // Re-send puts it back in the composer -- `session` has no method that re-dispatches a stored
  // action, and the entry keeps no payload beyond `text`, so restoring the draft is the one
  // move that loses nothing -- and Discard is his to make. Both are remembered here, per pane,
  // because the session exposes no way to clear an entry off `status.rejected`.
  let dismissedRejects = $state([]);
  const refused = $derived(rejectedFor(status?.rejected, conversationId, dismissedRejects));
  const retrying = $derived(retryingNote(status));
  const transcriptDown = $derived(transcriptFailed(status, conversation));

  function resendRejected(entry) {
    dismissedRejects = dismiss(dismissedRejects, entry);
    // `Composer.insert` appends to whatever is already in the draft rather than replacing it,
    // so a refusal answered while he is mid-sentence costs him neither text.
    if (entry.text) composer?.insert(entry.text);
    focusComposerNow();
  }

  function discardRejected(entry) {
    dismissedRejects = dismiss(dismissedRejects, entry);
  }

  // Find and select-all cover the whole chat, not only the newest page it opened with, so the earlier pages are fetched
  // first. False when the server could not give all of them (offline, an error): what is loaded is then all they cover.
  async function loadWholeChat(id, wanted) {
    for (let more = session.canLoadEarlier?.(id); more && wanted(); ) {
      const page = await session.loadEarlier(id);
      if (page.offline || (page.more && !page.loaded)) return false;
      more = page.more;
    }
    return true;
  }
  const hydratedChat = $derived(Boolean(conversation?.hydrated));
  $effect(() => {
    if (!finding || !hydratedChat) return;
    const id = conversationId;
    let wanted = true;
    // Find covers the whole chat: the earlier pages are fetched first, the status in the store.
    untrack(() => findStore.dispatch('find.status', { chat: id, status: 'loading' }));
    loadWholeChat(id, () => wanted).then((whole) => {
      if (!wanted) return;
      findStore.dispatch('find.status', { chat: id, status: whole ? 'whole' : 'partial' });
    });
    return () => { wanted = false; if (findStore.get().status[id] === 'loading') findStore.dispatch('find.status', { chat: id, status: null }); };
  });

  // A match inside a tool call, a subagent or a thinking block is shown, not just the header it folds under: its card
  // opens through the fold store (disclosure.svelte.js), as a click would, and stays open.
  const FOLD_OF = { tool: 'card', agent: 'agent', thinking: 'thinking' };
  function showMatch(match) {
    if (!match) { highlightItemId = null; return; }
    const item = items.find((entry) => entry.id === match.itemId);
    for (const [kind, id] of [['agent', item?.agentId], [FOLD_OF[item?.type], item?.id]]) {
      if (kind && id && !isOpen(conversationId, kind, id)) toggleOpen(conversationId, kind, id);
    }
    highlightItemId = item?.agentId || match.itemId;
    scrollToItemId = highlightItemId;
  }

  let jumpedSeq = $state(0);
  $effect(() => {
    if (!jump || jump.conversationId !== conversationId || jump.seq === jumpedSeq) return;
    const item = items.find((row) => row.cursor === jump.cursor);
    if (!item) return;
    jumpedSeq = jump.seq;
    highlightItemId = item.id;
    scrollToItemId = item.id;
  });
  const forks = $derived(conversationId ? forksOf(chatState, conversationId) : []);
  const running = $derived(['queued', 'starting', 'thinking', 'running'].includes(conversation?.runState));
  const pending = $derived(Boolean(conversation?.awaitingFirstToken));
  $effect(() => {
    if (!atBottom || !conversationId || !unreadOf(conversation)) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    session?.markRead?.(conversationId, true, { mute: false });
  });

  // The strip's clock counts the whole stretch of work, from where the agent
  // last stopped, not the gap since the newest item: a correction he sends
  // mid-turn, and every event a subagent forwards, is a newer item and used to
  // restart the number at zero. `busyStretch` is the reducer and its comment
  // carries the reason; the row's own `runSince`, computed from the run's
  // events and persisted by the server, is what survives a reload.
  const lastEventAt = $derived(items.at(-1)?.at ?? null);
  const stretchAt = $derived(conversation?.runSince ?? lastEventAt);
  const agentIsLive = $derived(isLive({
    online: status?.online !== false,
    connected: Boolean(status?.connected),
    runState: conversation?.runState || 'idle'
  }));
  let busy = $state({ conversationId: null, at: null, restingSince: null });
  $effect(() => {
    const input = { conversationId, live: agentIsLive, at: stretchAt };
    untrack(() => {
      const next = busyStretch(busy, input);
      if (next.conversationId !== busy.conversationId || next.at !== busy.at || next.restingSince !== busy.restingSince) busy = next;
    });
  });
  const activity = $derived({
    online: status?.online !== false,
    connected: Boolean(status?.connected),
    runState: conversation?.runState || 'idle',
    awaitingFirstToken: pending,
    linked: Boolean(conversation?.linked),
    since: (busy.conversationId === conversationId ? busy.at : null) ?? stretchAt,
    maintenance: Boolean(conversation?.maintenance),
    noteAt: conversation?.noteAt || null
  });

  const note = $derived(conversation?.note || null);
  const noteAt = $derived(conversation?.noteAt || null);

  const uploadRefs = (attachments) => attachments.map((a) => ({ id: a.key, name: a.name, size: a.size }));

  let uploadProgress = $state({});
  let uploadFailures = $state([]);

  const waitingUploads = $derived.by(() => {
    const held = (status?.waitingUploads?.[conversationId] || []).map((file) => {
      const seen = uploadProgress[file.id];
      const total = Number(seen?.total) || Number(file.size) || 0;
      const loaded = Math.max(0, Math.min(total, Number(seen?.loaded) || 0));
      return { id: file.id, name: file.name || seen?.name || 'file', percent: total ? Math.floor((loaded / total) * 100) : null, failed: false };
    });
    return [...uploadFailures, ...held.filter((file) => !uploadFailures.some((bad) => bad.id === file.id))];
  });

  function send(text, attachments = []) {
    onengage();
    uploadFailures = [];
    onboard('message.sent', { chat: conversationId, n: (conversation?.turns || 0) + 1 });
    session.send(conversationId, text, uploadRefs(attachments));
    // The agent he just worked with is the one his next new chat opens on.
    rememberAgent(conversation?.settings);
    dictation?.noteSent(text);
  }

  function forkSend(text, attachments = [], { split = false } = {}) {
    onengage();
    const id = fork(null, { beside: split });
    uploadFailures = [];
    onboard('chat.created', { chat: id, split });
    onboard('message.sent', { chat: id, n: 1 });
    session.send(id, text, uploadRefs(attachments));
    dictation?.noteSent(text);
  }

  // The pill's Fork: a whole fork of the chat through the message the passage is in, with the
  // passage quoted into the new chat's composer. The fork is renamed from the first message he
  // sends in it (store.js, message.user), not left as "<parent> ↳".
  function forkFromSelection(anchor) {
    if (!anchor || !conversationId) return;
    anchor = $state.snapshot(anchor);
    const item = items.find((entry) => entry?.id === anchor.itemId);
    globalThis.getSelection?.()?.removeAllRanges();
    selection = null;
    const id = session.newConversationId();
    writeDraft(id, quoteLine(anchor.quote));
    session.fork(id, {
      parentId: conversationId,
      forkedFromCursor: item?.cursor ?? null,
      title: `${conversation?.title || 'Chat'} ↳`
    });
    onselect(id);
  }

  function fork(fromItem = null, { beside = false } = {}) {
    const id = session.newConversationId();
    session.fork(id, {
      parentId: conversationId,
      forkedFromCursor: fromItem?.cursor ?? null,
      title: `${conversation?.title || 'Chat'} ↳`
    });
    if (beside && onforkopen) onforkopen(id, { split: beside });
    else onselect(id);
    return id;
  }

  let voiceOrb = $state(null);
  let dictation = $state(null);
  // An incognito chat (core/incognito.js) has no dictation and no voice mode: both keep audio and text on disk.
  const incognito = $derived(isIncognito(conversationId));
  let armTimer = null;
  let inputProvenance = $state(null);
  let provenanceAsked = false;
  $effect(() => {
    if (provenanceAsked) return;
    provenanceAsked = true;
    (async () => {
      try {
        const res = await fetch('/api/dictation/provenance');
        if (!res.ok) return;
        const flag = await res.json();
        if (!flag?.enabled) return;
        inputProvenance = createInputProvenance({
          sessionId: new Date().toISOString().replace(/[:.]/gu, '-'),
          conversationId: () => conversationId
        });
      } catch {  }
    })();
  });
  // Voice preferences are declared once (core/prefs-state.js) and hydrated before this component's first render.
  const prefs = uiApp().use(prefsDecl);

  export function openFind() { setFinding(true); }
  export function focusComposer() { focusComposerNow(); }
  /** ⌘A away from a text field: this chat's whole transcript, rather than everything on the page (tophat-md/tophat#5). */
  export async function selectTranscript() {
    const id = conversationId;
    await loadWholeChat(id, () => id === conversationId);
    await tick();
    const column = paneEl?.querySelector('[data-testid="transcript"] .column');
    if (!column || id !== conversationId) return;
    const range = document.createRange();
    range.selectNodeContents(column);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  }
  // Ctrl-Shift-U / Ctrl-Shift-D: half a screen up or down, wherever the keyboard is (tophat-md/tophat#4).
  export function scrollTranscript(direction) {
    const scroller = transcriptEl();
    scroller?.scrollBy({ top: direction * scroller.clientHeight / 2 });
  }
  // Ctrl-C on a Mac: the Stop button, when there is a turn to stop.
  export function stop() {
    if (!running) return false;
    session.interrupt(conversationId);
    return true;
  }
  
  export function openVoice() { voiceOrb?.openFromTap(); }

  export function pushToTalkDown(event) {
    if (!dictation?.available?.()) return 'pass';
    const context = contextFor(event.target, {
      composer: composer?.textField?.() ?? null,
      draft: composer?.draftText?.() ?? '',
      recording: dictation.isRecording(),
      pending: composer?.spacePending?.() ?? false
    });
    const decision = pushToTalkDecision(event, context);
    if (decision === 'start') dictation.holdStart({ fromComposer: context.ownComposer });
    if (decision === 'arm') {
      composer?.holdSpace?.();
      clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armTimer = null;
        if (!composer?.spacePending?.()) return;
        if (dictation?.holdStart?.({ fromComposer: true })) composer.dropSpace();
        else composer.flushSpace();
      }, HOLD_ARM_MS);
    }
    return decision;
  }

  







  export function pushToTalkOther() {
    if (interruptAction({ pending: composer?.spacePending?.() ?? false }) !== 'flush') return false;
    clearTimeout(armTimer);
    armTimer = null;
    return Boolean(composer?.flushSpace?.());
  }

  





  export function pushToTalkUp() {
    const action = releaseAction({
      pending: composer?.spacePending?.() ?? false,
      recording: dictation?.isRecording?.() ?? false
    });
    clearTimeout(armTimer);
    armTimer = null;
    if (action === 'type_space') return Boolean(composer?.flushSpace?.());
    return dictation?.holdStop?.() ?? false;
  }
  $effect(() => () => { clearTimeout(armTimer); armTimer = null; });

  export function attachFiles(files) { composer?.acceptFiles(files); }
  export function stagedUploads() { return composer?.staged() ?? []; }
</script>

{#snippet dictateControl()}
  <DictationMic
    bind:this={dictation}
    {conversationId}
    onbegin={(token, options) => composer?.dictateBegin(token, options)}
    onpartial={(token, text) => composer?.dictatePartial(token, text)}
    oncommit={(token, text, options) => composer?.dictateCommit(token, text, options)}
    onextend={(token, text) => composer?.dictateExtend(token, text)}
    onwords={(token, info) => composer?.dictateWords(token, info)}
    oncancel={(token) => composer?.dictateCancel(token)}
    onmeasurement={(type, detail) => composer?.measure(type, detail)}
    onpermission={() => inputProvenance?.recordDevices?.()}
  />
{/snippet}

{#snippet railSlot()}
  <SideThreads
    bind:this={railRef}
    {session}
    {chatState}
    {threads}
    focusedId={rail.focused}
    collapsed={rail.collapsed}
    wide={wideEnough}
    {railWidth}
    {highlights}
    hoverBlock={hovered}
    oncomment={() => openThread(anchorFromBlock(hovered))}
    {selection}
    {quick}
    onquote={() => quoteIntoMain(selection?.anchor)}
    onsidethread={() => { const anchor = selection?.anchor; selection = null; openThread(anchor); }}
    onforkselection={() => forkFromSelection(selection?.anchor)}
    onnote={() => openQuick('note')}
    onhighlight={highlightSelection}
    onreply={() => openQuick('reply')}
    onquicksubmit={submitQuick}
    onquickcancel={closeQuick}
    onquickvalue={(text) => { if (quick) quick = { ...quick, text }; growQuick(); }}
    onquickkey={quickKey}
    onquickbeforeinput={quickBeforeInput}
    onquickbox={(el) => (quickBox = el)}
    oncollapse={(id) => dismissThread(id)}
    {onnewchat}
  />
{/snippet}


<section
  class="pane"
  data-focus-pane={focusKey}
  class:secondary={!primary}
  bind:this={paneEl}
  bind:clientWidth={paneWidth}
  onpointerdowncapture={onfocus}
  data-testid={primary ? 'pane-primary' : 'pane-secondary'}
>
  <ChatHeader
    {conversation}
    forkCount={forks.length}
    dim={!primary}
    {pane}
    {onpane}
    {onclosepane}
    onfind={() => setFinding(!finding)}
    onfork={() => fork(null)}
    onsettings={(patch) => {
      const next = { ...conversation?.settings, ...patch };
      session.settings(conversationId, next);
      rememberAgent(next);
    }}
    onrename={(title) => session.rename(conversationId, title)}
    onhost={(host) => session.setHost(conversationId, host)}
    onmovescope={(to, opts) => session.moveScope(conversationId, to, { ...opts, from: conversation?.scope ?? null })}
  />

  <div class="body">
    {#if finding}
      <FindBar
        {items}
        tools={$prefs.find.tools}
        loading={findStatus === 'loading'}
        partial={findStatus === 'partial'}
        query={$findStore.query[conversationId] ?? ''}
        index={$findStore.index[conversationId] ?? 0}
        onquery={(text) => findStore.dispatch('find.query', { chat: conversationId, text })}
        onindex={(index) => findStore.dispatch('find.index', { chat: conversationId, index })}
        ontools={(tools) => prefs.dispatch('find.set', { tools })}
        onjump={showMatch}
        onclose={() => { setFinding(false); highlightItemId = null; }}
      />
    {/if}
    
    <div
      class="reading"
      data-focus-at="transcript"
      onclick={transcriptClick}
      ondblclick={transcriptDblClick}
      onpointermove={transcriptPointerMove}
      onpointerleave={() => (hovered = null)}
    >
      
      <SkippedNotice count={status?.skipped || 0} reason={status?.skipReason || ''} />

      
      {#if notes.length}
        <button class="noteschip press focus-ring" onclick={() => (notesOpen = !notesOpen)}
                data-testid="chat-notes-chip" aria-expanded={notesOpen}>
          {notes.length} note{notes.length === 1 ? '' : 's'}
        </button>
      {/if}
      {#if notesOpen && notes.length}
        <div class="notespanel" data-sidechat data-testid="chat-notes-panel">
          {#each notes as note (note.id)}
            <button class="noterow" onclick={() => {
              notesOpen = false;
              if (!note.anchorKey) return;
              highlightItemId = note.anchorKey;
              scrollToItemId = note.anchorKey;
            }}>
              <span class="nquote">{note.quote}</span>
              {#if note.note}<span class="nbody">{note.note}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
      {#if peekHere && peekNote}
        <div class="markpeek" class:below={peekHere.below} data-sidechat data-testid="chat-mark-peek"
             style:left={`${peekHere.x}px`} style:top={`${peekHere.y}px`} role="dialog" aria-label="Highlight">
          <span class="nquote" data-testid="chat-mark-quote">{peekNote.quote}</span>
          {#if peekNote.note}<span class="nbody">{peekNote.note}</span>{/if}
          <div class="peekrow">
            <button class="press focus-ring" onclick={closePeek} data-testid="chat-mark-close">Close</button>
            <button class="danger press focus-ring" class:armed={$chatNotesStore.armed === peekNote.id}
                    onclick={pressDelete} data-testid="chat-mark-delete">
              {$chatNotesStore.armed === peekNote.id ? 'Delete?' : 'Delete'}
            </button>
          </div>
        </div>
      {/if}
      {#if transcriptDown}
        
        <TranscriptError message={status.transcriptError} onretry={() => session.hydrate(conversationId)} />
      {:else}
      <Transcript
        {items}
        {running}
        loading={Boolean(conversation) && !conversation.hydrated}
        {conversationId}
        {onpath}
        onfork={fork}
        {highlightItemId}
        {scrollToItemId}
        rail={railSlot}
        {railOpen}
        {railWidth}
        onAtBottom={(v) => { measuredBottom = v; bottomOf = conversationId; }}
        canLoadEarlier={() => session.canLoadEarlier(conversationId)}
        onLoadEarlier={() => session.loadEarlier(conversationId)}
        {activity}
      />
      {/if}
    </div>

    {#if sheet}
      
      <div class="sheet" data-testid="sidechat-sheet">
        <SideThread
          {session}
          {chatState}
          thread={sheet}
          focused
          oncollapse={() => dismissThread(sheet.id)}
          {onnewchat}
        />
      </div>
    {/if}
  </div>

  {#if dropping}
    
    <div class="dropping" data-testid="drop-overlay" aria-hidden="true">
      <span>Drop to attach</span>
    </div>
  {/if}

  <div class="chrome" bind:this={chromeEl}>
  
  <RejectedNotice entries={refused} onresend={resendRejected} ondiscard={discardRejected} />
  
  <RetryNotice note={retrying} />
  <Composer
    bind:this={composer}
    dropZone={paneEl}
    ondragfiles={(active) => (dropping = active)}
    onsend={send}
    onsubmit={() => dictation?.holdStop({ send: true })}
    onstage={(key) => session.stageUpload(key)}
    onuploadfail={(key, { name, error }) => {
      session.failUpload(key, error);
      uploadFailures = [...uploadFailures.filter((file) => file.id !== key), { id: key, name, percent: null, failed: true, error }];
    }}
    onuploadprogress={(key, info) => {
      const { [key]: _gone, ...rest } = uploadProgress;
      uploadProgress = info.state === 'ready' || info.state === 'failed' ? rest : { ...rest, [key]: info };
    }}
    waiting={waitingUploads}
    onforksend={forkSend}
    {onnewchat}
    oninterrupt={() => session.interrupt(conversationId)}
    {running}
    {pending}
    {note}
    {noteAt}
    {autofocus}
    draftKey={conversationId}
    ondraft={() => { onengage(); session?.commitProvisional?.(conversationId); }}
    queued={status.unsentByConversation ? (status.unsentByConversation[conversationId] || 0) : (status.unsentMessages ?? status.queued ?? 0)}
    online={status.online !== false && !status.offline}
    placeholder={running ? 'Correct it mid-run…' : 'Message…'}
    dictate={incognito ? null : dictateControl}
    provenance={inputProvenance}
  />
  </div>

  {#if !incognito}
  <VoiceOrb
    bind:this={voiceOrb}
    {items}
    {running}
    onsend={send}
    speed={$prefs.voice.speed}
    handsFree={$prefs.voice.handsFree}
    onsettings={(change) => prefs.dispatch('voice.set', change)}
    onclosed={focusComposerNow}
  />
  {/if}
</section>

<style>
  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
    
    border-left: 1px solid transparent;
  }
  .secondary { border-left-color: var(--line-soft); }
  .dropping {
    position: absolute;
    inset: 0;
    z-index: 6;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 2px dashed color-mix(in srgb, var(--accent) 55%, transparent);
    border-radius: 10px;
  }
  .dropping span {
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 13px;
    color: var(--ink-dim);
  }
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
  
  .chrome { flex: none; display: flex; flex-direction: column; }
  .reading { flex: 1; min-height: 0; display: flex; flex-direction: column; }

  .sheet {
    position: absolute;
    left: 10px; right: 10px; bottom: 10px;
    z-index: 6;
  }
  
  .noteschip {
    position: absolute; top: 6px; right: 10px; z-index: 7;
    border: 1px solid var(--line); border-radius: 999px;
    padding: 3px 10px; font-size: 11.5px;
    background: var(--bg-raised); color: var(--ink-faint);
  }
  .noteschip:hover { color: var(--ink-dim); }
  .notespanel {
    position: absolute; top: 34px; right: 10px; z-index: 9;
    width: min(320px, calc(100% - 20px));
    max-height: 50%; overflow-y: auto;
    display: flex; flex-direction: column; gap: 2px;
    padding: 6px;
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 14px 34px rgba(0,0,0,0.26);
  }
  .noterow {
    display: flex; flex-direction: column; gap: 2px; text-align: left;
    border: 0; background: none; border-radius: 8px; padding: 6px 8px; cursor: pointer;
  }
  .noterow:hover { background: var(--accent-soft); }
  .nquote {
    color: var(--ink-faint); font-size: 11.5px; line-height: 1.35;
    padding-left: 6px; border-left: 2px solid var(--line);
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .nbody { color: var(--ink); font-size: 13px; line-height: 1.4; }

  .markpeek {
    position: fixed; z-index: 30; width: min(280px, calc(100vw - 24px));
    transform: translate(-50%, -100%);
    display: flex; flex-direction: column; gap: 8px; padding: 10px;
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 14px 34px rgba(0,0,0,0.26);
  }
  .markpeek.below { transform: translate(-50%, 0); }
  .peekrow { display: flex; justify-content: flex-end; gap: 6px; }
  .peekrow button {
    border: 1px solid var(--line); border-radius: 8px; padding: 4px 12px; font-size: 12.5px;
    background: none; color: var(--ink-dim); cursor: pointer;
  }
  .peekrow button:hover { color: var(--ink); }
  .peekrow .danger { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .peekrow .danger.armed { background: var(--warn); border-color: var(--warn); color: #fff; }

  :global(::highlight(sidechat)) {
    background-color: color-mix(in srgb, var(--accent) 20%, transparent);
  }
  :global(::highlight(sidechat-focus)) {
    background-color: color-mix(in srgb, var(--accent) 38%, transparent);
  }
</style>
