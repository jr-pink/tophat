<script>
  // The notes editor, shared by his notes (src/routes/notes) and the public documents
  // (src/routes/docs/[token]). With no `doc` prop it is his notes page exactly as it was. With one,
  // it is the same editor over /api/docs/<token>: the same rows, markers, headings, folding, vim,
  // drag, CRDT merge and offline outbox, with what only his notes have switched off (chats, the
  // state area, dictation, the stream, archive to the past, the day rollover) and comments and
  // presence switched on.
  //
  // Notes: one continuous chronological document, the way the reference app's timeline notes work, in the
  // webchat.
  //
  // The page has two zones. Above is the timeline, what has happened, oldest first, ending in the
  // empty note the caret opens in. Below it is the future area: its first block is the today
  // block, his standing scratchpad, and anything under that is further out. Opening the app shows
  // an empty screen with the today block just peeking at the bottom edge; his old writing is one
  // scroll up. ⇧↵ leaves a page break behind and clears the screen again, and ⌘↵ hands the block
  // he is in to a new chat, which stays on the page as a folded chip he can open. Archiving a
  // future block moves it into the timeline with the time it was archived.
  //
  // A block is a chunk separated by two blank lines, so ↵ is a line inside a block and the second
  // blank line ends it. The list behaviour is the reference app's, keystroke for keystroke: Tab indents no
  // deeper than one below the item above and is swallowed either way, ⇧Tab outdents, ↵ on an empty
  // item outdents and then drops the marker, ⌫ at the head does the same before anything merges,
  // and the marker ring is bullet -> todo -> done -> dropped -> bullet. the reference app puts that ring on ⌘↵;
  // here ⌘↵ starts a chat, so the ring is ⌘. and a tap on the marker.
  //
  // Blocks are never re-sorted.
  //
  // What is stored underneath is lines, not blocks: every line has its own id, its own created_at
  // and updated_at, its own order and its own soft delete, and a block is the run of lines up to
  // the gap two blank lines leave. So the gutter tick on a row is the first line's own time, and
  // ⌥↑ / ⌥↓ move the line the caret is on -- inside the block, and out of it into the block above
  // or below.

  import { notesDay } from '$lib/core/notes-time.js';
  import { onMount, tick } from 'svelte';
  import { lineDrag } from '$lib/client/notes-drag.js';
  import { treeEnd } from '$lib/core/notes-reorder.js';
  import Nav from '$lib/ui/Nav.svelte';
  import ChatPane from '$lib/ui/ChatPane.svelte';
  import DictationMic from '$lib/services/voice/ui/DictationMic.svelte';
  import NotesBar from '$lib/ui/NotesBar.svelte';
  import NotesStream from '$lib/ui/NotesStream.svelte';
  import DocComments from '$lib/ui/DocComments.svelte';
  import DocCursors from '$lib/ui/DocCursors.svelte';
  import { createSession } from '$lib/client/session.js';
  import { createLiveConnection, liveClientId, liveHeaders, liveSubscribe } from '$lib/client/live.js';
  import {
    HOLD_ARM_MS, interruptAction, isSpaceKey, pushToTalkDecision, releaseAction
  } from '$lib/services/voice/core/pushtotalk.js';
  import { holdModifier } from '$lib/client/hold-modifier.js';
  import { parseInline, serializeInline, toggleInline, replaceInline, visibleOffset, rawOffset, headingLine } from '$lib/client/notes-format.js';
  import { caretStops, currentStop, closestStop } from '$lib/client/notes-geometry.js';
  import { richEditor, inlineView } from '$lib/client/notes-rich-editor.js';
  import { editLines, joinedCreatedAt, splitLines } from '$lib/client/notes-edit.js';
  import { offsetFromPoint, rulerTick } from '$lib/client/notes-dom.js';
  import { enqueueObservation, flushObservations } from '$lib/client/interaction-delivery.js';
  import { readFolds, writeFolds } from '$lib/client/fold-store.js';
  import { installNotesHarness } from '$lib/client/notes-harness.js';
  import { vimKey } from '$lib/core/vim.js';
  import { VIM_STORAGE_KEY, syncVim, vimDrawn, vimLabel, vimNotation } from '$lib/client/notes-vim.js';
  import {
    comparePoints, deleteRange, duplicateLines, homeStop, insertAt, insertLinesAbove, lineOf, linePoint, rangeText, span, wordAround, wordStop
  } from '$lib/client/notes-range.js';
  import { rowClip, rowPastePlan, rowsClipText, wholeRowSpan } from '$lib/client/notes-clip.js';
  import { setNotesCacheScope } from '$lib/client/notes-cache.js';
  import { applyOutbox, baseOf, baseStateOf, forgetOps, markSent, NotesOffline, notFromApp, reachedBack, readOutbox, readSnapshot, readWeek, rebaseOps, rememberOps, replayable, unanswered, writeOutbox, writeSnapshot, writeWeek } from '$lib/client/notes-cache.js';
  import { baseOfBlock, coveredRanges, lineRows as blockLineRows, mergeBlock, mergeDocument, snapshotOf, sortDocument } from '$lib/core/notes-sync.js';
  import { captureCursors, crdtReady, cursorOffsets, editedDoc, newBlockDoc } from '$lib/core/notes-block-doc.js';
  import { loadCrdt } from '$lib/client/notes-crdt-browser.js';
  import { takeEarly } from '$lib/client/early.js';
  import { canArchive, canPageBreak, carriesState, menuItems, zoneCaps } from '$lib/core/notes-zones.js';
  import { backlinkOf, transcludedIds, transclusionBlock } from '$lib/core/notes-stream.js';
  import { forgetMissing, markClosedByHand, retiredRows } from '$lib/client/notes-sticky.js';
  import {
    changedLines, defaultFolds, hiddenUnder, outline, splitScore, stripScores, threadOf
  } from '$lib/client/notes-fold.js';
  import {
    appendOrd, backspaceAtHead, backspaceOnList, caretForColumn, column, cycleAtCaret, splitBlock,
    cycleTodo, deleteAtTail, enter, gutterStamps, indentLine, indentRange, inZone, isBreak, isText, liveBlock,
    insertSpoken, lineAt, lineStamps, moveBlock, newBlockId, newLineId, onFirstLine, onLastLine, ordered, ordBetween, pageBreak,
    parseListItem, presentSlice, sectionOf, serializeListItem, setListState, tailGap, todayBlock, todayGap,
    zoneOf, deferToEnd
  } from '$lib/core/notes-doc.js';

  // How much of what is around the present shows on open: lines of the past above the caret and
  // lines of the future below it. Blank rows, gaps and the NOW/NEXT labels do not count. `doc`: {
  // token, owner, name, title } for a public document, read live (the page owns it as state, so a
  // renamed author is the next write's author). `docBar` is the page's header for it.
  let { doc = null, docBar = null } = $props();
  const API = doc ? `/api/docs/${doc.token}` : '/api/notes';
  setNotesCacheScope(doc ? `doc:${doc.token}` : '');
  const docHeaders = (headers = {}) => (doc
    ? { ...headers, 'x-doc-name': encodeURIComponent(doc.name || ''), 'x-doc-client': liveClientId() }
    : headers);
  // A document is not a timeline: nothing in it goes to a past, so nothing archives.
  const archivable = (zone) => !doc && canArchive(zone);
  let presence = $state([]);
  let docComments = $state(null);
  let docThreads = $state([]);
  const threadsOn = (lineId) => (lineId ? docThreads.filter((thread) => thread.lineId === lineId && !thread.resolvedAt).length : 0);

  const PEEK_LINES = 5;
  const TAIL_LINES = 3;               // empty lines between NOW's last line and the NEXT label
  const SEAM_AT = 0.55;               // where the NOW/NEXT seam sits on landing, as a fraction of the screen

  let blocks = $state([]);
  let earlier = $state(0);            // how much history is above the window
  let later = $state(0);              // how much of the future area is below what is loaded
  let cursors = { pastBefore: null, futureAfter: null };   // where the next page of each side starts
  let hydrated = $state(false);       // the server's own answer has landed over the cached paint
  let focusId = $state(null);         // the block the caret is in; it is the one textarea on screen
  let gutterOpen = $state(null);      // touch only: 'block:line' whose grip and chevron a tap on its gutter brought up
  let scroller = $state(null);
  let flow = $state(null);
  let futureEl = $state(null);
  let loading = $state(true);
  let saving = $state(0);
  let error = $state(null);
  // The server could not be asked (no connection, the tunnel's 502/530 page). Quiet, not an error:
  // the document is on this device and every write is in the outbox until it can go.
  let offline = $state(false);
  let tail = $state(72);              // the room under NOW's last line, above the NEXT label
  let menu = $state(null);            // { id, x, y } the actions on a block he tapped
  let find = $state(null);            // { query, hidden:Set, anchor:id }
  let findBox = $state(null);
  let mic = $state(null);
  let recording = $state(false);
  let partial = $state('');
  let heldSpace = null;               // { id, start, end } the space withheld while a hold is judged
  let armTimer = null;                // the hold's 250ms: past it the space becomes dictation
  let richLineId = $state(null);
  let verticalColumn = null;
  let verticalX = null;
  let caretLine = $state(0);          // which line of the focused block the caret is on

  // A phone has no ⌘, so the floating bar carries one: its cmd segment is held with a thumb (or
  // latched by a tap) while the other hand types, and `onKeydown` counts that state as a ⌘ so the
  // chord takes exactly the path a hardware ⌘ takes. The bar spends a latch itself, on its own
  // window keydown, which runs after this page's.
  const PHONE = 768;                  // the bar's own breakpoint; wider than this is the desktop
  const chords = holdModifier();      // never pressed: this instance stands in for the chord table
  let phone = $state(false);          // whether the bar is on screen at all
  let barHeld = $state(false);        // the bar's cmd, held or latched
  let clipRead = null;                // the clipboard read the bar's own pointer gesture started

  // ⌘↵ hands a block to a chat. The chat machinery is the webchat's own session, created the first
  // time he asks for one rather than on every visit to the notes tab, and the chat lives on the
  // page as a folded chip: open it and the card is a real chat pane, open it again to the right and
  // it is the same pane at full height beside the document. The two surfaces are not merged; the
  // notes document is still the page.
  let chat = $state(null);            // the lazily created session
  let chatStateSnapshot = $state(null);
  let chatStatus = $state(null);
  let cardFor = $state(null);         // block id whose chip is expanded into a card
  let paneChat = $state(null);        // conversation id open as the pane on the right

  // The stream of recent notes: everything he marked up lately in the reader and in chats, in a
  // rail beside the document, with an action that writes one into it. The rail owns its own
  // fetching; the page owns the write, because the write is an ordinary block of the document.
  let streamOpen = $state(false);
  let streamBusy = $state(null);      // the note id being written right now

  // The system state area is the third zone: generated by a builder, edited by hand, and followed
  // here with a held-open poll so a rebuild lands on the page without a reload.
  let repliesAvailable = $state(false);
  let stateHash = $state(null);       // the server's hash of the state zone; the poll's cursor
  let commentFor = $state(null);      // state block whose comment box is open
  let commentText = $state('');
  let commentBox = $state(null);
  let pendingState = null;            // a poll answer not fully applied; held blocks wait for calm

  // Folding is the document's, not the state area's: any line with indented lines under it can
  // fold. The default in the state area is computed from the builder's scores; a fold he sets by
  // hand overrides it and is kept by line id, so a rebuild does not reset what he closed.
  const FOLD_SCOPE = doc ? `doc:${doc.token}` : 'notes';         // the namespace his folds live under in the fold store
  let folds = $state(new Set());      // `shut:<line id>` and `open:<line id>`, his hand only
  let foldAt = 0;                     // when he last toggled one; the motion belongs to that gesture

  // Sticky completion. A task he ticks takes effect at once and stays under his hand until he
  // clicks away, then leaves the active view -- the row keeps its id, its words and its history,
  // and `tasks`/`state read` still answer with it. Only lines HE closed in this session retire;
  // a line that was already done when the page loaded renders exactly as it did before.
  let closedByHand = $state(new Set());
  // The row he closed a moment ago, and what the caret was in when he did it. It is kept on screen
  // until his attention actually moves somewhere else -- a marker tap from across the page is a
  // close with the caret still in another block, and the row must not vanish under the tap itself.
  let pinnedClose = $state(null);
  // Lines whose pin was released by marking something else done while the caret still sat in them:
  // the caret no longer keeps them visible.
  let releasedClose = $state(new Set());

  // An edit or a check-off in the state area is an owner report on the push plane, which is the
  // interpreter. It is debounced by the line and flushed at once on blur and on a marker tap.
  const REPORT_WAIT_MS = 2_500;
  const DOC_TYPING_MS = 30;           // a public document's save delay while typing (live for others)
  const reported = new Map();         // block id -> the lines as the store or the builder last said
  const reportTimers = new Map();     // `<block id>:<line>` -> the debounce for that one line

  const chatTitle = (id) => chatStateSnapshot?.conversations?.[id]?.title || 'chat';

  async function ensureChat() {
    if (chat) return chat;
    const made = createSession({});
    made.subscribe((next, status) => { chatStateSnapshot = next; chatStatus = status; });
    chat = made;
    await made.start({ fullLog: false, hydrate: 4 });
    return made;
  }

  /** ⌘↵ : the block he is in becomes the first message of a new chat. */
  async function askHere(block) {
    const text = (block.body || '').trim();
    if (!text || doc) return;
    const session = await ensureChat();
    const id = session.newConversationId();
    session.create(id, { title: text.split('\n')[0].slice(0, 60) || 'From notes' });
    session.send(id, text);
    put({ id: block.id, chatId: id });
    cardFor = block.id;
    flush();
  }

  /** It is an append into the future area through the same `create` every other block goes through,
   * so nothing of his is edited, the write is journalled like any other, and undo covers it like
   * any other typing.
   *
   * A note on a chat message also sets the block's `chatId`, which is the field the chat chip
   * already reads, so the transcluded block opens that conversation in place. The chip's label is
   * the conversation's title, which only a live session knows, so one is started in the background.
   */
  async function transclude(note) {
    if (!note?.id || streamBusy) return;
    streamBusy = note.id;
    try {
      const draft = transclusionBlock(note, { id: newBlockId() });
      const block = create({ body: draft.body, zone: 'future', source: draft.source });
      if (draft.chatId) {
        put({ id: block.id, chatId: draft.chatId });
        ensureChat().catch(() => {});
      }
      await flush();
      await tick();
      reveal(block._viewId || block.id);
    } catch (cause) {
      error = String(cause.message || cause);
    } finally {
      streamBusy = null;
    }
  }

  /**
   * Bring a block on screen without taking the caret. He is reading the rail, not typing, and
   * focusing the new block would scroll the document out from under his hand and, on a phone,
   * raise the keyboard over the thing he just added.
   */
  function reveal(viewId) {
    const block = blocks.find((entry) => (entry._viewId || entry.id) === viewId);
    const id = block?.id || viewId;
    const row = scroller?.querySelector?.(`[data-block="${globalThis.CSS?.escape ? CSS.escape(id) : id}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // Which notes are already in the document, read off the backlinks the blocks carry, so the rail
  // can say so rather than letting him add the same note twice without noticing.
  const transcluded = $derived(transcludedIds(blocks));

  const past = $derived(inZone(blocks, 'past'));
  const timeline = $derived(inZone(blocks, 'timeline'));
  const future = $derived(inZone(blocks, 'future'));
  const threadChats = $derived(inZone(blocks, 'state').filter(block => block.id.startsWith('thread-chat-')));
  const stateArea = $derived(inZone(blocks, 'state').filter(block => !block.id.startsWith('thread-chat-')));
  /** One rule for every zone. */
  const spentBlock = (block) => isText(block) && lines(block).every((line) => line.retired || line.hidden);
  const standing = (list) => list.filter((block) => !spentBlock(block));
  const liveThreadChats = $derived(standing(threadChats));
  const liveState = $derived(standing(stateArea));
  const today = $derived(todayBlock(blocks));
  const stamps = $derived(gutterStamps(blocks));
  // The gutter is a ruler: each tick says only what changed since the tick above it, and the ticks
  // stay out of sight until the pointer is on their row.
  // Each tick is two parts: the date, which is always on screen, and the time, which is there
  // when the row is under the pointer or holds the caret. Both are always in the layout, so
  // nothing moves when one of them appears.
  const ticks = $derived.by(() => {
    const labels = new Map();
    let previous = null;
    for (const [id, stamp] of stamps) {
      labels.set(id, rulerTick(stamp.at, previous));
      previous = stamp.at;
    }
    return labels;
  });

  // Every line carries its own time, so the ruler is per line rather than per block: quiet until
  // the pointer is on the row, and on screen by itself when the line was written more than a
  // minute after the one above it.
  const lineMarks = $derived(lineStamps(blocks));
  const lineTicks = $derived.by(() => {
    const labels = new Map();
    let previous = null;
    for (const [key, stamp] of lineMarks) {
      labels.set(key, { ...rulerTick(stamp.at, previous), loud: stamp.loud });
      previous = stamp.at;
    }
    return labels;
  });
  const lineTickOf = (id, index) => lineTicks.get(`${id}#${index}`) || null;
  const tickOf = (id) => lineTickOf(id, 0) || ticks.get(id) || { date: '', time: '···', loud: false };
  // The gutter of the row he is typing in follows the caret: the time it shows is the caret's own
  // line, which is the line he is worried about when he has been writing for a while.
  const rowTick = (block) => (
    tickOf(block.id)
  );
  // The first line's tick is the handle's; the rest carry their own in the margin beside them.
  const showLineTick = (block, index) => (index === 0 || !block.body.split('\n')[index]?.trim() ? null : lineTickOf(block.id, index));

  // --- folding -----------------------------------------------------------------------------------

  // A line's own id is what a fold is kept under, so it survives a rebuild that rewrites the text
  // around it; a block whose lines have not come back from the store yet folds under its index.
  const lineKey = (block, index) => block?.lines?.[index]?.id || `${block?.id}#${index}`;

  /** What is folded in this block right now: the computed default, overridden by his own hand. */
  function foldedIn(block, nodes) {
    const computed = defaultFolds(nodes);
    const shut = new Set();
    for (const node of nodes) {
      if (node.children.length === 0) continue;
      const key = lineKey(block, node.index);
      const byHand = folds.has(`shut:${key}`) ? true : folds.has(`open:${key}`) ? false : null;
      if (byHand === null ? computed.has(node.index) : byHand) shut.add(node.index);
    }
    return shut;
  }

  /** The line id of one row of a block, when the store has given the rows back. */
  const lineIdAt = (block, index) => block?.lines?.[index]?.id || null;

  /**
   * He set this marker himself. Done and dropped pin the row until he clicks away; reopening it
   * takes it straight back off the list, so an undo is one click and never a hunt.
   */
  function rememberClose(block, index, body) {
    const id = lineIdAt(block, index);
    if (!id) return;
    const item = parseListItem(String(body ?? '').split('\n')[index] ?? '');
    const state = item && item.listType === 'checkbox' ? item.checkboxState : null;
    closedByHand = markClosedByHand(closedByHand, id, state);
    if (pinnedClose && pinnedClose.id !== id) {
      const prior = pinnedClose;
      releasedClose = new Set([...releasedClose, prior.id]);
      releasePin(prior);
    }
    // A root line (no indent) marked done takes its whole tree to the Past once he leaves it, as
    // cmd-e does; a done child stays put and rides along when its root goes. A public document has
    // no Past; its archive is the line "@@archive" in the document, and a done OR dropped root goes
    // just under it when the pin ends (notes archive done only).
    const unindented = !/^\s/u.test(String(body ?? '').split('\n')[index] ?? '');
    const root = doc
      ? (state === 'done' || state === 'dropped') && unindented
      : state === 'done' && unindented && archivable(zoneOf(block));
    pinnedClose = state === 'done' || state === 'dropped' ? { id, active: activeLineId(), block: block.id, root } : null;
  }

  /** The pin ends: a done root goes to the Past (in a document, under @@archive), as when the caret leaves. */
  function releasePin(gone) {
    if (!gone?.root) return;
    const block = blocks.find((entry) => entry.id === gone.block);
    const index = block?.lines?.findIndex((line) => line.id === gone.id) ?? -1;
    const item = index >= 0 ? parseListItem(String(block.body ?? '').split('\n')[index] ?? '') : null;
    // Still done, still there: reopened or deleted lines stay where they are.
    const closed = item?.checkboxState === 'done' || (doc && item?.checkboxState === 'dropped');
    if (closed) archiveLineHere({ block: block.id, index }, { marker: doc });
  }

  /** The line the caret is in right now, by its own id. */
  const activeLineId = () => (focusId ? lineIdAt(blocks.find((entry) => entry.id === focusId), caretLine) : null);

  /** The rows retired from one block's active view right now: every closed line, in every zone, not
   * only the ones he ticked in this session. Retiring is still a view decision: the line keeps its
   * id, its words and its place in the store, the caret's line and the hovered line always render,
   * and a search shows everything.
   */
  function retiredIn(block, rows) {
    // In a document a done line stays on the page, struck through, as in any shared doc.
    if (doc) return new Set();
    const closed = new Set(closedByHand);
    for (const row of rows) {
      if (row.state !== 'done' && row.state !== 'dropped') continue;
      const id = lineIdAt(block, row.index);
      if (id) closed.add(id);
    }
    if (closed.size === 0) return new Set();
    const activeIndex = focusId === block.id ? caretLine : -1;
    const hoverIndex = mouseLine?.block === block.id ? mouseLine.index : -1;
    const out = retiredRows(rows.map((row) => ({ index: row.index, lineId: lineIdAt(block, row.index), status: row.state })), {
      closed,
      activeLineId: activeIndex >= 0 && !releasedClose.has(lineIdAt(block, activeIndex)) ? lineIdAt(block, activeIndex) : null,
      hoverLineId: hoverIndex >= 0 ? lineIdAt(block, hoverIndex) : null,
      keep: find ? new Set(rows.map((row) => lineIdAt(block, row.index))) : (pinnedClose ? [pinnedClose.id] : null)
    });
    // A closed line takes its subtree with it, so nothing dangles under a parent that is gone.
    for (const row of [...out].map((index) => rows[index]).filter(Boolean)) {
      for (let index = row.index + 1; index <= row.index + (row.hides || 0); index += 1) {
        if (index === activeIndex || index === hoverIndex) continue;
        out.add(index);
      }
    }
    return out;
  }

  /** A click on the chevron or ⌘/ on the line: his hand, which outranks the rule from now on. */
  function toggleFold(block, index) {
    const nodes = outline(block.body.split('\n'));
    if (!nodes[index] || nodes[index].children.length === 0) return;
    const key = lineKey(block, index);
    const shut = foldedIn(block, nodes).has(index);
    const next = new Set(folds);
    next.delete(`shut:${key}`);
    next.delete(`open:${key}`);
    next.add(shut ? `open:${key}` : `shut:${key}`);
    folds = next;
    foldAt = Date.now();
    writeFolds(FOLD_SCOPE, [...next]);
  }

  /** The fold itself is the point, so the motion is only ever the toggle's, and never his reader's. */
  function foldMotion() {
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduced || Date.now() - foldAt > 400) return { duration: 0 };
    return { duration: 140, css: (t) => `opacity: ${t}; transform: translateY(${(1 - t) * -4}px)` };
  }

  // --- the store ---------------------------------------------------------------------------------

  const dirty = new Map();            // id -> the block last typed, not yet acknowledged
  // id -> the block as it stood before this unsent batch touched it, null where it did not exist.
  // This is the inverse of what is about to be written, which is what makes undo a local paint.
  const preEdit = new Map();
  // Ids in a POST that has not answered yet.
  const inflight = new Set(); // one set of entity references per pending save
  const pendingRemovals = new Set();
  const pendingSaves = new Set();
  let flushTimer = null;

  // The caret's textarea, found in the DOM rather than bound: the block he leaves is destroyed and
  // the block he enters is created in the same update, and one bind:this across both of them ends
  // up holding the element that was torn down.
  const theBox = () => scroller?.querySelector('[data-testid="notes-box"]') ?? null;

  let historyOwner;
  function ownerOfHistory() {
    if (!historyOwner) {
      historyOwner = sessionStorage.getItem('notes-history-owner') || crypto.randomUUID();
      sessionStorage.setItem('notes-history-owner', historyOwner);
    }
    return historyOwner;
  }
  const undoStack = [];
  const redoStack = [];
  // A block is named by its head entity. A merge can change that head while a later
  // write is already queued, so resolve its reference when sending, never when queueing.
  const blockAliases = new Map();
  const canonicalBlock = id => blockAliases.get(id) || id;
  function rememberBlock(previous, current) {
    for (const [id, target] of blockAliases) if (target === previous) blockAliases.set(id, current);
    blockAliases.set(previous, current);
  }
  let writeChain = Promise.resolve();
  // Moves on every write this tab sends and every answer it gets: a push refetch that saw it move
  // may have read the store from before a write of ours landed, so it reads again (refreshFromPush).
  let writeEpoch = 0;
  let offlineAt = 0;
  const serverDownRecently = () => offline && Date.now() - offlineAt < 3000;
  // Operations the server has to perform (archive, rollover, remote undo) lock the editor while
  // they run, so they never start against a server known to be down, and never wait for saves.
  const settledSoon = (promises) => Promise.race([Promise.allSettled(promises), new Promise((r) => setTimeout(r, 400))]);
  // Undo paints from the client's own row delta and confirms with the store afterwards, so the
  // stack entry exists before its token does: the write that is about to go out claims the token
  // when the answer carries it.
  async function api(path, options, entry = null) {
    const write = path === API && options?.method === 'POST';
    const perform = async () => {
      // `bodyAt` is written when the request's turn comes, not when it is queued: the undo
      // confirmation names a token the write ahead of it in this very chain is still earning.
      const raw = options?.bodyAt ? options.bodyAt() : options?.body;
      if (raw === null) return null;
      let body = write ? { ...JSON.parse(raw), historyOwner: ownerOfHistory() } : null;
      if (write && body.blocks) body.blocks = body.blocks.map(block => ({ ...block, id: canonicalBlock(block.id) }));
      if (write && body.remove) body.remove = body.remove.map(canonicalBlock);
      if (write && !body.rollover && !body.historyAction) body.recordHistory ??= true;
      // A server that is down or hung must cost nothing: a write fails at once for three seconds
      // after the last failure, and no request waits longer than four.
      if (write && serverDownRecently()) throw new NotesOffline();
      let response;
      // A write names this tab, so the live push of it is skipped here and taken everywhere else.
      if (write) writeEpoch += 1;
      // The notes' first read may already be on the wire: the document starts it before any script has loaded.
      const early = write ? null : takeEarly(path);
      try {
        response = early
          ? await Promise.race([early, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))])
          : await fetch(path, { ...(write ? { ...options, headers: liveHeaders(docHeaders(options?.headers)), bodyAt: undefined, body: JSON.stringify(body) } : options), signal: AbortSignal.timeout(4000) });
      }
      catch { offline = true; offlineAt = Date.now(); throw new NotesOffline(); }
      finally { if (write) writeEpoch += 1; }
      if (notFromApp(response)) { offline = true; offlineAt = Date.now(); throw new NotesOffline(); }
      let answer;
      try { answer = await response.json(); } catch { offline = true; offlineAt = Date.now(); throw new NotesOffline(); }
      offline = false;
      if (!response.ok) throw new Error(answer.error || `${options?.method || 'GET'} ${path} ${response.status}`);
      // This runs before the serialized promise resolves, so the very next write sees
      // the new identity even before the view's acknowledgement handler has run.
      if (body?.historyAction) blockAliases.clear();
      else for (const block of answer.blocks || []) {
        if (block.previousId && block.previousId !== block.id) rememberBlock(block.previousId, block.id);
      }
      if (answer.historyToken) {
        if (entry) entry.token = answer.historyToken;
        else { undoStack.push({ token: answer.historyToken, focus: focusId, line: caretLine, cursorBefore: cursorAtKey, cursorAfter: cursorNow() }); redoStack.length = 0; }
      }
      return answer;
    };
    if (!write) return perform();
    const request = writeChain.then(perform);
    writeChain = request.catch(() => {});
    return request;
  }

  /** ⌘Z paints before it asks. The step he is undoing is one the page itself made, so the page
   * already knows its inverse: the blocks it touched, as they stood before and after. That goes
   * straight into the document and onto the screen, and the store is told afterwards, in order,
   * on a chain of its own. It used to be the other way around -- flush the queue, wait for the
   * write to answer, POST the undo, wait for the whole document back, merge it -- which is one
   * python spawn and two round trips before a single character moved. A token that came from the
   * store rather than from this page (another tab, an earlier session) has no local inverse and
   * still travels the slow way.
   */
  function applyLocalDelta(delta, redo) {
    const next = [...blocks];
    for (const change of delta) {
      const id = canonicalBlock(change.id);
      const wanted = redo ? change.after : change.before;
      const index = next.findIndex((entry) => canonicalBlock(entry.id) === id);
      if (!wanted) { if (index >= 0) next.splice(index, 1); continue; }
      // The note takes the name it had in the step being restored: the store renames it the same
      // way (a note is named by its first row), and keeping the interim name showed the restored
      // note twice once the store's answer came back. The view stays on the same DOM node.
      // The restored words go into the block's document as one more edit, so its history only grows
      // and the store (told afterwards) and every other device converge on it.
      const restored = index >= 0 && typeof next[index].crdt === 'string' ? editedDoc(next[index], wanted) : null;
      next[index >= 0 ? index : next.length] = {
        ...wanted,
        ...(restored ? { crdt: restored } : {}),
        id: wanted.id ?? (index >= 0 ? next[index].id : id),
        ...(index >= 0 ? { _viewId: next[index]._viewId || next[index].id } : {}),
        _automatic: false,
        _revision: ((index >= 0 ? next[index]._revision : wanted._revision) || 0) + 1
      };
    }
    blocks = sortDocument(next);
  }

  async function travelHistory(redo) {
    // Anything typed and not yet sent is a step of its own: sending it now is what puts it on the
    // stack, and flush() has pushed that entry by the time it first awaits.
    if (dirty.size || flushTimer) flush();
    const from = redo ? redoStack : undoStack;
    const to = redo ? undoStack : redoStack;
    const entry = from.at(-1);
    if (!entry) return;
    if (!entry.delta) return travelHistoryRemote(redo);
    from.pop(); to.push(entry);
    applyLocalDelta(entry.delta, redo);
    window.getSelection()?.removeAllRanges();
    focusId = null;
    await tick();
    // ⌘Z puts the caret, or the selection, back where it was before the edit, and ⇧⌘Z where the
    // edit left it, as VS Code does; the line's start is only the fallback.
    const restored = await restoreCursor(redo ? entry.cursorAfter : entry.cursorBefore);
    const target = blocks.find(block => block.id === entry.focus && isText(block));
    if (!restored && target) await focusBlock(target.id, Math.min(target.body.length, target.body.split('\n').slice(0, entry.line).join('\n').length + (entry.line ? 1 : 0)));
    measureTail();
    // Straight into the write chain, in the order he pressed the keys. Queueing these behind each
    // other instead let an archive typed right after a redo reach the store first, and the store
    // then refused the redo because its token was no longer the top of the history.
    confirmHistory(entry, redo);
  }

  /**
   * The documents of the blocks an undo or redo restored, as this page now holds them. The words are
   * an edit in each document already (applyLocalDelta); the store restores the same rows, and if it
   * diffed them into its own document it would make the same edit a second time, and two identical
   * edits of one text are two edits. Handed the page's documents it merges them instead.
   */
  function restoredDocs(entry, redo) {
    const docs = {};
    for (const change of entry.delta || []) {
      const wanted = redo ? change.after : change.before;
      const block = wanted && blocks.find((entry) => canonicalBlock(entry.id) === canonicalBlock(wanted.id));
      if (block && typeof block.crdt === 'string') docs[block.id] = block.crdt;
    }
    return docs;
  }

  /**
   * Tell the store what the screen already shows. This goes into the same serialized write chain
   * as everything else rather than waiting for the chain to drain and then posting: waiting let a
   * later write (an archive, a save) reach the store first, and then the store refused the undo
   * because its token was no longer the top of the history.
   */
  async function confirmHistory(entry, redo) {
    try {
      const answer = await api(API, { method: 'POST', headers: { 'content-type': 'application/json' },
        bodyAt: () => (entry.token ? JSON.stringify({ historyAction: { token: entry.token, redo }, docs: restoredDocs(entry, redo) }) : null) });
      if (!answer) return;
      // Reconciliation, not a repaint: the block he is in now stays his, because the undo it is
      // confirming is already on the screen.
      adopt(answer, {
        reachedStart: { timeline: true, future: true, state: true },
        reachedEnd: { timeline: true, future: true, state: true, past: true }
      });
      if (typeof answer.earlier === 'number') earlier = answer.earlier;
      keepSnapshot();
      // The answer redraws the rows the undo restored; a selection it put back goes back again.
      if (keptRange) tick().then(() => requestAnimationFrame(restoreKeptRange));
    } catch (cause) { error = String(cause.message || cause); }
  }

  /** A step this page did not make: no local inverse, so the store does the work and sends it back. */
  async function travelHistoryRemote(redo) {
    if (archiveBusy) return;
    if (serverDownRecently()) { error = 'offline: this undo step needs the server'; return; }
    await settledSoon([...pendingSaves]);
    await flush();
    await settledSoon([writeChain]);
    if (dirty.size || inflight.size || archiveBusy) return;
    archiveBusy = true;
    try {
      const from = redo ? redoStack : undoStack;
      const to = redo ? undoStack : redoStack;
      const entry = from.at(-1);
      if (!entry) return;
      const answer = await api(API, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ historyAction: { token: entry.token, redo } }) });
      from.pop(); to.push(entry);
      adoptFull(answer);
      earlier = answer.earlier;
      window.getSelection()?.removeAllRanges();
      focusId = null;
      await tick();
      const restored = await restoreCursor(redo ? entry.cursorAfter : entry.cursorBefore);
      const target = blocks.find(block => block.id === entry.focus && isText(block));
      if (!restored && target) await focusBlock(target.id, Math.min(target.body.length, target.body.split('\n').slice(0, entry.line).join('\n').length + (entry.line ? 1 : 0)));
      measureTail();
    } catch (cause) { error = String(cause.message || cause); }
    finally { archiveBusy = false; }
  }

  async function insertBetween(before, after, boundary = null, body = '', caret = 0) {
    if (archiveBusy) return;
    const block = boundary
      ? put({ id: boundary.id, kind: 'text', body })
      : create({ body, zone: zoneOf(before || after), ord: ordBetween(before, after) });
    await tick();
    await focusBlock(block.id, caret);
    measureTail();
  }

  /** The shape an unsent write is kept in on disk: enough to redraw it and to send it again. */
  const outboxShape = (block) => ({
    id: block.id, kind: block.kind, body: block.body, ord: block.ord, zone: zoneOf(block),
    createdAt: block.createdAt, updatedAt: block.updatedAt, source: block.source || 'type',
    chatId: block.chatId ?? null,
    lines: (block.lines || []).map((line) => ({ ...line })),
    lineIds: Array.isArray(block.lineIds) ? [...block.lineIds] : null,
    // The block's text as an Automerge document: what is merged with other devices' edits.
    ...(typeof block.crdt === 'string' ? { crdt: block.crdt } : {})
  });

  function queue(block) {
    dirty.set(block.id, block);
    saving = dirty.size;
    // Offline first: the write is on the client's own disk before it is on the wire, so a reload,
    // a dropped connection or a server restart cannot lose what he just typed.
    // The rows the block had before this edit, when the page knows them; with no list the write
    // carries no base and the store treats it as the whole block, as it always did.
    const before = preEdit.has(block.id) ? preEdit.get(block.id) : block;
    const seen = before ? (lineIdsOf(before) || before.lines?.map((line) => line.id) || null) : [];
    // The words of those rows too, so the store can merge a concurrent change to the same line
    // instead of overwriting it (notes-merge.js). A block with no row ids to name sends none.
    const baseLines = before ? baseOfBlock(before) : [];
    const baseFields = before ? { ord: before.ord, zone: zoneOf(before), chatId: before.chatId ?? null } : null;
    rememberOps([{ id: block.id, block: outboxShape(block), ...(seen ? { base: seen.filter(Boolean) } : {}), ...(baseLines.length || !before ? { baseLines } : {}), ...(baseFields ? { baseFields } : {}) }]);
    // The save waits for a pause in the typing, like CodeMirror's 500ms undo group, so a run of
    // typing is one save and one ⌘Z; it never waits longer than five seconds behind the first key.
    // Anything else a key or the pointer does goes out as soon as the handler is done, so it is an
    // undo step of its own and the typing after it starts a new one.
    if (flushTimer && Date.now() - queuedSince > 5000) return;
    if (!flushTimer) queuedSince = Date.now();
    clearTimeout(flushTimer);
    // A public document is live with other people in it: its typing goes out within a frame or
    // two (DOC_TYPING_MS) so the others see it as it is typed, at the cost of a finer undo group.
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, typingKey ? (doc ? DOC_TYPING_MS : 500) : 0);
  }
  let queuedSince = 0;
  let typingKey = false;          // the latest key typed a character

  async function flush({ removed = [] } = {}) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    for (const id of removed) pendingRemovals.add(id);
    if (removed.length) rememberOps(removed.map((id) => ({ id, remove: true })));
    const removals = [...pendingRemovals];
    pendingRemovals.clear();
    const snapshots = [...dirty.values()];
    const recordHistory = snapshots.some(block => !block._automatic) || removals.length > 0;
    const batch = snapshots.map((block) => {
      const ids = lineIdsOf(block);
      const bodies = String(block.body ?? '').split('\n');
      return {
        id: block.id, kind: block.kind, body: block.body, ord: block.ord, zone: zoneOf(block),
        // Lines he did not touch keep what they already had.
        createdAt: block.createdAt, source: block.source === 'dictation' ? 'dictation' : 'type',
        chatId: block.chatId ?? null,
        // The block's document: the store merges it into its own, so the write is never a
        // replacement of what another device wrote meanwhile.
        ...(typeof block.crdt === 'string' ? { crdt: block.crdt } : {}),
        // The rows this device last knew the block to have, so the store keeps rows another device
        // added meanwhile instead of archiving them as ones this write left out.
        ...(baseOf(block.id) ? { base: baseOf(block.id) } : {}),
        // Which row each line on screen is, said outright. Without it the store has to guess by
        // diffing the words, and the guess swaps two rows -- and their created_at -- whenever a
        // line moves and is edited in the same save.
        ...(ids ? { lines: bodies.map((body, index) => ({ id: ids[index] ?? null, body, createdAt: block.lines?.[index]?.createdAt })) } : {})
      };
    });
    dirty.clear();
    if (batch.length === 0 && removals.length === 0) { saving = 0; preEdit.clear(); return; }
    const requestBlocks = new Set([...batch.map(block => block.id), ...removals]);
    inflight.add(requestBlocks);
    // What this write undoes, in the page's own terms: for every block it touches, the block as it
    // stood before and the block as it stands now, null on either side for one that did not exist.
    // The store keeps the authoritative row delta; this is the same change in the shape the view
    // can repaint from without asking anybody, which is what makes ⌘Z instant.
    const entry = recordHistory
      // A batch that only removed notes never went through put or create, so it starts from where
      // the key that made it found the caret (⌘X cutting a one-line note, then ⌘Z, left nothing
      // focused).
      ? { token: null, focus: focusId, line: caretLine, cursorBefore: batchCursor ?? cursorAtKey, cursorAfter: cursorNow(),
          delta: [...new Set([...batch.map(block => block.id), ...removals])].map((id) => ({
            id,
            before: preEdit.has(id) ? preEdit.get(id) : (blocks.find((block) => block.id === id) ?? null),
            after: blocks.find((block) => block.id === id) ?? null
          })) }
      : null;
    if (entry) { undoStack.push(entry); redoStack.length = 0; }
    preEdit.clear();
    batchCursor = null;
    // Which unsent write each block was at when this one left, so the answer clears only those.
    const sentOps = Object.fromEntries(readOutbox().map((op) => [op.id, op.n]));
    try {
      // The merge facts (which version of the write this is, what it supersedes, the lines it began
      // from) are read when the request's turn comes, not now: a write ahead of it in the chain
      // may have been answered and moved the base.
      const withMerge = () => batch.map((block) => {
        const sent = markSent(block.id);
        if (!sent?.opId) return block;
        const out = { ...block, opId: sent.opId, supersedes: sent.supersedes, ...(sent.baseLines ? { baseLines: sent.baseLines } : {}) };
        // Position, zone and chat link are named only when this device changed them: a stale copy
        // would otherwise undo a move or a chat another device made while he was typing.
        const was = sent.baseFields;
        if (was) {
          if (out.ord === was.ord) delete out.ord;
          if (out.zone === was.zone) delete out.zone;
          if ((out.chatId ?? null) === was.chatId) delete out.chatId;
        }
        return out;
      });
      const request = api(API, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        bodyAt: () => JSON.stringify({ blocks: withMerge(), remove: removals, recordHistory })
      }, entry);
      pendingSaves.add(request);
      let answer;
      try { answer = await request; } finally { pendingSaves.delete(request); }
      error = null;
      // The store's answer carries the line rows it wrote: their ids and their own created_at,
      // which is what the per-line gutter reads. The body is never taken back from it -- he may
      // have typed on since -- only the rows beside it.
      for (const saved of answer?.blocks || []) {
        if (!saved?.lines?.length) continue;
        const oldId = saved.previousId || saved.id;
        const index = blocks.findIndex((block) => canonicalBlock(block.id) === canonicalBlock(oldId));
        if (index >= 0) {
          const sent = snapshots.find(block => canonicalBlock(block.id) === canonicalBlock(oldId));
          const unchanged = blocks[index]._revision === sent?._revision;
          // The store merged this write with changes other devices had already made to the block,
          // so its answer can carry words that were not sent.
          const sentRows = sent ? blockLineRows(sent) : null;
          const viaDoc = typeof saved.crdt === 'string' && crdtReady() && typeof blocks[index].crdt === 'string';
          const news = viaDoc || (sentRows && (sentRows.length !== saved.lines.length
            || sentRows.some((row, at) => row.id !== saved.lines[at]?.id || row.body !== saved.lines[at]?.body)));
          const cap = news ? captureCaret() : null;
          const wasBody = blocks[index].body;
          const folded = news ? mergeBlock(blocks[index], null, saved) : null;
          // Keep the view keyed to the same DOM node when its head entity changes.
          // This preserves focus, selection and composition while later typing is pending.
          blocks[index] = folded
            ? { ...folded, _viewId: blocks[index]._viewId || blocks[index].id, id: saved.id }
            : { ...blocks[index], _viewId: blocks[index]._viewId || blocks[index].id, id: saved.id, ...(unchanged ? { lines: saved.lines, lineIds: null } : {}) };
          // The unsent write is re-made only when the answer brought words he did not have: otherwise
          // there is nothing new for it to carry, and a re-made op that nothing sends would sit in
          // the outbox for good.
          if (folded && !unchanged && folded.body !== wasBody) rememberOps([{ id: blocks[index].id, block: outboxShape(blocks[index]) }]);
          if (folded && cap) restoreCaret(cap);
          // A redo of this step must land under the name the store has just given the note.
          for (const change of entry?.delta || []) {
            if (change.after && canonicalBlock(change.after.id) === canonicalBlock(oldId)) change.after = { ...change.after, id: saved.id };
          }
          const queued = [...dirty.keys()].find(id => canonicalBlock(id) === saved.id);
          if (queued) { dirty.delete(queued); dirty.set(saved.id, blocks[index]); }
          if (canonicalBlock(focusId) === saved.id) focusId = saved.id;
        }
      }
      // Acknowledged: the write is the store's now, so it leaves the client's outbox.
      const agreed = {};
      const agreedLines = {};
      const agreedFields = {};
      for (const saved of answer?.blocks || []) {
        if (!saved?.lines?.length) continue;
        const rows = saved.lines.map((line) => line.id).filter(Boolean);
        agreed[saved.id] = rows;
        // What the store holds now, with its words and age: the base of whatever was typed since.
        const held = saved.lines.map((line) => ({ id: line.id, body: line.body, updatedAt: line.updatedAt }));
        agreedLines[saved.id] = held;
        const fields = { ord: saved.ord, zone: saved.zone || 'timeline', chatId: saved.chatId ?? null };
        agreedFields[saved.id] = fields;
        if (saved.previousId) { agreed[saved.previousId] = rows; agreedLines[saved.previousId] = held; agreedFields[saved.previousId] = fields; }
      }
      forgetOps([...snapshots.map((block) => block.id), ...removals,
        ...(answer?.blocks || []).map((saved) => saved.previousId).filter(Boolean)], undefined, { sent: sentOps, agreed, agreedLines, agreedFields });
      keepSnapshot();
      if (keptRange) tick().then(() => requestAnimationFrame(restoreKeptRange));
    } catch (cause) {
      // Nothing is dropped: the bodies go back in the queue, they stay in the outbox on disk,
      // and the next keystroke -- or the next open of the app -- retries.
      if (entry && !entry.token) { const at = undoStack.indexOf(entry); if (at >= 0) undoStack.splice(at, 1); }
      for (const id of removals) pendingRemovals.add(canonicalBlock(id));
      for (const snapshot of snapshots) {
        const id = canonicalBlock(snapshot.id);
        if ([...dirty.keys()].some(key => canonicalBlock(key) === id)) continue;
        const current = blocks.find(block => canonicalBlock(block.id) === id);
        if (current) dirty.set(current.id, current);
      }
      error = String(cause.message || cause);
    } finally {
      inflight.delete(requestBlocks);
    }
    saving = dirty.size;
    // A state block held back while it had unsaved text can take its update now that it is clean.
    if (pendingState) mergeState();
    settleRemote();
  }

  // A line is a row in the store with its own id and its own created_at, and the page is what
  // knows which row each line on screen is. `lineIds` is an array parallel to the block's body
  // lines, null where the line is new; it is trusted only while its length matches the body, and
  // where it does not the write falls back to the body alone and the store's older diff.
  function lineIdsOf(block) {
    const count = String(block?.body ?? '').split('\n').length;
    if (Array.isArray(block?.lineIds) && block.lineIds.length === count) return block.lineIds;
    if (block?.lines?.length === count) return block.lines.map((line) => line.id);
    return null;
  }

  /** The rows the block had, when the edit left the count alone; a caller that moves lines around
   *  hands `put` the array itself. */
  function keptIds(was, body) {
    const ids = lineIdsOf(was);
    return ids && ids.length === String(body ?? '').split('\n').length ? ids : null;
  }

  function put(patch) {
    const index = blocks.findIndex((block) => block.id === patch.id);
    if (index < 0) return null;
    if (!preEdit.size && !dirty.size) batchCursor = cursorAtKey;
    if (!preEdit.has(patch.id)) preEdit.set(patch.id, blocks[index]);
    const next = { ...blocks[index], ...patch, _automatic: false, _revision: (blocks[index]._revision || 0) + 1 };
    if (typeof patch.body === 'string') {
      next.lines = patch.lines || editLines(blocks[index], patch.body, new Date().toISOString(), patch.editLine ?? (focusId === patch.id ? caretLine : 0));
      if (!patch.lines) {
        const prior = new Map(lines(blocks[index]).map(line => [blocks[index].lines?.[line.index]?.id, parseInline(line.text).text.trim()]));
        for (const line of lines(next)) {
          const metadata = next.lines[line.index];
          if (prior.has(metadata.id) && !prior.get(metadata.id) && parseInline(line.text).text.trim()) metadata.createdAt = new Date().toISOString();
        }
      }
      next.lineIds = Array.isArray(patch.lineIds) ? patch.lineIds : next.lines.map(line => line.id);
    }
    // The gutter reads the first line's own created_at, so when archiving restamps the block the
    // line under it has to hear about it too, or the tick keeps the time it used to have.
    if (patch.createdAt && next.lines?.length) {
      next.lines = [{ ...next.lines[0], createdAt: patch.createdAt }, ...next.lines.slice(1)];
    }
    // The edit goes into the block's document as the shortest edit that makes its text this text:
    // a typed word is an insert, Enter an inserted newline, Backspace at a line's start a deleted one.
    if (typeof patch.body === 'string' || patch.lines || patch.lineIds) {
      const crdt = editedDoc(blocks[index], next);
      if (crdt) next.crdt = crdt;
    }
    blocks[index] = next;
    queue(blocks[index]);
    return blocks[index];
  }

  function create({ kind = 'text', body = '', ord, zone = 'timeline', source = 'type', lines: metadata = null, recordHistory = true }) {
    if (!preEdit.size && !dirty.size) batchCursor = cursorAtKey;
    const now = new Date().toISOString();
    const block = {
      id: metadata?.[0]?.id || newBlockId(), kind, body, zone, _automatic: !recordHistory,
      ord: ord ?? appendOrd(blocks, zone),
      createdAt: now, updatedAt: now, deletedAt: null, source
    };
    block.lines = metadata || editLines(block, body, now);
    block.lineIds = block.lines.map(line => line.id);
    const crdt = kind === 'break' ? undefined : newBlockDoc(block);
    if (crdt) block.crdt = crdt;
    if (!preEdit.has(block.id)) preEdit.set(block.id, null);
    blocks = [...blocks, block];
    queue(block);
    return block;
  }

  function drop(id) {
    if (!preEdit.has(id)) preEdit.set(id, blocks.find((block) => block.id === id) || null);
    blocks = blocks.filter((block) => block.id !== id);
    dirty.delete(id);
    return flush({ removed: [id] });
  }

  // --- opening -----------------------------------------------------------------------------------

  // Opening the app: what the browser already has, then the present, then everything else.
  //
  // It used to be one POST that rolled the day over, refreshed every bound task line through a
  // python spawn, scanned the reply drop and returned the whole document -- and nothing was on
  // screen until all of that had finished. it should load present first and then backfill future
  // and past.
  //
  // So: the snapshot on disk paints and scrolls to the present with no network at all, the present
  // window lands over it from sqlite alone, and the slow half -- the task refresh, the replies,
  // the undo history, the pages further up and further down -- arrives behind the screen. Each
  // step keeps anything he has touched since the last one. The first paint IS the present. So the
  // opening answer carries the timeline, the future and only the handful of past lines that make
  // the peek above the caret; with nothing tall above it, the present is already where it belongs
  // and there is no scroll to watch. History comes in above only when he actually scrolls up, and
  // it goes in without moving what he is reading.
  const PRESENT_PAGE = { limit: 200, past: 6, future: 120 };
  const PAGE_MORE = 200;

  /**
   * A block a merge cannot touch right now. A block with a document (notes-crdt.js) is never held:
   * another device's change is merged into what he is typing as characters, whenever it arrives,
   * and a write in flight or sent without an answer is no reason to wait (a replay changes nothing).
   * What is held is an IME composition in progress (the browser owns that text until it ends), and
   * a block with no document (the library did not load, or a snapshot older than documents): that
   * one keeps the older rule of waiting for its write to settle (settleRemote).
   */
  const holdsMerge = (id) => {
    if (composing && id === focusId) return true;
    // A block with a document merges whenever the other side arrives: the merge is commutative and
    // a replay changes nothing, so a write in flight or sent without an answer is no reason to wait.
    if (crdtReady() && typeof blocks.find((entry) => entry.id === id)?.crdt === 'string') return false;
    if ([...inflight].some((ids) => [...ids].some((key) => canonicalBlock(key) === id))) return true;
    if (unanswered(id)) return true;
    if (composing && id === focusId) return true;
    return dirty.has(id) && !baseStateOf(id);
  };
  const mine = holdsMerge;
  let composing = false;           // an IME composition is under way in the caret's line

  /** The caret and selection of the line being edited, as offsets in the block's body. */
  function captureCaret() {
    if (!focusId) return null;
    const box = theBox();
    const block = blocks.find((entry) => entry.id === focusId);
    if (!box || !block) return null;
    const start = bodyCaret(block, caretLine, box.selectionStart ?? 0);
    const end = bodyCaret(block, caretLine, box.selectionEnd ?? 0);
    return {
      id: block.id, body: block.body, start, end,
      // The two ends as Automerge cursors: they stay on their characters through any merge.
      cursors: captureCursors(block, start, end),
      // Another device's cut or join can move the caret to a different line, which is a different
      // box; the focus has to follow it or the next keys he types go nowhere.
      focused: document.activeElement === box,
      direction: box.selectionDirection || 'none'
    };
  }
  /** Put the caret back where the same characters are, after other people's edits were folded in. */
  async function restoreCaret(cap) {
    if (!cap || composing) return;
    const block = blocks.find((entry) => entry.id === cap.id);
    if (!block || block.body === cap.body) return;
    const moved = cursorOffsets(block, cap.cursors);
    const start = editCaret(block, moved ? moved.start : Math.min(cap.start, block.body.length));
    const end = editCaret(block, moved ? moved.end : Math.min(cap.end, block.body.length));
    caretLine = start.index;
    await tick();
    const box = theBox();
    if (!box || focusId !== cap.id) return;
    if (cap.focused && document.activeElement !== box) box.focus({ preventScroll: true });
    box.setSelectionRange(start.local, end.index === start.index ? end.local : start.local, cap.direction);
  }

  /**
   * Fold server blocks into the document on screen and keep the bookkeeping straight: a block that
   * was merged against unsent edits has new words, so the write waiting for it must carry them and
   * must be judged against what the server holds now, not against what it held when he began.
   */
  function foldBlocks(incoming, { ranges = {}, force = false, held = mine } = {}) {
    const cap = captureCaret();
    const merged = mergeDocument(blocks, incoming, { ranges, busy: force ? () => false : held, baseOf: force ? () => null : baseStateOf });
    if (merged.changed) blocks = merged.blocks;
    const rebased = {};
    for (const entry of merged.merged) {
      const landed = blocks.find((block) => block.id === entry.id);
      if (!landed) continue;
      if (dirty.has(landed.id)) dirty.set(landed.id, landed);
      rememberOps([{ id: landed.id, block: outboxShape(landed) }]);
      rebased[landed.id] = { lines: (entry.theirs || []).map((line) => ({ id: line.id, body: line.body, updatedAt: line.updatedAt })), fields: entry.fields };
    }
    if (Object.keys(rebased).length) rebaseOps(rebased);
    if (cap && merged.changed) restoreCaret(cap);
    return merged;
  }

  /**
   * A whole-document answer -- an undo, an archive, a rollover, a line that crossed a block
   * boundary -- folded in the same way as a page. These carry the newest page of the past and all
   * of the future and the state, so those edges are authoritative and anything they dropped is
   * really gone; a block further back than the page they carry is left where it is.
   */
  function adoptFull(answer) {
    // Holding that block back here is what made an undo of the line he was typing in do nothing.
    adopt(answer, {
      force: true,
      reachedStart: { timeline: true, future: true, state: true },
      reachedEnd: { timeline: true, future: true, state: true, past: true }
    });
    if (typeof answer.earlier === 'number') earlier = answer.earlier;
    keepSnapshot();
  }

  /** Fold a server answer into the document on screen, keeping his unsaved work. */
  function adopt(body, { reachedStart = {}, reachedEnd = {}, force = false, busy: held = mine } = {}) {
    const incoming = [...(body.past || []), ...(body.blocks || []), ...(body.future || []), ...(body.state || [])];
    const ranges = coveredRanges(incoming, { reachedStart, reachedEnd });
    const merged = foldBlocks(incoming, { ranges, force, held });
    for (const block of body.state || []) markReported(block);
    return merged;
  }

  async function loadPresent() {
    const query = new URLSearchParams({
      view: 'present', rollover: '1',
      limit: String(PRESENT_PAGE.limit), past: String(PRESENT_PAGE.past), future: String(PRESENT_PAGE.future)
    });
    const body = await api(`${API}?${query}`);
    // The present page reads the timeline to its end and the future from its top, so those edges
    // are authoritative: a block the answer does not carry there really is gone.
    adopt(body, {
      reachedStart: { timeline: true, future: true, state: true },
      reachedEnd: { timeline: true, state: true, past: true, future: (body.later || 0) === 0 }
    });
    earlier = body.earlier || 0;
    later = body.later || 0;
    cursors = { ...cursors, ...(body.cursors || {}) };
    hydrated = true;
    return body;
  }

  // --- the live push -----------------------------------------------------------------------------
  // Another device or tab wrote to the store: read the present again and fold it in through the same
  // merge as an open, so a block he has the caret in, has typed into or has a save in flight for is
  // kept as it is on screen. why not ? A block held back that way is retried once it settles
  // (settleRemote). Signals arriving while a read is out collapse into one more read after it, and a
  // read that overlapped a write of ours is repeated, because its answer may predate that write and
  // would otherwise remove what we just saved.
  let pushReading = false;
  let pushAgain = false;
  let heldRemote = new Set();
  const PUSH_PAGE = { limit: PRESENT_PAGE.limit, past: PRESENT_PAGE.past, future: PRESENT_PAGE.future };
  async function refreshFromPush() {
    if (!hydrated) return;
    if (pushReading) { pushAgain = true; return; }
    pushReading = true;
    try {
      for (let round = 0; round < 4; round += 1) {
        pushAgain = false;
        const epoch = writeEpoch;
        const query = new URLSearchParams({ view: 'present', limit: String(PUSH_PAGE.limit),
          past: String(PUSH_PAGE.past), future: String(PUSH_PAGE.future) });
        let body;
        try { body = await api(`${API}?${query}`); } catch { return; }
        if (epoch !== writeEpoch || writeChainBusy()) { pushAgain = true; await writeChain; continue; }
        const merged = adopt(body, {
          busy: pushBusy,
          reachedStart: { timeline: true, future: true, state: true },
          reachedEnd: { timeline: true, state: true, past: true, future: (body.later || 0) === 0 }
        });
        heldRemote = new Set(merged.held.map((block) => block.id));
        if (merged.changed) keepSnapshot();
        if (!pushAgain) break;
      }
    } finally { pushReading = false; }
  }
  /**
   * A public document's push carries the written blocks with their documents (docs-routes.js), so
   * they are merged here at once, one block at a time so each one's range covers only itself and
   * nothing else on the page reads as deleted. False sends the caller back to reading the document:
   * not hydrated yet, a block without its lines, or a different local block sharing the slot.
   */
  function applyPushedBlocks(list) {
    if (!doc || !hydrated || !Array.isArray(list) || !list.length) return false;
    for (const block of list) {
      if (!block || !block.id || !Array.isArray(block.lines)) return false;
      const zone = block.zone || 'timeline';
      if (blocks.some((other) => other.id !== block.id && zoneOf(other) === zone && (other.ord ?? 0) === (block.ord ?? 0))) return false;
    }
    let changed = false;
    const held = new Set(heldRemote);
    for (const block of list) {
      const merged = adopt({ blocks: [block] }, { busy: pushBusy });
      for (const entry of merged.held || []) held.add(entry.id);
      changed ||= merged.changed;
    }
    heldRemote = held;
    if (changed) keepSnapshot();
    return true;
  }
  // --- other people's cursors in a public document (DocCursors.svelte) ---------------------------

  /**
   * Where this tab's caret and selection are, for the others: block, anchor and head as line id +
   * offset in the line's words, and the same two ends as Automerge cursors on the block's text.
   * null when the caret is not in a plain line box.
   */
  function docCaretNow() {
    const box = theBox();
    if (!doc || !focusId || !box || document.activeElement !== box || box.isContentEditable) return null;
    const block = textBlock(focusId);
    if (!block) return null;
    const start = box.selectionStart ?? 0;
    const end = box.selectionEnd ?? start;
    const backward = box.selectionDirection === 'backward';
    const [anchorLocal, headLocal] = backward ? [end, start] : [start, end];
    const line = lineIdAt(block, caretLine);
    if (!line) return null;
    const anchorBody = bodyCaret(block, caretLine, anchorLocal);
    const headBody = bodyCaret(block, caretLine, headLocal);
    const captured = captureCursors(block, anchorBody, headBody);
    return {
      block: block.id, line, la: anchorLocal, hl: line, lh: headLocal, backward,
      ...(captured ? { cursors: { start: captured.start, end: captured.end } } : {})
    };
  }

  /** Someone else's cursor, resolved against this tab's copy of the block: { anchor, head } as { lineId, local }. */
  function docCursorWhere(cursor) {
    const block = cursor && textBlock(cursor.block);
    if (!block) return null;
    let offsets = null;
    if (cursor.cursors) { try { offsets = cursorOffsets(block, cursor.cursors); } catch { offsets = null; } }
    if (!offsets) {
      // The characters have not reached this tab yet: line id + offset, as sent.
      const index = (id) => (block.lines || []).findIndex((line) => line?.id === id);
      const a = index(cursor.line), h = index(cursor.hl || cursor.line);
      if (a < 0 || h < 0) return null;
      offsets = { start: bodyCaret(block, a, cursor.la), end: bodyCaret(block, h, cursor.lh) };
    }
    const end = (body) => { const at = editCaret(block, body); return { lineId: lineIdAt(block, at.index), local: at.local }; };
    const anchor = end(offsets.start), head = end(offsets.end);
    return anchor.lineId && head.lineId ? { anchor, head } : null;
  }

  const writeChainBusy = () => inflight.size > 0;
  /** Whether a push may not touch this block: only where a merge is impossible (see holdsMerge). */
  const pushBusy = (id) => holdsMerge(id);
  /** A block held back from a push (a write in flight, a composition): take the push once it settles. */
  function settleRemote() {
    if (!heldRemote.size) return;
    if ([...heldRemote].some((id) => pushBusy(id))) return;
    heldRemote = new Set();
    refreshFromPush();
  }

  /** The slow half, once he can see his writing: task refresh, replies, and the undo history. */
  async function backfill() {
    try {
      const sync = await api(`${API}?view=sync&historyOwner=${encodeURIComponent(ownerOfHistory())}`);
      // The store's view of the stacks, keeping the local inverse of any step this page made: a
      // token the page already holds a delta for stays the fast one.
      const known = new Map([...undoStack, ...redoStack].filter(item => item.token).map(item => [item.token, item]));
      const seed = (tokens) => (tokens || []).map(token => known.get(token) || { token });
      const unsent = undoStack.filter(item => !item.token);
      undoStack.splice(0, undoStack.length, ...seed(sync.history?.undo), ...unsent);
      redoStack.splice(0, redoStack.length, ...seed(sync.history?.redo));
      if (Array.isArray(sync.state)) { pendingState = sync.state; mergeState(); }
      repliesAvailable = sync.replies?.available === true;
    } catch { /* the document is already on screen; a failed reconcile is not his problem */ }
    try { await bufferHistory(); } catch { /* scrolling up will ask again */ }
    try { if (later > 0) await loadLater(); } catch { /* paged on demand instead */ }
    keepSnapshot();
    keepWeek();
  }

  // The past is paged from the server as he scrolls; this walks it back a week in the background
  // and keeps it on the device, and an open that cannot reach the server folds it in.
  let weekWalking = false;
  async function keepWeek() {
    if (weekWalking || !hydrated) return;
    weekWalking = true;
    try {
      const pages = [];
      let before = null;
      for (let page = 0; page < 40; page += 1) {
        const body = await api(`${API}?view=page&zone=past&limit=${PAGE_MORE}${before === null ? '' : `&before=${before}`}`);
        const rows = body.blocks || [];
        pages.push(...rows);
        if (!rows.length || !(body.earlier > 0) || reachedBack(rows)) break;
        const first = body.cursors?.first;
        if (first === null || first === undefined || first === before) break;
        before = first;
      }
      if (pages.length) await writeWeek({ blocks: pages });
    } catch { /* the next open tries again */ }
    finally { weekWalking = false; }
  }

  async function paintWeek() {
    const week = await readWeek();
    if (!week?.blocks?.length) return;
    foldBlocks(week.blocks, { ranges: {} });
    earlier = 0;
  }

  onMount(async () => {
    folds = new Set(readFolds(FOLD_SCOPE));
    // The documents' WebAssembly loads beside the first paint; it is a build asset the service
    // worker holds, so with the server down it still loads.
    loadCrdt();
    // Paint from the browser's own copy first: no request, no await on the network.
    const cached = await readSnapshot();
    // Only writes worth sending: an empty block an offline open made and never saved is dropped,
    // or every offline open would add one more empty block once the server is back.
    const known = new Set((cached?.blocks || []).map((block) => block.id));
    const outbox = replayable(readOutbox(), known);
    writeOutbox(outbox);
    if (cached?.blocks?.length || outbox.length) {
      blocks = sortDocument(applyOutbox(cached?.blocks || [], outbox));
      earlier = cached?.earlier || 0;
      later = cached?.later || 0;
      cursors = cached?.cursors || cursors;
      loading = false;
      await tick();
      await toPresent({ smooth: false, focus: false });
    }
    for (const op of outbox) {
      const block = blocks.find((entry) => entry.id === op.id);
      if (op.remove) pendingRemovals.add(op.id);
      else if (block) dirty.set(block.id, block);
    }
    // The present is asked for while the WebAssembly is still downloading, and is not held for it.
    // A cold open used to wait for ~800 KB of wasm before it even asked for the text (the paint was
    // the sum of the two, not the longer one). A block that arrives before the documents can be
    // made is edited as plain text, the same path an open with the wasm blocked already takes.
    try {
      await loadPresent();
    } catch (cause) {
      if (cause instanceof NotesOffline) await paintWeek();
      else if (!blocks.length) error = String(cause.message || cause);
    }
    loading = false;
    const gap = tailGap(blocks);
    if (gap) create({ ...gap, recordHistory: false });
    const scratch = doc ? null : todayGap(blocks);
    if (scratch) create({ ...scratch, recordHistory: false });
    if (dirty.size) flush();
    await tick();
    await toPresent({ smooth: false });
    backfill();
  });

  // What the next cold open paints, written after the document settles rather than on every
  // keystroke. It is bounded by bytes, so a pasted page cannot push the present out of it.
  let snapshotTimer = null;
  function keepSnapshot() {
    if (!hydrated) return;
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      writeSnapshot({ blocks: snapshotOf(blocks), earlier, later, cursors });
    }, 800);
  }

  /** Opening (and Escape) lands on the seam between NOW and NEXT: the bottom of NOW, with the caret
   * on its live line, in the upper half of the screen and the top of NEXT right under it in the
   * lower half.
   */
  async function toPresent({ smooth = false, focus = true } = {}) {
    // A document opens at its top, as any document does, with no caret (no keyboard on a phone).
    if (doc) { await tick(); measureTail(); return; }
    const live = liveBlock(blocks);
    if (focus && live) await focusBlock(live.id, null);
    await tick();
    measureTail();
    await tick();
    const anchorId = live?.id;
    const anchor = anchorId ? flow?.querySelector(`[data-block="${anchorId}"]`) : null;
    if (!anchor || !scroller) return;
    const seam = futureEl ? Math.round(scrollOf(futureEl) - scroller.clientHeight * SEAM_AT) : pastEdge(anchor);
    scroller.scrollTo({ top: Math.max(0, seam), behavior: smooth ? 'smooth' : 'auto' });
  }

  /** Where an element's top sits in the scroller's own coordinates, whatever it is nested in. */
  function scrollOf(element) {
    return scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }

  /** The rows of written text under a root, in order: blank lines and retired 2pt lines are not lines he can read. */
  function textRows(root) {
    return [...(root?.querySelectorAll('[data-line]') || [])].filter((row) => !row.classList.contains('retired') && (row.querySelector('[data-text]')?.textContent ?? '').trim() !== '');
  }

  /**
   * The scroll position that shows PEEK_LINES written lines of the past above the present: the top
   * of the PEEK_LINES-th non-blank row above the caret, whatever blank rows, gaps and labels sit in
   * between, so the top of the screen is real text and never half a line.
   */
  function pastEdge(anchor) {
    const top = scrollOf(anchor);
    const above = textRows(flow).filter((row) => scrollOf(row) + row.getBoundingClientRect().height <= top + 1);
    if (above.length === 0) return Math.max(0, Math.round(top - peek()));
    const first = above[Math.max(0, above.length - PEEK_LINES)];
    return Math.max(0, Math.round(scrollOf(first) - 6));
  }

  /** One written line in pixels, read off the page's own type scale. */
  function noteLine() {
    const root = flow || scroller;
    if (!root) return 24;
    const style = getComputedStyle(root);
    const size = parseFloat(style.getPropertyValue('--note-size')) || 15;
    const leading = parseFloat(style.getPropertyValue('--note-leading')) || 1.62;
    return size * leading;
  }

  const peek = () => Math.round(PEEK_LINES * noteLine());

  /**
   * The room between the last line of NOW and the NEXT label: a few lines of empty space that take
   * a click and give the live line's caret, small enough that NOW's bottom and NEXT's top share the
   * landing screen.
   */
  function measureTail() {
    tail = Math.max(72, Math.round(TAIL_LINES * noteLine()));
  }

  // Paging the two ends. Both are cursor walks over the (zone, ord) index on the server, so the
  // cost of a page is the page and not the document: the stream can be as long as he likes.
  let pagingUp = false;
  let pagingDown = false;

  async function loadEarlier() {
    if (pagingUp || earlier === 0) return;
    pagingUp = true;
    const fromBottom = scroller ? scroller.scrollHeight - scroller.scrollTop : 0;
    try {
      const cursor = cursors.pastBefore ?? past[0]?.lines?.[0]?.ord ?? past[0]?.ord ?? null;
      const body = await api(`${API}?view=page&zone=past&limit=${PAGE_MORE}${cursor === null ? '' : `&before=${cursor}`}`);
      if (body.blocks?.length) {
        foldBlocks(body.blocks, { ranges: coveredRanges(body.blocks) });
      }
      earlier = body.earlier || 0;
      if (body.cursors?.first !== null && body.cursors?.first !== undefined) cursors = { ...cursors, pastBefore: body.cursors.first };
      await tick();
      // His place on the page does not move: the new rows go in above where he is reading.
      if (scroller) scroller.scrollTop = scroller.scrollHeight - fromBottom;
    } finally { pagingUp = false; }
  }

  /** The other direction: the future area below what is loaded, paged the same way. */
  async function loadLater() {
    if (pagingDown || later === 0) return;
    pagingDown = true;
    try {
      const cursor = cursors.futureAfter ?? future.at(-1)?.lines?.at(-1)?.ord ?? null;
      const body = await api(`${API}?view=page&zone=future&limit=${PAGE_MORE}${cursor === null ? '' : `&after=${cursor}`}`);
      if (body.blocks?.length) {
        foldBlocks(body.blocks, { ranges: coveredRanges(body.blocks) });
      }
      later = body.later || 0;
      if (body.cursors?.last !== null && body.cursors?.last !== undefined) cursors = { ...cursors, futureAfter: body.cursors.last };
    } finally { pagingDown = false; }
  }

  // History is buffered ahead, above the present, as soon as the present is painted. So the
  // first paint is still the present alone -- nothing tall above it, nothing to scroll past --
  // and then a few screens of the past go in behind it, each page anchored so what he is reading
  // does not move. Scrolling up tops the buffer back up before he reaches its edge.
  const BUFFER_SCREENS = 4;          // how much history is kept loaded above the viewport
  const REFILL_SCREENS = 2;          // how close to the top he may get before more is pulled

  /** How much loaded document sits above the top of the screen, in screens. */
  const screensAbove = () => (scroller ? scroller.scrollTop / Math.max(1, scroller.clientHeight) : 0);

  async function bufferHistory(screens = BUFFER_SCREENS) {
    if (!scroller) return;
    // Each page goes in above and the scroll position is held, so screensAbove grows page by page.
    for (let page = 0; page < 12 && earlier > 0 && screensAbove() < screens; page += 1) {
      const before = scroller.scrollHeight;
      await loadEarlier();
      if (scroller.scrollHeight <= before) break;     // nothing more came back; stop asking
    }
  }

  function onScroll() {
    if (!scroller || loading) return;
    if (earlier > 0 && screensAbove() < REFILL_SCREENS) bufferHistory();
    const toBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (later > 0 && toBottom < 2 * scroller.clientHeight) loadLater();
  }

  // --- the caret ---------------------------------------------------------------------------------

  async function focusBlock(id, caret = null, { pointed = false } = {}) {
    menu = null;
    const block = blocks.find((entry) => entry.id === id);
    const at = caret === null ? (block?.body.length ?? 0) : caret;
    const spot = block ? editCaret(block, at) : { index: 0, local: 0 };
    focusId = id;
    caretLine = spot.index;
    await tick();
    const box = theBox();
    if (!box) return;
    box.focus({ preventScroll: true });
    box.selectionStart = box.selectionEnd = Math.max(0, Math.min(spot.local, box.value.length));
    grow(box);
    // A line he clicked is where he is looking: the page scrolls only if it is cut off. Keeping a
    // typing margin there moved a line near the bottom up a row under the pointer, so the second
    // click of a double click missed it.
    keepCaretInView(pointed ? { above: 0, below: box.getBoundingClientRect().height } : undefined);
  }

  function keepCaretInView({ above = 40, below = 140 } = {}) {
    const box = theBox();
    if (!box || !scroller) return;
    const top = box.getBoundingClientRect().top;
    const frame = scroller.getBoundingClientRect();
    if (top < frame.top + above) scroller.scrollTop -= frame.top + above - top;
    else if (top > frame.bottom - below) scroller.scrollTop += top - (frame.bottom - below);
  }

  function grow(element) {
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }

  async function adjacentSurface(source, direction, x = null) {
    const surfaces = [...scroller.querySelectorAll('[data-line], [data-gap-editor]')];
    const target = surfaces[surfaces.indexOf(source) + direction];
    if (!target) return false;
    if (target.hasAttribute('data-gap-editor')) {
      focusId = null;
      await tick();
      target.focus({ preventScroll: true });
      target.setSelectionRange(direction > 0 ? 0 : 1, direction > 0 ? 0 : 1);
      target.scrollIntoView({ block: 'nearest' });
      return;
    }
    const block = blocks.find(entry => entry.id === target.closest('[data-block]').dataset.block);
    const row = lines(block)[Number(target.dataset.line)];
    await focusBlock(block.id, bodyCaret(block, row.index, direction > 0 ? 0 : row.text.length));
    if (x !== null) {
      const box = theBox(), stops = caretStops(box);
      const y = direction > 0 ? Math.min(...stops.map(stop => stop.y)) : Math.max(...stops.map(stop => stop.y));
      const at = closestStop(stops, x, y).offset;
      box.setSelectionRange(at, at);
    }
  }

  /** ⌫ or ⌦ in the blank space between two notes. The gap is a textarea holding a single newline,
   * so the browser had nothing of its own to delete and the key did nothing at all; what he means
   * by it is the seam, exactly as at the head of a block.
   */
  async function gapSeam(box, direction) {
    const breakId = box.dataset.boundary || null;
    if (breakId) {
      const landing = neighbourText(breakId, direction > 0 ? 1 : -1) || neighbourText(breakId, direction > 0 ? -1 : 1);
      drop(breakId);
      await tick();
      measureTail();
      if (landing) await focusBlock(landing.id, direction > 0 ? 0 : landing.body.length);
      return;
    }
    const after = box.dataset.after;
    const before = box.dataset.before;
    if (!after || !before) return;
    const seam = backspaceAtHead(blocks, after);
    if (!seam) return;
    if (seam.removeBreak) {
      drop(seam.removeBreak);
      await tick();
      measureTail();
      await focusBlock(seam.focus, seam.caret);
      return;
    }
    mergeSeam(seam);
    drop(seam.remove);
    await focusBlock(seam.mergeInto, seam.caret);
    measureTail();
  }

  /** ↵ in the blank space between two blocks adds one more blank line to it. */
  async function growGap(box) {
    const above = box.dataset.before ? blocks.find((entry) => entry.id === box.dataset.before) : null;
    const below = box.dataset.after ? blocks.find((entry) => entry.id === box.dataset.after) : null;
    const target = above && isText(above) ? above : below && isText(below) ? below : null;
    if (!target) return;
    const tail = target === above;
    const body = tail ? `${target.body}\n` : `\n${target.body}`;
    put({ id: target.id, body });
    flush();
    await tick();
    await focusBlock(target.id, tail ? body.length : 0);
    measureTail();
  }

  async function gapKey(event) {
    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey;
    const key = event.key.toLowerCase();
    // ⇥ between notes indents nothing; it must not send focus off into the page chrome either.
    if (event.key === 'Tab') { event.preventDefault(); return; }
    if (event.key === 'Enter' && !event.metaKey && !event.altKey && !event.shiftKey && !event.ctrlKey && !event.isComposing) {
      event.preventDefault();
      await growGap(event.currentTarget);
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      await gapSeam(event.currentTarget, event.key === 'Backspace' ? -1 : 1);
      return;
    }
    const direction = key === 'arrowdown' || key === 'arrowright' || (ctrl && key === 'n') ? 1
      : key === 'arrowup' || key === 'arrowleft' || (ctrl && key === 'p') ? -1 : 0;
    // ⌥← and ⌥→ leave the gap as ← and → do: there is no word in it to stop at.
    if (!direction || event.shiftKey || event.metaKey || (event.altKey && (key === 'arrowup' || key === 'arrowdown'))) return;
    event.preventDefault();
    const box = event.currentTarget;
    const at = box.selectionStart;
    // The gap is one row high, so ↑ and ↓ always leave it; only ← and → walk its single offset.
    // Stepping inside it vertically ate a keypress and the caret appeared to be stuck in the gap.
    const vertical = key === 'arrowup' || key === 'arrowdown' || (ctrl && (key === 'n' || key === 'p'));
    // One stop, like the blank line it looks like: ← and → leave it at once (ORACLE.md D5).
    void at;
    await adjacentSurface(box, direction, vertical ? verticalX : null);
  }

  function neighbourText(id, direction) {
    const live = ordered(blocks);
    const index = live.findIndex((block) => block.id === id);
    if (index < 0) return null;
    for (let at = index + direction; at >= 0 && at < live.length; at += direction) {
      if (isText(live[at]) && !find?.hidden.has(live[at].id)) return live[at];
    }
    return null;
  }

  function lineIndex(body, caret) {
    return body.slice(0, Math.max(0, caret)).split('\n').length - 1;
  }

  // --- one line raw, the rest rendered ----------------------------------------------------------
  //
  // The caret's line is the only raw thing on the page. It is a textarea holding that line's WORDS alone -- no
  // marker characters, no indent spaces, no score comment -- sitting in the row the rendered line was in, with
  // the marker drawn beside it by the same span and the indent still a margin. the reference app never had two
  // appearances of a line to reconcile: one contenteditable, markers as::before in reserved space, indent as
  // margin (src/lib/tiptap/CustomListItem.js:219-247 and src/routes/+page.svelte:2094-2127 in the reference
  // notes app). This is that geometry with a textarea, so nothing moves when the caret arrives.
  //
  // Everything below the keys still speaks in body offsets, which is what notes-doc.js works in;
  // these three turn one into the other.

  /** Which line is the raw one: the caret's, clamped to the lines the block actually has. */
  function editing(block, index) {
    if (focusId !== block.id) return false;
    const last = Math.max(0, block.body.split('\n').length - 1);
    return index === Math.max(0, Math.min(caretLine, last));
  }

  const richLine = (block, line) => Boolean(line.heading) || richLineId === `${block.id}#${line.index}` || parseInline(line.text).text !== line.text;

  /** One row per Enter, into the interaction stream the chat pane already writes to
   * (interaction.sqlite, 14 day retention). The caret's own offset at the moment the key is handled
   * answers that in one query. Telemetry only: it is wrapped so nothing it does can change what the
   * key does.
   */
  const enterSession = globalThis.crypto?.randomUUID?.() || `notes-${Date.now()}-${Math.random()}`;
  let enterSeq = 0;
  let enterFlush = null;
  function observeEnter(blockId, index, local, length, body) {
    try {
      const seq = enterSeq++;
      enqueueObservation({
        schema: 1, session: enterSession, seq, id: `${enterSession}:${seq}`, conversation: 'notes',
        type: 'notes_enter', at: new Date().toISOString(), mono: performance.now(),
        block: blockId, line: index, selectionStart: local, lineLength: length, bodyLength: body
      });
      clearTimeout(enterFlush);
      enterFlush = setTimeout(() => { flushObservations(); }, 2000);
    } catch {  }
  }

  /** Where line `index` of this body starts, in the body's own offsets. */
  function lineStart(body, index) {
    const rows = String(body ?? '').split('\n');
    let at = 0;
    for (let row = 0; row < index && row < rows.length; row += 1) at += rows[row].length + 1;
    return at;
  }

  /** A caret in the editing line's words, as a caret in the whole body. */
  function bodyCaret(block, index, local) {
    const rows = lines(block);
    const row = rows[index] || rows[rows.length - 1];
    if (!row) return 0;
    const words = Math.max(0, Math.min(local ?? 0, row.text.length));
    return lineStart(block.body, row.index) + row.head.length + words;
  }

  /** The reverse: which line a body caret is on, and where in that line's words it sits. */
  function editCaret(block, caret) {
    const { index, offset } = lineAt(block.body, Math.max(0, Math.min(caret ?? 0, block.body.length)));
    const row = lines(block)[index];
    return { index, local: row ? Math.max(0, Math.min(offset - row.head.length, row.text.length)) : 0 };
  }

  function writeLine(block, index, words) {
    const rows = lines(block);
    const row = rows[index];
    if (!row) return block.body;
    const raw = block.body.split('\n');
    raw[index] = `${row.head}${words}${row.tail}`;
    return raw.join('\n');
  }

  /** Put the caret at a body offset: the same line if it is there, or the line it landed in. */
  async function placeCaret(id, caret) {
    const block = blocks.find((entry) => entry.id === id);
    if (!block) return;
    const spot = editCaret(block, caret);
    if (spot.index !== caretLine || focusId !== id) { await focusBlock(id, caret); return; }
    await tick();
    const box = theBox();
    if (!box) return;
    // The row he lands in is a different element from the one he left, so the caret has to be
    // given to it: without this, ⌫ at the head of a line joined the lines and then dropped the
    // focus on <body>, and the next keystroke went nowhere.
    if (document.activeElement !== box) box.focus({ preventScroll: true });
    box.selectionStart = box.selectionEnd = Math.max(0, Math.min(spot.local, box.value.length));
    grow(box);
  }

  // --- keys --------------------------------------------------------------------------------------

  /**
   * The lines standing above a block in its own zone, which is what decides how deep Tab may go.
   * A block boundary is derived and invisible, so the list item above a block's FIRST line is
   * still its parent; reading the ceiling from the block alone made Tab on an indented first line
   * jump it left. A page break is a drawn edge, so the walk stops at one.
   */
  function linesAbove(block) {
    const zone = zoneOf(block);
    const live = ordered(blocks).filter((entry) => zoneOf(entry) === zone);
    const at = live.findIndex((entry) => entry.id === block.id);
    if (at <= 0) return [];
    const above = live.slice(0, at);
    const lastBreak = above.map((entry) => isBreak(entry)).lastIndexOf(true);
    return above.slice(lastBreak + 1).filter(isText).flatMap((entry) => String(entry.body ?? '').split('\n'));
  }

  /** Tab, ⇧Tab and the bar's two indent segments: one step, no deeper than one below the item
   *  above, with the caret keeping its place in the words. */
  async function indentHere(block, caret, direction, { keep = null, typed = false } = {}) {
    const item = parseListItem(block.body.split('\n')[lineIndex(block.body, caret)]);
    if (!item) {
      // Prose has no outline level, so only a typed ⇥ at a bare caret does anything there: blanks
      // to the next tab stop, as VS Code types them (ORACLE.md D8).
      if (!typed || direction < 0 || (keep && keep[0] !== keep[1])) return;
      const { start } = lineAt(block.body, caret);
      const width = 2 - ((caret - start) % 2);
      put({ id: block.id, body: insertAt(block.body, caret, ' '.repeat(width)).body });
      await tick();
      await placeCaret(block.id, caret + width);
      return;
    }
    const moved = indentLine(block.body, caret, direction, { above: linesAbove(block) });
    if (!moved) return;
    put({ id: block.id, body: moved.body });
    await tick();
    await placeCaret(block.id, caret + moved.delta);
    // A selection inside the line stays selected: the words did not change, only their level.
    if (keep && keep[0] !== keep[1]) theBox()?.setSelectionRange(keep[0], keep[1], keep[2] || 'forward');
  }

  /** ⌘. and the bar's marker segment: the reference app's ring on the caret's line. A check-off is a claim for
   *  the push plane to verify, and a marker is never mid-thought, so in the state area it is
   *  reported at once rather than after the typing debounce. */
  async function cycleHere(block, caret, { keepCaret = false } = {}) {
    const next = cycleAtCaret(block.body, caret);
    let body = next.body;
    let index = lineIndex(body, next.caret);
    // Parking a line sends it to the end of its own level, and only then: moving the caret onto it
    // later must not shuffle anything.
    const parked = parseListItem(body.split('\n')[index])?.checkboxState === 'await';
    // The move to the end waits until he leaves the line, so cycling ⌘. through await does not
    // jump the line and the caret out from under him.
    pendingPark = parked ? { block: block.id, index, text: stripMarker(body.split('\n')[index]) } : null;
    put({ id: block.id, body });
    rememberClose(block, index, body);
    if (carriesState(zoneOf(block))) reportLine(block.id, index, 'check');
    await tick();
    measureTail();
    // The condition is the point of deferring, so the caret lands in the pill ready to say it.
    if (parked) { focusCondition(block.id, index); return; }
    if (keepCaret) return;
    await placeCaret(block.id, next.caret);
  }

  let pendingPark = null;
  const stripMarker = (line) => parseListItem(line)?.content ?? String(line ?? '');
  /** Where the caret is now, as a block and line: the pill's own line, or the focused block's. */
  function caretRow() {
    const active = document.activeElement;
    if (active?.dataset?.await) return { block: active.dataset.await, index: Number(active.dataset.awaitLine) };
    return focusId ? { block: focusId, index: caretLine } : null;
  }
  /** Once he is off the parked line, send it to the end of its level, as ⌘. used to at once. */
  function settlePark() {
    const park = pendingPark;
    if (!park) return;
    const here = caretRow();
    if (here && here.block === park.block && here.index === park.index) return;
    pendingPark = null;
    const block = blocks.find((entry) => entry.id === park.block);
    if (!block) return;
    const raw = block.body.split('\n');
    // Find the line again by its words if typing elsewhere in the block shifted it.
    let index = park.index;
    if (stripMarker(raw[index]) !== park.text) index = raw.findIndex((line) => stripMarker(line) === park.text);
    if (index < 0 || parseListItem(raw[index])?.checkboxState !== 'await') return;
    const moved = deferToEnd(block.body, index);
    if (!moved || moved.body === block.body) return;
    put({ id: block.id, body: moved.body });
    if (focusId === block.id && caretLine === index) caretLine = moved.index;
    tick().then(measureTail);
  }
  const settleSoon = () => queueMicrotask(() => setTimeout(settlePark, 0));

  /** The pill's own textbox: the condition a parked line waits on, editable in place. */
  function conditionBox(blockId, index) {
    return scroller?.querySelector(`[data-await="${blockId}"][data-await-line="${index}"]`) || null;
  }

  function focusCondition(blockId, index) {
    const box = conditionBox(blockId, index);
    if (!box) return false;
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
    return true;
  }

  function setCondition(block, index, text) {
    const raw = block.body.split('\n');
    if (index < 0 || index >= raw.length) return;
    raw[index] = setListState(raw[index], 'await', text);
    put({ id: block.id, body: raw.join('\n') });
    lastEdit = Date.now();
  }

  /** ArrowRight out of the condition and into the words; ArrowLeft back in is in onKeydown. */
  async function onConditionKeydown(event, block, index) {
    const box = event.currentTarget;
    const at = box.selectionStart ?? 0;
    if (event.key === 'Escape') { event.preventDefault(); box.blur(); flush(); return; }
    // ⌘. carries the ring on from inside the pill. Cycling a line into `await` moves the caret
    // here to say what it waits on, and the chord was not handled here, so the ring was one way
    // from the keyboard: a parked line could never be carried on to dropped or back to a bullet
    // without the mouse. The window handler cannot do it either, because it reads the hovered
    // row or the focused block, and while the pill has the caret there is neither.
    if ((event.metaKey || barHeld) && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === '.') {
      event.preventDefault();
      event.stopPropagation();
      flush();
      const landed = blocks.find((entry) => entry.id === block.id) || block;
      await cycleHere(landed, bodyCaret(landed, index, 0));
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab'
        || (event.key === 'ArrowRight' && at === box.value.length && box.selectionEnd === at)) {
      event.preventDefault();
      flush();
      const landed = blocks.find((entry) => entry.id === block.id) || block;
      await focusBlock(landed.id, bodyCaret(landed, index, 0));
    }
  }

  /** ⌘⌥0-4 on a line: its heading level, or back to plain words when it is already that level. */
  async function headingHere(block, index, level) {
    flush();
    const raw = block.body.split('\n');
    if (index < 0 || index >= raw.length) return;
    raw[index] = headingLine(raw[index], lines(block)[index]?.heading === level ? 0 : level);
    put({ id: block.id, body: raw.join('\n') });
    await tick();
    measureTail();
  }

  /** A bar segment acts on the line the caret is on: the bar never takes focus, so that is still
   *  the block the textarea is in. */
  function fromBar(act) {
    const block = blocks.find((entry) => entry.id === focusId);
    if (!block) return;
    act(block, bodyCaret(block, caretLine, theBox()?.selectionStart ?? 0));
  }

  /**
   * The bar's cmd went down, or its latch expired. navigator.clipboard.readText() only resolves
   * inside a user gesture and a pointer handler is the last one there is -- the v that follows is
   * a keydown of its own, too late -- so the read starts here and the key spends what it brought.
   */
  function onBarCmd(held) {
    if (!held) { clipRead = null; return; }
    try {
      const read = navigator.clipboard?.readText?.();
      clipRead = read ? Promise.resolve(read).catch(() => '') : null;
    } catch { clipRead = null; }
  }

  /**
   * ⌘C / ⌘X / ⌘V from the bar. What they work on is the caret line's words: the marker in front
   * of them belongs to the gutter, so it is neither copied nor cut, and a paste lands between the
   * words rather than in front of the bullet.
   */
  async function clipboardHere(action, block) {
    const box = theBox();
    if (!box) return;
    const row = lines(block)[caretLine];
    if (!row) return;
    const words = box.value;
    const start = Math.min(box.selectionStart ?? 0, box.selectionEnd ?? 0);
    const end = Math.max(box.selectionStart ?? 0, box.selectionEnd ?? 0);
    const base = lineStart(block.body, row.index) + row.head.length;

    if (action === 'paste') {
      // Kept for as long as the thumb is: a second v under one hold pastes the same thing rather
      // than nothing. onBarCmd drops it when cmd lets go.
      const text = await (clipRead ?? Promise.resolve(''));
      if (!text) return;
      const flat = String(text).replace(/\r\n?/g, '\n');
      const pasted = replaceInline(words,start,end,flat);
      put({ id: block.id, body: writeLine(block, caretLine, pasted.body) });
      await tick();
      measureTail();
      await placeCaret(block.id, base + pasted.caret);
      return;
    }

    const visible = parseInline(words).text;
    const picked = start === end ? visible : visible.slice(visibleOffset(words,start),visibleOffset(words,end));
    try { await navigator.clipboard?.writeText?.(picked); }
    catch { error = 'the clipboard said no'; return; }
    if (action !== 'cut') return;
    const kept = start === end ? '' : replaceInline(words,start,end,'').body;
    put({ id: block.id, body: writeLine(block, caretLine, kept) });
    await tick();
    measureTail();
    await placeCaret(block.id, base + (start === end ? 0 : start));
  }

  async function onKeydown(event, block) {
    if (archiveBusy) { event.preventDefault(); return; }
    // The bar's cmd is a ⌘ as far as every chord below is concerned: held with a thumb, or latched
    // by a tap for the one key that follows. ⌘, and the bar's latched cmd: the page's own chords.
    // Control is NOT one of them. macOS sends its native editing bindings as Control chords, and
    // folding ctrlKey in here made ⌃f open the find bar and ⌃b toggle bold, which then wrote `**`
    // into the words. all work in multiline and all modes in our editor...
    const command = event.metaKey || barHeld;
    const meta = command || event.ctrlKey;
    // The four AppKit editing commands that have to cross a line, because a one-line textarea has
    // nowhere of its own to go. Read as the motion they are, so one branch serves both keys.
    const EMACS_KEYS = { f: 'ArrowRight', b: 'ArrowLeft', h: 'Backspace', d: 'Delete' };
    // ⌃k is not a motion: mid-line the browser kills to the end of the line and fills the kill
    // ring, which ⌃y reads back. Only at the end of a line is it ours, where what it kills is the
    // newline itself.
    const killEnd = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !barHeld
      && event.key.toLowerCase() === 'k';
    const emacs = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !barHeld
      ? EMACS_KEYS[event.key.toLowerCase()] || null
      : null;
    const key = emacs || event.key;
    const box = event.currentTarget;
    // The textarea holds one line's words; the keys below speak in the body's offsets.
    const rows = lines(block);
    const row = rows[caretLine] || rows[rows.length - 1] || null;
    const words = row?.text ?? '';
    const local = box.selectionStart ?? 0;
    const caret = bodyCaret(block, caretLine, local);
    const vertical = !event.metaKey && !event.altKey && !event.shiftKey &&
      (['ArrowUp', 'ArrowDown'].includes(event.key) || (event.ctrlKey && ['n', 'p'].includes(event.key.toLowerCase())));
    if (!vertical && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) verticalColumn = null;
    if (!vertical && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) verticalX = null;
    const spread = box.selectionStart !== box.selectionEnd;
    const place = (at) => { placeCaret(block.id, at); };
    // The nearest lines of this note he can see: a closed todo the view has retired is skipped by
    // ←, →, ⌫ and ⌦ at a line's edge, as VS Code's caret skips a folded region, instead of being
    // walked into (it popped up) or joined onto a line he could not see.
    const shownRow = (index) => rows[index] && (!rows[index].hidden && !rows[index].retired);
    let shownAbove = caretLine - 1, shownBelow = caretLine + 1;
    while (shownAbove >= 0 && !shownRow(shownAbove)) shownAbove -= 1;
    while (shownBelow < rows.length && !shownRow(shownBelow)) shownBelow += 1;
    if (shownBelow >= rows.length) shownBelow = -1;

    // A key arriving while a space is being held back settles it: the space was his, not a hold.
    if (heldSpace && !isSpaceKey(event) && interruptAction({ pending: true }) === 'flush') {
      clearTimeout(armTimer);
      armTimer = null;
      flushSpace();
    }

    // ⌃a / ⌃e: the ends of the line the caret is on, and on a list line the start is after the
    // marker. or after the todo marker etc. A second ⌃a from there goes to the true start of the
    // line.
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        && (event.key === 'a' || event.key === 'e')) {
      event.preventDefault();
      const { index, start } = lineAt(block.body, caret);
      const text = block.body.split('\n')[index] ?? '';
      if (event.key === 'e') { place(start + text.length); keepCaretInView(); return; }
      const item = parseListItem(text);
      const head = start + (item ? item.prefix : 0);
      place(caret === head ? start : head);
      keepCaretInView();
      return;
    }

    // The words of one line all selected: the selection is the row. ⌘X takes the row, bullet and
    // all, with its markdown on the clipboard; ⌘C copies that markdown (a bullet or todo line
    // only: plain words copy as words); ⌫ and ⌦ remove the row instead of leaving an empty bullet.
    // A selection inside the words is text, and goes on being text.
    if (spread && !event.isComposing && box.selectionStart === 0 && box.selectionEnd === (box.value ?? '').length
        && (box.value ?? '').length > 0 && !event.altKey && (row?.item || row?.marker)) {
      const here = { block: block.id, line: caretLine };
      const plain = !event.shiftKey && !event.altKey;
      const key = event.key.toLowerCase();
      if (event.metaKey && !event.ctrlKey && plain && (key === 'x' || key === 'c')) {
        event.preventDefault();
        if (event.repeat) return;
        busyWhile((async () => {
          if (!(await copyRows([here], key === 'x' ? 'the clipboard said no, so nothing was cut' : 'the clipboard said no'))) return;
          error = null;
          if (key === 'x') await deleteRows([here], 0);
        })());
        return;
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat) busyWhile(deleteRows([here], 0));
        return;
      }
    }

    if (lineCommand(event, block, box)) return;

    // ⇧↓ / ⇧↑ / ⌃⇧n / ⌃⇧p while the caret is in a line: inside a wrapped line the browser
    // extends by visual row, and only at the line's own edge does the page take over.
    if (event.shiftKey && !event.metaKey && !event.altKey && !barHeld
        && (['ArrowUp', 'ArrowDown'].includes(event.key)
          || (event.ctrlKey && ['n', 'p'].includes(event.key.toLowerCase())))) {
      const direction = ['n', 'ArrowDown'].includes(event.key) ? 1 : -1;
      const stops = caretStops(box);
      // The row the selection's head is on, not its start: a whole wrapped line selected has its
      // head on the last row, where ⇧↓ leaves the line.
      const headAt = box.selectionDirection === 'backward' ? box.selectionStart : box.selectionEnd;
      const current = currentStop({ tagName: box.tagName, value: box.value, selectionStart: headAt }, stops);
      if (stops.filter(stop => direction * (stop.y - current.y) > 1).length) return;
      event.preventDefault();
      const back = box.selectionDirection === 'backward';
      const held = back ? (box.selectionEnd ?? 0) : (box.selectionStart ?? 0);
      const edge = direction > 0 ? Math.max(box.selectionStart ?? 0, box.selectionEnd ?? 0) : held;
      await busyWhile(extendVertically(direction, {
        block: block.id, line: caretLine,
        offset: visibleOffset(words, spread ? (back ? edge : held) : held)
      }));
      return;
    }

    if (vertical) {
      event.preventDefault();
      const direction = ['n', 'ArrowDown'].includes(event.key) ? 1 : -1;
      // From a selection ↑ and ↓ go from its head (ORACLE.md); measuring from its start took a
      // selection on the last row of a wrapped line back up to its first.
      if (spread) {
        const head = box.selectionDirection === 'backward' ? box.selectionStart : box.selectionEnd;
        box.setSelectionRange(head, head);
      }
      const stops = caretStops(box);
      const current = currentStop(box, stops);
      const wanted = verticalX ?? current.x;
      verticalX = wanted;
      const following = stops.filter(stop => direction * (stop.y - current.y) > 1);
      if (following.length) {
        const y = direction > 0 ? Math.min(...following.map(stop => stop.y)) : Math.max(...following.map(stop => stop.y));
        const target = closestStop(stops, wanted, y);
        box.setSelectionRange(target.offset, target.offset);
      } else if (await adjacentSurface(box.closest('[data-line]'), direction, wanted) === false) {
        // Nothing above the first line or below the last: VS Code goes to the line's start or end.
        // A formatted line is a contenteditable with no value to measure; it stays where it is.
        if (!box.isContentEditable) {
          const edge = direction < 0 ? 0 : box.value.length;
          box.setSelectionRange(edge, edge);
        }
      }
      keepCaretInView();
      return;
    }

    const format = { b: 'bold', i: 'italic', u: 'underline' }[event.key.toLowerCase()];
    if (command && !event.altKey && !event.shiftKey && format) {
      event.preventDefault();
      flush(); // formatting is its own undoable action, distinct from preceding typing
      const from = box.selectionStart, to = box.selectionEnd;
      richLineId = `${block.id}#${caretLine}`;
      if (from !== to) {
        const formatted = toggleInline(box.value, from, to, format);
        put({ id: block.id, body: writeLine(block, caretLine, formatted.body) });
        await tick();
        const editor = theBox(); editor?.focus(); editor?.setSelectionRange(formatted.start, formatted.end);
      } else {
        await tick();
        const editor = theBox(); editor?.focus(); editor?.setSelectionRange(from, to); editor?.toggleFormat(format);
      }
      return;
    }
    if (meta && event.altKey && !event.shiftKey && /^[0-4]$/.test(event.code.replace('Digit',''))) {
      event.preventDefault();
      await headingHere(block, caretLine, Number(event.code.replace('Digit','')));
      const editor=theBox(); editor?.focus(); editor?.setSelectionRange(local, local);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (find) { closeFind(); return; }
      if (menu) { menu = null; return; }
      await toPresent({ smooth: true });
      return;
    }

    if (command && (event.key === 'f' || event.key === 'F')) { event.preventDefault(); openFind(); return; }

    // c / x / v under the bar's cmd, and only there: a real ⌘C is the browser's own and the
    // desktop keeps it, but on a phone the letter would land in the line, so it is spent here
    // instead. Which letters those are is hold-modifier's table, not a second copy of it.
    if (barHeld && !event.metaKey && !event.ctrlKey) {
      const asked = chords.chordFor(event.key);
      if (asked === 'copy' || asked === 'cut' || asked === 'paste') {
        event.preventDefault();
        await clipboardHere(asked, block);
        return;
      }
    }

    // ⌘⇧↑ / ⌘⇧↓ : move this block within its zone, the keyboard's half of the tap menu.
    if (meta && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      move(block.id, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }

    // ⌥↑ / ⌥↓ : move the line the caret is on, one place, block boundary and all.
    if (event.altKey && !meta && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      const held = [box.selectionStart, box.selectionEnd, box.selectionDirection];
      const step = event.key === 'ArrowUp' ? -1 : 1;
      // Next to a line the view hides (a retired done todo) the swap would be with that line and
      // nothing he can see would move: the line goes past it to the nearest line he can see.
      const neighbour = rows[caretLine + step];
      if (neighbour && (neighbour.hidden || neighbour.retired)) {
        const moved = rotateRows([{ block: block.id, line: caretLine }], step);
        if (!moved) return;
        await tick();
        const to = moved.rows[moved.i + step];
        const landed = to && textBlock(to.block);
        if (landed) {
          await focusBlock(landed.id, bodyCaret(landed, to.line, held[0]));
          if (held[0] !== held[1]) theBox()?.setSelectionRange(...held);
        }
        return;
      }
      await moveLineHere(block, caret, step);
      if (held[0] !== held[1]) theBox()?.setSelectionRange(...held);
      return;
    }

    // ⌘/ : fold or unfold the line the caret is on. General to the document, not the state area's.
    if (meta && event.key === '/') {
      event.preventDefault();
      toggleFold(block, lineIndex(block.body, caret));
      return;
    }

    // ⌘. : the marker ring, the reference app's toggleCheckbox, on the caret's line.
    if (meta && event.key === '.') {
      event.preventDefault();
      await cycleHere(block, caret);
      return;
    }

    // ⌘↵ : hand this block to a new chat, which stays here as a chip. In the state area the block
    // is mostly generated, so what a subagent needs is his remark about it, not the block alone.
    if (event.key === 'Enter' && meta && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (carriesState(zoneOf(block))) { await openComment(block); return; }
      await askHere(block);
      return;
    }

    // ⌥↵ : a deliberate block boundary. Nothing else makes one.
    if (event.key === 'Enter' && event.altKey && !meta && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      const split = splitBlock(blocks, block.id, caret);
      if (!split) return;
      // Both halves keep the rows they already were. splitLines cuts the caret's line in two and
      // hands every whole row below it to the new block with its id and birthday intact, which is
      // what breakHere does for ⇧↵. Slicing editLines at the caret's line instead dropped the
      // tail of that line out of the metadata, so the new block carried one line fewer than its
      // body had and every carried row was saved under its neighbour's id.
      const rows = splitLines(block, caret, new Date().toISOString());
      put({ id: block.id, body: split.keep, lines: rows.before });
      const started = create({ ...split.create, lines: rows.after.length ? rows.after : null });
      await focusBlock(started.id, split.caretInNew ?? 0);
      measureTail();
      flush();
      return;
    }

    // ⇧↵ : a page break, and the screen is clear again.
    if (event.key === 'Enter' && event.shiftKey && !event.isComposing) {
      event.preventDefault();
      // A page break clears the screen of the present, so it belongs to the timeline (the pageBreak
      // column of notes-zones.js, the one capability that is genuinely NOW's alone). Anywhere else
      // ⇧↵ made one at the END of the timeline and carried the rest of the line up there with it;
      // there it is VS Code's: a new line, keeping the line's own leading blanks (ORACLE.md D6).
      if (!canPageBreak(zoneOf(block))) {
        const lead = (block.body.split('\n')[caretLine] ?? '').match(/^[ \t]*/)[0];
        const end = bodyCaret(block, caretLine, box.selectionEnd ?? local);
        const next = insertAt(block.body.slice(0, caret) + block.body.slice(end), caret, `\n${lead}`);
        put({ id: block.id, body: next.body });
        await tick();
        await placeCaret(block.id, next.at);
        return;
      }
      await breakHere(block, caret);
      return;
    }

    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      observeEnter(block.id, caretLine, local, words.length, block.body.length);
      if (parseInline(words).text !== words && parseInline(words).text.length) {
        const before = replaceInline(words, local, words.length, '').body;
        const after = replaceInline(words, 0, box.selectionEnd ?? local, '').body;
        const raw = block.body.split('\n');
        raw.splice(caretLine, 1, `${row.head}${before}${row.tail}`, `${row.head}${after}`);
        const newIndex = caretLine + 1;
        put({id:block.id,body:raw.join('\n')});
        richLineId = `${block.id}#${newIndex}`;
        await tick();
        await focusBlock(block.id, lineStart(raw.join('\n'),newIndex)+row.head.length);
        measureTail();
        return;
      }
      const result = enter(blocks, block.id, caret);
      if (!result) return;
      put({ id: block.id, body: result.keep });
      if (!result.create) {
        await tick();
        place(result.caret);
        keepCaretInView();
        measureTail();
        return;
      }
      // The caret moves before the save: a keystroke arriving while a POST is in flight must not
      // land in the block he just left.
      const previousLines = editLines(block, block.body, new Date().toISOString());
      const transferred = previousLines.slice(lineAt(block.body, caret).index + 1);
      const made = create({ ...result.create, lines: transferred.length ? transferred : null });
      await focusBlock(made.id, result.caretInNew ?? 0);
      measureTail();
      flush();
      return;
    }

    if (event.key === 'Tab') {
      // Inside a list item Tab is ours and is swallowed either way, so focus never leaves.
      event.preventDefault();
      await indentHere(block, caret, event.shiftKey ? -1 : 1, { typed: true, keep: [box.selectionStart, box.selectionEnd, box.selectionDirection] });
      return;
    }

    if (key === 'Backspace' && !spread && !event.altKey && !meta && local > 0 && /^ +$/.test(words.slice(0, local)) && !(row?.head)) {
      // In the leading blanks of a line ⌫ goes back to the previous tab stop, as VS Code's
      // useTabStops and CodeMirror's deleteCharBackward do.
      event.preventDefault();
      const width = local % 2 || 2;
      put({ id: block.id, body: writeLine(block, caretLine, words.slice(0, local - width) + words.slice(local)) });
      flush();
      await tick();
      await placeCaret(block.id, caret - width);
      return;
    }
    if (key === 'Backspace' && !spread) {
      const semanticCaret = visibleOffset(words,local) === 0 ? lineStart(block.body,caretLine) + (row?.item?.prefix ?? 0) : caret;
      const list = backspaceOnList(block.body, semanticCaret);
      if (list) {
        event.preventDefault();
        put({ id: block.id, body: list.body });
        await tick();
        place(list.caret);
        return;
      }
      // At the head of a line inside the block, the words join the line above and that line's
      // syntax stands: a raw join would leave its marker characters in the middle of the words.
      if (visibleOffset(words, local) === 0 && shownAbove >= 0) {
        event.preventDefault();
        joinLines(block, shownAbove, caretLine);
        return;
      }
      if (visibleOffset(words, local) === 0 && shownAbove < 0) {
        if (caretLine > 0) { event.preventDefault(); return; }
        const seam = backspaceAtHead(blocks, block.id);
        event.preventDefault();
        // The first line of a section (NEXT, say) is not the top of the document: an empty one
        // goes, and the caret lands at the end of whatever is above it.
        if (!seam) {
          if (block.body === '' && block.kind !== 'break') {
            const all = ordered(blocks);
            const above = all[all.findIndex((entry) => entry.id === block.id) - 1];
            if (above && above.kind !== 'break') {
              drop(block.id);
              await focusBlock(above.id, above.body.length);
              measureTail();
            }
          }
          return;
        }
        if (seam.removeBreak) { drop(seam.removeBreak); await tick(); measureTail(); await focusBlock(seam.focus, seam.caret); return; }
        mergeSeam(seam);
        drop(seam.remove);
        await focusBlock(seam.mergeInto, seam.caret);
        measureTail();
        return;
      }
    }

    if ((key === 'Delete' || killEnd) && !spread && visibleOffset(words, local) === parseInline(words).text.length && shownBelow >= 0) {
      event.preventDefault();
      joinLines(block, caretLine, shownBelow);
      return;
    }

    if ((key === 'Delete' || killEnd) && !spread && shownBelow < 0 && visibleOffset(words, local) === parseInline(words).text.length) {
      // Only hidden lines below it in this note: nothing he can see to join.
      if (caretLine < rows.length - 1) { event.preventDefault(); return; }
      const seam = deleteAtTail(blocks, block.id);
      if (!seam) return;
      event.preventDefault();
      if (seam.removeBreak) { drop(seam.removeBreak); await tick(); measureTail(); await focusBlock(seam.focus, seam.caret); return; }
      mergeSeam(seam);
      drop(seam.remove);
      await focusBlock(seam.mergeInto, seam.caret);
      return;
    }

    // ⌃v and ⌥v: a screenful down and up. Inside a one-line textarea the browser's pageDown has
    // nowhere to go, so nothing happened at all; the page scrolls and the caret lands in the line
    // nearest where it was on the screen, which is what a big text box does.
    if (!event.metaKey && !event.shiftKey && !barHeld && scroller
        && ((event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'v')
          || (event.altKey && !event.ctrlKey && ['v', '√'].includes(event.key.toLowerCase())))) {
      event.preventDefault();
      const down = event.ctrlKey;
      const rect = box.getBoundingClientRect();
      const wantedX = rect.left + 2;
      const y = rect.top + rect.height / 2;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + (down ? 1 : -1) * scroller.clientHeight);
      await tick();
      const near = nearestRow(scroller, y);
      if (near) await caretAtRow(near, wantedX, y);
      return;
    }

    if (event.key === 'ArrowUp' && meta) { event.preventDefault(); await toTop(); return; }
    if (event.key === 'ArrowDown' && meta) { event.preventDefault(); await toPresent({ smooth: true }); return; }

    // ← at the head of a line and → at its end cross into the line beside it: the textarea holds
    // one line, so the browser has nowhere of its own to go.
    if (key === 'ArrowLeft' && !event.shiftKey && !spread && row?.state === 'await'
        && visibleOffset(words, local) === 0 && conditionBox(block.id, caretLine)) {
      event.preventDefault();
      focusCondition(block.id, caretLine);
      return;
    }
    if (key === 'ArrowLeft' && !event.shiftKey && (!meta || emacs) && !spread && visibleOffset(words, local) === 0) {
      if (shownAbove >= 0) {
        event.preventDefault();
        const above = rows[shownAbove];
        caretLine = shownAbove;
        await placeCaret(block.id, bodyCaret(block, above.index, above.text.length));
        return;
      }
      const previous = neighbourText(block.id, -1);
      if (!previous) return;
      event.preventDefault();
      await adjacentSurface(box.closest('[data-line]'), -1);
      return;
    }
    if (key === 'ArrowRight' && !event.shiftKey && (!meta || emacs) && !spread && visibleOffset(words, local) === parseInline(words).text.length) {
      if (shownBelow >= 0) {
        event.preventDefault();
        const below = rows[shownBelow];
        caretLine = shownBelow;
        await placeCaret(block.id, bodyCaret(block, below.index, 0));
        return;
      }
      const next = neighbourText(block.id, 1);
      if (!next) return;
      event.preventDefault();
      await adjacentSurface(box.closest('[data-line]'), 1);
      return;
    }

    // Hold space to dictate, the rule the chat pane already uses, and on a line with words on it
    // too: the space is withheld rather than typed, and a hold shorter than the arm window puts it
    // back.
    const decision = pushToTalkDecision(event, {
      available: !doc && (mic?.available?.() ?? false),
      editable: true,
      ownComposer: true,
      draftEmpty: block.body.trim() === '',
      recording,
      pending: Boolean(heldSpace)
    });
    if (decision === 'pass') return;
    event.preventDefault();                      // 'start', 'arm' and 'suppress' all hold the key
    if (decision === 'start') { startMic(); return; }
    if (decision !== 'arm') return;
    heldSpace = { id: block.id, line: caretLine, start: local, end: box.selectionEnd ?? local };
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      armTimer = null;
      if (!heldSpace) return;
      if (startMic()) heldSpace = null;          // dictation took the key; no space was meant
      else flushSpace();                        
    }, HOLD_ARM_MS);
  }

  function mergeSeam(seam) {
    const left = blocks.find(block => block.id === seam.mergeInto);
    const right = blocks.find(block => block.id === seam.remove);
    const at = new Date().toISOString();
    const a = editLines(left, left.body, at), b = editLines(right, right.body, at);
    const first = lines(left).at(-1), second = lines(right)[0];
    if (!parseInline(first.text).text.trim() && !first.head && a.length === 1) {
      // The note above is one empty line: joining into it is that line going. The note below keeps
      // its own name and rows and the empty one is removed, instead of the empty note being
      // rewritten under the lower note's head row, which left it standing in the store as a ghost.
      seam.remove = left.id;
      seam.mergeInto = right.id;
      seam.caret = 0;
      return right.id;
    }
    const firstText = parseInline(first.text), secondText = parseInline(second.text);
    // re-serializing the parsed runs escaped every literal _ * < > and \ (snake_case came back as
    // snake\_case).
    const text = first.text + second.text;
    const head = firstText.text.trim() ? first.head : second.head || first.head;
    const merged = { ...(firstText.text.trim() ? a[a.length - 1] : b[0]), body: head + text + (first.tail || second.tail),
      createdAt: joinedCreatedAt({...a[a.length - 1],body:firstText.text}, {...b[0],body:secondText.text}) };
    seam.caret = lineStart(left.body, a.length - 1) + head.length + first.text.length;
    const metadata = [...a.slice(0, -1), merged, ...b.slice(1)];
    put({ id: left.id, body: metadata.map(line=>line.body).join('\n'), lines: metadata, lineIds: metadata.map(line => line.id) });
    return metadata[0].id;
  }

  /** Two lines become one: the words of the second onto the end of the first, whose syntax wins. */
  async function joinLines(block, above, below = above + 1) {
    const rows = lines(block);
    const first = rows[above];
    const second = rows[below];
    if (!first || !second) return;
    const raw = block.body.split('\n');
    // Raw words, as in VS Code: re-serializing parsed runs escaped every literal _ * < > and \.
    // `below` is the next line he can see; a line the view hides between them stays where it is.
    const joined = first.text + second.text;
    raw[above] = `${first.head}${joined}${first.tail}`;
    raw.splice(below, 1);
    const ids = lineIdsOf(block);
    const metadata = editLines(block, block.body, new Date().toISOString());
    metadata[above] = { ...metadata[above], body: raw[above], createdAt: joinedCreatedAt(metadata[above], metadata[below]) };
    metadata.splice(below, 1);
    put({
      id: block.id, body: raw.join('\n'), lines: metadata,
      lineIds: ids ? ids.filter((_, index) => index !== below) : null
    });
    caretLine = above;
    await tick();
    const landed = blocks.find((entry) => entry.id === block.id);
    if (landed) await placeCaret(block.id, bodyCaret(landed, above, first.text.length));
    measureTail();
  }

  /** In the comment box ⌘↵ sends and Escape puts it away; ↵ is a new line, as in any note. */
  function onCommentKeydown(event, block) {
    if (event.key === 'Escape') { event.preventDefault(); closeComment(); return; }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault();
      sendComment(block);
    }
  }

  // The textarea holds one line's words, so there is no line to read off its caret: which line is
  // raw is `caretLine`, and only the keys that leave a line -- and the pointer -- move it. Reading
  // it back from the box here set it to 0 after every keystroke, which tore the textarea out of the
  // row it had just been created in and dropped the focus.
  function onKeyup(event) {
    if (!isSpaceKey(event)) return;
    releaseHold();
  }

  /** The space came back up: too short a hold types the space, a real one stops the microphone. */
  function releaseHold() {
    const action = releaseAction({ pending: Boolean(heldSpace), recording });
    clearTimeout(armTimer);
    armTimer = null;
    if (action === 'type_space') { flushSpace(); return; }
    if (action === 'stop') stopMic();
  }

  /** The withheld space, typed where it was held back from. */
  function flushSpace() {
    const at = heldSpace;
    heldSpace = null;
    const box = theBox();
    const block = blocks.find((entry) => entry.id === at?.id);
    if (!at || !box || !block) return false;
    const start = Math.max(0, Math.min(box.value.length, at.start));
    const end = Math.max(start, Math.min(box.value.length, at.end));
    box.setRangeText(' ', start, end, 'end');
    const was = lines(block)[at.line]?.head.length ?? 0;
    put({ id: at.id, body: writeLine(block, at.line, box.value) });
    grow(box);
    syncBox(at.id, at.line, box.selectionStart ?? 0, was);
    return true;
  }

  async function breakHere(block, caret) {
    const result = pageBreak(blocks, { id: block.id, caret });
    if (!result.create) { await toPresent({ smooth: true }); return; }
    const split = result.keep ? splitLines(block, caret, new Date().toISOString()) : null;
    if (result.keep) put({ ...result.keep, lines: split.before });
    const made = result.create.map((spec) => create({ ...spec, lines: spec.kind === 'text' ? split?.after : null }));
    const rule = made.find((entry) => entry.kind === 'break');
    const line = made[made.length - 1];
    focusId = line.id;
    caretLine = 0;
    await tick();
    measureTail();
    await tick();
    const box = theBox();
    if (box) { box.focus({ preventScroll: true }); box.selectionStart = box.selectionEnd = 0; }
    const anchor = flow?.querySelector(`[data-block="${rule?.id || line.id}"]`);
    if (anchor && scroller) scroller.scrollTo({ top: Math.max(0, anchor.offsetTop), behavior: 'smooth' });
    flush();
  }

  async function toTop() {
    while (earlier > 0) await loadEarlier();          // the top means the top of the whole document
    scroller?.scrollTo({ top: 0, behavior: 'smooth' });
    const first = timeline.find(isText);
    if (first) await focusBlock(first.id, 0);
  }

  async function onInput(event, block) {
    verticalColumn = null;
    verticalX = null;
    mouseLine = null;
    lastEdit = Date.now();
    grow(event.target);
    const local = event.target.selectionStart ?? 0;
    const was = lines(block)[caretLine]?.head.length ?? 0;
    put({ id: block.id, body: writeLine(block, caretLine, event.target.value) });
    if (carriesState(zoneOf(block))) noteEdit(block.id, caretLine);
    // A deletion, a paste or a cut is an undo step of its own; only typing runs on (D13).
    if (event.inputType && event.inputType !== 'insertText' && !event.inputType.startsWith('insertComposition')) flush();
    measureTail();
    await syncBox(block.id, caretLine, local, was);
  }

  async function syncBox(id, index, local, was) {
    const landed = blocks.find((entry) => entry.id === id);
    const row = landed ? lines(landed)[index] : null;
    if (!row) return;
    const took = row.head.length - was;
    const current = theBox();
    if (took === 0 && (!current || current.value === row.text)) return;
    await tick();
    const box = theBox();
    if (!box) return;
    if (box.value !== row.text) { box.value = row.text; grow(box); }
    box.selectionStart = box.selectionEnd = Math.max(0, Math.min(local - took, box.value.length));
  }

  /**
   * Rows into a note at the caret's line. 'replace' takes the caret's line out (an empty bullet, or
   * a whole line selected); 'above' puts them over it and the caret stays in its own line, as in
   * VS Code. The rows are new rows with new ids, written the way every other row command writes
   * them, so the paste merges like any edit.
   */
  function pasteRows(block, raws, plan, local) {
    const rows = rowsOf(block);
    if (plan === 'replace') {
      rows.splice(caretLine, 1, ...freshRows(raws));
      putRows(block.id, rows);
      const last = caretLine + raws.length - 1;
      tick().then(() => {
        measureTail();
        const landed = textBlock(block.id);
        if (landed) focusBlock(block.id, bodyCaret(landed, last, lines(landed)[last]?.text.length ?? 0));
      });
      return;
    }
    // Above the caret's line as he sees it: past any lines the view hides right above it (a
    // retired done todo), or the pasted line lands under that todo and is hidden with it.
    const drawn = lines(block);
    let at = caretLine;
    while (at > 0 && (drawn[at - 1]?.hidden || drawn[at - 1]?.retired)) at -= 1;
    rows.splice(at, 0, ...freshRows(raws));
    putRows(block.id, rows);
    const line = caretLine + raws.length;
    tick().then(() => { measureTail(); const landed = textBlock(block.id); if (landed) focusBlock(block.id, bodyCaret(landed, line, local)); });
  }

  /** A paste of several blocks arrives as blocks: two blank lines are the boundary he writes. */
  function onPaste(event, block) {
    const text = event.clipboardData?.getData('text/plain') || '';
    // A line ⌘C or ⌘X took whole, pasted at a bare caret, goes in above the caret's line and the
    // caret stays where it was, as in VS Code.
    const here = theBox();
    // Whole rows on the clipboard (a ⌘X or ⌘C of whole lines, or markdown rows from anywhere): they
    // go in as rows with their marker, todo state and indent, not as text typed into a line.
    const clip = rowClip(text) || (lineClip && text === lineClip ? { lines: text.replace(/\n$/, '').split('\n'), newline: true } : null);
    if (clip && here) {
      const row = lines(block)[caretLine];
      const wholeLine = here.selectionStart === 0 && here.selectionEnd === (here.value ?? '').length && (here.value ?? '').length > 0;
      const bare = here.selectionStart === here.selectionEnd;
      // Over a whole line's words, markdown rows replace the row (a plain line's own words stay a
      // text paste, as ORACLE.md M8 has it).
      const plan = bare ? rowPastePlan(clip, { empty: (row?.text ?? '') === '', item: Boolean(row?.item || row?.marker) })
        : wholeLine && rowClip(text) && (row?.item || row?.marker) ? 'replace' : null;
      if (plan) {
        event.preventDefault();
        pasteRows(block, clip.lines, plan, bare ? here.selectionStart ?? 0 : 0);
        return;
      }
    }
    // The same line pasted over a selection replaces it with the line's words, without the newline,
    // as a paste over a selection across lines does (ORACLE.md M8): the textarea's own paste split
    // the line there and left an empty line behind.
    if (lineClip && text === lineClip && here && here.selectionStart !== here.selectionEnd && !event.currentTarget.isContentEditable) {
      event.preventDefault();
      const words = text.replace(/\s+$/, '');
      const from = bodyCaret(block, caretLine, here.selectionStart), to = bodyCaret(block, caretLine, here.selectionEnd);
      put({ id: block.id, body: `${block.body.slice(0, from)}${words}${block.body.slice(to)}` });
      tick().then(() => { measureTail(); if (textBlock(block.id)) focusBlock(block.id, from + words.length); });
      return;
    }
    if (!/\n\s*\n\s*\n/.test(text)) {
      // Several lines, one note: the textarea is one line, so pasting through it flattened the
      // markdown and a cut todo came back as plain words. The lines go into the body as they are
      // written, markers, indent and all.
      if (/\n/.test(text.replace(/\s+$/, '')) && !event.currentTarget.isContentEditable) {
        event.preventDefault();
        const words = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
        const box = theBox();
        const caret = bodyCaret(block, caretLine, box?.selectionStart ?? 0);
        const body = `${block.body.slice(0, caret)}${words}${block.body.slice(caret)}`;
        put({ id: block.id, body });
        tick().then(() => { measureTail(); placeCaret(block.id, caret + words.length); });
        return;
      }
      if (event.currentTarget.isContentEditable) {
        event.preventDefault(); event.currentTarget.setRangeText(text); onInput({target:event.currentTarget}, block);
      }
      return;
    }                 // one block: the textarea handles it
    event.preventDefault();
    const caret = bodyCaret(block, caretLine, theBox()?.selectionStart ?? 0);
    const parts = text.split(/\n\s*\n\s*\n+/).map((part) => part.replace(/\s+$/, ''));
    const head = block.body.slice(0, caret);
    const tailText = block.body.slice(caret);
    const split = splitLines(block, caret, new Date().toISOString());
    put({ id: block.id, body: head + parts[0] });
    let previous = blocks.find((entry) => entry.id === block.id);
    let last = previous;
    for (const part of parts.slice(1)) {
      const after = ordered(blocks).find((entry) => zoneOf(entry) === zoneOf(previous) && entry.ord > previous.ord);
      last = create({ body: part, zone: zoneOf(block), ord: after ? (previous.ord + after.ord) / 2 : previous.ord + 1 });
      previous = last;
    }
    if (tailText) {
      const prefix = last.lines.slice(0, -1);
      const end = last.lines.at(-1);
      const first = split.after[0];
      const joined = { ...end, body: end.body + first.body, createdAt: joinedCreatedAt(end, first) };
      put({ id: last.id, body: `${last.body}${tailText}`, lines: [...prefix, joined, ...split.after.slice(1)] });
    }
    flush();
    focusBlock(last.id, last.body.length - tailText.length);
  }

  /** Touch has no hover, so the grip and the chevron wait behind the row's gutter: a tap there
   *  brings them up for that row alone, and a press anywhere else (another row's gutter included,
   *  whose own click then opens it) puts them away again.
   */
  function closeGutter(event) {
    if (gutterOpen === null) return;
    if (event.target.closest?.('[data-gutter-zone], [data-drag-handle], [data-fold]')) return;
    gutterOpen = null;
  }

  /** A click on a rendered block puts the caret where he pointed, not at the end of the line. */
  async function onBlockPointer(event, block) {
    verticalColumn = null;
    verticalX = null;
    // A press makes a new caret or selection: a ⇧↑ / ⇧↓ run from before it is over, or the next ⇧↑
    // went on from its old anchor and threw away what the mouse selected.
    extending = null;
    // The gutter's touch zone only brings the row's controls up: no caret in the text, no selection.
    if (event.target.closest('[data-gutter-zone]')) {
      event.preventDefault();
      return;
    }
    // The chevron folds; it is not a place to put the caret, and the click never reaches the text.
    if (event.target.closest('[data-fold]')) {
      event.preventDefault();
      event.stopPropagation();
      toggleFold(block, Number(event.target.closest('[data-line]')?.dataset.line || 0));
      return;
    }
    if (event.target.closest('[data-marker]')) {
      event.preventDefault();
      const line = Number(event.target.closest('[data-line]')?.dataset.line || 0);
      const cycled = cycleTodo(block.body, line);
      // The checkbox is a button: a selection across the lines stays what it was, though the redraw
      // replaces the text it sat in.
      const selection = window.getSelection();
      const held = selection && !selection.isCollapsed && !focusId
        ? [linePoint(selection.anchorNode, selection.anchorOffset), linePoint(selection.focusNode, selection.focusOffset)] : null;
      // An edit by mouse: ⌘Z puts back the caret or selection as the click found it, not the last key.
      cursorAtKey = cursorNow();
      put({ id: block.id, body: cycled });
      if (held?.[0] && held[1]) {
        tick().then(() => {
          const from = renderedPoint(held[0].block, held[0].line, held[0].offset), to = renderedPoint(held[1].block, held[1].line, held[1].offset);
          if (from && to) window.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
        });
      }
      rememberClose(block, line, cycled);
      if (carriesState(zoneOf(block))) reportLine(block.id, line, 'check');
      return;
    }
    if (event.target.closest('[data-handle]') || event.target.closest('[data-await]')) return;
    // A double click takes a word by VS Code's word classes, not the browser's, which reads "it's"
    // or "foo.bar" as one word; a triple click takes the line's words (ORACLE.md, M3).
    if ((event.detail === 2 || event.detail === 3) && event.button === 0 && !event.shiftKey) {
      event.preventDefault();
      let at = null;
      if (event.target.closest('[data-testid="notes-box"]') && focusId === block.id) {
        const lineStart = block.body.split('\n').slice(0, caretLine).reduce((sum, text) => sum + text.length + 1, 0);
        at = lineStart + (lines(block)[caretLine]?.head.length ?? 0) + (theBox()?.selectionStart ?? 0);
      } else {
        try { at = offsetFromPoint(event.currentTarget, event.clientX, event.clientY, block.body); } catch { at = null; }
      }
      if (at === null) return;
      const where = lineOf(block.body, at);
      if (focusId !== block.id || caretLine !== where.index) await focusBlock(block.id, at, { pointed: true });
      const box = theBox();
      if (box?.tagName !== 'TEXTAREA') return;
      const head = lines(block)[where.index]?.head.length ?? 0;
      const [from, to] = event.detail === 2 ? wordAround(box.value, Math.max(0, at - where.start - head)) : [0, box.value.length];
      box.setSelectionRange(from, to, 'forward');
      // A press that began inside a selection is collapsed by the browser when the button comes up;
      // this press made the selection, so the release keeps it.
      window.addEventListener('mouseup', (up) => {
        up.preventDefault();
        requestAnimationFrame(() => { if (theBox() === box) box.setSelectionRange(from, to, 'forward'); });
      }, { once: true, capture: true });
      return;
    }
    // A press inside a selection starts a new one, where the browser would start dragging the
    // selected words, which have nowhere to land (ORACLE.md, M6).
    const editor = event.target.closest('[data-testid="notes-box"]');
    if (event.button === 0 && !event.shiftKey) {
      if (editor && editor.selectionStart !== editor.selectionEnd) editor.setSelectionRange(editor.selectionStart, editor.selectionStart);
      else if (!editor && !window.getSelection()?.isCollapsed) window.getSelection()?.removeAllRanges();
    }
    // A click in the caret's own line is the browser's to handle: that line is already a textarea.
    if (editor) {
      // A native selection cannot escape a line's editing host. Restore the
      // rendered line when the drag crosses it and continue document selection.
      const bounds = editor.getBoundingClientRect();
      const x = event.clientX, y = event.clientY;
      let selecting = false, anchor = null, ended = false, pressed = null, swapped = null;
      const point = (x, y) => {
        const caret = document.caretPositionFromPoint?.(x, y);
        if (caret) return [caret.offsetNode, caret.offset];
        const range = document.caretRangeFromPoint?.(x, y);
        return range ? [range.startContainer, range.startOffset] : null;
      };
      const move = async (move) => {
        // Where the press put the caret, read before this move extends anything: a mouse-made
        // selection in a textarea has no direction on a Mac, so its ends cannot say which was pressed.
        if (pressed === null) {
          const box = theBox();
          pressed = { id: focusId, line: caretLine, at: box && box.selectionStart === box.selectionEnd ? box.selectionStart : undefined };
          pressedAt = pressed;
        }
        if (!selecting && (move.clientY < bounds.top || move.clientY > bounds.bottom)) {
          selecting = true;
          // The anchor is where the drag began in the words, not the press's pixel: the rendered
          // line is laid out differently, so that pixel can miss the words.
          const from = pressed;
          focusId = null;
          swapped = tick().then(() => {
            anchor = typeof from.at === 'number' ? { block: from.id, line: from.line, offset: from.at } : point(x, y);
          });
          move.preventDefault();
          await swapped;
          if (ended) return;
        }
        if (selecting) {
          move.preventDefault();
          extendTo(move.clientX, move.clientY);
        }
      };
      const extendTo = (cx, cy) => {
        // Resolved again on every move: a redraw of the line replaces the text node it was in.
        const kept = anchor && !Array.isArray(anchor) ? renderedPoint(anchor.block, anchor.line, anchor.offset) : null;
        const start = kept ? [kept.node, kept.offset] : Array.isArray(anchor) ? anchor : null;
        const end = point(cx, cy);
        try {
          if (start && end && scroller.contains(end[0])) window.getSelection()?.setBaseAndExtent(...start, ...end);
        } catch { /* a point the redraw took away; the next move has a fresh one */ }
      };
      // A flick can come up before the line has gone back to text: the selection still ends where
      // the button came up, instead of nowhere.
      const end = async (up) => {
        ended = true;
        window.removeEventListener('mousemove', move);
        if (selecting && swapped) { await swapped; extendTo(up.clientX, up.clientY); }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', end, { once: true });
      return;
    }
    // Keep the rendered text in place during a drag so native selection can cross blocks.
    const element = event.currentTarget;
    const x = event.clientX, y = event.clientY;
    // The caret's line is a textarea, and a native selection cannot enter one: a drag from here
    // into that line stopped dead at its start. Once the press becomes a drag that line goes back
    // to text, so the selection follows the pointer anywhere, as in VS Code.
    if (focusId !== null) {
      const release = (move) => {
        if (Math.hypot(move.clientX - x, move.clientY - y) <= 4) return;
        window.removeEventListener('mousemove', release);
        focusId = null;
      };
      window.addEventListener('mousemove', release);
      window.addEventListener('mouseup', () => window.removeEventListener('mousemove', release), { once: true });
    }
    window.addEventListener('mouseup', async (up) => {
      if (Math.hypot(up.clientX - x, up.clientY - y) > 4 || event.detail > 1) return;
      let caret = null;
      try { caret = offsetFromPoint(element, x, y, block.body); } catch { caret = null; }
      await focusBlock(block.id, caret, { pointed: true });
    }, { once: true });
  }

  /** A click on the open page rather than on a word. The cursor has to land somewhere: under the
   * last line of the timeline that is the empty line he writes in, and beside a line (its gutter,
   * the room to its right, the hair between two rows) it is that line.
   */
  async function onSurfaceClick(event) {
    if (event.button !== 0 || event.shiftKey || barHeld || event.detail > 1 || archiveBusy) return;
    extending = null;
    const target = event.target;
    // A comment card in the rail, or a comment popover, is not the document: no caret moves.
    if (target.closest('[data-sidechat], [data-sidechat-slot], [data-doc-pop]')) return;
    // The drag handle is a grip, not a button: it sits invisible in the gutter beside every line,
    // and a plain click on it used to be swallowed whole. It belongs to the line behind it.
    const control = target.closest('button, a, input, [data-menu], [data-gap-editor], [data-testid="notes-box"]');
    if (control && !target.closest('[data-drag-handle]')) return;
    if (target.closest('[data-line]') && !target.closest('[data-drag-handle]')) return;   // the block placed it
    const selection = window.getSelection();
    // He was selecting, not pointing; but a press on the grip selects nothing, so a selection still
    // standing is an old one and the click moves the caret as any click does.
    if (selection && !selection.isCollapsed && !target.closest('[data-drag-handle]')) return;
    const x = event.clientX, y = event.clientY;
    const section = target.closest('.tail, .flow') || target.closest('.zone') || sectionAt(y);
    if (!section || section === 'present') { await focusBlock(liveBlock(blocks)?.id, null); return; }
    const near = nearestRow(section, y);
    if (!near) { await focusBlock(liveBlock(blocks)?.id, null); return; }
    await caretAtRow(near, x, y);
  }

  /** Which part of the page a bare click on the scroller's own margin belongs to, by height. */
  function sectionAt(y) {
    const under = (element) => element && y >= element.getBoundingClientRect().top;
    if (flow && y > flow.getBoundingClientRect().bottom && (!futureEl || y < futureEl.getBoundingClientRect().top)) return 'present';
    if (under(futureEl)) {
      const sections = [...(scroller?.querySelectorAll(':scope > .zone') || [])].filter(under);
      return sections[sections.length - 1] || futureEl;
    }
    return flow;
  }

  /** The line of a section nearest a height, so a click in its margins still has somewhere to go. */
  function nearestRow(root, y) {
    let best = null;
    for (const row of root.querySelectorAll('[data-line]')) {
      const rect = row.getBoundingClientRect();
      if (!rect.height) continue;
      const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      if (!best || distance < best.distance) best = { row, rect, distance };
      if (distance === 0) break;
    }
    return best;
  }

  /** Put the caret in a line a click pointed at from outside its words, at the column it asks for. */
  async function caretAtRow({ row, rect }, x, y) {
    const element = row.closest('[data-block]');
    const block = blocks.find((entry) => entry.id === element?.dataset.block);
    if (!block) return;
    const read = element.querySelector('[data-testid="notes-read"]') || element;
    const inside = Math.min(Math.max(y, rect.top + 1), rect.bottom - 1);
    let caret = null;
    try { caret = offsetFromPoint(read, x, inside, block.body); } catch { caret = null; }
    await focusBlock(block.id, caret, { pointed: true });
  }

  /** ⇧click extends the selection from where the caret is. A textarea holds one line, and a native
   * selection cannot start inside it and end outside, so the page does it: the caret's line goes back
   * to being text, the anchor is put where the caret stood, and the head is the click.
   *
   * On a phone the same thing has to happen without a ⇧ and without a mouse. The system's own
   * selection handles belong to the textarea and stop dead at the end of its one line, and their drag
   * never reaches the page, so the bar's cmd stands in for ⇧: hold or tap ⌘, then tap where the tail
   * belongs.
   */
  let pressedAt = null;   // where the last mouse drag inside the caret's line was pressed

  async function onShiftPointer(event) {
    if ((!event.shiftKey && !barHeld) || event.button !== 0) return;
    extending = null;
    if (!focusId) {
      // A selection across rendered lines (a drag, ⇧↓) extends from its own anchor.
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !scroller?.contains(selection.anchorNode)) return;
      if (event.target.closest('button, a, input, [data-gap-editor]') && !event.target.closest('[data-drag-handle]')) return;
      const head = pointAt(event.clientX, event.clientY);
      if (!head || !scroller.contains(head.node)) return;
      event.preventDefault();
      event.stopPropagation();
      selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, head.node, head.offset);
      // Back onto the anchor itself: a caret, in a line that takes typing.
      const at = selection.isCollapsed ? linePoint(head.node, head.offset) : null;
      const block = at ? textBlock(at.block) : null;
      if (block) await focusBlock(block.id, bodyCaret(block, at.line, at.offset));
      return;
    }
    if (event.target.closest('button, a, input, [data-gap-editor]') && !event.target.closest('[data-drag-handle]')) return;
    const box = theBox();
    // The anchor stays where the selection was started, as in VS Code: one made with ⇧→ keeps its
    // start whichever side the click is on, one made with ⇧← its end. A selection with no direction
    // (a phone's handles, a mouse on a Mac) keeps all of itself: tapping below holds its start,
    // above holds its end.
    const direction = box?.selectionDirection;
    const back = direction === 'backward' || (direction !== 'forward' && event.clientY < (box?.getBoundingClientRect().top ?? 0));
    // A mouse drag in the line says which end it pressed, which a Mac does not record.
    const press = direction !== 'forward' && direction !== 'backward' && pressedAt?.id === focusId && pressedAt?.line === caretLine
      && (pressedAt.at === box?.selectionStart || pressedAt.at === box?.selectionEnd) ? pressedAt.at : null;
    const kept = press ?? (back ? (box?.selectionEnd ?? 0) : (box?.selectionStart ?? 0));
    const from = { block: focusId, line: caretLine, offset: kept };
    event.preventDefault();
    event.stopPropagation();
    const x = event.clientX, y = event.clientY;
    focusId = null;
    await tick();
    const anchor = renderedPoint(from.block, from.line, from.offset);
    const head = pointAt(x, y);
    // Inside the caret's own line the selection is the textarea's again, and a click on the caret
    // itself leaves the caret: a collapsed document selection has no textarea to type into.
    const at = head ? linePoint(head.node, head.offset) : null;
    const block = at && at.block === from.block && at.line === from.line ? textBlock(from.block) : null;
    if (block) {
      await focusBlock(block.id, bodyCaret(block, from.line, at.offset));
      if (at.offset !== from.offset) theBox()?.setSelectionRange(Math.min(at.offset, from.offset), Math.max(at.offset, from.offset), at.offset < from.offset ? 'backward' : 'forward');
      return;
    }
    if (anchor && head) window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
  }

  /**
   * ⇧ with a vertical motion, and ⌃⇧n / ⌃⇧p with it. A textarea holds one line, so a selection
   * that starts in it can never reach the line below: it stopped dead at the end of the words. The
   * first step hands the selection to the document, the same kind ⇧click makes, and later steps
   * move its head a line at a time; ⌘X and ⌫ already know what to do with it.
   */
  let extending = null;   // { anchor: {block, line, offset}, head: {...}, column }

  function visibleRows() {
    return [...(scroller?.querySelectorAll('[data-line]') || [])].map((row) => ({
      row,
      block: row.closest('[data-block]')?.dataset.block || null,
      line: Number(row.dataset.line)
    })).filter((entry) => entry.block !== null);
  }

  async function extendVertically(direction, start = null) {
    const anchor = extending?.anchor || start;
    const head = extending?.head || start;
    if (!anchor || !head) return false;
    const column = extending?.column ?? start?.offset ?? 0;
    // The caret's line is a textarea until this moment; it has to be rendered text before a
    // document range can name a point inside it.
    if (focusId) {
      focusId = null;
      await tick();
      // The line just left is drawn by its inlineView action after the update; a point set on the
      // node it replaces falls back to offset 0.
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const rows = visibleRows();
    const at = rows.findIndex((entry) => entry.block === head.block && entry.line === head.line);
    const beyond = at < 0 ? null : rows[at + direction];
    // Past the first or last line VS Code takes the head to that line's start or end.
    const next = beyond || (at < 0 ? null : rows[at]);
    if (!next) return false;
    const words = wordsOf(next);
    const offset = beyond ? Math.min(column, words.length) : direction < 0 ? 0 : words.length;
    if (anchor.block === next.block && anchor.line === next.line && anchor.offset === offset) {
      // Back onto the anchor: what is left is a caret, in its line, not a page with nothing focused.
      extending = null;
      await caretAtWords(anchor);
      return true;
    }
    const from = renderedPoint(anchor.block, anchor.line, anchor.offset);
    const to = renderedPoint(next.block, next.line, offset);
    if (!from || !to) return false;
    window.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
    extending = { anchor, head: { block: next.block, line: next.line, offset }, column };
    // A save the key closed (the typing before it) redraws these rows when it is acknowledged.
    keptRange = { anchor, focus: extending.head, input: handInput };
    return true;
  }

  /** Indent or outdent every selected line, block by block, then select the same lines again. */
  async function indentSelection(targets, direction, keep = null) {
    const byBlock = new Map();
    for (const { block, index } of targets) {
      const span = byBlock.get(block) || { from: index, to: index };
      byBlock.set(block, { from: Math.min(span.from, index), to: Math.max(span.to, index) });
    }
    let moved = false;
    let leadSeen = false;
    for (const [id, span] of byBlock) {
      const block = blocks.find((entry) => entry.id === id);
      if (!block || !isText(block)) continue;
      const next = indentRange(String(block.body ?? ''), span.from, span.to, direction, { above: linesAbove(block) });
      // The run moves as one across notes too: if its first list item may not go deeper, nothing
      // does (the depth-3 walk had the second note's items indenting under a refused lead).
      const hasItem = String(block.body ?? '').split('\n').slice(span.from, span.to + 1).some((line) => parseListItem(line));
      if (direction > 0 && hasItem && !leadSeen) {
        leadSeen = true;
        if (!next) return;
      }
      if (!next) continue;
      put({ id, body: next.body });
      moved = true;
    }
    if (!moved) return;
    await tick();
    // A selection the keys made keeps its own two ends: indenting changes a line's head, never its
    // words, so the same points in the words are the same text (VS Code shifts them with it).
    if (keep) { await selectWords(keep.anchor, keep.focus); return; }
    const first = targets[0], last = targets[targets.length - 1];
    const lastWords = scroller?.querySelector(`[data-block="${CSS.escape(last.block)}"] [data-line="${last.index}"] [data-text]`)?.textContent ?? '';
    const from = renderedPoint(first.block, first.index, 0);
    const to = renderedPoint(last.block, last.index, lastWords.length);
    if (from && to) window.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
    keptRange = { anchor: { block: first.block, line: first.index, offset: 0 }, focus: { block: last.block, line: last.index, offset: lastWords.length }, input: handInput };
  }

  /** The text node and offset inside a rendered line that a column of its words points at. */
  function renderedPoint(blockId, line, offset) {
    const text = scroller?.querySelector(`[data-block="${blockId}"] [data-line="${line}"] [data-text]`);
    if (!text) return null;
    let left = offset;
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let last = null;
    while (node) {
      if (left <= node.nodeValue.length) return { node, offset: left };
      left -= node.nodeValue.length;
      last = node;
      node = walker.nextNode();
    }
    return last ? { node: last, offset: last.nodeValue.length } : { node: text, offset: 0 };
  }

  const pointAt = (x, y) => {
    const found = document.caretPositionFromPoint?.(x, y);
    if (found) return { node: found.offsetNode, offset: found.offset };
    const range = document.caretRangeFromPoint?.(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  };

  /**
   * ⌘X over a selection that spans rendered lines. A browser can only cut inside something
   * editable, and the document is rendered text, so nothing happened at all. The words go to the
   * clipboard and the lines they cover leave the document; ⌘Z brings them back.
   */
  /** What a selection of rendered lines is worth on the clipboard: the markdown it is stored as,
   * indent and `- [ ]` and all, not the glyphs the page draws.
   */
  function markdownOf(target) {
    const out = [];
    for (const item of target) {
      const block = blocks.find((entry) => entry.id === item.block);
      if (!block) continue;
      const raw = block.body.split('\n')[item.index];
      if (raw === undefined) continue;
      out.push(splitScore(raw).text.replace(/\s+$/, ''));
    }
    return out.join('\n');
  }

  /** ⌘C over rendered lines: the same markdown the cut writes, so a round trip keeps the state. */
  async function onDocumentCopy(event) {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !scroller) return;
    const target = selectedArchiveLines();
    if (!target || target.length < 1) return;
    const words = markdownOf(target);
    if (!words) return;
    event.preventDefault();
    if (event.clipboardData) event.clipboardData.setData('text/plain', words);
    else { try { await navigator.clipboard?.writeText?.(words); } catch { error = 'the clipboard said no'; } }
  }

  async function onDocumentCut(event) {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !scroller) return;
    const target = selectedArchiveLines();
    if (!target) return;
    event.preventDefault();
    const words = markdownOf(target) || selection.toString();
    if (event.clipboardData) event.clipboardData.setData('text/plain', words);
    else { try { await navigator.clipboard?.writeText?.(words); } catch { error = 'the clipboard said no'; return; } }
    await cutLines(target);
  }

  /** Take named lines out of the document. Generated rows are not his to cut, so they stay. */
  async function cutLines(target) {
    const byBlock = new Map();
    for (const item of target) {
      if (!byBlock.has(item.block)) byBlock.set(item.block, new Set());
      byBlock.get(item.block).add(item.index);
    }
    const removed = [];
    for (const [id, indices] of byBlock) {
      const block = blocks.find((entry) => entry.id === id);
      // The state area is generated, but it is still his document: a blank line or a row he is
      // done with goes when he deletes it, and the builder puts back whatever is still true.
      if (!block || !isText(block)) continue;
      // A line is a line. Taking one out never takes its neighbours with it, blank or not: the
      // block is a derived run of lines, not something he can delete, and it goes only when its
      // last line has gone. Before this, a block whose remaining lines were all blank was dropped
      // whole, so deleting the one written line under a heading took the blank lines around it
      // too.
      const bodies = block.body.split('\n');
      const keptRows = bodies.map((_, index) => index).filter((index) => !indices.has(index));
      if (keptRows.length === 0) {
        // What it was goes on the undo step, so ⌘Z puts it back at once and the caret with it;
        // without it the note only came back with the store's answer, after the caret had nowhere
        // to go.
        if (!preEdit.has(id)) preEdit.set(id, block);
        blocks = blocks.filter((entry) => entry.id !== id);
        dirty.delete(id);
        removed.push(id);
        continue;
      }
      // Name the rows that stay, so their ids and their own created_at travel with their words
      // instead of being re-guessed by diffing the bodies against a block that is a line shorter.
      const rows = block.lines?.length === bodies.length ? keptRows.map((index) => block.lines[index]) : null;
      put({ id, body: keptRows.map((index) => bodies[index]).join('\n'), ...(rows ? { lines: rows } : {}) });
    }
    window.getSelection()?.removeAllRanges();
    focusId = null;
    await flush({ removed });
    await tick();
    const gap = tailGap(blocks);
    if (gap) create({ ...gap, recordHistory: false });
    await tick();
    measureTail();
  }

  // --- moving, archiving -------------------------------------------------------------------------

  function dragOptions(block) {
    return {
      source(index) {
        const rows = block.lines || [];
        if (!rows[index]) return null;
        // A grip on the first line of a block is the block's: dropped on another block it takes
        // every line it has and lands beside that block rather than inside its words. Dropped
        // within its own block it is still just a line, because there is nowhere else for a whole
        // block to go.
        const end = treeEnd(rows, index);
        return {
          id: rows[index].id, zone: zoneOf(block), block: block.id,
          first: index === 0 && rows.length > 1,
          ids: rows.slice(index, end).map(line => line.id),
          rows: rows.slice(index, end).map((_, step) => index + step),
          blockIds: rows.map(line => line.id),
          blockRows: rows.map((_, step) => step)
        };
      },
      target(id, index) {
        const target = blocks.find(entry => entry.id === id);
        const line = target?.lines?.[index];
        return line ? { id: line.id, zone: zoneOf(target) } : null;
      },
      async move(moveTree) {
        await flush();
        try {
          const body = await api(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moveTree }) });
          if (!body.moved) return;
          adoptFull(body);
          focusId = null;
          await tick();
          measureTail();
        } catch (cause) { error = String(cause.message || cause); }
      }
    };
  }

  function openMenu(event, block) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    // The handle sits beside a line, so the menu is aimed at that line: the row the mouse is on
    // when there is one, and the head of the run otherwise. Nothing here acts on the whole block.
    const index = mouseLine?.block === block.id ? mouseLine.index : (focusId === block.id ? caretLine : 0);
    // The menu is fixed to the screen, so a handle near the bottom edge used to open it below
    // the fold where it could not be clicked at all. It flips above the handle instead, and
    // stays inside the window on both axes.
    const MENU = { width: 200, height: 190 };
    const belowFits = rect.bottom + 4 + MENU.height <= window.innerHeight;
    const y = belowFits ? rect.bottom + 4 : Math.max(8, rect.top - MENU.height - 4);
    const x = Math.max(8, Math.min(rect.left, window.innerWidth - MENU.width - 8));
    menu = { id: block.id, index, x, y };
  }

  function move(id, direction) {
    const moved = moveBlock(blocks, id, direction);
    if (!moved) return;
    put(moved);
    flush();
    measureTail();
  }

  /**
   * ⌥↑ / ⌥↓ : move the line the caret is on. A line is its own row in the store, so this is a
   * write about that line and nothing else; when it reaches the edge of its block it crosses into
   * the one above or below, which changes the shape of two blocks at once, so the answer is the
   * document rather than a patch.
   */
  async function moveLineHere(block, caret, direction, { keepCaret = false } = {}) {
    const { index, offset } = lineAt(block.body, caret);
    // Driven from the pointer, the line moves and the caret stays in the line he is writing in.
    const held = keepCaret && focusId
      ? { id: focusId, at: bodyCaret(blocks.find((entry) => entry.id === focusId) || block, caretLine, theBox()?.selectionStart ?? 0) }
      : null;
    await flush();
    let body;
    try {
      body = await api(API, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ moveLine: { block: block.id, index, direction } })
      });
    } catch (cause) { error = String(cause.message || cause); return; }
    if (!body.moved) return;
    const keep = focusId;
    // The move answer carries the document; without the state zone the area would blink out.
    adoptFull(body);
    const landed = ordered(blocks).find((entry) => entry.lines?.some((line) => line.id === body.moved.id));
    const at = landed ? landed.lines.findIndex((line) => line.id === body.moved.id) : -1;
    await tick();
    if (held && blocks.some((entry) => entry.id === held.id)) {
      await focusBlock(held.id, held.at);
    } else if (landed && at >= 0) {
      const head = landed.body.split('\n').slice(0, at).join('\n');
      // `at`, not `head`: an empty line above makes head the empty string, which still has a newline after it.
      await focusBlock(landed.id, (at > 0 ? head.length + 1 : 0) + offset);
    } else if (keep) {
      await focusBlock(keep, caret);
    }
    // The store's step for this move redoes to where the line landed, not where it started.
    const step = undoStack.at(-1);
    if (step && !step.delta && step.token && body.historyToken === step.token) step.cursorAfter = cursorNow();
    measureTail();
  }

  let archiveBusy = $state(false);
  let mouseLine = $state(null);
  let lastEdit = 0;
  let rolledDay = notesDay();
  let pointerAt = null;
  function mouseArchiveTarget(event) {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    // A redraw under a resting pointer makes the browser send a move to the same spot. That is not
    // his hand moving: a key he pressed since stays aimed at the caret (select, ↵, then ⌥↑ moved
    // the line under the resting pointer instead of his).
    if (pointerAt && pointerAt.x === event.clientX && pointerAt.y === event.clientY) return;
    pointerAt = { x: event.clientX, y: event.clientY };
    // A line in his hand is not a hover: the pointer crossing a retired 2pt line on its way to the
    // drop would bring that line back to full size under it, and the document would jump by a row at
    // every one he passed.
    if (document.body.classList.contains('notes-dragging')) return;
    const line = event.target.closest?.('[data-line]');
    const block = line?.closest('[data-block]');
    mouseLine = block ? { block: block.dataset.block, index: Number(line.dataset.line) } : null;
  }
  async function archiveLineHere(target, { promote = false, marker = false } = {}) {
    // A document only archives to its "@@archive" marker line, and only from the pin above
    // (there is no Past to send ⌘E to); the server leaves the line where it is when the
    // document has no marker.
    if (!target || archiveBusy || (doc && (!marker || promote))) return;
    if (serverDownRecently()) { error = 'offline: archiving needs the server'; return; }
    // The editor stays his while the saves ahead settle; only the server's own move locks it, and
    // a save that has not been answered in 400ms means the server is not there to move anything.
    await settledSoon([...pendingSaves]);
    await flush();
    await settledSoon([...pendingSaves]);
    if (dirty.size || inflight.size || archiveBusy) { error = 'still saving: try the archive again in a moment'; return; }
    archiveBusy = true;
    // In a document the archive fires because the caret moved to another line, so that line keeps
    // the caret: it is found again by its id after the move, because the block it is in may now
    // start somewhere else (and so be named differently).
    const held = marker && focusId ? { line: activeLineId(), cursor: cursorNow() } : null;
    try {
      const answer = await api(API, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [promote ? 'promoteTree' : marker ? 'archiveToMarker' : 'archiveTree']: (Array.isArray(target) ? target : [target]).map(line => ({ ...line, block: canonicalBlock(line.block) })) })
      });
      if (!(promote ? answer.promoted : answer.archived)) return;
      adoptFull(answer);
      earlier = answer.earlier;
      mouseLine = null;
      if (!(await keepHeldLine(held))) {
        window.getSelection()?.removeAllRanges();
        focusId = null;
      }
      const gap = tailGap(blocks);
      if (gap) create({ ...gap, recordHistory: false });
      const scratch = doc ? null : todayGap(blocks);
      if (scratch) create({ ...scratch, recordHistory: false });
      await tick();
      measureTail();
    } catch (cause) { error = String(cause.message || cause); }
    finally { archiveBusy = false; }
  }
  /** The caret back in the line it was in before a move, wherever that line's block starts now. */
  async function keepHeldLine(held) {
    if (!held?.line || !held.cursor?.id) return false;
    const block = blocks.find((entry) => isText(entry) && (entry.lines || []).some((line) => line.id === held.line));
    if (!block) return false;
    const line = block.lines.findIndex((entry) => entry.id === held.line);
    try { return await restoreCursor({ ...held.cursor, id: block.id, line }); } catch { return false; }
  }
  /** The NOW heading's click: everything in NOW goes to the Past. Only NOW has an "everything" that archiving means. */
  const archiveNow = {
    title: 'Archive everything in NOW',
    run: () => archiveLineHere(timeline.filter(isText).flatMap((block) => block.body.split('\n').map((_, index) => ({ block: block.id, index }))))
  };
  /** The future section is measured (peek, tail); every zone registers through the one action. */
  function registerZone(node, name) {
    if (name === 'future') futureEl = node;
    return { destroy() { if (futureEl === node) futureEl = null; } };
  }
  function selectedArchiveLines() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const targets = [];
    for (const row of scroller?.querySelectorAll('[data-line]') || []) {
      const text = row.querySelector('[data-text]') || row;
      for (let i = 0; i < selection.rangeCount; i++) {
        if (selection.getRangeAt(i).intersectsNode(text)) {
          targets.push({ block: row.closest('[data-block]').dataset.block, index: Number(row.dataset.line) });
          break;
        }
      }
    }
    return targets.length ? targets : null;
  }
  /**
   * The lines a document selection covers, when the selection is the document's own and not a
   * textarea's. Null when he is typing in a line, when nothing is selected, or when the selection
   * covers no line the page owns, so the key falls through to the browser.
   */
  function documentSelectionLines() {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;
    return selectedArchiveLines();
  }

  /** The clipboard first: a cut that could not copy is a delete, and that is not what he pressed. */
  async function keyboardCut(target, words) {
    try { await navigator.clipboard.writeText(markdownOf(target) || words); }
    catch { error = 'the clipboard said no, so nothing was cut'; return; }
    error = null;
    await cutLines(target);
  }

  /** The row the pointer is resting on, as a block, a line index and that line's body caret. Spark's
   * combination: a chord pressed while the mouse sits over a row acts on THAT row, not on the
   * caret's line, so he can tick, fold, move or archive something without leaving the line he is
   * writing in. hover+keyboard combo.
   */
  function hoverRow() {
    if (!mouseLine) return null;
    const block = blocks.find((entry) => entry.id === mouseLine.block);
    if (!block || !isText(block)) return null;
    const rows = lines(block);
    if (!rows.length) return null;
    const index = Math.max(0, Math.min(mouseLine.index, rows.length - 1));
    return { block, index, caret: bodyCaret(block, index, 0) };
  }

  /** Is the caret inside something that takes typing right now? Bare letters belong to it. */
  function typingNow() {
    const active = document.activeElement;
    return !!active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
  }

  /**
   * The line chords, aimed at the hovered row. True when the key was spent here, so the caret's
   * own line never sees it: hovering outranks the caret for as long as the pointer rests there,
   * and the pointer moving off a row (or a click) clears it.
   */
  function hoverChord(event) {
    if (find || commentFor || paneChat || event.isComposing || archiveBusy) return false;
    const hover = hoverRow();
    if (!hover) return false;
    const { block, index, caret } = hover;
    // The pointer resting on the caret's own line aims the chord where the caret already is: the
    // caret's own keys do it and keep a selection, which the hover path dropped (⌥↑ right after a
    // drag inside the line collapsed it).
    if (focusId === block.id && caretLine === index) return false;
    const meta = (event.metaKey || barHeld) && !event.ctrlKey;
    const key = event.key;
    const take = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    if (meta && !event.altKey && !event.shiftKey && key === '.') {
      take(); if (!event.repeat) cycleHere(block, caret, { keepCaret: true }); return true;
    }
    if (meta && !event.altKey && !event.shiftKey && key === '/') {
      take(); if (!event.repeat) toggleFold(block, index); return true;
    }
    if (meta && event.shiftKey && !event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      take(); if (!event.repeat) move(block.id, key === 'ArrowUp' ? -1 : 1); return true;
    }
    if (event.altKey && !meta && !event.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      take(); if (!event.repeat) moveLineHere(block, caret, key === 'ArrowUp' ? -1 : 1, { keepCaret: true }); return true;
    }
    if (meta && event.altKey && !event.shiftKey && /^Digit[0-4]$/.test(event.code)) {
      take(); if (!event.repeat) headingHere(block, index, Number(event.code.slice(5))); return true;
    }
    if (meta && !event.altKey && !event.shiftKey && key === 'Enter') {
      take();
      if (!event.repeat) { if (carriesState(zoneOf(block))) openComment(block); else askHere(block); }
      return true;
    }
    return false;
  }

  // --- VS Code editing: the line commands, and a selection that spans lines ---------------------
  //
  // The caret's line is a one-line textarea, so the commands that act on whole lines, and a
  // selection that leaves its line, are the page's to carry out. Each does what VS Code does;
  // tests/notes-parity runs every two- and three-key sequence against that, and ORACLE.md beside
  // it lists where notes differs.

  let lineClip = null;            // the text a whole-line ⌘C or ⌘X put on the clipboard
  let handInput = 0;              // every key and pointer press he makes, counted
  let cursorAtKey = null;         // the caret or selection as the latest key found it
  let batchCursor = null;         // ... and as the first edit of the unsaved batch found it

  /** The caret in its line, or the document's selection, in terms that survive a redraw. */
  function cursorNow() {
    const box = theBox();
    if (focusId && box && document.activeElement === box) {
      return { id: focusId, line: caretLine, start: box.selectionStart ?? 0, end: box.selectionEnd ?? 0, direction: box.selectionDirection };
    }
    const range = documentRange();
    if (range) return { range };
    // The blank between two notes is a place the caret stands too (ORACLE.md D5).
    const active = document.activeElement;
    if (active?.hasAttribute?.('data-gap-editor')) {
      return { gap: { before: active.dataset.before || null, after: active.dataset.after || null } };
    }
    return null;
  }

  /** Put a remembered caret or selection back. False when its line is gone. */
  async function restoreCursor(cursor) {
    if (!cursor) return false;
    if (cursor.gap) {
      await tick();
      const name = (id) => (id ? CSS.escape(canonicalBlock(id)) : null);
      const before = name(cursor.gap.before), after = name(cursor.gap.after);
      const gap = scroller?.querySelector(`[data-gap-editor]${before ? `[data-before="${before}"]` : ''}${after ? `[data-after="${after}"]` : ''}`);
      if (!gap) return false;
      focusId = null;
      gap.focus({ preventScroll: true });
      gap.setSelectionRange(0, 0);
      return true;
    }
    if (cursor.range) {
      if (!textBlock(cursor.range.anchor.block) || !textBlock(cursor.range.focus.block)) return false;
      await selectWords(cursor.range.anchor, cursor.range.focus);
      return true;
    }
    const block = textBlock(canonicalBlock(cursor.id)) || textBlock(cursor.id);
    if (!block || !lines(block)[cursor.line]) return false;
    await focusBlock(block.id, bodyCaret(block, cursor.line, cursor.start));
    if (cursor.start !== cursor.end) theBox()?.setSelectionRange(cursor.start, cursor.end, cursor.direction);
    return true;
  }
  let keptRange = null;           // the selection the page last set, and the press it answered

  /**
   * A line rewritten under a selection is redrawn when the store acknowledges it (its rows get
   * their stored ids), and the redraw drops the selection's end into offset 0 of a new node. The
   * page puts back the selection it set, unless he has pressed something since.
   */
  function restoreKeptRange() {
    if (!keptRange || keptRange.input !== handInput || focusId || typingNow()) { keptRange = null; return; }
    // A note renamed by the write (its first row changed) is followed to its new name.
    const follow = (point) => ({ ...point, block: textBlock(point.block) ? point.block : canonicalBlock(point.block) });
    keptRange = { ...keptRange, anchor: follow(keptRange.anchor), focus: follow(keptRange.focus) };
    const now = documentRange();
    const same = (a, b) => a && b && sameRow(a, b) && a.offset === b.offset;
    if (now && same(now.anchor, keptRange.anchor) && same(now.focus, keptRange.focus)) return;
    const from = renderedPoint(keptRange.anchor.block, keptRange.anchor.line, keptRange.anchor.offset);
    const to = renderedPoint(keptRange.focus.block, keptRange.focus.line, keptRange.focus.offset);
    if (from && to) window.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
  }

  const textBlock = (id) => {
    const block = blocks.find((entry) => entry.id === id);
    return block && isText(block) ? block : null;
  };
  /** The notes as drawn, top to bottom. */
  const drawnOrder = () => [...(scroller?.querySelectorAll('[data-block]') || [])].map((node) => node.dataset.block);
  const wordsOf = (point) => {
    const block = textBlock(point.block);
    return (block && lines(block)[point.line]?.text) ?? '';
  };
  const toBody = (point) => {
    const block = textBlock(point.block);
    return block ? { id: block.id, at: bodyCaret(block, point.line, point.offset) } : null;
  };
  const sameRow = (a, b) => a.block === b.block && a.line === b.line;
  /** A note's rows as the store knows them, one per body line: the id and created_at each line
   *  carries, which have to travel with its words when a command moves or copies lines. */
  const rowsOf = (block) => editLines(block, String(block.body ?? ''), new Date().toISOString(), 0);
  /** Rows for lines this page is making: new ids, made now. */
  const freshRows = (texts) => {
    const now = new Date().toISOString();
    return texts.map((text) => ({ id: newLineId(), body: text, createdAt: now }));
  };
  /** Write a note from its rows, the body their words in order. */
  const putRows = (id, rows) => put({ id, body: rows.map((row) => row.body).join('\n'), lines: rows, lineIds: rows.map((row) => row.id) });

  /** The document's own selection as two points in lines' words; null when a line has the keys. */
  function documentRange() {
    if (typingNow()) return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const anchor = linePoint(selection.anchorNode, selection.anchorOffset);
    const focus = linePoint(selection.focusNode, selection.focusOffset);
    return anchor && focus ? { anchor, focus } : null;
  }

  /** Select from one point in a line's words to another, the lines drawn as text. */
  async function selectWords(anchor, focus) {
    if (sameRow(anchor, focus) && anchor.offset === focus.offset) { await caretAtWords(focus); return; }
    // A row that has just been rewritten gets its words from its inlineView action, which replaces
    // the text node after the update; a selection set on the old node would fall to offset 0.
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (focusId) { focusId = null; await tick(); }
    // Whatever editable still has focus (the blank between notes, say) lets it go: the keys belong
    // to the selection now (the depth-3 walk: sel-blocks [Tab Up M-Z] left focus in the blank).
    if (typingNow()) document.activeElement.blur();
    const from = renderedPoint(anchor.block, anchor.line, anchor.offset);
    const to = renderedPoint(focus.block, focus.line, focus.offset);
    if (from && to) window.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
    keptRange = { anchor, focus, input: handInput };
    verifyKeptRange();
  }

  // Rows written just before a selection is set can be drawn again a moment later (a note put back
  // by undo mounts, a store answer re-keys its rows), which drops the selection's ends to offset 0.
  // The selection is looked at again two frames and 150ms on, and put back if he has not pressed
  // anything since.
  let verifying = 0;
  function verifyKeptRange() {
    verifying += 1;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      restoreKeptRange();
      setTimeout(() => { restoreKeptRange(); verifying -= 1; }, 150);
    }));
  }

  /** The caret into a line's words, the line a textarea again. */
  async function caretAtWords(point) {
    const block = textBlock(point.block);
    if (!block) return;
    window.getSelection()?.removeAllRanges();
    extending = null;
    await focusBlock(block.id, bodyCaret(block, point.line, point.offset));
  }

  /** The drawn line beside a line, blanks between notes not counted. */
  function rowBeside(point, direction) {
    const rows = visibleRows();
    const at = rows.findIndex((entry) => sameRow(entry, point));
    const next = at < 0 ? null : rows[at + direction];
    return next ? { block: next.block, line: next.line } : null;
  }

  /** One character step of a selection's moving end, over line edges, never into a marker. */
  function stepPoint(point, direction) {
    const words = wordsOf(point);
    if (direction < 0 && point.offset > 0) return { ...point, offset: point.offset - 1 };
    if (direction > 0 && point.offset < words.length) return { ...point, offset: point.offset + 1 };
    const beside = rowBeside(point, direction);
    return beside ? { ...beside, offset: direction < 0 ? wordsOf(beside).length : 0 } : point;
  }

  /** The lines a line command acts on: those a range covers, less a last one it only reaches the
   *  start of, as VS Code leaves it out. */
  function lineRows(first, last) {
    const rows = rowsBetween(first, last);
    return rows.length > 1 && last.offset === 0 ? rows.slice(0, -1) : rows;
  }

  /** The rows a selection takes whole, marker and indent with them (null when it is partial): a
   * selection that starts at or before a row's first character and ends at or after the last
   * character of its own last row is a selection of rows, however it was made.
   */
  function wholeOf(first, last) {
    const rows = wholeRowSpan(rowsBetween(first, last), first, last, wordsOf(last).length);
    // Only where there is a bullet or a todo to take along: plain prose lines are text, and
    // deleting a prose line's words leaves its empty line as any editor does.
    return rows?.some((row) => parseListItem(textBlock(row.block)?.body.split('\n')[row.line] ?? '')) ? rows : null;
  }

  /** Whole rows on the clipboard as the markdown they are stored as; false when the clipboard said no. */
  async function copyRows(rows, refusal = 'the clipboard said no') {
    const raws = rows.map((row) => {
      const raw = textBlock(row.block)?.body.split('\n')[row.line];
      return raw === undefined ? null : splitScore(raw).text.replace(/\s+$/, '');
    }).filter((raw) => raw !== null);
    if (!raws.length) return false;
    const text = rowsClipText(raws);
    try { await navigator.clipboard.writeText(text); }
    catch { error = refusal; return false; }
    lineClip = text;
    return true;
  }

  /** Whole rows swapped for pasted ones, in their note; false when they are not one run of lines. */
  function replaceRows(rows, raws) {
    const block = textBlock(rows[0]?.block);
    if (!block || !rows.every((row, i) => row.block === block.id && row.line === rows[0].line + i)) return false;
    window.getSelection()?.removeAllRanges();
    extending = null;
    const kept = rowsOf(block);
    kept.splice(rows[0].line, rows.length, ...freshRows(raws));
    putRows(block.id, kept);
    const last = rows[0].line + raws.length - 1;
    tick().then(() => {
      measureTail();
      const landed = textBlock(block.id);
      if (landed) focusBlock(block.id, bodyCaret(landed, last, lines(landed)[last]?.text.length ?? 0));
    });
    return true;
  }

  /**
   * Draw a selection of whole rows as rows: the bullet, the checkbox and the indent are not
   * selectable text, so the browser's own highlight stops at the words and the marker looks left
   * out of a selection that will take it. Touches the DOM directly: the attribute is not Svelte's.
   */
  let rowMarks = 0;
  function markSelectedRows() {
    if (!scroller) return;
    const keys = [];
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.isContentEditable) && scroller.contains(active)) {
      const value = active.value ?? '';
      if (value && active.selectionStart === 0 && active.selectionEnd === value.length) {
        const row = active.closest('[data-line]');
        if (row?.querySelector('.marker')) keys.push(row);
      }
    } else {
      const range = documentRange();
      const ends = range && orderedEnds(range);
      const whole = ends && wholeOf(ends[0], ends[1]);
      for (const row of whole || []) {
        const found = scroller.querySelector(`[data-block="${CSS.escape(row.block)}"] [data-line="${row.line}"]`);
        if (found) keys.push(found);
      }
    }
    if (!keys.length && !rowMarks) return;
    for (const node of scroller.querySelectorAll('[data-row-selected]')) node.removeAttribute('data-row-selected');
    for (const node of keys) node.setAttribute('data-row-selected', '');
    rowMarks = keys.length;
  }

  /** The drawn lines a range covers, first to last. */
  function rowsBetween(a, b) {
    const rows = visibleRows();
    const i = rows.findIndex((entry) => sameRow(entry, a)), j = rows.findIndex((entry) => sameRow(entry, b));
    if (i < 0 || j < 0) return [];
    return withHidden(rows.slice(Math.min(i, j), Math.max(i, j) + 1));
  }

  /**
   * Drawn rows with the lines the view hides between two of them in one note (a retired done todo)
   * put back in place: a line command takes those, as VS Code's take a folded region. ⌥↑ moving
   * only the drawn lines jumped a hidden one, and the line it swapped past landed under the closed
   * todo and vanished from view.
   */
  function withHidden(rows) {
    const out = [];
    for (const entry of rows) {
      const before = out[out.length - 1];
      if (before && before.block === entry.block) for (let line = before.line + 1; line < entry.line; line += 1) out.push({ block: entry.block, line });
      out.push({ block: entry.block, line: entry.line });
    }
    return out;
  }

  /** The two ends of a range, the earlier one first. */
  function orderedEnds(range) {
    const a = toBody(range.anchor), b = toBody(range.focus);
    if (!a || !b) return null;
    return comparePoints(drawnOrder(), a, b) <= 0 ? [range.anchor, range.focus] : [range.focus, range.anchor];
  }

  /** Delete what a range covers and type `text` in its place, as one undo step. */
  async function replaceRange(range, text = '', { hold = false } = {}) {
    // An edit of the selection is aimed at the caret, and so is the next key: this path returns
    // before the key handler clears the hover, and the next ⌥↑ moved the line under the resting
    // pointer instead of his.
    mouseLine = null;
    const order = drawnOrder();
    const a = toBody(range.anchor), b = toBody(range.focus);
    if (!a || !b) return null;
    const [from, to] = span(order, a, b);
    const bodies = new Map(blocks.filter(isText).map((block) => [block.id, String(block.body ?? '')]));
    const result = deleteRange(bodies, order, from, to, (id) => zoneOf(textBlock(id)));
    if (!result) return null;
    window.getSelection()?.removeAllRanges();
    extending = null;
    // The joined note keeps its own rows up to the first line, that line's row for the joined line,
    // and the last note's rows after the last line, ids and all.
    // Rows coming over from the last note are new rows here: the save that writes them also removes
    // their old note, and a row id in both made the store keep it twice (the depth-3 walk,
    // prose-eol [S-Up x Del]).
    const firstRows = rowsOf(textBlock(from.id));
    const lastRows = from.id === to.id ? firstRows
      : rowsOf(textBlock(to.id)).map((row) => ({ ...freshRows([row.body])[0], createdAt: row.createdAt }));
    const fromLine = lineOf(bodies.get(from.id), from.at).index, toLine = lineOf(bodies.get(to.id), to.at).index;
    const joinedBody = result.put[0].body;
    const rows = [...firstRows.slice(0, fromLine), firstRows[fromLine], ...lastRows.slice(toLine + 1)]
      .map((row, index) => ({ ...row, body: joinedBody.split('\n')[index] }));
    putRows(from.id, rows);
    for (const id of result.drop) {
      if (!preEdit.has(id)) preEdit.set(id, textBlock(id));
      blocks = blocks.filter((entry) => entry.id !== id);
      dirty.delete(id);
    }
    let at = result.caret.at;
    if (text) {
      const next = insertAt(String(textBlock(result.caret.id).body), at, text);
      put({ id: result.caret.id, body: next.body, editLine: lineOf(next.body, result.caret.at).index });
      at = next.at;
    }
    // Held, the save goes out with the edit that follows (↵ over a selection is one undo step).
    if (hold) {
      for (const id of result.drop) pendingRemovals.add(id);
      if (result.drop.length) rememberOps(result.drop.map((id) => ({ id, remove: true })));
    } else flush({ removed: result.drop });
    await tick();
    await focusBlock(result.caret.id, at);
    measureTail();
    return { id: result.caret.id, at };
  }

  /** Lines out, the caret onto the line that takes their place, keeping its raw column. */
  async function deleteRows(rows, rawColumn = 0) {
    if (!rows.length) return;
    const drawn = visibleRows();
    const i = drawn.findIndex((entry) => sameRow(entry, rows[0]));
    const j = drawn.findIndex((entry) => sameRow(entry, rows[rows.length - 1]));
    const land = drawn[j + 1] || drawn[i - 1] || null;
    let landing = land ? { block: land.block, line: land.line } : null;
    if (landing && drawn[j + 1]) {
      landing.line -= rows.filter((row) => row.block === landing.block && row.line < landing.line).length;
    }
    await cutLines(rows.map((row) => ({ block: row.block, index: row.line })));
    // Taking a note's first line can rename the note (it is named by its head row), so the
    // landing note is looked up through the store's answer.
    const block = landing ? textBlock(canonicalBlock(landing.block)) || textBlock(landing.block) : null;
    const row = block ? lines(block)[landing.line] : null;
    if (!row) return;
    await focusBlock(block.id, bodyCaret(block, landing.line, Math.max(0, rawColumn - row.head.length)));
    // The save went out while nothing was focused; ⇧⌘Z should land where the caret landed now.
    const step = undoStack.at(-1);
    if (step?.delta && !step.cursorAfter) step.cursorAfter = cursorNow();
  }

  /** Every drawn line from `rows` swaps one place up or down, as ⌥↑ and ⌥↓ move lines in VS Code:
   *  the words move and the boundaries between notes stay where they are drawn. */
  function rotateRows(rows, direction) {
    const visible = visibleRows();
    const drawn = withHidden(visible);
    const i = drawn.findIndex((entry) => sameRow(entry, rows[0]));
    const j = drawn.findIndex((entry) => sameRow(entry, rows[rows.length - 1]));
    // The line swapped with is the nearest one he can see; hidden lines between go along.
    let target = direction < 0 ? i - 1 : j + 1;
    while (target >= 0 && target < drawn.length && !visible.some((entry) => sameRow(entry, drawn[target]))) target += direction;
    if (i < 0 || j < 0 || target < 0 || target >= drawn.length) return false;
    const touched = drawn.slice(Math.min(i, target), Math.max(j, target) + 1);
    const zones = new Set(touched.map((entry) => zoneOf(textBlock(entry.block))));
    if (zones.size !== 1 || touched.some((entry) => !textBlock(entry.block))) return false;
    // Inside a note a row moves with its words, id and created_at. A line crossing into another
    // note goes in as a new row with its created_at: its row id moving notes would rename the note
    // it lands at the head of (a note is named by its first row) and the selection with it.
    const held = new Map(touched.map((entry) => [entry.block, rowsOf(textBlock(entry.block))]));
    const moving = touched.map((entry) => ({ block: entry.block, row: held.get(entry.block)[entry.line] }));
    const turned = direction < 0 ? [...moving.slice(1), moving[0]] : [moving[moving.length - 1], ...moving.slice(0, -1)];
    const written = new Map();
    touched.forEach((entry, index) => {
      const rows = written.get(entry.block) || [...held.get(entry.block)];
      const incoming = turned[index];
      // A line arriving from another note is a new row there (its old row leaves its own note);
      // reusing the row that stood in this place made the store re-match rows by their words.
      rows[entry.line] = incoming.block === entry.block ? incoming.row : { ...freshRows([incoming.row.body])[0], createdAt: incoming.row.createdAt };
      written.set(entry.block, rows);
    });
    for (const [id, rows] of written) putRows(id, rows);
    return { rows: drawn, i, j };
  }

  /** ⌘⇧↵: a fresh line above, a list item of the same kind on a list line. */
  async function lineAbove(block, line) {
    const raw = block.body.split('\n')[line] ?? '';
    const item = parseListItem(raw);
    const fresh = item
      ? serializeListItem({ ...item, checkboxState: item.listType === 'checkbox' ? 'todo' : item.checkboxState, awaitCondition: '', content: '' })
      : raw.match(/^[ \t]*/)[0];
    const rows = rowsOf(block);
    rows.splice(line, 0, ...freshRows([fresh]));
    putRows(block.id, rows);
    await tick();
    await focusBlock(block.id, lineStart(textBlock(block.id).body, line) + fresh.length);
  }

  /** ⌘A a second time: the whole note, never the whole history (ORACLE.md D10). */
  async function selectNote(id) {
    const block = textBlock(id);
    if (!block) return;
    const rows = lines(block).filter((row) => !row.hidden && !row.retired);
    if (!rows.length) return;
    const first = rows[0], last = rows[rows.length - 1];
    await selectWords({ block: id, line: first.index, offset: 0 }, { block: id, line: last.index, offset: last.text.length });
  }

  /**
   * A key the caret's line hands to the document. True when it was spent here. It decides and
   * calls preventDefault synchronously, inside the keydown, and only then does its work: a
   * preventDefault after an await is too late, the browser has already moved the caret, typed the
   * newline or sent focus away.
   */
  function lineCommand(event, block, box) {
    const key = event.key;
    const meta = (event.metaKey || barHeld) && !event.ctrlKey;
    const bare = !event.metaKey && !event.ctrlKey && !event.altKey;
    const start = box.selectionStart ?? 0, end = box.selectionEnd ?? start;
    const direction = box.selectionDirection;
    const backward = direction === 'backward';
    const words = box.value ?? '';
    const here = { block: block.id, line: caretLine };
    const head = { ...here, offset: backward ? start : end };
    const anchor = { ...here, offset: backward ? end : start };
    const rawColumn = (lines(block)[caretLine]?.head.length ?? 0) + head.offset;
    if (box.isContentEditable) return false;
    const spend = (work) => {
      event.preventDefault();
      if (work) busyWhile(work());
      return true;
    };

    // Home and End: on a Mac Chrome scrolls the page on them and the caret stays where it was.
    // ⌘← and ⌘→ are VS Code's Home and End on a Mac: the first non-blank of the words, then the start.
    const homeEnd = (key === 'Home' || key === 'End') && bare ? key
      : meta && !event.altKey && (key === 'ArrowLeft' || key === 'ArrowRight') ? (key === 'ArrowLeft' ? 'Home' : 'End') : null;
    if (homeEnd) {
      const to = homeEnd === 'Home' ? homeStop(words, head.offset) : words.length;
      if (event.shiftKey) {
        box.setSelectionRange(Math.min(anchor.offset, to), Math.max(anchor.offset, to), to < anchor.offset ? 'backward' : 'forward');
      } else box.setSelectionRange(to, to);
      return spend();
    }
    // ⇧← and ⇧→ move the selection's head one character, from the head whichever way the
    // selection was made, and at the edge of the words on into the next line.
    if (event.shiftKey && bare && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const step = key === 'ArrowLeft' ? -1 : 1;
      if (step < 0 ? head.offset > 0 : head.offset < words.length) {
        const to = head.offset + step;
        box.setSelectionRange(Math.min(anchor.offset, to), Math.max(anchor.offset, to), to < anchor.offset ? 'backward' : 'forward');
        return spend();
      }
      const beside = rowBeside(here, step);
      return spend(beside ? () => selectWords(anchor, { ...beside, offset: step < 0 ? wordsOf(beside).length : 0 }) : null);
    }
    // ⌥← and ⌥→: VS Code's word stops from the head, a selection dropped, over the line's edge
    // into the line or blank beside it.
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const step = key === 'ArrowLeft' ? -1 : 1;
      const stop = wordStop(words, head.offset, step);
      if (stop !== null) { box.setSelectionRange(stop, stop); return spend(); }
      box.setSelectionRange(head.offset, head.offset);
      return spend(async () => { await adjacentSurface(box.closest('[data-line]'), step); });
    }
    // ⌘⇧K: the line goes.
    if (meta && event.shiftKey && !event.altKey && key.toLowerCase() === 'k') {
      return spend(() => deleteRows([here], rawColumn));
    }
    // ⇧⌥↑ / ⇧⌥↓: the line copied above or below, the caret on the lower copy for ↓.
    if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      return spend(async () => {
        const copied = duplicateLines(block.body, caretLine, caretLine, key === 'ArrowUp' ? -1 : 1);
        const rows = rowsOf(block);
        rows.splice(caretLine + 1, 0, ...freshRows([rows[caretLine].body]));
        putRows(block.id, rows);
        await tick();
        const landed = textBlock(block.id);
        await focusBlock(block.id, bodyCaret(landed, here.line + copied.shift, start));
        if (start !== end) theBox()?.setSelectionRange(start, end, direction);
      });
    }
    // ⌘⇧↵: a line above.
    if (meta && event.shiftKey && !event.altKey && key === 'Enter') {
      return spend(() => lineAbove(block, here.line));
    }
    // ⌘] and ⌘[: the line one level in or out.
    if (meta && !event.altKey && !event.shiftKey && (event.code === 'BracketRight' || event.code === 'BracketLeft')) {
      return spend(() => indentHere(block, bodyCaret(block, here.line, start), event.code === 'BracketRight' ? 1 : -1, { keep: [start, end, direction] }));
    }
    // ⌘C and ⌘X with nothing selected take the whole line, and a paste puts it back above.
    if (meta && !event.altKey && !event.shiftKey && start === end && ['c', 'x'].includes(key.toLowerCase())) {
      const raw = `${splitScore(block.body.split('\n')[here.line] ?? '').text}\n`;
      const cut = key.toLowerCase() === 'x';
      return spend(async () => {
        try { await navigator.clipboard.writeText(raw); }
        catch { error = 'the clipboard said no'; return; }
        lineClip = raw;
        if (cut) await deleteRows([here], rawColumn);
      });
    }
    // ⌘A: the words of the line, and once they are all selected, the whole note.
    if (meta && !event.altKey && !event.shiftKey && key.toLowerCase() === 'a') {
      if (start === 0 && end === words.length) return spend(() => selectNote(block.id));
      box.setSelectionRange(0, words.length, 'forward');
      return spend();
    }
    // ↵ over a selection inside the line: the selection goes first, then the line splits.
    if (key === 'Enter' && !meta && !event.altKey && !event.ctrlKey && start !== end && !event.isComposing) {
      const replay = keyLike(event, null);
      return spend(async () => {
        put({ id: block.id, body: writeLine(block, here.line, words.slice(0, start) + words.slice(end)) });
        await tick();
        const after = theBox();
        if (!after) return;
        after.setSelectionRange(start, start);
        await onKeydown({ ...replay, currentTarget: after }, textBlock(block.id));
      });
    }
    return false;
  }

  /** The parts of a key event the line's handler reads, aimed at a different element. */
  const keyLike = (event, target) => ({
    key: event.key, code: event.code, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
    ctrlKey: event.ctrlKey, isComposing: false, repeat: false, currentTarget: target, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}
  });

  // Keys that arrive while a command is still between leaving one line and landing the caret or the
  // selection somewhere else would find nothing to act on (no textarea focused, no selection yet),
  // and go to the browser. They wait here and are replayed in order once the command has landed.
  let keyBusy = 0;
  const keyQueue = [];
  function busyWhile(promise) {
    keyBusy += 1;
    Promise.resolve(promise).catch((cause) => { error = String(cause?.message || cause); })
      .finally(() => { keyBusy -= 1; if (!keyBusy) replayKeys(); });
    return promise;
  }
  function replayKeys() {
    while (!keyBusy && keyQueue.length) {
      const event = keyQueue.shift();
      archiveKey(event);
      if (event.defaultPrevented) continue;
      const box = theBox();
      const block = focusId ? textBlock(focusId) : null;
      if (!box || !block || document.activeElement !== box) continue;
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        box.setRangeText(event.key, box.selectionStart ?? 0, box.selectionEnd ?? 0, 'end');
        onInput({ target: box, inputType: 'insertText' }, block);
      } else {
        onKeydown({ ...event, currentTarget: box }, block);
      }
    }
  }

  // --- vim mode ----------------------------------------------------------------------------------
  //
  // Opt-in, remembered on this device. While it is on, every key typed into a line goes through the
  // engine (src/lib/core/vim.js, checked against a headless Neovim by tests/vim-parity), which
  // edits the note's markdown; ⌘ chords, arrows and the mouse stay the page's. j and k at a note's
  // first or last line go on into the next note.

  let vimOn = $state(false);
  let vimShown = $state('');
  // { id, state }: the block the engine last acted on and its state. Only what vim owns is trusted
  // from it (mode, registers, a half-typed command, `.`, undo over that exact text); the text and
  // the caret are read back from the editor on every key (syncVim in notes-vim.js).
  let vim = null;

  function toggleVim() {
    vimOn = !vimOn;
    try { localStorage.setItem(VIM_STORAGE_KEY, vimOn ? '1' : '0'); } catch { /* private window */ }
    vim = null;
    vimShown = vimOn ? vimLabel(null) : '';
    const box = theBox();
    if (box) { box.focus({ preventScroll: true }); box.setSelectionRange(box.selectionStart, box.selectionStart); }
  }

  /** A key for the vim engine, when vim mode is on and a line has the caret. True when spent. */
  function vimRoute(event) {
    if (!vimOn || find || commentFor || paneChat || event.isComposing) return false;
    const box = theBox();
    // A heading or formatted line is a contenteditable host (notes-rich-editor.js) that answers the
    // same value / selectionStart / setSelectionRange contract as the textarea, so the engine drives
    // it the same way.
    if (!focusId || !box || document.activeElement !== box) return false;
    const key = vimNotation(event);
    if (!key) return false;
    const block = textBlock(focusId);
    if (!block) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const body = String(block.body ?? '');
    let state = vimFromEditor(block, box);
    const before = state;
    state = vimKey(state, key);
    if (state.text !== body) {
      put({ id: block.id, body: state.text, editLine: lineOf(state.text, state.cursor).index });
      if (state.mode !== 'insert') flush();
    }
    vim = { id: block.id, state };
    vimShown = vimLabel(state);
    busyWhile(showVim(block.id, state, before, key));
    return true;
  }

  /** How the page shows a body offset of this block: out of the marker, canonical in the caret line's markup. */
  function vimView(block, box) {
    const canon = (local) => (box?.isContentEditable ? rawOffset(box.value, visibleOffset(box.value, local)) : local);
    return {
      project: (offset) => {
        const at = editCaret(block, offset);
        return bodyCaret(block, at.index, at.index === caretLine ? canon(at.local) : at.local);
      },
      words: (offset) => {
        const at = editCaret(block, offset);
        return { start: bodyCaret(block, at.index, 0), end: bodyCaret(block, at.index, Infinity) };
      }
    };
  }

  /** The engine's state, re-derived from the editor's text and caret (the one source of truth). */
  function vimFromEditor(block, box) {
    const body = String(block.body ?? '');
    const at = { start: bodyCaret(block, caretLine, box.selectionStart ?? 0), end: bodyCaret(block, caretLine, box.selectionEnd ?? 0) };
    return syncVim(vim?.state ?? null, body, at, { view: vimView(block, box), same: vim?.id === block.id });
  }

  /**
   * After anything that is not a vim key (a click, an arrow, a paste, ⌘Z, a remote edit, a focus
   * change), the mode label and the block cursor follow the editor at once rather than at the
   * next key. Not while a key is being drawn or the pointer is down (a drag is still choosing).
   */
  let vimPointer = false;
  function vimResync() {
    if (!vimOn || keyBusy || vimPointer || !focusId) return;
    const box = theBox();
    const block = textBlock(focusId);
    if (!box || !block || document.activeElement !== box) return;
    const state = vimFromEditor(block, box);
    if (vim?.state === state && vim?.id === block.id) return;
    // Leaving insert mode here would take out an autoindent: that edit is the next key's to write.
    if (state.text !== String(block.body ?? '')) return;
    vim = { id: block.id, state };
    vimShown = vimLabel(state);
    const drawn = vimDrawn(state, vimView(block, box));
    const base = bodyCaret(block, caretLine, 0);
    // A collapsed caret in normal mode becomes vim's block cursor; a selection he made is left alone.
    if (state.mode === 'normal' && drawn.end > drawn.start && box.selectionStart === box.selectionEnd) {
      box.setSelectionRange(drawn.start - base, drawn.end - base, 'forward');
    }
  }
  /** For the desync check (tests/notes-vim-sync.spec.js): the engine's text, mode and drawing, in the caret line's terms. */
  function vimProbe() {
    if (!vim) return null;
    const block = textBlock(vim.id);
    const box = theBox();
    const drawn = block && box && vim.id === focusId ? vimDrawn(vim.state, vimView(block, box)) : null;
    const base = block && drawn ? bodyCaret(block, caretLine, 0) : 0;
    return { id: vim.id, text: vim.state.text, label: vimLabel(vim.state), drawn: drawn ? { start: drawn.start - base, end: drawn.end - base } : null };
  }
  const vimSelection = () => requestAnimationFrame(vimResync);
  const vimPointerDown = () => { vimPointer = true; };
  const vimPointerUp = () => { vimPointer = false; requestAnimationFrame(vimResync); };

  /** The caret, or vim's block cursor, or its visual selection, drawn where the engine says. */
  async function showVim(id, state, before, key) {
    const textLines = state.text.split('\n');
    const at = lineOf(state.text, state.cursor);
    // j or k that could not move inside the note: on into the note beside it.
    if ((key === 'j' || key === 'k') && state.mode === 'normal' && lineOf(before.text, before.cursor).index === at.index
        && before.text === state.text && (key === 'j' ? at.index === textLines.length - 1 : at.index === 0)) {
      const box = theBox();
      // The engine state is kept: the next key finds another block and starts on it, carrying registers.
      if (box && await adjacentSurface(box.closest('[data-line]'), key === 'j' ? 1 : -1) !== false) return;
    }
    await tick();
    await placeCaret(id, state.cursor);
    const box = theBox();
    const block = textBlock(id);
    if (!box || !block) return;
    // The same drawing syncVim compares against, so the editor and the engine agree by construction.
    const drawn = vimDrawn(state, vimView(block, box));
    const base = bodyCaret(block, caretLine, 0);
    if (drawn.end > drawn.start) box.setSelectionRange(drawn.start - base, drawn.end - base, 'forward');
  }

  /** A key over the document's own selection. True when it is spent here. */
  function rangeKey(event, range) {
    const key = event.key;
    const meta = event.metaKey && !event.ctrlKey;
    const bare = !event.metaKey && !event.ctrlKey && !event.altKey;
    const ends = orderedEnds(range);
    if (!ends) return false;
    const [first, last] = ends;
    const take = (work) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      busyWhile(work());
      return true;
    };
    const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (bare && !event.shiftKey && arrows.includes(key)) {
      if (key === 'ArrowLeft') return take(() => caretAtWords(first));
      if (key === 'ArrowRight') return take(() => caretAtWords(last));
      return take(async () => {
        await caretAtWords(range.focus);
        const box = theBox();
        if (box) await adjacentSurface(box.closest('[data-line]'), key === 'ArrowUp' ? -1 : 1);
      });
    }
    if (bare && event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      return take(() => selectWords(range.anchor, stepPoint(range.focus, key === 'ArrowLeft' ? -1 : 1)));
    }
    if (bare && event.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      if (!extending) extending = { anchor: range.anchor, head: range.focus, column: range.focus.offset };
      return take(() => extendVertically(key === 'ArrowDown' ? 1 : -1));
    }
    if ((key === 'Home' && bare && !event.shiftKey) || (meta && !event.shiftKey && !event.altKey && key === 'ArrowLeft')) {
      return take(() => caretAtWords({ ...range.focus, offset: homeStop(wordsOf(range.focus), range.focus.offset) }));
    }
    if ((key === 'End' && bare && !event.shiftKey) || (meta && !event.shiftKey && !event.altKey && key === 'ArrowRight')) {
      return take(() => caretAtWords({ ...range.focus, offset: wordsOf(range.focus).length }));
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const direction = key === 'ArrowLeft' ? -1 : 1;
      const stop = wordStop(wordsOf(range.focus), range.focus.offset, direction);
      return take(async () => {
        if (stop !== null) { await caretAtWords({ ...range.focus, offset: stop }); return; }
        await caretAtWords(range.focus);
        const box = theBox();
        if (box) await adjacentSurface(box.closest('[data-line]'), direction);
      });
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      const direction = key === 'ArrowUp' ? -1 : 1;
      const rows = lineRows(first, last);
      if (event.shiftKey) {
        // ⇧⌥: the lines copied in under the last of them, into its note; ↓ takes the selection
        // onto the copies and ↑ leaves it on the originals, as VS Code does.
        if (!rows.length) return take(async () => {});
        const drawnBefore = withHidden(visibleRows());
        return take(async () => {
          const lastRow = rows[rows.length - 1];
          const block = textBlock(lastRow.block);
          const raws = rows.map((row) => textBlock(row.block).body.split('\n')[row.line]);
          const kept = rowsOf(block);
          kept.splice(lastRow.line + 1, 0, ...freshRows(raws));
          putRows(block.id, kept);
          await tick();
          if (direction < 0) {
            // ⇧⌥↑ leaves the selection on the same drawn lines (the originals; an end that only
            // reached the start of the next line stays at the start of whatever line is there now).
            const before = drawnBefore;
            const drawn = withHidden(visibleRows());
            const stay = (point) => {
              const at = before.findIndex((entry) => sameRow(entry, point));
              const to = drawn[at] || drawn[drawn.length - 1];
              const past = !rows.some((row) => sameRow(row, point));
              return { block: to.block, line: to.line, offset: past ? 0 : point.offset };
            };
            await selectWords(stay(range.anchor), stay(range.focus));
            return;
          }
          // ⇧⌥↓ takes the selection down onto the copies: every end moves down as many drawn lines
          // as were copied, the end of a line the copy left out included.
          const before = drawnBefore;
          const drawn = withHidden(visibleRows());
          const down = (point) => {
            const at = before.findIndex((entry) => sameRow(entry, point));
            const to = drawn[Math.min(drawn.length - 1, at + rows.length)];
            return { block: to.block, line: to.line, offset: point.offset };
          };
          await selectWords(down(range.anchor), down(range.focus));
        });
      }
      return take(async () => {
        const moved = rotateRows(rows, direction);
        if (!moved) return;
        await tick();
        const shifted = (point) => {
          const at = moved.rows.findIndex((entry) => sameRow(entry, point));
          const to = moved.rows[at + direction];
          // An end that only reached the start of the last line stops at that line's end.
          if (!to) { const last = moved.rows[moved.rows.length - 1]; return { block: last.block, line: last.line, offset: wordsOf(last).length }; }
          return { block: to.block, line: to.line, offset: point.offset };
        };
        await selectWords(shifted(range.anchor), shifted(range.focus));
      });
    }
    if (meta && event.shiftKey && !event.altKey && key.toLowerCase() === 'k') {
      const raw = (lines(textBlock(range.focus.block) || { body: '' })[range.focus.line]?.head.length ?? 0) + range.focus.offset;
      return take(() => deleteRows(lineRows(first, last), raw));
    }
    if (meta && !event.shiftKey && !event.altKey && key.toLowerCase() === 'a') {
      // Inside one line and short of all of it: the line's words first, as in the line itself.
      if (sameRow(first, last) && !(first.offset === 0 && last.offset === wordsOf(last).length)) {
        return take(() => selectWords({ ...first, offset: 0 }, { ...last, offset: wordsOf(last).length }));
      }
      return take(() => selectNote(first.block));
    }
    if (meta && !event.altKey && (event.code === 'BracketRight' || event.code === 'BracketLeft')) {
      return take(() => indentSelection(lineRows(first, last).map((row) => ({ block: row.block, index: row.line })), event.code === 'BracketRight' ? 1 : -1, range));
    }
    if (meta && event.shiftKey && !event.altKey && key === 'Enter') {
      return take(async () => {
        await caretAtWords(first);
        const block = textBlock(first.block);
        if (block) await lineAbove(block, first.line);
      });
    }
    const text = () => {
      const order = drawnOrder();
      const bodies = new Map(blocks.filter(isText).map((block) => [block.id, String(block.body ?? '')]));
      return rangeText(bodies, order, toBody(first), toBody(last));
    };
    // A selection of whole rows takes the rows: ⌘C and ⌘X put their markdown on the clipboard
    // (indent, bullet, todo state), ⌘X and ⌫ and ⌦ remove them bullet and all.
    if (meta && !event.shiftKey && !event.altKey && ['c', 'x'].includes(key.toLowerCase())) {
      const whole = wholeOf(first, last);
      const cut = key.toLowerCase() === 'x';
      if (whole?.length) {
        return take(async () => {
          if (!(await copyRows(whole, cut ? 'the clipboard said no, so nothing was cut' : 'the clipboard said no'))) return;
          error = null;
          if (cut) await deleteRows(whole);
        });
      }
    }
    if ((key === 'Backspace' || key === 'Delete') && !event.metaKey && !event.altKey && !event.ctrlKey) {
      const whole = wholeOf(first, last);
      if (whole?.length) return take(() => deleteRows(whole));
    }
    if (meta && !event.shiftKey && !event.altKey && key.toLowerCase() === 'c') {
      return take(async () => {
        try { await navigator.clipboard.writeText(text()); lineClip = null; }
        catch { error = 'the clipboard said no'; }
      });
    }
    if (meta && !event.shiftKey && !event.altKey && key.toLowerCase() === 'x') {
      return take(async () => {
        try { await navigator.clipboard.writeText(text()); lineClip = null; }
        catch { error = 'the clipboard said no, so nothing was cut'; return; }
        await replaceRange(range, '');
      });
    }
    if (meta && !event.shiftKey && !event.altKey && key.toLowerCase() === 'v') {
      return take(async () => {
        let pasted;
        // A read can be refused for a moment while focus is settling; one more try a frame later.
        try { pasted = await navigator.clipboard.readText(); }
        catch {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          try { pasted = await navigator.clipboard.readText(); }
          catch { error = 'the clipboard said no'; return; }
        }
        // As a paste into a line does: several lines lose their trailing blank space (a whole line
        // ⌘C took ends in a newline, which would otherwise leave an empty line behind).
        const text = pasted.replace(/\r\n?/g, '\n');
        // Markdown rows over whole rows replace them as rows, state and indent kept.
        const clip = rowClip(text), whole = clip && wholeOf(first, last);
        if (whole?.length && replaceRows(whole, clip.lines)) return;
        await replaceRange(range, text.includes('\n') ? text.replace(/\s+$/, '') : text);
      });
    }
    if ((key === 'Backspace' || key === 'Delete') && !event.metaKey && !event.altKey) return take(() => replaceRange(range, ''));
    if (key === 'Enter' && !event.metaKey && !event.altKey && !event.ctrlKey) {
      return take(async () => {
        const landed = await replaceRange(range, '', { hold: true });
        const box = theBox();
        if (landed && box) await onKeydown(keyLike(event, box), textBlock(landed.id));
        if (dirty.size || pendingRemovals.size) flush();
      });
    }
    // A typed character starts a run of typing like any other: its save waits with the typing after
    // it, so ⌘Z takes back the whole run, selection restored (CodeMirror's history, D13).
    if (key.length === 1 && !event.metaKey && !event.ctrlKey) return take(() => replaceRange(range, key, { hold: true }));
    return false;
  }

  function archiveKey(event) {
    // Keys typed into a document comment (DocComments' popover layer) are the comment's, not the
    // document's: no chord, hover command or vim key may act on a line while one is being written.
    if (event.target?.closest?.('[data-doc-pop], [data-sidechat], [data-sidechat-slot]')) return;
    const modifier = ['Shift', 'Control', 'Meta', 'Alt', 'CapsLock'].includes(event.key);
    if (keyBusy && !modifier && !typingNow() && event.isTrusted) {
      event.preventDefault();
      event.stopImmediatePropagation();
      keyQueue.push(keyLike(event, null));
      return;
    }
    if (!modifier && vimRoute(event)) return;
    // A key with no ⌘ ⌥ ⌃ is aimed at the caret, and so is the next one: the hover goes here, ahead
    // of the paths below that return early (⇧↓ growing a selection kept it, and the next ⌥↑ moved
    // the line under the resting pointer). Plain E is the one hover command without a modifier
    // (hover a line, press E to archive it), so it keeps the hover.
    if (!modifier && !event.metaKey && !event.altKey && !event.ctrlKey && event.key.toLowerCase() !== 'e') mouseLine = null;
    if (!modifier) {
      handInput += 1;
      cursorAtKey = cursorNow();
      // A run of typed characters is one undo step; any other key ends the run first, so the edit
      // it makes is a step of its own (CodeMirror's history, ORACLE.md D13).
      const typed = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
      // Only an open run of typing needs closing here; anything else already went out on its own.
      const closing = typingKey && !typed;
      typingKey = typed;
      if (closing && !event.isComposing && (dirty.size || flushTimer)) flush();
    }
    // A selection that has already left its line keeps growing from here: the document has the
    // selection now, and nothing in it is editable, so these keys reach the window instead.
    const verticalExtend = event.shiftKey && !event.metaKey && !event.altKey
      && (['ArrowUp', 'ArrowDown'].includes(event.key)
        || (event.ctrlKey && ['n', 'p'].includes(event.key.toLowerCase())));
    if (verticalExtend && extending) {
      event.preventDefault();
      event.stopImmediatePropagation();
      busyWhile(extendVertically(['n', 'ArrowDown'].includes(event.key) ? 1 : -1));
      return;
    }
    if (extending && !event.shiftKey && !['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) extending = null;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z'
        && !event.isComposing && !find && !commentFor && !paneChat) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) travelHistory(event.shiftKey);
      return;
    }
    // A selection across lines is edited as VS Code edits one: the characters between its ends.
    if (!find && !commentFor && !paneChat && !event.isComposing && !archiveBusy
        && !['Shift', 'Control', 'Meta', 'Alt', 'CapsLock'].includes(event.key) && !(event.key === 'Tab')) {
      const range = documentRange();
      if (range && rangeKey(event, range)) return;
    }
    const command = event.metaKey && !event.ctrlKey && !event.altKey;
    // ⌘X over a selection of rendered lines. Chromium raises `cut` only inside something editable,
    // so the document's own selection never reached onDocumentCut and the key did nothing at all.
    if (command && event.key.toLowerCase() === 'x' && !event.isComposing && !find && !commentFor && !paneChat) {
      const lines = documentSelectionLines();
      if (lines) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) keyboardCut(lines, window.getSelection().toString());
        return;
      }
    }
    // Backspace or Delete over the same selection. A selection that spans rendered lines lives in
    // the document, which is not editable, so the browser had nothing to delete and the keys did
    // nothing at all.
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.altKey && !event.isComposing
        && !find && !commentFor && !paneChat) {
      const lines = documentSelectionLines();
      if (lines) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) cutLines(lines);
        return;
      }
    }
    // Tab and ⇧Tab over a selection of rendered lines: every selected list item moves one level,
    // together, and the selection stays on the same lines so a second Tab goes on indenting. The
    // selection lives in the document, not in a textarea, so the line editor's Tab never saw it and
    // the browser moved focus instead.
    if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing
        && !find && !commentFor && !paneChat) {
      const range = documentRange();
      const ends = range && orderedEnds(range);
      const lines = ends ? lineRows(ends[0], ends[1]).map((row) => ({ block: row.block, index: row.line })) : documentSelectionLines();
      if (lines?.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        indentSelection(lines, event.shiftKey ? -1 : 1, range);
        return;
      }
    }
    // Everything the hovered row answers to, before the caret's line is even consulted.
    if (hoverChord(event)) return;
    const target = (command && selectedArchiveLines()) || mouseLine || (focusId ? { block: focusId, index: caretLine } : null);
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && mouseLine;
    if (event.key.toLowerCase() === 'e' && target && (command || plain)
        && !event.isComposing && !find && !commentFor && !paneChat) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) archiveLineHere(target);
      return;
    }
    // ⌘O is ⌘E's opposite: the same target, sent to the top of the future area instead of the past.
    if (event.key.toLowerCase() === 'o' && target && command && !event.shiftKey
        && !event.isComposing && !find && !commentFor && !paneChat) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) archiveLineHere(target, { promote: true });
      return;
    }
    // A modifier arrives as a keydown of its own, ahead of the letter it is held for: clearing the
    // hover here threw away the row ⌘. was aimed at before the '.' ever landed.
    if (!['Meta', 'Shift', 'Alt', 'Control', 'CapsLock'].includes(event.key)) mouseLine = null;
    lastEdit = Date.now();
  }
  async function rollDay() {
    if (notesDay() === rolledDay || loading || archiveBusy || recording || dirty.size || inflight.size
        || Date.now() - lastEdit < 60000 || serverDownRecently()) return;
    archiveBusy = true;
    try {
      const answer = await api(API, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rollover: true }) });
      rolledDay = notesDay();
      // Editing is locked for this brief atomic move; apply the committed boundary.
      const same = JSON.stringify(answer.blocks.map(b => b.id)) === JSON.stringify(timeline.map(b => b.id));
      if (same) return;
      adoptFull(answer);
      earlier = answer.earlier;
      focusId = null;
      const gap = tailGap(blocks);
      if (gap) create({ ...gap, recordHistory: false });
      await tick();
      await toPresent();
    } catch (cause) { error = String(cause.message || cause); }
    finally { archiveBusy = false; }
  }

  /** Archive: out of the future area, into the timeline, stamped with the time it was archived. */
  function archiveBlock(id) {
    menu = null;
    archiveLineHere({ block: id, index: focusId === id ? caretLine : 0 });
  }

  /** Delete, from the row menu: one line, the one the handle was aimed at. There is no block-level
   * delete any more.
   */
  function removeLineAt(id, index) {
    menu = null;
    const block = blocks.find((entry) => entry.id === id);
    if (!block) return;
    const rows = block.body.split('\n').length;
    cutLines([{ block: id, index: Math.min(Math.max(index || 0, 0), rows - 1) }]);
  }

  // --- find --------------------------------------------------------------------------------------

  /** the reference app's Escape: the filter clears and the page goes back to the block that was in the middle. */
  function centreBlock() {
    if (!scroller) return null;
    const middle = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
    let best = null;
    for (const element of scroller.querySelectorAll('[data-block]')) {
      const box = element.getBoundingClientRect();
      const distance = Math.abs(box.top + box.height / 2 - middle);
      if (!best || distance < best.distance) best = { id: element.dataset.block, distance };
    }
    return best?.id || null;
  }

  async function openFind() {
    // Where the caret stood, so closing the bar gives it back rather than leaving him on <body>
    // with the next keystroke going nowhere.
    const was = focusId ? { id: focusId, line: caretLine, offset: theBox()?.selectionStart ?? 0 } : null;
    find = { query: '', hidden: new Set(), anchor: centreBlock(), was };
    await tick();
    findBox?.focus();
  }

  async function closeFind() {
    const anchor = find?.anchor;
    const was = find?.was;
    find = null;
    await tick();
    const element = anchor ? scroller?.querySelector(`[data-block="${anchor}"]`) : null;
    if (element && scroller) scroller.scrollTop = Math.max(0, element.offsetTop - scroller.clientHeight / 2);
    else await toPresent({ smooth: false });
    const block = was ? blocks.find((entry) => entry.id === was.id) : null;
    if (block) await focusBlock(block.id, bodyCaret(block, was.line, was.offset));
  }

  function runFind(query) {
    const needle = query.trim().toLowerCase();
    if (!needle) { find = { ...find, query, hidden: new Set() }; return; }
    const hidden = new Set();
    for (const block of ordered(blocks)) {
      if (isBreak(block)) continue;
      if (!block.body.toLowerCase().includes(needle)) hidden.add(block.id);
    }
    find = { ...find, query, hidden };
  }

  /** the reference app draws one dashed rule for a contiguous run of hidden blocks rather than a gap. */
  function elided(list, index) {
    if (!find || find.hidden.size === 0) return false;
    const block = list[index];
    if (!find.hidden.has(block.id)) return false;
    const previous = list[index - 1];
    return !previous || !find.hidden.has(previous.id);
  }

  // --- dictation ---------------------------------------------------------------------------------

  function startMic() {
    if (!mic?.available?.()) { error = 'no microphone here'; return false; }
    if (mic.isRecording()) return false;
    if (!mic.holdStart({ fromComposer: true })) return false;
    recording = true;
    return true;
  }

  function stopMic({ send = false } = {}) {
    if (mic?.isRecording?.()) mic.holdStop({ send });
    recording = false;
  }

  function toggleMic() {
    if (recording) stopMic();
    else startMic();
  }

  /** Dictated words land at the caret of the block he is in, and are marked as dictation on disk. */
  async function speak(text) {
    const id = focusId || liveBlock(blocks)?.id;
    if (!id || !text) return;
    const block = blocks.find((entry) => entry.id === id);
    if (!block) return;
    const current = theBox();
    const caret = current && focusId === id
      ? bodyCaret(block, caretLine, current.selectionStart ?? 0)
      : block.body.length;
    const spoken = insertSpoken(block.body, caret, text);
    put({ id, body: spoken.body, source: 'dictation' });
    measureTail();
    if (focusId === id) await placeCaret(id, spoken.caret);
  }

  // --- the system state area -----------------------------------------------------------------------

  const STATE_IDLE_MS = 1_000;        // a floor under one pass, so an eager server is not a hot loop
  const STATE_RETRY_MS = 3_000;       // the route may not be up at all; back off instead of hammering

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A block the caret is in, or one with typing not yet acknowledged, is his; the poll waits. */
  const busy = (id) => id === focusId || dirty.has(id) || [...inflight].some(ids => [...ids].some(key => canonicalBlock(key) === id));

  const sameBlock = (a, b) =>
    a.body === b.body && a.ord === b.ord && a.updatedAt === b.updatedAt
    && (a.chatId ?? null) === (b.chatId ?? null) && (a.kind ?? 'text') === (b.kind ?? 'text');

  /**
   * Take as much of the last poll answer as is safe. A block he has the caret in, or has typed into
   * since the last save, is skipped and the answer is kept for when it is calm; everything the
   * answer did not change keeps its object, so the update is invisible to the rest of the page.
   */
  function mergeState() {
    const incoming = pendingState;
    if (!incoming) return;
    const byId = new Map(incoming.map((block) => [block.id, block]));
    let held = false;
    let changed = false;
    const next = [];
    for (const block of blocks) {
      if (!carriesState(zoneOf(block))) { next.push(block); continue; }
      const fresh = byId.get(block.id);
      if (!fresh) {
        // Gone on the server. His own block stays on screen until it is clean, then it goes.
        if (busy(block.id)) { next.push(block); held = true; } else changed = true;
        continue;
      }
      byId.delete(block.id);
      // A chat id he just started may not have reached the store yet; losing it would lose the chip.
      const merged = { ...block, ...fresh, chatId: fresh.chatId ?? block.chatId ?? null };
      if (sameBlock(block, merged)) { next.push(block); continue; }
      if (busy(block.id)) { next.push(block); held = true; continue; }
      next.push(merged);
      markReported(merged);        // the builder's own rewrite is not an edit of his to report
      changed = true;
    }
    for (const fresh of byId.values()) { next.push(fresh); markReported(fresh); changed = true; }
    pendingState = held ? incoming : null;
    if (changed) blocks = next;
  }

  async function pullState() {
    const since = stateHash;
    const response = await fetch(`/api/state${since ? `?since=${encodeURIComponent(since)}` : ''}`);
    if (!response.ok) throw new Error(`GET /api/state ${response.status}`);
    const body = await response.json();
    repliesAvailable = body.replies?.available === true;
    if (Array.isArray(body.blocks)) { pendingState = body.blocks; mergeState(); }
    stateHash = body.hash || null;
  }

  /** A hidden tab has nothing to show, so the connection is dropped until it comes back. */
  function whenVisible() {
    return new Promise((resolve) => {
      const done = () => { document.removeEventListener('visibilitychange', done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 10_000);
      document.addEventListener('visibilitychange', done);
    });
  }

  /**
   * The brief's held-open shape: one request that waits for the hash to change, then straight back
   * in. A state route that is missing or failing must cost the page nothing, so a failure is quiet
   * and the next attempt is seconds away rather than immediate.
   */
  async function followState(alive) {
    while (alive()) {
      if (document.visibilityState === 'hidden') { await whenVisible(); continue; }
      const started = Date.now();
      let ok = true;
      try { await pullState(); } catch { ok = false; }
      if (!alive()) return;
      const wait = ok ? Math.max(0, STATE_IDLE_MS - (Date.now() - started)) : STATE_RETRY_MS;
      if (wait > 0) await sleep(wait);
    }
  }

  // --- the stream: an edit in the state area is an owner report ------------------------------------

  /** What the store or the builder last said, so only his own hand is ever reported. */
  function markReported(block) {
    if (carriesState(zoneOf(block))) reported.set(block.id, block.body.split('\n'));
  }

  /** Typing on a line: one report when the line has been still for the debounce, not one a key. */
  function noteEdit(id, index) {
    const key = `${id}:${index}`;
    clearTimeout(reportTimers.get(key));
    reportTimers.set(key, setTimeout(() => reportLine(id, index, 'edit'), REPORT_WAIT_MS));
  }

  /** Blur is a settled edit, so what the debounce is still holding for this block goes now. */
  function flushReports(id) {
    for (const key of [...reportTimers.keys()]) {
      if (!key.startsWith(`${id}:`)) continue;
      reportLine(id, Number(key.slice(id.length + 1)), 'edit');
    }
  }

  /**
   * One record for the push plane, which interprets it against evidence; a check-off is a claim to
   * verify and not a fact, and the record says so itself. Best effort by design: the line is
   * already saved in the notes store, so a report that cannot be written is never his problem and
   * never reaches the error line.
   */
  async function reportLine(id, index, kind) {
    const key = `${id}:${index}`;
    clearTimeout(reportTimers.get(key));
    reportTimers.delete(key);
    const block = blocks.find((entry) => entry.id === id);
    if (!block || !carriesState(zoneOf(block)) || block.id.startsWith('thread-chat-')) return;
    const now = block.body.split('\n');
    const was = reported.get(id) || [];
    const [change] = changedLines([was[index] ?? ''], [now[index] ?? '']);
    if (!change) return;
    const base = was.slice();
    base[index] = now[index] ?? '';
    reported.set(id, base);
    // Checkbox edits are reported durably by the shared-task outbox on save.
    if (parseListItem(stripScores(change.after))?.listType === 'checkbox') return;
    try {
      await fetch('/api/state/report', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind, section: sectionOf(block) || '', blockId: block.id, line: index,
          before: change.before, after: change.after, thread: threadOf(now, index)
        })
      });
    } catch { /* the edit stands; the store has it either way */ }
  }

  /** The comment a state block sends to a subagent, which edits the area through scripts/state.mjs. */
  function statePrompt({ section, body, comment, blockId }) {
    const quoted = stripScores(body || '').split('\n').map((line) => `> ${line}`).join('\n');
    return `From the system state area of my notes, section "${section}":

${quoted}

the owner: ${comment}

Original notes block ID: ${blockId}. Preserve this identity, including when done, dropped, moved, or archived.

Act on that. You can edit the system state area yourself: run
\`node scripts/state.mjs read\` in ~/projects/tophat/webchat to see it with line
indexes. Read the original with \`node scripts/state.mjs read --block ${blockId}\`.
The state area is a projection, not the full task list. Look up the underlying task across all
statuses and attach this comment to that existing item. Done/dropped does not mean absent.
Do not append a replacement completion record just because a filtered view omits the item.
Change only what this comment asks for;
lines the owner wrote by hand are not yours to rewrite.`;
  }

  async function openComment(block) {
    commentFor = block.id;
    commentText = '';
    await tick();
    commentBox?.focus();
  }

  function closeComment() {
    commentFor = null;
    commentText = '';
  }

  /**
   * Send the comment to a chat of this block's own. The conversation id is derived from the block
   * id rather than made fresh, so a rebuild that rewrites the section leaves the chip pointing at
   * the same conversation.
   */
  async function sendComment(block) {
    const comment = commentText.trim();
    if (!comment) return;
    const section = sectionOf(block) || 'system state';
    const session = await ensureChat();
    const id = `state-${block.id}`;
    // Name the conversation after the owner's reply, not the generated section label.
    const title = comment.split('\n')[0].slice(0, 60);
    const existing = chatStateSnapshot?.conversations?.[id];
    if (!existing) session.create(id, { title });
    else if (existing.title === `state: ${section}` || existing.title === 'state: system state') {
      session.rename(id, title);
    }
    session.send(id, statePrompt({ section, body: block.body, comment, blockId: block.id }));
    closeComment();
    put({ id: block.id, chatId: id });
    cardFor = block.id;
    flush();
  }

  // --- rendering ---------------------------------------------------------------------------------

  // A deferred line is parked, not closed: the glyph is a clock face, and the condition it waits on
  // rides beside it in a pill he can type in.
  const MARKER = { bullet: '-', todo: '◯', done: '✓', dropped: '◯', await: '◷' };

  // The score comes off the end of a line, but the separator in front of it is one space at most:
  // a space he has just typed at the end of the line is his text, not punctuation around the
  // comment. Handing all of it to the tail wrote the trimmed line back into the box between
  // keystrokes, and every space typed on a scored line disappeared.


  /** Who wrote a line. The store has kept this all along, one source per line: `type` and
   * `dictation` are his hands and his voice, `system` and `import` are an agent's. The page shows
   * it so he can archive what a model wrote without reading it as his own note.
   */
  const AGENT_SOURCES = new Set(['system', 'import']);
  const writtenBy = (source) => (AGENT_SOURCES.has(source) ? 'agent' : 'owner');

  function lines(block) {
    // `## x` is a heading only in the state area, where the builder writes the section names.
    const headings = Boolean(doc) || carriesState(zoneOf(block));
    // A row's own source, not the block's: an agent's block he has typed into is half his.
    const stored = block.lines || [];
    const raw = block.body.split('\n');
    const nodes = outline(raw);
    const shut = foldedIn(block, nodes);
    const hidden = hiddenUnder(nodes, shut);
    let completedThrough = -1;
    const rendered = raw.map((line, index) => {
      // The importance score is the builder talking to the fold rule; the eye never sees it.
      const { text: bare, score } = splitScore(line);
      const item = parseListItem(bare);
      const state = item ? (item.listType === 'bullet' ? 'bullet' : item.checkboxState) : null;
      const droppedByParent = state === 'todo' && index <= completedThrough;
      if (state === 'done') completedThrough = Math.max(completedThrough, index + nodes[index].descendants);
      const content = item ? item.content : bare;
      const headingMatch = /^[\t ]*(#{1,4})[ \t]/.exec(content);
      const heading = headingMatch?.[1].length || 0;
      const text = heading ? content.slice(headingMatch[0].length) : content;
      return {
        index, item, marker: state ? MARKER[state] : null, text, state, heading, droppedByParent,
        condition: item?.awaitCondition ?? null,
        // What the eye never sees, kept so the caret's line can be edited as words alone and put
        // back with its own syntax: the indent and the marker in front, the score behind.
        head: bare.slice(0, bare.length - text.length), tail: score,
        folds: nodes[index].children.length > 0, folded: shut.has(index),
        hides: nodes[index].descendants, hidden: hidden.has(index),
        wrote: writtenBy(stored[index]?.source ?? block.source),
        lineId: stored[index]?.id ?? null,
        author: stored[index]?.author ?? null,
        authorOwner: stored[index]?.authorOwner === true
      };
    });
    const retired = retiredIn(block, rendered);
    return rendered.map((line) => (retired.has(line.index) ? { ...line, retired: true } : line));
  }

  function scrollToToday() {
    const element = futureEl;
    if (element && scroller) scroller.scrollTo({ top: Math.max(0, element.offsetTop - 12), behavior: 'smooth' });
  }

  // the reference app's window title: the section he is in, so a tab in the background still says where he was.
  $effect(() => {
    const live = blocks.find((block) => block.id === focusId) || liveBlock(blocks);
    const first = (live?.body || '').split('\n').find((line) => line.trim()) || '';
    if (doc) { document.title = doc.title || 'doc'; return; }
    document.title = first ? `notes - ${first.slice(0, 50)}` : 'notes';
  });

  $effect(() => {
    if (focusId === null) return;
    grow(theBox());
  });

  // The pin lasts until his attention really moves: the caret in a line that is neither the row he
  // closed nor the one he closed it from. That is "clicks away" without making the tap itself the
  // thing that hides the row.
  $effect(() => {
    if (releasedClose.size === 0) return;
    const active = activeLineId();
    if (![...releasedClose].every((id) => id === active)) releasedClose = new Set([...releasedClose].filter((id) => id === active));
  });

  $effect(() => {
    if (!pinnedClose) return;
    const active = activeLineId();
    if (active !== pinnedClose.id && active !== pinnedClose.active) {
      const gone = pinnedClose;
      pinnedClose = null;
      releasePin(gone);
    }
  });

  // A row he closed and then deleted, archived or rolled over leaves the pinned set with it.
  $effect(() => {
    if (closedByHand.size === 0) return;
    const live = new Set(blocks.flatMap((block) => (block.lines || []).map((line) => line.id)));
    const kept = forgetMissing(closedByHand, live);
    if (kept.size !== closedByHand.size) closedByHand = kept;
  });

  // The caret leaving a state block releases an update that was held back for it.
  $effect(() => {
    focusId;
    if (pendingState) mergeState();
    settleRemote();
  });

  // Away long enough for the page to be a thing he is coming back to rather than glancing past.
  const RETURN_AFTER_MS = 5 * 60_000;
  const RETURN_DELAY_MS = 280;        // a click that brings the window back is a place of his own

  /** Shorter switches preserve the current caret and scroll position for multitasking. */
  async function returnToPresent() {
    const gap = tailGap(blocks);
    if (gap) create({ ...gap, recordHistory: false });
    await tick();
    await toPresent({ smooth: false });
  }

  /**
   * A document's live stream (/api/docs/<token>/events): another tab's write is refetched through
   * the same push path his notes use, a comment reloads the threads, and presence is who is here.
   * A slow poll stands behind it, because a stream that dropped during a restart misses signals.
   */
  function docLive() {
    const connection = createLiveConnection({
      url: `${API}/events?client=${encodeURIComponent(liveClientId())}&name=${encodeURIComponent(doc.name || '')}`
    });
    const stops = [
      connection.subscribe('doc', (event) => { if (!applyPushedBlocks(event.blocks)) refreshFromPush(); }),
      connection.subscribe('comments', () => { docComments?.refresh(); }),
      connection.subscribe('presence', (event) => { if (Array.isArray(event.here)) presence = event.here; }),
      connection.subscribe('meta', (event) => { if (typeof event.title === 'string') doc.title = event.title; })
    ];
    const poll = setInterval(() => { refreshFromPush(); docComments?.refresh(); }, 20_000);
    return () => { clearInterval(poll); for (const stop of stops) stop(); };
  }

  onMount(() => {
    try { vimOn = localStorage.getItem(VIM_STORAGE_KEY) === '1'; } catch { vimOn = false; }
    if (vimOn) vimShown = vimLabel(null);
    const stopMouse = () => { mouseLine = null; lastEdit = Date.now(); handInput += 1; typingKey = false; };
    window.addEventListener('pointermove', mouseArchiveTarget);
    window.addEventListener('pointerdown', stopMouse, true);
    window.addEventListener('blur', stopMouse);
    window.addEventListener('keydown', archiveKey, true);
    document.addEventListener('selectionchange', vimSelection);
    let markFrame = 0;
    const markSoon = () => { if (!markFrame) markFrame = requestAnimationFrame(() => { markFrame = 0; markSelectedRows(); }); };
    document.addEventListener('selectionchange', markSoon);
    document.addEventListener('select', markSoon, true);
    window.addEventListener('keyup', markSoon, true);
    window.addEventListener('pointerup', markSoon, true);
    window.addEventListener('pointerdown', vimPointerDown, true);
    window.addEventListener('pointerup', vimPointerUp, true);
    const dayTimer = doc ? null : setInterval(rollDay, 30000);
    const onResize = () => { measureTail(); phone = window.innerWidth < PHONE; };
    phone = window.innerWidth < PHONE;
    const leaving = () => { if (dirty.size) flush(); };
    let awayAt = 0;
    let returnTimer = null;
    const away = () => { if (!awayAt) awayAt = Date.now(); releaseHold(); leaving(); };
    const back = () => {
      const gone = awayAt ? Date.now() - awayAt : 0;
      awayAt = 0;
      if (doc || gone < RETURN_AFTER_MS) return;
      clearTimeout(returnTimer);
      returnTimer = setTimeout(() => returnToPresent(), RETURN_DELAY_MS);
    };
    const cancelReturn = () => { clearTimeout(returnTimer); returnTimer = null; };
    const onVisibility = () => (document.visibilityState === 'hidden' ? away() : back());
    window.addEventListener('resize', onResize);
    window.addEventListener('pagehide', leaving);
    window.addEventListener('blur', away);
    window.addEventListener('focus', back);
    window.addEventListener('pointerdown', cancelReturn, true);
    document.addEventListener('visibilitychange', onVisibility);
    // Writes that could not go out are retried on their own, not only on the next keystroke: the
    // server coming back is not something he should have to type to notice.
    const resend = () => {
      if (flushTimer || inflight.size) return;
      if (!dirty.size && !pendingRemovals.size) {
        if (offline) api(`${API}?view=page&zone=future&limit=1`).then(() => { if (!hydrated) loadPresent().then(keepSnapshot).catch(() => {}); }).catch(() => {});
        return;
      }
      flush();
    };
    const resendTimer = setInterval(resend, 4000);
    window.addEventListener('online', resend);
    // The interaction model check's handle on the page; inert without its localStorage flag.
    const dropHarness = installNotesHarness({
      blocks: () => blocks, isText, zoneOf, lines, tick, focusBlock, renderedPoint, theBox, scroller: () => scroller,
      focusId: () => focusId, caretLine: () => caretLine,
      vim: () => vimProbe(),
      busy: () => Boolean(flushTimer || dirty.size || inflight.size || pendingRemovals.size || pendingSaves.size || archiveBusy || heldSpace || verifying || keyBusy),
      drained: () => writeChain,
      // The 400ms save debounce is for typing; a check reading the result sends the write now.
      flushNow: () => { if (flushTimer || dirty.size || pendingRemovals.size) flush(); },
      clearFocus: async () => { focusId = null; await tick(); },
      outbox: () => readOutbox().length,
      kept: () => (keptRange ? { ...keptRange, now: handInput } : null),
      ready: () => !loading,
      history: () => ({ undo: undoStack.slice(-3).map((entry) => ({ local: Boolean(entry.delta), token: Boolean(entry.token), before: entry.cursorBefore ?? null, focus: entry.focus ?? null })), redo: redoStack.length }),
      reset: async () => {
        writeOutbox([]);
        focusId = null; extending = null; verticalX = null; verticalColumn = null; mouseLine = null;
        menu = null; richLineId = null; error = null; caretLine = 0;
        undoStack.length = 0; redoStack.length = 0; lineClip = null;
        vim = null; if (vimOn) vimShown = vimLabel(null);
        window.getSelection()?.removeAllRanges();
        await tick();
        adoptFull(await api(`${API}?limit=1000`));
        await tick();
      }
    });
    let alive = true;
    if (!doc) followState(() => alive);
    // Another device's edit lands here within the push's round trip instead of on the next reload.
    const stopLive = doc ? docLive() : liveSubscribe('notes', () => { refreshFromPush(); });
    // Leaving the window releases a block the caret was holding back from a push.
    window.addEventListener('blur', settleRemote);
    return () => {
      alive = false;
      stopLive();
      window.removeEventListener('blur', settleRemote);
      dropHarness();
      clearInterval(resendTimer);
      window.removeEventListener('online', resend);
      clearInterval(dayTimer);
      window.removeEventListener('pointermove', mouseArchiveTarget);
      window.removeEventListener('pointerdown', stopMouse, true);
      window.removeEventListener('blur', stopMouse);
      window.removeEventListener('keydown', archiveKey, true);
      document.removeEventListener('selectionchange', vimSelection);
      document.removeEventListener('selectionchange', markSoon);
      document.removeEventListener('select', markSoon, true);
      window.removeEventListener('keyup', markSoon, true);
      window.removeEventListener('pointerup', markSoon, true);
      window.removeEventListener('pointerdown', vimPointerDown, true);
      window.removeEventListener('pointerup', vimPointerUp, true);
      clearTimeout(returnTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pagehide', leaving);
      window.removeEventListener('blur', away);
      window.removeEventListener('focus', back);
      window.removeEventListener('pointerdown', cancelReturn, true);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });
</script>

<svelte:head><title>notes</title></svelte:head>

{#snippet gap(before, after, boundary = null)}
  <textarea class="document-gap" rows="2" tabindex="-1" aria-label="Blank lines between notes"
    data-testid="notes-gap" data-gap-editor data-before={before?.id} data-after={after?.id}
    data-boundary={boundary?.id}
    value={'\n'}
    onfocus={() => { focusId = null; }}
    onpointerdown={() => { verticalX = null; }}
    onkeydown={gapKey}
    oninput={(event) => {
      // The gap holds one newline of its own. Keeping the newline gave the note a blank first
      // line whenever the caret had come into the gap from below.
      const value = event.currentTarget.value, at = event.currentTarget.selectionStart;
      const lead = value.startsWith('\n') && !(at <= 0);
      const body = lead ? value.slice(1) : value.replace(/\n$/, '');
      const caret = Math.max(0, Math.min(body.length, at - (lead ? 1 : 0)));
      event.currentTarget.value = '\n';
      if (body.trim()) insertBetween(before, after, boundary, body.replace(/\s+$/, ''), Math.min(caret, body.replace(/\s+$/, '').length));
    }}
  ></textarea>
{/snippet}

<svelte:window oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; settleRemote(); }} onfocusin={settleSoon} onfocusout={settleSoon} onkeyup={settleSoon} onpointerup={settleSoon} onpointerdown={closeGutter} onclick={(event) => { if (menu && !event.target.closest('[data-menu]')) menu = null; }} oncut={onDocumentCut} oncopy={onDocumentCopy} />

<div class="notes" class:doc={Boolean(doc)}>
  <header class="bar">
    {#if doc}
      {@render docBar?.({ presence, offline, saving: saving > 0 })}
    {:else}
      <Nav current="notes" />
    {/if}
    <div class="right">
      {#if find}
        <input
          class="find"
          bind:this={findBox}
          value={find.query}
          placeholder="filter"
          data-testid="notes-find"
          oninput={(event) => runFind(event.target.value)}
          onkeydown={(event) => { if (event.key === 'Escape' || event.key === 'Enter') { event.preventDefault(); closeFind(); } }}
        />
      {:else}
        <button class="chip" onclick={openFind} data-testid="notes-find-open" title="Filter (⌘F)">filter</button>
      {/if}
      {#if !doc}
      <button class="chip" onclick={scrollToToday} data-testid="notes-today-jump" title="Jump to NEXT">next</button>
      <button
        class="chip"
        class:open={streamOpen}
        onclick={() => (streamOpen = !streamOpen)}
        data-testid="notes-stream-toggle"
        title="Recent notes from the reader and from chats"
      >stream</button>
      <button
        class="chip mic"
        class:on={recording}
        onclick={toggleMic}
        data-testid="notes-mic"
        aria-label={recording ? 'Stop dictating' : 'Dictate'}
        title={recording ? 'Stop dictating' : 'Dictate (hold space on an empty line)'}
      >{recording ? 'listening' : 'mic'}</button>
      {/if}
      <button class="chip" class:on={vimOn} onclick={toggleVim} data-testid="notes-vim-toggle" aria-pressed={vimOn}
        title="Vim keys in the notes (kept on this device)">vim</button>
      {#if vimOn}<span class="state" data-testid="notes-vim-mode">{vimShown || 'NORMAL'}</span>{/if}
      {#if saving > 0}<span class="state" data-testid="notes-saving">saving</span>{/if}
      {#if offline}<span class="state" data-testid="notes-offline" title="the server cannot be reached; what you write is kept on this device and sent when it can be">offline</span>{/if}
      {#if error && !offline}<span class="state bad" data-testid="notes-error">{error}</span>{/if}
    </div>
  </header>

  <div class="split">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scroller" bind:this={scroller} onscroll={onScroll}
    onclick={onSurfaceClick} onmousedowncapture={onShiftPointer} data-testid="notes-scroller">
    <div class="flow" bind:this={flow} data-testid="notes-flow">
      {#if earlier > 0}
        <button class="earlier" onclick={loadEarlier} data-testid="notes-earlier">{earlier} earlier</button>
      {/if}

      {@render zone('past', past, { testid: 'notes-past', labelTestid: 'notes-past-label' })}
      {@render zone('timeline', timeline, { labelTestid: 'notes-present-label', action: doc ? null : archiveNow })}

      {#if recording || partial}
        <div class="partial" data-testid="notes-partial">{partial || 'listening'}</div>
      {/if}
    </div>

    <div class="tail" style:height={`${tail}px`} data-testid="notes-tail"></div>

    {#if !doc || future.length}
      {@render zone('future', future, { testid: 'notes-future', labelTestid: 'notes-future-label' })}
    {/if}

    {#if !doc}
      {@render zone('threads', threadChats, { label: 'Thread chats', testid: 'notes-thread-chats', empty: true })}
    {/if}

    <!-- The state area, under the future area: the same rows, so hand editing, the marker ring, the
         gutter and the chat chip work here with nothing new. It is absent until there is one, so a
         document without a state area looks exactly as it did. -->
    {#if liveState.length > 0 && !doc}
      {@render zone('state', stateArea, { testid: 'notes-system' })}
    {/if}

    {#if doc}
      <DocComments bind:this={docComments} bind:threads={docThreads} {doc} api={API} />
      <DocCursors {doc} api={API} {presence} caretNow={docCaretNow} where={docCursorWhere} rev={blocks} />
    {/if}
  </div>

  {#if streamOpen}
    <NotesStream
      {transcluded}
      busyId={streamBusy}
      ontransclude={transclude}
      onclose={() => (streamOpen = false)}
    />
  {/if}

  {#if paneChat && chat}
    <aside class="side" data-testid="notes-chat-pane">
      <div class="side-bar">
        <span class="side-title">{chatTitle(paneChat)}</span>
        <button class="chip" onclick={() => (paneChat = null)} data-testid="notes-chat-pane-close">close</button>
      </div>
      <div class="side-body">
        <ChatPane
          session={chat}
          chatState={chatStateSnapshot}
          status={chatStatus}
          conversationId={paneChat}
        />
      </div>
    </aside>
  {/if}
  </div>

  {#if menu}
    {@const block = blocks.find((entry) => entry.id === menu.id)}
    <div class="menu" data-menu style:left={`${menu.x}px`} style:top={`${menu.y}px`} data-testid="notes-menu">
      <button onclick={() => { move(menu.id, -1); menu = null; }} data-testid="notes-move-up">move up</button>
      <button onclick={() => { move(menu.id, 1); menu = null; }} data-testid="notes-move-down">move down</button>
      {#if !doc && menuItems(zoneOf(block)).includes('archive')}
        <button onclick={() => archiveBlock(menu.id)} data-testid="notes-archive">archive</button>
      {/if}
      <button class="bad" onclick={() => removeLineAt(menu.id, menu.index)} data-testid="notes-delete">delete line</button>
    </div>
  {/if}

  <!-- The floating cmd bar, under the breakpoint the bar's own media query uses. Its segments
       call the page's handlers; its cmd is the ⌘ that onKeydown reads. -->
  {#if phone}
    <NotesBar
      bind:held={barHeld}
      onheld={onBarCmd}
      onindent={() => fromBar((block, caret) => indentHere(block, caret, 1))}
      onoutdent={() => fromBar((block, caret) => indentHere(block, caret, -1))}
      oncycle={() => fromBar((block, caret) => cycleHere(block, caret))}
      onfold={() => fromBar((block, caret) => toggleFold(block, lineIndex(block.body, caret)))}
      onchat={() => fromBar((block) => askHere(block))}
      onpresent={() => toPresent({ smooth: true })}
    />
  {/if}

  {#if !doc}
  <div class="mic-host">
    <DictationMic
      bind:this={mic}
      conversationId="notes"
      onbegin={() => { recording = true; partial = ''; }}
      onpartial={(token, text) => (partial = text)}
      oncommit={(token, text) => { partial = ''; recording = false; speak(text); }}
      onextend={(token, text) => { partial = ''; speak(text); }}
      oncancel={() => { partial = ''; recording = false; }}
    />
  </div>
  {/if}
</div>

<!--
  One zone of the document: Past, NOW, NEXT and the state area all render here, so find, gaps, page
  breaks, elision, the standing row and the heading are the same everywhere. A zone differs only in
  its label, its data-zone (on every row) and what notes-zones.js says it can do. `action` is the
  heading's click, set where "everything in this zone" has a meaning: archiving all of NOW.
-->
{#snippet zone(name, list, { label = null, testid = null, labelTestid = null, action = null, empty = false } = {})}
  {@const key = name === 'threads' ? 'state' : name}
  <section class="zone" data-section={name} data-testid={testid} use:registerZone={name}>
    <h2 class="era" data-testid={labelTestid}>
      {#if action}<button class="archive-now" disabled={archiveBusy} title={action.title} onclick={action.run}>{label || zoneCaps(key).label}</button>{:else}{label || zoneCaps(key).label}{/if}
    </h2>
    {#if empty && standing(list).length === 0}<p class="thread-empty">{repliesAvailable ? 'No conversations needing a reply in the latest assessment.' : 'Conversation assessments are currently unavailable.'}</p>{/if}
    {#each list as block, index (block._viewId || block.id)}
      {#if index > 0 && !find}{@render gap(list[index - 1], block)}{/if}
      {#if find && find.hidden.has(block.id)}
        {#if elided(list, index)}<div class="elided" data-testid="notes-elided"></div>{/if}
      {:else if isBreak(block)}
        <div data-block={block.id} data-testid="notes-break">{@render gap(null, null, block)}</div>
      {:else}
        {@render row(block)}
        {#if !doc && block.evidence?.scope?.startsWith('beeper:') && !spentBlock(block)}
          <a class="thread-source" href={`beeper://room/${encodeURIComponent(block.evidence.scope.slice(7))}`}
            title={`Covers ${block.evidence.evidence.length} incoming messages`}>Open in Beeper ↗</a>
        {/if}
      {/if}
    {/each}
  </section>
{/snippet}

{#snippet row(block)}
  <div class="row" class:today={block.id === today?.id} class:spent={spentBlock(block)} class:firstActive={focusId === block.id && caretLine === 0} class:firstHover={mouseLine?.block === block.id && mouseLine?.index === 0} data-block={block.id} data-zone={zoneOf(block)} data-testid="notes-block">
    <div class="gutter" class:blank={!block.body.split('\n')[0]?.trim()}>
      <button
        class="handle"
        class:loud={rowTick(block).loud}
        data-handle
        aria-label="Block actions"
        title="Block actions"
        onclick={(event) => openMenu(event, block)}
        data-testid="notes-handle"
      ><span class="date" data-testid="notes-tick-date">{rowTick(block).date}</span><span
          class="time"
          data-testid="notes-tick-time"
        >{rowTick(block).date ? ' ' : ''}{rowTick(block).time}</span></button>
    </div>
    <div
      class="read"
      class:empty={block.body === ''}
      role="button"
      tabindex="-1"
      data-testid="notes-read" use:lineDrag={dragOptions(block)}
      onmousedown={(event) => onBlockPointer(event, block)}
    >
        {#each lines(block) as line (line.index)}
          {#if !line.hidden || editing(block, line.index)}
            <div
              class="line"
              class:active={editing(block, line.index)}
              class:agent={line.wrote === 'agent'}
              class:retired={line.retired && !editing(block, line.index)}
              data-wrote={line.wrote}
              class:dropped-by-parent={line.droppedByParent}
              title={line.droppedByParent ? 'Parent completed; this task stays unchecked' : undefined}
              data-line={line.index}
              class:gutter-open={gutterOpen === `${block.id}:${line.index}`}
              data-item={doc ? line.lineId : undefined}
              data-author={doc ? line.author : undefined}
              data-depth={line.item?.indent || 0}
              data-prefix={line.head.length}
              data-inline={line.text}
              style:--indent={`${(line.item?.indent || 0) * 1.25}rem`}
              transition:foldMotion
            >
              <!-- The grip glyph is drawn by CSS, not written into the line: a decorative
                   character inside [data-line] is part of the line's text content, so anything
                   reading the line back (a test, a copy, a screen reader walking the row) sees
                   "⠿ first line". The accessible name is the aria-label. -->
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <span class="gutter-zone" data-gutter-zone aria-hidden="true" onclick={() => { gutterOpen = `${block.id}:${line.index}`; }}></span>
              <button class="drag-handle" data-drag-handle data-testid="notes-drag-handle" tabindex="-1" aria-label="Drag line and children" title="Drag line and children"></button>
              {#if showLineTick(block, line.index)}
                <span
                  class="line-tick"
                  class:loud={showLineTick(block, line.index).loud}
                  data-testid="notes-line-tick"
                >{showLineTick(block, line.index).time}</span>
              {/if}
              {#if line.folds}
                <button
                  class="fold"
                  class:shut={line.folded}
                  data-fold
                  data-testid="notes-fold"
                  aria-expanded={!line.folded}
                  aria-label={line.folded ? 'Unfold this line' : 'Fold this line'}
                  title="Fold (⌘/)"
                ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg></button>
              {/if}
              {#if line.marker}<span class="marker" data-marker={line.state}>{line.marker}</span>{/if}
              {#if line.state === 'await'}
                <input
                  class="await-pill"
                  data-testid="notes-await"
                  data-await={block.id}
                  data-await-line={line.index}
                  size={Math.max(10, (line.condition || '').length + 1)}
                  value={line.condition || ''}
                  placeholder="waiting on what?"
                  aria-label="What this line is waiting on"
                  spellcheck="false"
                  onpointerdown={(event) => event.stopPropagation()}
                  oninput={(event) => setCondition(block, line.index, event.currentTarget.value)}
                  onkeydown={(event) => onConditionKeydown(event, block, line.index)}
                  onblur={() => { if (dirty.size) flush(); }}
                />
              {/if}
              {#if editing(block, line.index)}
                {#if richLine(block, line)}
                  <div class="box text rich" class:heading={line.heading} class:done={line.state === 'done'}
                    class:dropped={line.state === 'dropped'} data-heading={line.heading || undefined}
                    contenteditable={!archiveBusy} role="textbox" aria-multiline="true" tabindex="0"
                    spellcheck="false" data-testid="notes-box" use:richEditor={line.text}
                    oninput={(event) => onInput(event, block)} onkeydown={(event) => onKeydown(event, block)}
                    onkeyup={onKeyup} onpaste={(event) => onPaste(event, block)}
                    onblur={() => { if (dirty.size) flush(); flushReports(block.id); }}></div>
                {:else}
                <textarea
                  class="box text"
                  class:heading={line.heading}
                  class:done={line.state === 'done'}
                  class:dropped={line.state === 'dropped'}
                  readonly={archiveBusy}
                  data-heading={line.heading || undefined}
                  rows="1"
                  spellcheck="false"
                  data-testid="notes-box"
                  value={line.text}
                  oninput={(event) => onInput(event, block)}
                  onkeydown={(event) => onKeydown(event, block)}
                  onkeyup={onKeyup}
                  onpaste={(event) => onPaste(event, block)}
                  onblur={() => { if (dirty.size) flush(); flushReports(block.id); }}
                ></textarea>
                {/if}
              {:else}
                <span class="text" data-text data-empty={line.text === '' ? '' : undefined} class:heading={line.heading} class:done={line.state === 'done'} class:dropped={line.state === 'dropped'} data-heading={line.heading || undefined} use:inlineView={line.text || ' '}></span>
              {/if}
              {#if line.folded}<span class="hides" data-testid="notes-fold-count">{line.hides}</span>{/if}
              {#if doc && line.lineId}
                <span class="doc-side" data-testid="doc-line-side">
                  {#if line.author}<span class="who" class:owner={line.authorOwner} data-testid="doc-line-author" title={`last edited by ${line.author}`}>{line.author}</span>{/if}
                  <button class="add-comment" class:has={threadsOn(line.lineId) > 0} tabindex="-1" data-testid="doc-comment-add"
                    aria-label="Comment on this line" title="Comment on this line (⌘⌥M on a selection)"
                    onmousedown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                    onclick={(event) => { event.stopPropagation(); docComments?.open(line.lineId, line.text); }}
                  >+</button>
                </span>
              {/if}
            </div>
          {/if}
        {/each}
      </div>

    {#if carriesState(zoneOf(block))}
      <div class="comment">
        {#if commentFor === block.id}
          <textarea
            class="comment-box"
            rows="2"
            bind:this={commentBox}
            bind:value={commentText}
            placeholder="what should change here?"
            data-testid="notes-state-comment-box"
            onkeydown={(event) => onCommentKeydown(event, block)}
          ></textarea>
          <div class="comment-row">
            <button class="chip" onclick={() => sendComment(block)} data-testid="notes-state-comment-send">send</button>
            <button class="chip" onclick={closeComment} data-testid="notes-state-comment-cancel">cancel</button>
            <span class="hint">⌘↵ sends</span>
          </div>
        {:else}
          <button
            class="chat-chip"
            onclick={() => openComment(block)}
            data-testid="notes-state-comment"
            title="Send a comment on this section to a subagent (⌘↵)"
          >comment</button>
        {/if}
      </div>
    {/if}

    {#if !doc && backlinkOf(block.body)}
      {@const link = backlinkOf(block.body)}
      <div class="attached">
        <a
          class="source-chip"
          href={link.href}
          data-testid="notes-source-link"
          title="Open where this note came from"
        >{link.label} ↗</a>
      </div>
    {/if}

    {#if block.chatId && !doc}
      <div class="attached">
        <button
          class="chat-chip"
          class:open={cardFor === block.id}
          onclick={() => (cardFor = cardFor === block.id ? null : block.id)}
          data-testid="notes-chat-chip"
          data-chat={block.chatId}
          title="The chat this block started"
        >{cardFor === block.id ? '▾' : '▸'} {chatTitle(block.chatId)}</button>
        <button
          class="chat-chip forget"
          onclick={() => { if (cardFor === block.id) cardFor = null; if (paneChat === block.chatId) paneChat = null; put({ id: block.id, chatId: null }); flush(); }}
          data-testid="notes-chat-chip-remove"
          title="Take this chat off the note; the conversation itself stays"
          aria-label="Remove this chat chip"
        >×</button>

        {#if cardFor === block.id && chat}
          <div class="chat-card" data-testid="notes-chat-card">
            <div class="card-bar">
              <button
                class="chip"
                onclick={() => { paneChat = block.chatId; cardFor = null; }}
                data-testid="notes-chat-to-pane"
                title="Open this chat as a pane on the right"
              >open to the right</button>
            </div>
            <div class="card-body">
              <ChatPane
                session={chat}
                chatState={chatStateSnapshot}
                status={chatStatus}
                conversationId={block.chatId}
              />
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<style>
  .thread-source { display: block; margin: 0 0 12px var(--gutter); font-size: 12px; color: var(--ink-faint); }
  .thread-empty { font-size: 13px; opacity: .55; margin: 8px 0 20px var(--gutter); }
  .notes {
    display: flex; flex-direction: column; height: 100dvh;
    background: var(--bg); color: var(--ink); font-family: var(--sans);
    --measure: 44rem;
    --gutter: 4.5rem;
    /* One written line. A block break is two blank lines, so the gap between two rows has to
       measure exactly two of these (less the 1px of padding each box carries) or the text he
       is typing jumps the moment the block splits. */
    --note-size: 15px;
    --note-leading: 1.62;
    --note-line: calc(var(--note-size) * var(--note-leading));
  }
  .bar {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--line);
  }
  .right { display: inline-flex; align-items: center; gap: 6px; }
  .chip {
    border: 1px solid var(--line); border-radius: 999px; background: var(--bg-raised);
    color: var(--ink-dim); font-size: 12px; padding: 5px 11px;
  }
  .chip:hover { color: var(--ink); }
  .chip.on { background: var(--warn); color: var(--bg); border-color: transparent; }
  /* The stream chip is a toggle, not a recording light: open reads as the ink coming up, the way
     an opened chat chip does, and never as the mic's warn colour. */
  .chip.open { color: var(--ink); border-color: var(--ink-faint); }
  .find {
    border: 1px solid var(--line); border-radius: 999px; background: var(--bg-raised);
    color: var(--ink); font-size: 12px; padding: 5px 11px; width: 12rem;
  }
  .state { font-size: 11px; color: var(--ink-faint); }
  .state.bad { color: var(--warn); }

  .scroller { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
  /* A document: no zone labels (it is one document, not a timeline), the comment rail to the right
     of the text inside the scroller, and each line's last author and comment button at its end. */
  .notes.doc .scroller { position: relative; }
  .notes.doc .era { display: none; }
  .notes.doc .scroller > .zone { padding-bottom: 40vh; }
  @media (min-width: 1100px) { .notes.doc .scroller { padding-right: 340px; } }
  .doc-side {
    margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 6px;
    padding-left: 8px; align-self: center;
  }
  .doc-side .who {
    font-size: 10.5px; color: var(--ink-faint); opacity: 0; max-width: 9rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: opacity 120ms;
  }
  .doc-side .who.owner { color: var(--accent); }
  .line:hover .doc-side .who, .line.active .doc-side .who { opacity: 1; }
  .add-comment {
    font-size: 11px; line-height: 1; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--bg-raised); color: var(--ink-faint); cursor: pointer;
    opacity: 0; transition: opacity 120ms;
  }
  .add-comment.has { opacity: 1; color: var(--ink); border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); }
  .line:hover .add-comment, .line.active .add-comment { opacity: 1; }
  @media (hover: none) { .add-comment { opacity: 0.6; } }
  /* One width and one rhythm for the document; its zones are sections of it, not different things.
     .flow wraps Past and NOW because the tail spacer, which sets how much of NEXT peeks in, measures
     from there. The last section gets the room that keeps its final line reachable. */
  .flow, .tail, .scroller > .zone { width: min(100%, calc(var(--measure) + var(--gutter))); margin: 0 auto; padding: 0 16px; }
  .flow { padding-top: 14px; }
  .scroller > .zone { padding-bottom: 28px; }
  /* Room under the last zone so a page break can still scroll to the top of the screen now that the
     tail under NOW is a few lines rather than a screen. */
  .scroller > .zone:last-child { padding-bottom: 85vh; }
  .era {
    margin: 18px 0 10px; width: 100%; padding-right: 14px;
    display: flex; align-items: center; gap: 14px;
    text-align: right; font-size: 10px; font-weight: 300;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-faint);
  }
  .archive-now { font: inherit; letter-spacing: inherit; color: inherit; border: 0; padding: 0; background: transparent; cursor: pointer; }
  .archive-now:hover { color: var(--ink); }
  .era::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  /* A block whose every line has retired keeps its 2pt lines and drops its furniture. */
  .row.spent .gutter > *, .row.spent .comment, .row.spent .attached { display: none; }
  .row.spent .gutter { padding: 0; }

  .comment { grid-column: 2; margin-top: 6px; }
  .comment-box {
    width: 100%; resize: vertical; font: inherit; font-size: 13px; color: var(--ink);
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px;
    outline: none;
  }
  .comment-row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .hint { font-size: 11px; color: var(--ink-faint); }

  .earlier {
    display: block; margin: 0 auto 14px; border: 0; background: none;
    color: var(--ink-faint); font-size: 11px;
  }
  .earlier:hover { color: var(--ink); }

  .split { flex: 1; min-height: 0; display: flex; }
  .split > .scroller { flex: 1 1 auto; min-width: 0; }
  .side {
    flex: 0 0 min(38vw, 30rem); display: flex; flex-direction: column;
    border-left: 1px solid var(--line); min-width: 0; background: var(--bg);
  }
  .side-bar {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 6px 10px; border-bottom: 1px solid var(--line);
  }
  .side-title { font-size: 12px; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .side-body { flex: 1; min-height: 0; display: flex; }
  .side-body > :global(*) { flex: 1; min-width: 0; }

  .attached { grid-column: 2; margin-top: 6px; }
  .chat-chip {
    border: 1px solid var(--line); border-radius: 999px; background: var(--bg-raised);
    color: var(--ink-faint); font: inherit; font-size: 11.5px; padding: 3px 10px; cursor: pointer;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .chat-chip:hover, .chat-chip.open { color: var(--ink); }
  /** Normal text, slightly gray and italic: no pill chrome. */
  .await-pill {
    font: inherit; font-style: italic; line-height: inherit;
    border: 0; border-radius: 0; padding: 0; margin-right: .35em;
    background: transparent; color: color-mix(in srgb, var(--ink) 62%, transparent);
    outline: none; min-width: 4em; max-width: 60%;
  }
  .await-pill:focus { color: var(--ink); }
  .line[data-await-parked] .text { color: var(--ink-faint); }
  .chat-chip.forget { opacity: 0; margin-left: 4px; padding: 0 4px; }
  .attached:hover .chat-chip.forget, .chat-chip.forget:focus { opacity: .7; }
  /* A transcluded note ends on a line that names its source and links back, and the document
     renders no links; this is that line's click, in the chat chip's shape so the two read as one
     family of attachments under a block. */
  .source-chip {
    display: inline-block; border: 1px solid var(--line); border-radius: 999px;
    background: var(--bg-raised); color: var(--ink-faint); font: inherit; font-size: 11.5px;
    padding: 3px 10px; text-decoration: none; max-width: 100%; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .source-chip:hover { color: var(--ink); }
  .chat-card {
    margin-top: 6px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
    display: flex; flex-direction: column; height: min(46vh, 30rem); background: var(--bg-raised);
  }
  .card-bar { display: flex; justify-content: flex-end; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .card-body { flex: 1; min-height: 0; display: flex; }
  .card-body > :global(*) { flex: 1; min-width: 0; }

  .row { display: grid; grid-template-columns: var(--gutter) 1fr; align-items: start; }
  .gutter.blank { visibility: hidden; }
  .document-gap { display: block; width: calc(100% - var(--gutter)); margin-left: var(--gutter);
    height: calc(2 * var(--note-line) - 2px); padding: 0; border: 0; background: transparent;
    cursor: text; color: inherit; text-align: left; resize: none; overflow: hidden; outline: none;
    font: inherit; font-size: var(--note-size); line-height: var(--note-leading); }

  /* The tick is anchored to the inside edge of the gutter and grows away from the text: a full
     stamp is wider than the gutter, and laid out in flow it would sit on top of the words and eat
     the clicks meant for them. */
  .gutter { position: relative; text-align: right; padding: 2px 28px 0 0; }
  .handle {
    position: absolute; right: 28px; top: 2px; user-select: none;
    border: 0; background: none; padding: 0; font: inherit; font-size: 11px;
    color: var(--ink-faint); font-variant-numeric: tabular-nums; white-space: pre;
    cursor: pointer;
  }
  /* The day is always there. The time is only for when he looks for it: hovering the row, or
     having the caret in it, brings it up. It keeps its place in the line either way -- opacity,
     never display -- so the date does not slide sideways under the pointer. */
  .handle .time { opacity: 0; transition: opacity var(--tap, 120ms) ease; }
  .row.firstHover .handle .time, .row.firstActive .handle .time { opacity: 1; }
  /* A line written more than a minute after the one above it says so without being asked: that
     gap is the thing he wants to see while he keeps writing. */

  .handle:hover { color: var(--ink); }
  .rule { grid-column: 1 / -1; margin: 18px 0 18px var(--gutter); border-top: 1px solid var(--line); }
  .elided { margin: 8px 0 8px var(--gutter); border-top: 1px dashed var(--line); opacity: 0.7; height: 12px; }

  .box, .read {
    font: inherit; font-size: var(--note-size); line-height: var(--note-leading);
    color: var(--ink); background: none; border: 0; padding: 1px 0; margin: 0;
    white-space: pre-wrap; word-break: break-word;
  }
  /* The caret's line is a textarea sitting where the rendered span was, inside the same row: same
     font, same leading, same wrap width, no padding or border of its own, so the words do not move
     by a pixel when the caret arrives or leaves. */
  .box {
    flex: 1 1 auto; min-width: 0; width: auto; resize: none; overflow: hidden; outline: none;
    display: block; padding: 0;
  }
  .read { min-height: calc(1em * var(--note-leading)); cursor: text; }
  .read.empty { color: var(--ink-faint); }
  /* The row's items line up by their tops, not their baselines: a textarea is a scroll container,
     whose baseline is its bottom edge, so baseline alignment would drop the caret's line a few
     pixels below where the rendered one sat. Equal line-heights make tops and baselines agree. */
  .drag-handle { position:absolute; right:100%; margin-right:20px; width:22px; height:24px; border:0; background:transparent; color:var(--muted); cursor:grab; opacity:0; touch-action:none; user-select:none; line-height:24px; }
  .drag-handle::before { content:'\283F'; }
  .drag-handle { transition: opacity var(--tap, 120ms) ease; }
  .drag-handle:focus { opacity:.8; }
  @media (hover: hover) { .line:hover > .drag-handle { opacity:.8; } }
  :global(.dragging-lines) { user-select:none; cursor:grabbing; }
  :global(body.notes-dragging), :global(body.notes-dragging *) { cursor:grabbing !important; }
  :global(.drag-source), :global(.drag-source) :global(*) { opacity:.45; }
  /** While a line is travelling the document shrinks to its landing spots: every line is one row
   *     tall whatever its length, and anything deeper than the level being dragged is out of the way.
   */
  :global(.drag-compact) :global([data-text]) {
    display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  :global(.drag-compact) :global(.line.drag-deep) { display:none; }
  /* Touch has no hover: the grip is put away and a tap on the row's gutter (or a hold that has
     picked the row up) brings it back for that row alone. Until then it takes no touches, so the
     gutter zone beneath it is what a tap lands on. */
  .gutter-zone { display: none; }
  @media (hover: none) {
    .gutter-zone { display: block; position: absolute; right: 100%; top: 0; width: 46px; height: 100%; min-height: 24px; touch-action: manipulation; }
    .drag-handle { pointer-events: none; }
    .line.gutter-open > .drag-handle, .line:global(.grip-held) > .drag-handle { opacity: .6; pointer-events: auto; }
    .line.gutter-open > .gutter-zone, .line:global(.grip-held) > .gutter-zone { display: none; }
  }
  .line[data-row-selected] { background: color-mix(in srgb, #3b82f6 22%, transparent); border-radius: 4px; box-shadow: 0 0 0 2px color-mix(in srgb, #3b82f6 22%, transparent); }
  .line { min-height: calc(1em * var(--note-leading)); display: flex; gap: 0.45rem; align-items: flex-start; position: relative; margin-left: var(--indent, 0); }
  /* An agent's line, in the machine serif. Both the rendered span and the box he edits it in take
     the same face and the same size, so clicking into a line never reflows it. */
  .line.agent .text, .line.agent .box, .line.agent .marker {
    font-family: var(--serif-machine);
    /* The size and the leading stay exactly his, or an agent's line would be a different height
       and the gutter ticks, the fold rows and the two-blank-line gap would all shift under it. */
    font-size: var(--note-size);
    line-height: var(--note-leading);
    letter-spacing: 0.002em;
  }
  /* The per-line tick lives in the gutter beside its own line, right-aligned to the same inside
     edge the block's handle uses. The indent of a list line is subtracted back out, so the column
     of ticks is straight however deep the list goes. */
  .line-tick {
    position: absolute; top: 0; text-align: right; white-space: pre; pointer-events: none; user-select: none;
    left: calc(-1 * (var(--indent, 0px) + 28px + var(--gutter)));
    width: var(--gutter);
    font-size: 11px; line-height: var(--note-leading); color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    opacity: 0; transition: opacity var(--tap, 120ms) ease;
  }
  .line:hover .line-tick, .line.active .line-tick { opacity: 1; }
  /* The chevron sits in the margin and never in the flow: a line that can fold must not be set an
     inch to the right of one that cannot, or the document moves as the builder rewrites it. */
  .fold {
    position: absolute; left: -24px; top: 0; width: 24px; height: 24px; padding: 3px; border: 0; border-radius: 5px; background: none;
    display: grid; place-items: center; color: var(--ink-faint);
    cursor: pointer; opacity: 0; transition: opacity var(--tap, 120ms) ease;
  }
  /* Shown the way the grip is, on the line under the pointer, so a quiet document is quiet. A line
     that is folded keeps its chevron: its children are out of sight and the chevron is the only
     cue that they are there (the count pill beside the text says how many). The box stays 24px so
     the hover path from the grip to the text is unbroken; only the drawn chevron is 75% of what it was. */
  .fold.shut { opacity: 1; }
  @media (hover: hover) { .line:hover > .fold { opacity: 1; } }
  .fold::before { content: ''; position: absolute; inset: 3px; border-radius: 5px; }
  .fold svg { position: relative; width: 13.5px; height: 13.5px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transform: rotate(90deg); }
  .fold.shut svg { transform: rotate(0deg); }
  .fold:hover { color: var(--ink); }
  .fold:hover::before { background: var(--bg-raised); }
  .fold:focus-visible { opacity: 1; outline: 2px solid var(--ink-faint); outline-offset: 1px; }
  /* Touch: hidden until the row's gutter is tapped or the row is held; a folded row's chevron stays. */
  @media (hover: none) {
    .fold:not(.shut) { pointer-events: none; }
    .line.gutter-open > .fold, .line:global(.grip-held) > .fold { opacity: 1; pointer-events: auto; }
  }
  .hides {
    flex: 0 0 auto; font-size: 11px; color: var(--ink-faint); user-select: none;
    border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; line-height: 1.5;
  }
  @media (prefers-reduced-motion: reduce) { .fold { transition: none; } }
  .marker {
    flex: 0 0 auto; width: 1rem; color: var(--ink-faint); user-select: none; cursor: pointer;
    text-align: center;
  }
  /* The builder writes `## section` at the head of each state block; he reads a heading, not hashes. */
  .text.heading {
    font-weight: 700; color: var(--ink);
  }
  .text[data-heading="1"] { font-size: 1.6em; }
  /* Keep the reference's highlights fitted to the words, including while typing. */
  .text[data-heading="2"], .text[data-heading="3"] {
    flex: 0 1 auto; width: fit-content; min-width: 1ch; max-width: 100%;
    background: linear-gradient(transparent 0.18em, var(--heading-highlight) 0.18em,
      var(--heading-highlight) 1.3em, transparent 1.3em);
    background-size: 100% calc(1em * var(--note-leading));
  }
  .text[data-heading="2"] { font-size: 1.3em; color: #000; --heading-highlight: #d9ead3; }
  .text[data-heading="3"] { font-size: 1.2em; color: #434343; --heading-highlight: #fff2cc; }
  .text[data-heading="4"] { font-size: 1em; text-decoration: underline; }
  .rich { min-height: calc(1em * var(--note-leading)); white-space: pre-wrap; }
  .text :global(strong) { font-weight: 700; }
  .text :global(em) { font-style: italic; }
  .text :global(u) { text-decoration: underline; }
  .text.done { text-decoration: line-through; opacity: 0.68; }
  .line.retired, .line.retired * { font-size: 2pt !important; line-height: 1.2 !important; min-height: 0 !important; }
  /** Dropped sits well below done at a glance. */
  .text.dropped { text-decoration: line-through; color: var(--ink-faint); opacity: 0.32; }
  .marker[data-marker="dropped"] { opacity: 0.4; }
  .dropped-by-parent .text { text-decoration: line-through dashed; opacity: 0.5; }
  .dropped-by-parent .marker { opacity: 0.5; }

  .partial { margin-left: var(--gutter); font-size: var(--note-size); color: var(--ink-faint); font-style: italic; }

  .menu {
    position: fixed; z-index: 40; display: flex; flex-direction: column; min-width: 9rem;
    border: 1px solid var(--line); border-radius: 10px; background: var(--bg-raised);
    box-shadow: 0 8px 26px rgb(0 0 0 / 22%); overflow: hidden;
  }
  .menu button {
    border: 0; background: none; text-align: left; padding: 9px 12px; font: inherit; font-size: 13px;
    color: var(--ink);
  }
  .menu button:hover { background: color-mix(in srgb, var(--ink) 8%, transparent); }
  .menu button.bad { color: var(--warn); }

  .mic-host { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

  @media (max-width: 640px) {
    .notes { --gutter: 3.2rem; --note-size: 16px; }

    .menu button { padding: 12px 14px; font-size: 15px; }
  }
</style>
