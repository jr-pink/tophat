<script>
  // Comments on a public document: select words in a line, then the floating "Comment" button or ⌘⌥M
  // (Ctrl+Alt+M elsewhere, as in Google Docs); the span stays highlighted. On a desktop the threads are
  // webchat's own side-thread rail (SideThreads / SideThread, the very component the chat pane uses, so
  // a fix lands in both): each card beside its span, stacked without overlap, the focused one expanded;
  // a new comment opens as a card there. On a narrow screen there is no room for a rail, so it is the
  // reader's flow: the note box (SelectBox) over the words, and the reader's note popover over a
  // highlight. The selection pill is SelectPill.
  //
  // A comment is anchored to a span of one line (doc-anchor.js over reader-anchor.js): line id,
  // quote, offsets in the line's rendered text. The quote is found again after the line is edited,
  // or in another line if it moved; a comment whose words are gone is listed as detached, never
  // dropped. Highlights are painted with the CSS Custom Highlight API, so the editor's DOM is
  // never touched.
  //
  // Nothing here scrolls the page: every focus is preventScroll, the popovers live in a fixed
  // layer over the document, and opening a thread never re-renders the document.
  //
  // Offline first: the threads last seen are kept on the device and painted at once, and a comment
  // written with the server away is an action in the document's op log (docs-state.js, a kit state with
  // scope 'cloud'), shown at once, and delivered to the docs server by the log's sink on reconnect; the
  // server keeps the first copy of an id, so a replay never doubles a comment.
  import { onMount, tick } from 'svelte';
  import SelectPill from './SelectPill.svelte';
  import SelectBox from './SelectBox.svelte';
  import SideThreads from './SideThreads.svelte';
  import { liveClientId } from '$lib/client/live.js';
  import { docAnchor, isCommentChord, locateThread } from '$lib/core/doc-anchor.js';
  import { uiApp } from '$lib/client/ui-app.js';
  import { docCommentsDecl, docThreadsDecl, overlayThreads } from '$lib/core/docs-state.js';
  import { docsCommentSink, isOffline } from '$lib/client/docs-sync.js';

  let { doc, api, threads = $bindable([]) } = $props();

  const cache = uiApp().use(docThreadsDecl(doc.token));
  // What this device wrote: the op log. `pendingList` is what the docs server has not acknowledged yet.
  const comments = uiApp().use(docCommentsDecl(doc.token), {
    transport: docsCommentSink({ call: (...args) => call(...args), me: () => doc.name || '', adopt: (list) => adopt(list), refuse: (message) => { error = message; } })
  });
  const pendingList = $derived.by(() => { $comments; return comments.pending; });
  let pill = $state(null);          // { x, y, below, anchor } over a live selection
  let quick = $state(null);         // { x, y, below, anchor, text } a new comment being typed
  let peek = $state(null);          // { id, x, y, below } a thread open over its highlight
  let replyText = $state('');
  let listOpen = $state(false);
  let error = $state(null);
  let layout = $state(0);           // bumped when the document's DOM changes
  let narrow = $state(false);       // below RAIL_MIN_PX: popovers instead of the rail
  let rail = $state(null);
  let drafts = $state([]);          // rail cards opened here with no comment yet
  let focusedId = $state(null);
  let autofocusId = $state(null);
  let collapsed = $state([]);
  let rev = $state(0);
  const RAIL_MIN_PX = 1100;
  let quickBox = null;
  let replyBox = $state(null);
  const painted = new Map();        // thread id -> { el, start, end }

  const randomId = (prefix) => {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return `${prefix}${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  };

  const headers = (author) => ({
    'content-type': 'application/json',
    'x-doc-name': encodeURIComponent(author ?? (doc.name || '')),
    'x-doc-client': liveClientId()
  });

  // A 5xx, a Cloudflare page or no answer at all is "offline", never an error to show.
  const notJson = (response) => !(response.headers.get('content-type') || '').includes('json');

  async function call(method, body, author) {
    const response = await fetch(`${api}/comments`, { method, headers: headers(author), body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
    if (response.status >= 500 || notJson(response)) throw Object.assign(new Error('offline'), { offline: true });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error || `comment ${response.status}`);
    return answer;
  }

  function adopt(list) {
    threads = Array.isArray(list) ? list : [];
    cache.dispatch('threads.set', { threads });
  }

  export async function refresh() {
    try {
      const response = await fetch(`${api}/comments`, { signal: AbortSignal.timeout(6000) });
      if (response.status >= 500 || notJson(response) || !response.ok) return;
      adopt((await response.json()).threads);
      error = null;
    } catch { /* offline: the cached threads stay */ }
  }

  // Deliver the op log: one sync at a time (a write during one asks for another when it ends). Offline leaves
  // the entries pending; a refusal for good is acknowledged by the sink and reported in `error`.
  let syncing = null, again = false;
  function flushOutbox() {
    if (!comments.pending.length) return syncing;
    if (syncing) { again = true; return syncing; }
    syncing = comments.sync().catch((cause) => { if (!isOffline(cause)) error = cause.message; }).finally(() => {
      syncing = null;
      if (again) { again = false; flushOutbox(); }
    });
    return syncing;
  }

  const stamp0 = () => new Date().toISOString();
  /** A comment, on a thread that may not exist yet: one action in the log, shown at once, delivered by the sink. */
  function say(thread, text) {
    comments.dispatch('comment.add', {
      threadId: thread.threadId ?? thread.id, id: randomId('c'), lineId: thread.lineId, quote: thread.quote, start: thread.start, end: thread.end,
      body: text, author: doc.name || '', owner: doc.owner, at: stamp0()
    });
    flushOutbox();
  }

  // --- the threads as shown: the server's, plus what is still in the op log -------------------------

  const me = () => (doc.owner ? 'the owner' : doc.name || 'anonymous');
  const all = $derived.by(() => {
    const shown = overlayThreads(threads, pendingList, { me: me(), owner: doc.owner });
    const have = new Set(shown.map((thread) => thread.id));
    for (const draft of drafts) if (!have.has(draft.id)) shown.push(draft);
    return shown;
  });
  const openThreads = $derived(all.filter((thread) => !thread.resolvedAt));
  const resolvedList = $derived(all.filter((thread) => thread.resolvedAt));
  const peeked = $derived(peek ? all.find((thread) => thread.id === peek.id) || null : null);

  // --- the document's lines, read from the DOM --------------------------------------------------

  const scroller = () => document.querySelector('.notes.doc .scroller');
  const rowOf = (lineId) => scroller()?.querySelector(`.line[data-item="${CSS.escape(lineId)}"]`) || null;

  /** Every line with its rendered text (the editing line's textarea value stands in for it). */
  function readRows() {
    const out = [];
    for (const row of scroller()?.querySelectorAll('.line[data-item]') || []) {
      const span = row.querySelector('[data-text]');
      const box = row.querySelector('.box.text');
      const text = span ? span.textContent : box ? (box.value ?? box.textContent ?? '') : '';
      out.push({ lineId: row.dataset.item, text: text === ' ' ? '' : text, span, row });
    }
    return out;
  }

  /** A DOM Range over characters `start` to `end` of an element's text. */
  function rangeIn(el, start, end) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let seen = 0;
    let begun = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.nodeValue.length;
      if (!begun && start <= seen + length) { range.setStart(node, start - seen); begun = true; }
      if (begun && end <= seen + length) { range.setEnd(node, end - seen); return range; }
      seen += length;
    }
    return null;
  }

  /** The character offset of (node, offset) inside el's text. */
  function offsetIn(el, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(el);
    try { range.setEnd(node, offset); } catch { return -1; }
    return range.toString().length;
  }

  // --- painting ----------------------------------------------------------------------------------

  const canPaint = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

  function paint() {
    painted.clear();
    const rows = readRows();
    const ranges = [];
    const active = [];
    for (const thread of openThreads) {
      const at = locateThread(thread, rows);
      if (!at) continue;
      const row = rows.find((entry) => entry.lineId === at.lineId);
      if (!row?.span) continue;          // the line being edited: no highlight inside a textarea
      painted.set(thread.id, { el: row.span, start: at.start, end: at.end });
      const range = rangeIn(row.span, at.start, at.end);
      if (!range) continue;
      (peek?.id === thread.id ? active : ranges).push(range);
    }
    if (!canPaint()) return;
    // On a desktop the rail paints the same spans itself (sidechat / sidechat-focus).
    CSS.highlights.set('doc-comment', new Highlight(...(narrow ? ranges : [])));
    CSS.highlights.set('doc-comment-active', new Highlight(...(narrow ? active : [])));
  }

  const detached = $derived.by(() => {
    layout;
    const rows = typeof document === 'undefined' ? [] : readRows();
    return openThreads.filter((thread) => !locateThread(thread, rows));
  });

  $effect(() => {
    layout; openThreads; peek?.id; narrow;
    paint();
    rail?.remeasure();
  });

  // --- the desktop rail --------------------------------------------------------------------------

  /** The rail's anchor for a thread: its resolved span, as offsets in the row's whole text. */
  const railThreads = $derived.by(() => {
    layout; rev;
    if (narrow || typeof document === 'undefined') return [];
    const rows = readRows();
    const out = [];
    for (const thread of all) {
      if (thread.resolvedAt) continue;
      const at = locateThread(thread, rows);
      if (!at) continue;
      const row = rows.find((entry) => entry.lineId === at.lineId);
      const lead = row?.span ? Math.max(0, offsetIn(row.row, row.span, 0)) : 0;
      out.push({
        id: thread.id, runState: 'idle', resolvedAt: thread.resolvedAt || null,
        sidechat: { itemId: at.lineId, quote: thread.quote, start: lead + at.start, end: lead + at.end }
      });
    }
    return out;
  });
  const chatState = $derived.by(() => {
    const items = {};
    for (const thread of all) {
      items[thread.id] = (thread.comments || []).map((comment) => ({
        id: comment.id, type: 'user', text: comment.body, author: comment.author, owner: comment.owner, at: comment.createdAt, pending: comment.pending
      }));
    }
    return { rev: rev + pendingList.length + threads.length, items, conversations: {} };
  });
  const session = {
    send(threadId, text) {
      const thread = all.find((entry) => entry.id === threadId);
      if (!thread || !String(text || '').trim()) return;
      say(thread, String(text).trim());
      drafts = drafts.filter((draft) => draft.id !== threadId);
      rev += 1;
    }
  };
  async function focusRail(id) {
    collapsed = collapsed.filter((entry) => entry !== id);
    focusedId = id;
    rev += 1;
    await tick();
    rail?.remeasure();
    rail?.focusCard(id);
  }
  function railResolve(id, resolved) {
    if (drafts.some((draft) => draft.id === id)) { drafts = drafts.filter((draft) => draft.id !== id); return; }
    const thread = all.find((entry) => entry.id === id);
    if (thread) setResolved(thread, resolved);
    if (focusedId === id) focusedId = null;
  }
  function railCollapse(id) {
    if (drafts.some((draft) => draft.id === id)) drafts = drafts.filter((draft) => draft.id !== id);
    else collapsed = [...collapsed, id];
    if (focusedId === id) focusedId = null;
  }

  // --- placing a popover -------------------------------------------------------------------------

  /** Viewport point for a popover over `rect`: above it, or below when near the top. */
  function placeOver(rect) {
    const below = rect.top < 140;
    return { x: Math.max(170, Math.min(window.innerWidth - 170, rect.left + rect.width / 2)), y: below ? rect.bottom : rect.top, below };
  }

  function rectOfThread(thread) {
    const spot = painted.get(thread.id);
    if (spot) {
      const range = rangeIn(spot.el, spot.start, spot.end);
      const rect = range?.getClientRects?.()[0] || range?.getBoundingClientRect?.();
      if (rect && rect.width + rect.height > 0) return rect;
    }
    const row = rowOf(thread.lineId);
    if (row) return row.getBoundingClientRect();
    return null;
  }

  function reposition() {
    if (peek) {
      const thread = all.find((entry) => entry.id === peek.id);
      const rect = thread && rectOfThread(thread);
      if (rect && peek.attached) peek = { ...peek, ...placeOver(rect) };
    }
    if (quick?.rect) {
      const rect = quick.rect();
      if (rect) quick = { ...quick, ...placeOver(rect) };
    }
    if (pill) pill = null;   // a selection pill does not follow a scroll; selecting again brings it back
  }

  // --- reading the selection ---------------------------------------------------------------------

  /** The anchor and its on-screen rect for the current selection inside one line, or null. */
  function currentSelection({ wholeLine = false } = {}) {
    const root = scroller();
    if (!root) return null;
    const active = document.activeElement;
    // The editing line: its textarea holds the selection.
    if (active && root.contains(active) && active.matches?.('textarea.box.text')) {
      const row = active.closest('.line[data-item]');
      if (!row) return null;
      const value = active.value || '';
      let start = active.selectionStart ?? 0;
      let end = active.selectionEnd ?? 0;
      if (start === end) { if (!wholeLine) return null; start = 0; end = value.length; }
      const anchor = docAnchor(row.dataset.item, value, start, end);
      if (!anchor) return null;
      const rectFn = () => (rowOf(anchor.lineId)?.querySelector('.box.text, [data-text]') || rowOf(anchor.lineId))?.getBoundingClientRect() || null;
      return { anchor, rect: rectFn };
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest?.('[data-text]');
    const endEl = (range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement)?.closest?.('[data-text]');
    if (!startEl || startEl !== endEl || !root.contains(startEl)) {
      if (!wholeLine || !selection.isCollapsed) return null;
      return null;
    }
    const row = startEl.closest('.line[data-item]');
    if (!row) return null;
    const text = startEl.textContent || '';
    let start = offsetIn(startEl, range.startContainer, range.startOffset);
    let end = offsetIn(startEl, range.endContainer, range.endOffset);
    if (start < 0 || end < 0) return null;
    if (start === end) { if (!wholeLine) return null; start = 0; end = text.length; }
    const anchor = docAnchor(row.dataset.item, text, start, end);
    if (!anchor) return null;
    const rect = () => {
      const now = rowOf(anchor.lineId)?.querySelector('[data-text]');
      const live = now && rangeIn(now, anchor.start, anchor.end);
      const r = live?.getBoundingClientRect();
      return r && r.width + r.height > 0 ? r : rowOf(anchor.lineId)?.getBoundingClientRect() || null;
    };
    return { anchor, rect };
  }

  let selectTimer = null;
  function onSelectionChange() {
    clearTimeout(selectTimer);
    selectTimer = setTimeout(() => {
      if (quick || peek) return;
      const found = currentSelection();
      if (!found) { pill = null; return; }
      const rect = found.rect();
      if (!rect) { pill = null; return; }
      pill = { ...placeOver(rect), anchor: found.anchor, rect: found.rect };
    }, 120);
  }

  // --- opening things ----------------------------------------------------------------------------

  async function startComment(found) {
    if (!found) return false;
    pill = null;
    peek = null;
    if (!narrow) {
      const id = randomId('t');
      drafts = [...drafts, { ...found.anchor, id, comments: [], resolvedAt: null, draft: true }];
      autofocusId = id;
      window.getSelection()?.removeAllRanges();
      await focusRail(id);
      return true;
    }
    const rect = found.rect();
    quick = { ...placeOver(rect || { left: window.innerWidth / 2, width: 0, top: window.innerHeight / 2, bottom: window.innerHeight / 2 }), anchor: found.anchor, rect: found.rect, text: '' };
    await tick();
    quickBox?.focus({ preventScroll: true });
    return true;
  }

  function commitQuick() {
    if (!quick) return;
    const text = (quick.text || '').trim();
    if (!text) { quick = null; return; }
    const { anchor } = quick;
    const threadId = randomId('t');
    say({ threadId, lineId: anchor.lineId, quote: anchor.quote, start: anchor.start, end: anchor.end }, text);
    quick = null;
    window.getSelection()?.removeAllRanges();
  }

  function onQuickKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); quick = null; return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); commitQuick(); }
  }

  async function openThread(id, { attached = true } = {}) {
    const thread = all.find((entry) => entry.id === id);
    if (!thread) return;
    const rect = attached ? rectOfThread(thread) : null;
    const spot = rect ? placeOver(rect) : { x: window.innerWidth / 2, y: Math.round(window.innerHeight / 3), below: true };
    pill = null;
    quick = null;
    replyText = '';
    peek = { id, ...spot, attached: Boolean(rect) };
    await tick();
    replyBox?.focus({ preventScroll: true });
  }

  function sendReply() {
    const text = replyText.trim();
    const thread = peeked;
    if (!text || !thread) return;
    say({ threadId: thread.id, lineId: thread.lineId, quote: thread.quote, start: thread.start, end: thread.end }, text);
    replyText = '';
    replyBox?.focus({ preventScroll: true });
  }

  function onReplyKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); peek = null; return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendReply(); }
  }

  function setResolved(thread, resolved) {
    threads = threads.map((entry) => (entry.id === thread.id ? { ...entry, resolvedAt: resolved ? new Date().toISOString() : null } : entry));
    comments.dispatch('thread.resolve', { threadId: thread.id, resolved, at: stamp0() });
    flushOutbox();
    if (resolved) peek = null;
  }

  /**
   * The line's comment button: its open thread if it has one, else a comment on the whole line.
   * Kept under its old name; NotesEditor calls it.
   */
  export async function open(lineId) {
    if (!lineId) return;
    const rows = readRows();
    const existing = all.find((thread) => !thread.resolvedAt && locateThread(thread, rows)?.lineId === lineId);
    if (existing) { if (narrow) await openThread(existing.id); else await focusRail(existing.id); return; }
    const row = rows.find((entry) => entry.lineId === lineId);
    const anchor = row && docAnchor(lineId, row.text, 0, row.text.length);
    if (!anchor) return;
    await startComment({ anchor, rect: () => rowOf(lineId)?.getBoundingClientRect() || null });
  }

  // --- input: the chord, and clicks on a highlight -----------------------------------------------

  const inLayer = (target) => Boolean(target?.closest?.('[data-doc-pop]'));

  function onKey(event) {
    if (!isCommentChord(event)) return;
    if (inLayer(event.target)) return;
    const found = currentSelection({ wholeLine: true });
    if (!found) return;
    // Ahead of everything in the editor (vim included): this listener is registered first.
    event.preventDefault();
    event.stopImmediatePropagation();
    startComment(found);
  }

  /** The open thread whose highlight is under a viewport point, or null. */
  function threadAt(x, y) {
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
      const at = document.caretPositionFromPoint(x, y);
      if (at) { node = at.offsetNode; offset = at.offset; }
    } else if (document.caretRangeFromPoint) {
      const at = document.caretRangeFromPoint(x, y);
      if (at) { node = at.startContainer; offset = at.startOffset; }
    }
    const el = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('[data-text]');
    if (!el) return null;
    const at = offsetIn(el, node, offset);
    for (const [id, spot] of painted) {
      if (spot.el !== el || at < spot.start || at > spot.end) continue;
      // The caret lands between characters: check the point is really over the painted words.
      const range = rangeIn(el, spot.start, spot.end);
      for (const rect of range?.getClientRects?.() || []) {
        if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return id;
      }
    }
    return null;
  }

  let swallowClick = false;
  function onPointerDown(event) {
    if (inLayer(event.target)) return;
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) { closeLayer(event); return; }
    const id = painted.size ? threadAt(event.clientX, event.clientY) : null;
    if (!id) { closeLayer(event); return; }
    // A click on a highlight opens its thread and does not put the caret in the line: the
    // editor's own pointer handlers never see it.
    event.preventDefault();
    event.stopImmediatePropagation();
    swallowClick = true;
    if (narrow) openThread(id); else focusRail(id);
  }
  function onMouseOrClick(event) {
    if (!swallowClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'click') swallowClick = false;
  }
  function closeLayer(event) {
    if (inLayer(event.target)) return;
    if (peek) peek = null;
    if (quick && !(quick.text || '').trim()) quick = null;
  }

  onMount(() => {
    adopt(cache.get().threads);
    refresh();
    flushOutbox();
    const retry = setInterval(flushOutbox, 5000);
    const query = window.matchMedia(`(max-width: ${RAIL_MIN_PX - 1}px)`);
    const onQuery = () => { narrow = query.matches; if (!narrow) { peek = null; quick = null; } };
    onQuery();
    query.addEventListener('change', onQuery);
    // Capture on window, registered before the editor's own (a child mounts first), so the chord
    // and a click on a highlight are ours before vim or the line editor see them.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('mousedown', onMouseOrClick, true);
    window.addEventListener('click', onMouseOrClick, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('online', flushOutbox);
    document.addEventListener('selectionchange', onSelectionChange);
    // Any change to the document's text moves or breaks a painted range, so the layout is read
    // again on the next frame. The whole body is watched, not the scroller: the scroller can be
    // replaced under us (and is not in the document yet when this mounts), and a watcher on a
    // detached element silently sees nothing. Changes inside this layer are ignored.
    let frame = 0;
    const observer = new MutationObserver((records) => {
      if (frame || records.every((record) => inLayer(record.target.nodeType === 1 ? record.target : record.target.parentElement))) return;
      frame = requestAnimationFrame(() => { frame = 0; layout += 1; });
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    requestAnimationFrame(() => { layout += 1; });
    return () => {
      clearInterval(retry);
      query.removeEventListener('change', onQuery);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('mousedown', onMouseOrClick, true);
      window.removeEventListener('click', onMouseOrClick, true);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('online', flushOutbox);
      document.removeEventListener('selectionchange', onSelectionChange);
      if (canPaint()) { CSS.highlights.delete('doc-comment'); CSS.highlights.delete('doc-comment-active'); }
    };
  });

  const stamp = (iso) => {
    if (!iso) return '';
    const at = new Date(iso);
    const today = new Date().toDateString() === at.toDateString();
    return today ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : at.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
</script>

{#if !narrow}
  <SideThreads
    bind:this={rail}
    {session}
    {chatState}
    threads={railThreads}
    {focusedId}
    {collapsed}
    wide={true}
    {autofocusId}
    comments={true}
    onresolve={railResolve}
    onfocus={(id) => { focusedId = id; }}
    oncollapse={railCollapse}
  />
{/if}

<div class="layer" data-doc-pop data-testid="doc-comment-layer">
  {#if pill && !quick && !peek}
    <SelectPill x={pill.x} y={pill.y} below={pill.below} testid="doc-comment-pill">
      <button onmousedown={(event) => event.preventDefault()} onclick={() => startComment({ anchor: pill.anchor, rect: pill.rect })}
        data-testid="doc-comment-start" title="Comment (⌘⌥M)">Comment</button>
    </SelectPill>
  {/if}

  {#if quick}
    <SelectBox
      x={quick.x} y={quick.y} below={quick.below}
      value={quick.text}
      quote={quick.anchor.quote}
      placeholder="Comment"
      testid="doc-comment-box"
      onbox={(el) => { quickBox = el; }}
      onvalue={(text) => { quick.text = text; }}
      onkeydown={onQuickKey}
    >
      {#snippet footer()}
        <span>as {me()}</span>
        <span class="spacer"></span>
        <button class="qgo" onclick={() => { quick = null; }}>Cancel</button>
        <button class="qgo primary" onclick={commitQuick} disabled={!(quick.text || '').trim()} data-testid="doc-comment-save">Comment</button>
      {/snippet}
    </SelectBox>
  {/if}

  {#if peek && peeked}
    <div class="peek" class:below={peek.below} data-reader-pop style:left={`${peek.x}px`} style:top={`${peek.y}px`} data-testid="doc-comment-pop">
      <p class="pquote" title={peeked.quote}>{peeked.quote}</p>
      {#if !peek.attached}<p class="pnote">The words this was on are no longer in the document.</p>{/if}
      <div class="pthread" data-testid="doc-comment-thread">
        {#each peeked.comments as entry (entry.id)}
          <div class="pentry" class:pending={entry.pending} data-testid="doc-comment-entry">
            <div class="pmeta">
              <span class="pwho" data-testid="doc-comment-author">{entry.author}</span>
              {#if entry.owner}<span class="powner">owner</span>{/if}
              <time class="pwhen" datetime={entry.createdAt}>{entry.pending ? 'sending' : stamp(entry.createdAt)}</time>
            </div>
            <p class="ptext">{entry.body}</p>
          </div>
        {/each}
      </div>
      <div class="preply">
        <textarea bind:this={replyBox} bind:value={replyText} rows="1" placeholder="Reply" onkeydown={onReplyKey} data-testid="doc-comment-reply-box"></textarea>
        <button class="primary" onclick={sendReply} disabled={!replyText.trim()} data-testid="doc-comment-reply">Reply</button>
      </div>
      <div class="prow">
        {#if peeked.resolvedAt}
          <button onclick={() => setResolved(peeked, false)} data-testid="doc-comment-reopen">Reopen</button>
        {:else}
          <button onclick={() => setResolved(peeked, true)} data-testid="doc-comment-resolve">Resolve</button>
        {/if}
        <button onclick={() => { peek = null; }}>Close</button>
      </div>
    </div>
  {/if}

  {#if detached.length || resolvedList.length || error}
    <div class="foot" data-testid="doc-comments-foot">
      {#if error}<span class="err">{error}</span>{/if}
      <button class="chip" onclick={() => { listOpen = !listOpen; }} data-testid="doc-comments-list-toggle">
        {[detached.length ? 'detached' : '', resolvedList.length ? 'resolved' : ''].filter(Boolean).join(' and ')} comments
      </button>
      {#if listOpen}
        <div class="list" data-testid="doc-comments-list">
          {#if detached.length}
            <p class="lhead">Detached: their words were edited away</p>
            {#each detached as thread (thread.id)}
              <button class="litem" onclick={() => openThread(thread.id, { attached: false })} data-testid="doc-comment-detached">
                <span class="lquote">{thread.quote}</span><span class="lbody">{thread.comments[0]?.author}: {thread.comments[0]?.body}</span>
              </button>
            {/each}
          {/if}
          {#if resolvedList.length}
            <p class="lhead">Resolved</p>
            {#each resolvedList as thread (thread.id)}
              <button class="litem" onclick={() => openThread(thread.id, { attached: false })} data-testid="doc-comment-resolved">
                <span class="lquote">{thread.quote}</span><span class="lbody">{thread.comments[0]?.author}: {thread.comments[0]?.body}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* A fixed layer over the document: popovers are placed in viewport coordinates and never take
     part in the document's layout, so opening one cannot move the scroll position. */
  .layer { position: fixed; inset: 0; z-index: 40; pointer-events: none; }
  .layer :global([data-reader-pop]), .foot { pointer-events: auto; }
  .peek {
    position: absolute; transform: translate(-50%, calc(-100% - 8px));
    width: min(320px, calc(100vw - 24px));
    display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
    border: 1px solid var(--line); border-radius: 12px; background: var(--bg-raised);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.22);
  }
  .peek.below { transform: translate(-50%, 8px); }
  .pquote {
    margin: 0; padding-left: 7px; border-left: 2px solid rgba(241, 221, 138, 0.9); color: var(--ink-faint);
    font-size: 12px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .pnote { margin: 0; font-size: 11.5px; color: var(--warn, #d66); }
  .ptext { margin: 0; font-size: 14px; line-height: 1.45; color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; }
  .pthread { display: flex; flex-direction: column; gap: 10px; max-height: 40vh; overflow-y: auto; }
  .pentry { display: flex; flex-direction: column; gap: 3px; }
  .pentry.pending { opacity: 0.7; }
  .pmeta { display: flex; gap: 8px; align-items: baseline; font-size: 11.5px; color: var(--ink-faint); }
  .pwho { font-weight: 500; color: var(--ink-dim); }
  .powner { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--accent); }
  .preply { display: flex; gap: 6px; align-items: flex-end; }
  .preply textarea {
    flex: 1; min-width: 0; resize: none; overflow-y: auto; font-family: var(--sans); font-size: 14px; line-height: 1.4;
    padding: 7px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--ink);
  }
  .preply textarea:focus { outline: none; border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
  .preply .primary {
    flex: none; border: 0; border-radius: 999px; cursor: pointer; padding: 7px 14px; font-size: 12.5px;
    background: var(--accent-soft); color: var(--ink);
  }
  .preply .primary:disabled { opacity: 0.45; cursor: default; }
  .prow { display: flex; gap: 4px; }
  .prow button { border: 0; background: none; cursor: pointer; border-radius: 8px; padding: 4px 8px; font-size: 12.5px; color: var(--ink-dim); }
  .prow button:hover { background: color-mix(in srgb, var(--ink) 8%, transparent); color: var(--ink); }
  .foot {
    position: absolute; right: 14px; bottom: 14px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
    font-size: 11px; color: var(--ink-faint);
  }
  .foot .chip {
    border: 1px solid var(--line); border-radius: 999px; background: var(--bg-raised);
    color: var(--ink-dim); font-size: 11px; padding: 4px 10px; cursor: pointer;
  }
  .list {
    order: -1; width: min(300px, calc(100vw - 28px)); max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;
    padding: 8px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg-raised); box-shadow: 0 14px 34px rgba(0, 0, 0, 0.22);
  }
  .lhead { margin: 4px 2px 2px; font-size: 11px; color: var(--ink-faint); }
  .litem {
    display: flex; flex-direction: column; gap: 2px; text-align: left; border: 0; border-radius: 8px; background: none;
    padding: 6px 8px; cursor: pointer; color: var(--ink);
  }
  .litem:hover { background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .lquote { font-size: 12px; color: var(--ink-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lbody { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .err { color: var(--warn, #d66); }
</style>
