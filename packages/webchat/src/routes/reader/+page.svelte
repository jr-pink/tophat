<script>
  import { onMount, tick } from 'svelte';
  import Nav from '$lib/ui/Nav.svelte';
  import ShareLinks from '$lib/ui/ShareLinks.svelte';
  import {
    HIGHLIGHT_COLORS, clearPaint, offsetAtPoint, paint, scrollRatio, selectionOffsets, textIndex
  } from '$lib/client/reader-dom.js';
  import { makeAnchor, resolveAnchor } from '$lib/core/reader-anchor.js';
  import { createCache } from '$lib/client/reader-cache.js';
  import { readerReplica } from '$lib/client/reader-offline.js';
  import { liveSubscribe } from '$lib/client/live.js';
  import { createDwell } from '$lib/core/reader-dwell.js';
  import { clearDraft, loadDraft, saveDraft } from '$lib/client/note-draft.js';
  import DictationMic from '$lib/services/voice/ui/DictationMic.svelte';
  import SelectPill from '$lib/ui/SelectPill.svelte';
  import SelectBox from '$lib/ui/SelectBox.svelte';
  import SwipeRow from '$lib/ui/SwipeRow.svelte';
  import Tray from '$lib/ui/Tray.svelte';
  import DeferSheet from '$lib/ui/DeferSheet.svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import { deferLabel } from '$lib/core/defer.js';
  import { ACTIONS, makeAction, newId } from '$lib/core/contract.js';
  import UndoBar from '$lib/ui/UndoBar.svelte';
  import { createSerialQueue, createUndoStack, isUndoShortcut, watchEditedFields } from '$lib/core/undo.js';
  import { deviceId } from '$lib/client/reading.js';
  import { traceReading } from '$lib/ui/reading-trace.svelte.js';
  import { uiApp } from '$lib/client/ui-app.js';
  import { readerDecl, stepScale, mintDeviceSeq } from '$lib/core/reader-state.js';

  let library = $state([]);
  let libraryLoaded = $state(false);
  let recentNotes = $state([]);
  let filter = $state('all');
  // Which shelf he is looking at. Live is everything he has not put away; starred is the personal
  // canon; archived is what he has read and dismissed, kept and reachable rather than deleted.
  let shelfView = $state('live');
  // What he just did to a row, kept so a mistake is one press away: the bar names the last one
  // and Cmd-Z walks the last few back, newest first. The stack itself lives in core/undo.js
  // and is shared with the chat list.
  let undoLabel = $state(null);
  let undoId = null;
  const undoStack = createUndoStack({
    onchange: (view) => { undoLabel = view.toast?.label || null; undoId = view.toast?.id || null; }
  });
  // Writes to one document are queued behind each other, so the PATCH that undoes a gesture
  // cannot reach the server before the PATCH it undoes.
  const serialDoc = createSerialQueue();
  // The two trays under the shelf: what he put down with no date on it, and what he deferred to
  // an hour or a condition. and a defer until, where i can set a time or condition. same as todo
  // tasks.
  let asideDocs = $state([]);
  let deferredDocs = $state([]);
  let asideOpen = $state(false);
  let deferredOpen = $state(false);
  let deferFor = $state(null);     // the row whose defer popover is open
  let doc = $state(null);       // a document in the library
  let hoveredDoc = $state(null); // the shelf row under the pointer, for Cmd-E (Done)
  let page = $state(null);      // a page being looked at, not kept
  let section = $state(null);
  let sections = $state([]);
  let links = $state([]);
  let highlights = $state([]);
  let progress = $state(null);
  let pending = $state(null);   // what a click asked for, drawn before its bytes arrive

  let omni = $state('');
  let omniOpen = $state(false);
  let omniResults = $state(null);
  let busy = $state(null);
  let loading = $state(false);  // a hairline at the top of the pane; no words
  let error = $state(null);
  let rail = $state('library');     // library | notes | contents
  let selection = $state(null);     // { start, end, quote, x, y }
  let quick = $state(null);         // a note being typed straight onto the selection
  let quickBox = $state(null);      // the textarea it is typed into
  let quickEl = $state(null);       // the box itself, so it can be kept on screen
  let popEl = $state(null);         // the selection pill
  // Read at init, like the text size above: the library's field asks on its first render whether
  // this is a touch screen, and a value settled in onMount answers after that render is over.
  const touchScreen = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(hover: none)')?.matches);
  let docked = $state(touchScreen());   // on a phone the pill lives at the bottom, clear of iOS's callout
  let peekEl = $state(null);        // the note popover over a highlight
  let replyText = $state('');       // what he is writing back to a note
  let replyBusy = $state(false);
  let replyBox = $state(null);
  let editing = $state(null);       // a highlight being annotated
  let peek = $state(null);          // a highlight he clicked, shown where it sits
  let noteText = $state('');
  let orphans = $state([]);
  let ingest = $state(null);      // a book still being read in the background

  let capture = $state(null);      // { highlight, text, partial, state, sent }
  // The size he reads at, whether a highlight arms the mic, and the device's action sequence are his, not the
  // session's: one kit state (core/reader-state.js), hydrated before the first render, saved by the kit.
  const readerPrefs = uiApp().use(readerDecl);
  const autoMic = $derived($readerPrefs.autoMic);
  const textScale = $derived($readerPrefs.textScale);
  let mic = $state(null);
  let micReady = $state(false);

  let scroller = $state(null);
  let article = $state(null);
  let omniInput = $state(null);
  let sheet = $state(false);        // the library drawer, closed until he asks for it
  let adding = $state(false);       // the paste pill, over the text, nothing else on screen
  let canShare = $state(false);     // the OS share sheet is available
  let canPaste = $state(false);     // the clipboard can be read on a gesture
  let index = { text: '', nodes: [] };
  let sinceReport = 0;
  let reportTimer = null;
  let paintFrame = 0;
  let navToken = 0;                 // the open that is allowed to land; a later one wins
  // Clearing the pane sends its scroll to zero and the browser reports it; that zero must not be
  // written over the reading position of the entry he is leaving.
  let holdScrollStamp = false;

  // Anything already fetched is a paint rather than a round trip, and a hover or a pasted link
  // that has not been submitted yet pays for the next open before the click happens.
  // A page he actually reads keeps itself, with the copy already extracted; browsing still
  // writes nothing, so only real reading turns into a row in the library.
  const dwell = createDwell();
  let dwellTimer = null;

  const docs = createCache({ max: 24, freshMs: 45_000 });
  const pages = createCache({ max: 12, freshMs: 5 * 60_000 });

  // The device's own copy of the reader (lib/client/reader-offline.js): the past week, everything
  // starred and the live shelf, whole, in IndexedDB, kept current in the background. Reads paint
  // from it first and fall back to it when the server is gone; writes go through its op log, so a
  // highlight made with the server down is on the page, survives a reload and syncs later.
  const replica = typeof window === 'undefined' ? null : readerReplica();
  let sync = $state({ online: true, pending: 0, syncing: false, lastSync: null });

  const percentOf = (row) => Math.round(100 * Number(row?.percent || row?.state?.percent || 0));
  const linkFor = (rel) => links.find((l) => l.rel === rel) || null;
  const wordCount = (words) => {
    const n = Math.max(0, Math.round(words || 0));
    return n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k words` : `${n.toLocaleString('en-US')} words`;
  };
  const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./u, ''); } catch { return url; } };
  const view = $derived.by(() => {
    if (doc && section) {
      return {
        saved: true, title: doc.title, byline: doc.byline, site: doc.site, url: doc.url,
        published: doc.published_at, words: section.words || doc.words, percent: percentOf(doc.state)
      };
    }
    if (page) {
      return {
        saved: false, title: page.title, byline: page.byline, site: page.site, url: page.url,
        published: page.publishedAt, words: page.words, percent: 0
      };
    }
    if (pending) {
      return {
        saved: pending.saved, title: pending.title, byline: '', site: pending.site, url: pending.url,
        published: null, words: pending.words || 0, percent: pending.percent || 0, skeleton: true
      };
    }
    return null;
  });

  // Line-level reading trace: how long each line box of the open piece was in front of him.
  // Nothing is sent for a page he is only browsing; a kept document is the thing worth calibrating.
  $effect(() => {
    const node = article;
    const id = doc?.id;
    if (!node || !id) return;
    return traceReading(() => node, {
      surface: 'reader',
      ref: () => id,
      sub: () => String(section?.idx ?? 0)
    });
  });

  const shown = $derived(filter === 'all' ? library : library.filter((row) => (row.status || 'unread') === filter));
  const emptyWord = $derived(
    shelfView === 'starred' ? 'Nothing starred' : shelfView === 'archived' ? 'Nothing archived' : 'Nothing yet');
  // A deep link still wins, because a document, a browsed page or the skeleton of one is exactly
  // what makes this false.
  const shelf = $derived(!doc && !page && !pending);
  // The pill floats over the words only. On the library the same field is already part of the
  // page, and two of them would be two places to paste into.
  const pasting = $derived(adding && !shelf);
  const docNotes = $derived(highlights.filter((h) => h.sectionIdx === (section?.idx ?? 0)));

  async function api(path, options) {
    if (replica) return replica.api(path, options);
    const response = await fetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `${response.status}`);
    return body;
  }

  /** The shelf as this device last knew it, painted before the server is asked. */
  async function paintLocalShelf() {
    if (!replica || libraryLoaded) return;
    await replica.ready;
    const rows = replica.library({ view: shelfView });
    if (!rows || libraryLoaded) return;
    library = rows;
    libraryLoaded = true;
    if (shelfView === 'live') {
      deferredDocs = replica.library({ view: 'deferred' }) || [];
      asideDocs = replica.library({ view: 'aside' }) || [];
    }
  }

  async function loadLibrary(query = '') {
    if (!query) paintLocalShelf().catch(() => {});
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (shelfView !== 'live') params.set('view', shelfView);
    const search = params.toString();
    const body = await api(`/api/reader/library${search ? `?${search}` : ''}`);
    library = body.docs || [];
    if (!query) recentNotes = body.notes || [];
    // Before the first answer lands an empty list is ignorance, not an empty library, and the
    // shelf must not tell him he has nothing saved while the fetch is still in the air.
    libraryLoaded = true;
    if (!query) loadTrays().catch(() => {});
    return body.search;
  }

  /**
   * The two trays, read beside the shelf. Whether a deferred document is still waiting is the
   * server's answer at read time, so one whose hour has passed is back in the library here
   * without anything having been scheduled to put it there.
   */
  async function loadTrays() {
    const [deferred, aside] = await Promise.all([
      api('/api/reader/library?view=deferred'),
      api('/api/reader/library?view=aside')
    ]);
    deferredDocs = deferred.docs || [];
    asideDocs = aside.docs || [];
  }

  function showView(next) {
    if (shelfView === next) return;
    shelfView = next;
    libraryLoaded = false;
    loadLibrary().catch((cause) => { error = cause.message; });
  }

  /**
   * The three things he can do to a row without opening it. Archive is "ok, I read it" and takes
   * the row off the shelf; star is "worth referring back to" and leaves it where it is; mark
   * unread puts a finished piece back in front of him. Each writes optimistically, because
   * waiting on the round trip makes the gesture feel broken, and puts the row back on a failure.
   */
  async function patchDoc(id, body) {
    return serialDoc(id, () => api(`/api/reader/doc/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }));
  }

  /**
   * Record what the row was, so the gesture can be taken back. Only the fields the gesture
   * changed are remembered: undoing a Done on a document he had also set aside puts it back in
   * the tray it came from, because the archive never touched that flag and the undo does not
   * either. Marking unread is deliberately not on the stack: the server zeroes the percent when
   * it does that and nothing can hand back the reading position.
   *
   * This is called as the gesture happens, not after its write lands, so Cmd-Z pressed while
   * the PATCH is still in the air is still an undo. The inverse write is queued behind the
   * forward one by document id (createSerialQueue), so it cannot overtake it; a forward write
   * that fails takes its offer off the stack again.
   */
  function rememberUndo(row, label, body, { silent = false } = {}) {
    const id = row.id;
    const title = row.title || 'that';
    return undoStack.push({
      label: `${label} ${title}`,
      silent,
      undo: async () => {
        const answer = await patchDoc(id, body);
        // The open document carries its own copy of these flags (the star in the bar reads it),
        // so put the server's row back into it as well as into the shelf.
        if (doc?.id === id && answer?.doc) doc = { ...doc, ...answer.doc, state: answer.doc.state ?? doc.state };
        await loadLibrary();
      }
    });
  }

  function undoNow() {
    undoStack.undo(undoId).catch((cause) => { error = cause.message; });
  }

  async function archiveDoc(row, archived = true) {
    if (!row?.id) return;
    const id = row.id;
    // The row can be in the shelf or in either tray: archiving is reachable from all three.
    const had = { library, asideDocs, deferredDocs };
    library = library.filter((entry) => entry.id !== id);
    asideDocs = asideDocs.filter((entry) => entry.id !== id);
    deferredDocs = deferredDocs.filter((entry) => entry.id !== id);
    // The entry is still on the stack, so Cmd-Z and the swipe back both work.
    const offer = rememberUndo(row, archived ? 'Done:' : 'Put back:', { archived: Boolean(row.archived) }, { silent: archived });
    try {
      await patchDoc(id, { archived });
    } catch {
      ({ library, asideDocs, deferredDocs } = had);
      undoStack.remove(offer);
      return;
    }
    if (!archived) await loadLibrary();
  }

  async function starDoc(row) {
    if (!row?.id) return;
    const id = row.id;
    const starred = !row.starred;
    const had = library;
    // On the starred shelf, unstarring takes the row out of the list he is looking at.
    library = shelfView === 'starred' && !starred
      ? library.filter((entry) => entry.id !== id)
      : library.map((entry) => (entry.id === id ? { ...entry, starred: starred ? 1 : 0 } : entry));
    if (doc?.id === id) doc = { ...doc, starred: starred ? 1 : 0 };
    const offer = rememberUndo(row, starred ? 'Starred' : 'Unstarred', { starred: Boolean(row.starred) });
    try { await patchDoc(id, { starred }); }
    catch { library = had; undoStack.remove(offer); }
  }

  async function markUnread(row) {
    if (!row?.id) return;
    const id = row.id;
    const had = library;
    library = library.map((entry) => (
      entry.id === id ? { ...entry, status: 'unread', percent: 0 } : entry));
    try { await patchDoc(id, { status: 'unread' }); }
    catch { library = had; }
  }

  /**
   * Set aside is "not now", with no date on it: the row leaves the shelf for the tray and waits
   * there until he opens it. It is not the archive, which says he is done with the thing, and it
   * is not a defer, which names an hour or a condition. Passing false brings it back.
   */
  async function setAsideDoc(row, aside = true) {
    if (!row?.id) return;
    const id = row.id;
    const had = { library, asideDocs, deferredDocs };
    library = library.filter((entry) => entry.id !== id);
    asideDocs = asideDocs.filter((entry) => entry.id !== id);
    deferredDocs = deferredDocs.filter((entry) => entry.id !== id);
    const offer = rememberUndo(row, aside ? 'Set aside:' : 'Put back:', { aside: Boolean(row.aside) });
    try { await patchDoc(id, { aside }); }
    catch { ({ library, asideDocs, deferredDocs } = had); undoStack.remove(offer); return; }
    await loadLibrary();
  }

  /** nothing at all clears it and brings it back. */
  async function deferDoc(row, defer) {
    if (!row?.id) return;
    const id = row.id;
    const had = { library, asideDocs, deferredDocs };
    library = library.filter((entry) => entry.id !== id);
    asideDocs = asideDocs.filter((entry) => entry.id !== id);
    deferredDocs = deferredDocs.filter((entry) => entry.id !== id);
    deferFor = null;
    const was = { defer: { until: row.defer_until || null, condition: row.defer_condition || null } };
    const offer = rememberUndo(row, defer ? 'Deferred:' : 'Put back:', was);
    try { await patchDoc(id, { defer: defer || null }); }
    catch { ({ library, asideDocs, deferredDocs } = had); undoStack.remove(offer); return; }
    await loadLibrary();
  }

  // core/defer.js speaks the chat sidebar's shape; a document row carries the same two facts
  // under the column names sqlite gave them.
  const deferOf = (row) => ({
    deferUntil: row?.defer_until || null, deferCondition: row?.defer_condition || null
  });

  // --- where we are ----------------------------------------------------------------------------
  // Every deliberate navigation is a history entry, so Back and the swipe gesture undo it. The
  // scroll position rides on the entry: coming back lands where he left, not at the top.

  const docKey = (id, idx) => `doc:${id}:${idx === null || idx === undefined ? 'auto' : idx}`;
  const urlKey = (url) => `url:${url}`;

  function hrefFor(state) {
    if (state.url) return `/reader?url=${encodeURIComponent(state.url)}`;
    const part = state.sectionIdx === null || state.sectionIdx === undefined ? '' : `&section=${state.sectionIdx}`;
    return `/reader?doc=${state.docId}${part}`;
  }

  function parseLocation(search) {
    const params = new URLSearchParams(search || '');
    const url = (params.get('url') || '').trim();
    if (params.get('doc')) {
      return { docId: params.get('doc'), sectionIdx: params.has('section') ? Number(params.get('section')) : null, url: null };
    }
    return url ? { docId: null, sectionIdx: null, url } : null;
  }

  // A history entry cannot be written to once it is behind him: going back or forward, the entry
  // he is leaving is no longer the current one by the time the event arrives. So every entry
  // carries a key and the reading position lives in a table beside the history, which forward
  // restores as faithfully as back.
  const positions = new Map();
  let hereKey = null;

  function remember(state, push) {
    if (typeof history === 'undefined') return;
    const href = hrefFor(state);
    const here = `${location.pathname}${location.search}`;
    if (push && here !== href) {
      hereKey = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      history.pushState({ reader: true, ...state, key: hereKey, scrollTop: 0 }, '', href);
    } else {
      hereKey = history.state?.key || hereKey || `e${Date.now().toString(36)}`;
      history.replaceState({ ...(history.state || {}), reader: true, ...state, key: hereKey }, '', href);
    }
  }

  function stampHere() {
    if (!scroller || !hereKey) return;
    positions.set(hereKey, Math.round(scroller.scrollTop));
  }

  function rememberScroll() {
    if (holdScrollStamp) return;
    stampHere();
    if (typeof history === 'undefined' || !history.state?.reader || !scroller) return;
    try { history.replaceState({ ...history.state, scrollTop: Math.round(scroller.scrollTop) }, ''); } catch { /* fine */ }
  }

  function onPop(event) {
    const state = event.state?.reader ? event.state : parseLocation(location.search);
    // Stamp the entry he is stepping off, whichever direction he stepped.
    if (!holdScrollStamp) stampHere();
    if (!state) {
      closeSurfaces();
      clearPane();
      pending = null;
      hereKey = history.state?.key || null;
      holdScrollStamp = false;
      return;
    }
    const key = state.key || null;
    const where = (key && positions.has(key) ? positions.get(key) : null) ?? state.scrollTop ?? 0;
    hereKey = key;
    if (state.docId) openDoc(state.docId, { sectionIdx: state.sectionIdx ?? null, push: false, scrollTop: where });
    else if (state.url) openUrl(state.url, { push: false, scrollTop: where });
  }

  // --- opening ---------------------------------------------------------------------------------

  const fetchDoc = (id, idx) =>
    api(`/api/reader/doc/${id}${idx === null || idx === undefined ? '' : `?section=${idx}`}`);
  const readUrl = (url, refresh) => api('/api/reader/read', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, refresh })
  });

  function closeSurfaces() {
    adding = false;
    sheet = false;
    omniOpen = false;
    omniResults = null;
  }

  function clearPane() {
    doc = null; page = null; section = null; sections = []; links = []; highlights = [];
    progress = null; ingest = null; editing = null; selection = null;
  }

  /**
   * Put the pane back where he left it. The height of an article arrives over several frames, as
   * the text lays out and images settle, and a scrollTop set against a short page is clamped to
   * the bottom of it; so keep asking until it sticks.
   */
  function restoreScroll(where) {
    const wanted = Math.max(0, Math.round(where || 0));
    let tries = 0;
    const apply = () => {
      if (!scroller) { holdScrollStamp = false; return; }
      scroller.scrollTop = wanted;
      if (Math.abs(scroller.scrollTop - wanted) > 2 && tries < 16) { tries += 1; requestAnimationFrame(apply); return; }
      holdScrollStamp = false;
    };
    tick().then(apply);
  }

  function applyDoc(body, { push = true, scrollTop = null, quiet = false } = {}) {
    const moved = doc?.id !== body.doc?.id || section?.idx !== body.section?.idx;
    page = null;
    pending = null;
    doc = body.doc;
    section = body.section;
    sections = body.sections || [];
    links = body.links || [];
    highlights = body.highlights || [];
    progress = body.progress;
    ingest = body.ingest || null;
    if (ingest && ingest.state !== 'ready') pollIngest(doc.id);
    dwell.close();
    omniOpen = false;
    omniResults = null;
    if (rail === 'library' && sections.length > 1) rail = 'contents';
    if (!quiet) remember({ docId: doc.id, sectionIdx: section?.idx ?? null, url: null }, push);
    const saved = progress?.sections?.find((row) => row.section_idx === body.section?.idx);
    const where = scrollTop === null ? (saved?.scroll_top || 0) : scrollTop;
    if (moved || scrollTop !== null) restoreScroll(where);
    else holdScrollStamp = false;
    warmNeighbours();
    tick().then(restoreDraft);     // anything he was typing here comes back with the words
  }

  function applyPage(body, { push = true, scrollTop = null } = {}) {
    clearPane();
    dwell.open({ url: body.url, words: body.words || 0, visible: typeof document === 'undefined' || !document.hidden });
    pending = null;
    page = body;
    links = body.links || [];
    omniOpen = false;
    omniResults = null;
    remember({ docId: null, sectionIdx: null, url: page.url }, push);
    restoreScroll(scrollTop || 0);
    warmNeighbours();
  }

  /** Open something already in the library. A hit paints now; a miss paints its title now. */
  async function openDoc(id, { sectionIdx = null, push = true, scrollTop = null } = {}) {
    // Where he is now goes onto the entry he is leaving, before the pane is touched: a scroll a
    // frame before the click has not reached the scroll handler yet.
    if (push) rememberScroll();
    holdScrollStamp = true;
    closeSurfaces();
    error = null;
    const key = docKey(id, sectionIdx);
    const token = ++navToken;
    const hit = docs.peek(key);
    if (hit) {
      applyDoc(hit.value, { push, scrollTop });
      if (!hit.fresh) {
        docs.load(key, () => fetchDoc(id, sectionIdx))
          .then((body) => { if (token === navToken) applyDoc(body, { push: false, scrollTop: scroller?.scrollTop ?? 0, quiet: true }); })
          .catch(() => {});
      }
      return id;
    }
    const row = library.find((entry) => entry.id === id);
    // On this device already: paint it now, and let the server's answer land quietly behind it.
    const local = replica ? await replica.doc(id, sectionIdx).catch(() => null) : null;
    if (token !== navToken) return id;
    if (local) {
      applyDoc(local, { push, scrollTop });
      docs.load(key, () => fetchDoc(id, sectionIdx))
        .then((body) => { if (token === navToken && !body.local) applyDoc(body, { push: false, scrollTop: scroller?.scrollTop ?? 0, quiet: true }); })
        .catch(() => {});
      return id;
    }
    clearPane();
    pending = {
      saved: true, title: row?.title || '', site: row?.site || '', url: row?.url || '',
      words: row?.words || 0, percent: percentOf(row)
    };
    loading = true;
    try {
      const body = await docs.load(key, () => fetchDoc(id, sectionIdx));
      if (token !== navToken) return id;
      applyDoc(body, { push, scrollTop });
      return id;
    } catch (cause) {
      if (token !== navToken) return null;
      error = cause.message;
      pending = null;
      holdScrollStamp = false;
      return null;
    } finally {
      if (token === navToken) loading = false;
    }
  }

  /**
   * Open a URL. Looking at a page is not keeping it: unless it is already in the library, this
   * fetches and renders it and writes nothing. "Add to library" keeps it, and so does taking a
   * note on it.
   */
  async function openUrl(url, { refresh = false, push = true, scrollTop = null } = {}) {
    if (push) rememberScroll();
    holdScrollStamp = true;
    closeSurfaces();
    error = null;
    const key = urlKey(url);
    const token = ++navToken;
    const hit = refresh ? null : pages.peek(key);
    if (hit && hit.value?.saved) return openDoc(hit.value.id, { push, scrollTop });
    if (hit) { applyPage(hit.value.page, { push, scrollTop }); return null; }

    clearPane();
    pending = { saved: false, title: hostOf(url), site: hostOf(url), url, words: 0, percent: 0 };
    loading = true;
    try {
      const body = refresh
        ? await readUrl(url, true)
        : await pages.load(key, () => readUrl(url, false));
      if (token !== navToken) return null;
      if (body.saved) { await openDoc(body.id, { push, scrollTop }); return body.id; }
      applyPage(body.page, { push, scrollTop });
      return null;
    } catch (cause) {
      if (token !== navToken) return null;
      pages.drop(key);
      error = cause.message;
      pending = null;
      holdScrollStamp = false;
      return null;
    } finally {
      if (token === navToken) loading = false;
    }
  }

  // --- paying before the click -----------------------------------------------------------------

  function warmDoc(id, sectionIdx = null) {
    if (!id) return;
    docs.prefetch(docKey(id, sectionIdx), () => fetchDoc(id, sectionIdx));
  }

  /** Start the extraction the moment a link looks like one, so Enter is a cache hit. The warm path
      answers at once and fetches on the server; posting the read instead held the request open for
      the whole fetch, and two of those (the next and previous post, warmed on every open) sat on
      the page's connections for seconds while the notes and the reading trace queued behind them. */
  function warmUrl(url) {
    if (!url) return;
    fetch(`/api/reader/read?url=${encodeURIComponent(url)}`).catch(() => {});
  }

  function warmNeighbours() {
    const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 200));
    idle(() => {
      if (doc && sections.length > 1 && section) {
        if (section.idx + 1 < sections.length) warmDoc(doc.id, section.idx + 1);
        if (section.idx > 0) warmDoc(doc.id, section.idx - 1);
      }
      for (const link of links) if (link.rel === 'next' || link.rel === 'prev') warmUrl(link.href);
    });
  }

  /** Keep what is on screen: the same extraction, written to the library, with his place kept. */
  async function addToLibrary() {
    if (!page) return doc?.id || null;
    const where = scroller?.scrollTop || 0;
    busy = 'saving';
    try {
      const body = await api('/api/reader/save', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: page.url })
      });
      pages.drop(urlKey(page.url));
      await openDoc(body.id, { push: false, scrollTop: where });
      loadLibrary();
      return body.id;
    } catch (cause) {
      error = cause.message;
      return null;
    } finally {
      busy = null;
    }
  }

  function isUrl(text) {
    const trimmed = (text || '').trim();
    if (/^https?:\/\//u.test(trimmed)) return trimmed;
    if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/u.test(trimmed)) return `https://${trimmed}`;
    return null;
  }

  async function runOmni() {
    const text = omni.trim();
    if (!text) return;
    const url = isUrl(text);
    if (url) { omni = ''; await openUrl(url); return; }
    busy = 'searching';
    try {
      const search = await loadLibrary(text);
      omniResults = { ...search, web: null };
      omniOpen = true;
    } finally { busy = null; }
  }

  /** A pasted link goes straight there; there is nothing to confirm. */
  function onOmniPaste(event) {
    const text = (event.clipboardData?.getData('text') || '').trim();
    const url = isUrl(text);
    if (!url) return;
    event.preventDefault();
    omni = '';
    omniOpen = false;
    openUrl(url);
  }

  function onOmniInput() {
    const url = isUrl(omni);
    if (url) warmUrl(url);
  }

  async function searchWeb() {
    const text = omni.trim();
    if (!text) return;
    busy = 'searching the web';
    try {
      const body = await api(`/api/reader/websearch?q=${encodeURIComponent(text)}`);
      omniResults = { ...(omniResults || { docs: [], notes: [] }), web: body.results || [] };
    } catch (cause) { error = cause.message; } finally { busy = null; }
  }

  // --- reading position ------------------------------------------------------------------------

  function report({ force = false } = {}) {
    if (!doc || !section || !scroller) return;
    const ratio = scrollRatio(scroller);
    const seconds = Math.min(120, Math.round((Date.now() - sinceReport) / 1000));
    sinceReport = Date.now();
    const payload = {
      docId: doc.id, sectionIdx: section.idx, ratio, scrollTop: Math.round(scroller.scrollTop), seconds
    };
    api('/api/reader/progress', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), keepalive: true
    }).then((state) => {
      if (state?.percent !== undefined && doc) doc = { ...doc, state: { ...(doc.state || {}), percent: state.percent, status: state.status } };
      if (force) loadLibrary();
    }).catch(() => {});
  }

  /** Nothing is announced: the page simply stops being a page he is only looking at. */
  async function considerKeeping() {
    if (!page || busy) return;
    if (dwell.verdict().state !== 'reading') return;
    dwell.promoted();
    await addToLibrary();
  }

  function onScroll() {
    rememberScroll();
    if (page) { dwell.scroll({ ratio: scrollRatio(scroller) }); considerKeeping(); }
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => report(), 1200);
  }

  // --- highlights ------------------------------------------------------------------------------

  // The words paint first; the highlights land on the next frame. Indexing a long chapter is tens
  // of milliseconds of text walking and it has no business delaying the text itself.
  function reindex() {
    if (!article) return;
    cancelAnimationFrame(paintFrame);
    paintFrame = requestAnimationFrame(() => {
      if (!article) return;
      index = textIndex(article);
      repaint();
      // A selection made before the index existed found nothing; re-read it now that it does.
      const live = typeof window !== 'undefined' ? window.getSelection() : null;
      if (!selection && live && !live.isCollapsed) onSelect();
    });
  }

  /** The index the anchors are measured against, built now if the paint frame has not run yet. */
  function liveIndex() {
    if (!index.text && article) index = textIndex(article);
    return index;
  }

  function repaint() {
    if (!article) return;
    liveIndex();
    const resolved = [];
    const lost = [];
    for (const highlight of highlights) {
      if (highlight.sectionIdx !== (section?.idx ?? 0)) continue;
      const at = resolveAnchor(index.text, highlight);
      if (!at) { lost.push(highlight); continue; }
      resolved.push({ ...highlight, start: at.start, end: at.end, active: editing?.id === highlight.id });
    }
    orphans = lost;
    // The words the open note belongs to stay marked while he types.
    paint(index, resolved, quick?.sel || null);
  }

  function onSelect() {
    if (!article) return;
    const found = selectionOffsets(article, index);
    // Focusing the note box collapses the DOM selection; that must not erase what the note is about.
    if (!found) { if (!editing && !quick) selection = null; return; }
    // The popover is positioned inside the scrolling pane, so its coordinates are the pane's
    // content coordinates: viewport offset plus how far the pane has scrolled. Measuring against
    // the article box instead put it a page-header's worth too high, under the nav.
    const box = (scroller || article).getBoundingClientRect();
    const top = found.rect.top - box.top + (scroller?.scrollTop || 0);
    const bottom = found.rect.bottom - box.top + (scroller?.scrollTop || 0);
    // Above the words normally; below them when the selection is near the top of the window,
    // where the popover would otherwise sit under the header bar and take no clicks.
    // On a touch screen iOS draws its own Copy/Look Up callout immediately above the selection,
    // so ours goes underneath instead, and only moves above when there is no room down there.
    const touch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)')?.matches;
    const roomBelow = typeof window !== 'undefined' && found.rect.bottom < window.innerHeight - 150;
    const below = touch ? roomBelow : found.rect.top < 140;
    // Opposite the callout is not a dodge: iOS puts its Copy/Look Up bubble above the selection
    // when there is room above and below it when there is not, so whichever side we choose it
    // lands on us sooner or later. On a phone the pill leaves the selection's neighbourhood
    // entirely and docks at the bottom of the screen, where the callout never goes.
    docked = Boolean(touch);
    selection = {
      start: found.start,
      end: found.end,
      quote: index.text.slice(found.start, found.end),
      // The raw centre of the words; the card is clamped once it has been measured, because
      // guessing its half-width put the colour swatches off the left edge of a phone.
      x: found.rect.left - box.left + found.rect.width / 2 + (scroller?.scrollLeft || 0),
      y: below ? bottom : top,
      below
    };
  }

  async function makeHighlight(color = 'yellow', { withNote = false, card = true, sel = null } = {}) {
    const on = sel || selection;
    if (!on || (!doc && !page)) return null;
    // The anchor is taken from the text on screen before anything else happens, so promoting a
    // browsed page to the library cannot move the words the highlight is about.
    const anchor = makeAnchor(liveIndex().text, on.start, on.end);
    if (!doc) {
      const id = await addToLibrary();       // a note on a page is a decision to keep it
      if (!id) return null;
    }
    const body = await api('/api/reader/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: doc.id, sectionIdx: section?.idx ?? 0, color, ...anchor })
    });
    // A quiet refresh of the document can land first already carrying it (the op log folds pending
    // notes into every answer), so this is by id, never a second copy.
    highlights = [...highlights.filter((h) => h.id !== body.highlight.id), body.highlight];
    docs.drop(docKey(doc.id, section?.idx ?? null));
    window.getSelection()?.removeAllRanges();
    selection = null;
    quick = null;
    if (card && withNote) startCapture(body.highlight, { record: autoMic });
    repaint();
    loadLibrary();
    return body.highlight;
  }

  // --- a note typed on the selection -----------------------------------------------------------
  // Selecting words and typing is the whole gesture: the pill becomes the box on the first
  // keystroke, the box has focus already, Enter keeps it and Command-Enter hands it to the agent.
  // Nothing here waits for a highlight to be written first; that happens on commit.

  function openQuickNote(seed = '') {
    if (!selection) return;
    // Hold the words themselves: the textarea takes focus and the browser drops the live selection.
    quick = {
      text: seed, busy: false, x: selection.x, y: selection.y, below: selection.below,
      sel: { start: selection.start, end: selection.end, quote: selection.quote }
    };
    repaint();
    focusQuick(seed.length);
  }

  /** Edit the note on a highlight he clicked, in the same box, where the words are. */
  function editHere(highlight, at) {
    const text = highlight.note || '';
    quick = { text, busy: false, x: at.x, y: at.y, below: at.below, existing: highlight };
    peek = null;
    focusQuick(text.length);
  }

  /** Every keystroke is on disk: a dismissed keyboard, a tap away or a reload cannot take it. */
  function keepDraft() {
    if (!quick) return;
    saveDraft({
      docId: doc?.id || null, sectionIdx: section?.idx ?? 0, text: quick.text || '',
      sel: quick.sel || null, existingId: quick.existing?.id || null,
      x: quick.x, y: quick.y, below: Boolean(quick.below)
    });
  }

  const forgetDraft = () => clearDraft({ docId: doc?.id || null, sectionIdx: section?.idx ?? 0 });

  /** Put back what he was typing when the tab died, where the words are. */
  function restoreDraft() {
    if (quick) return;
    const draft = loadDraft({ docId: doc?.id || null, sectionIdx: section?.idx ?? 0 });
    if (!draft?.text?.trim()) return;
    const existing = draft.existingId ? highlights.find((h) => h.id === draft.existingId) : null;
    quick = {
      text: draft.text, busy: false, x: draft.x || 24, y: draft.y || 120, below: Boolean(draft.below),
      sel: draft.sel || null, existing: existing || undefined, restored: true
    };
    focusQuick(draft.text.length);
  }

  function focusQuick(caret = 0) {
    tick().then(() => {
      quickBox?.focus();
      if (caret) quickBox?.setSelectionRange?.(caret, caret);
      growQuick();
      keepOnScreen();
    });
  }

  /** The thread on a note: the note itself first, then every reply, in the order they were said. */
  function threadOf(highlight) {
    if (!highlight) return [];
    const root = highlight.note
      ? [{ id: highlight.id, note: highlight.note, author: highlight.author || 'owner',
           createdAt: highlight.createdAt, root: true }]
      : [];
    return [...root, ...(highlight.replies || [])];
  }

  /** Dated and timestamped, the way a comment is: "Oct 4, 12:05" and the year once it is not this one. */
  function stamp(iso) {
    if (!iso) return '';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const sameYear = at.getFullYear() === new Date().getFullYear();
    return at.toLocaleString(undefined, {
      month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
      hour: 'numeric', minute: '2-digit'
    });
  }

  function growReply() {
    if (!replyBox) return;
    replyBox.style.height = 'auto';
    replyBox.style.height = `${Math.min(replyBox.scrollHeight, 160)}px`;
  }

  /** Replying is the main thing a note is for, so it is the primary button and it keeps the card open. */
  async function postReply() {
    const text = (replyText || '').trim();
    if (!text || !peek || replyBusy) return;
    replyBusy = true;
    try {
      const body = await api('/api/reader/notes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: peek.highlight.docId || doc?.id, parentId: peek.highlight.id, note: text, author: 'owner' })
      });
      const root = body.highlight;
      if (root) {
        highlights = highlights.map((h) => (h.id === root.id ? root : h));
        peek = { ...peek, highlight: root };
      }
      replyText = '';
      if (doc) docs.drop(docKey(doc.id, section?.idx ?? null));
      repaint();
      loadLibrary();
    } catch (cause) {
      error = cause.message;
    } finally {
      replyBusy = false;
      tick().then(() => { growReply(); replyBox?.focus(); });
    }
  }

  function onReplyKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); peek = null; return; }
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;                       // a newline, as everywhere else
    if (docked && !(event.metaKey || event.ctrlKey)) return;   // and on a phone Return is the newline
    event.preventDefault();
    event.stopPropagation();
    postReply();
  }

  /** A highlight is a thing he can look at again: the note comes to the words, not to the rail. */
  function openPeek(highlight, clientX, clientY, link = null) {
    replyText = '';
    const box = (scroller || article)?.getBoundingClientRect();
    if (!box) return;
    const below = clientY - box.top < 120;
    selection = null;
    quick = null;
    peek = {
      highlight,
      link,
      // Pane coordinates: the card is absolutely placed inside the scroller, so a viewport y
      // would put it a screenful away as soon as he has scrolled.
      x: clientX - box.left + (scroller?.scrollLeft || 0),
      y: clientY - box.top + (scroller?.scrollTop || 0),
      below
    };
  }

  /**
   * A card centred on the words runs off the edge when the words are near one. Measure it and pull
   * it back inside the pane, which is what the hardcoded half-width could not do.
   */
  function fitCard(element) {
    if (!element || !scroller || element.classList.contains('docked')) return;
    const pane = scroller.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const half = box.width / 2;
    if (box.width >= pane.width - 16) { element.style.left = `${pane.width / 2}px`; return; }
    const centre = box.left + half - pane.left;
    const wanted = Math.max(8 + half, Math.min(pane.width - 8 - half, centre));
    if (Math.abs(wanted - centre) > 0.5) {
      const current = Number.parseFloat(element.style.left) || centre;
      element.style.left = `${current + (wanted - centre)}px`;
    }
  }

  /**
   * The same thing down the page. A selection taller than the screen has both its top and its
   * bottom off the screen, so a pill anchored to either edge of it is somewhere he cannot reach;
   * measured and pulled back inside the pane, it stays on the words he can see.
   */
  function fitCardVertically(element) {
    if (!element || !scroller || element.classList.contains('docked')) return;
    const pane = scroller.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    if (box.height >= pane.height - 24) return;
    const top = box.top - pane.top;
    const wanted = Math.max(12, Math.min(pane.height - 12 - box.height, top));
    if (Math.abs(wanted - top) > 0.5) {
      const current = Number.parseFloat(element.style.top) || 0;
      element.style.top = `${current + (wanted - top)}px`;
    }
  }

  $effect(() => {
    selection; quick; peek;                  // measure again whenever one of them appears or moves
    tick().then(() => {
      fitCard(popEl); fitCard(quickEl); fitCard(peekEl);
      fitCardVertically(popEl); fitCardVertically(peekEl);
    });
  });

  /** A box that hangs off the bottom of the pane is a box he has to pinch and hunt for. */
  function keepOnScreen() {
    if (!quickEl || !scroller) return;
    const box = quickEl.getBoundingClientRect();
    const pane = scroller.getBoundingClientRect();
    if (box.bottom > pane.bottom - 16) scroller.scrollTop += box.bottom - (pane.bottom - 16);
    else if (box.top < pane.top + 16) scroller.scrollTop -= (pane.top + 16) - box.top;
  }

  function growQuick() {
    if (!quickBox) return;
    quickBox.style.height = 'auto';
    quickBox.style.height = `${Math.min(220, quickBox.scrollHeight)}px`;
    keepOnScreen();
  }

  // Long enough for a tap's click to follow its blur, short enough that a genuine tap away saves
  // while he is still looking at the page.
  const BLUR_SAVE_MS = 300;
  let blurSave = null;
  function cancelBlurSave() {
    if (blurSave) { clearTimeout(blurSave); blurSave = null; }
  }

  function closeQuick() {
    cancelBlurSave();
    forgetDraft();               // Escape is him deciding against it; nothing is held back
    quick = null;
    selection = null;
    peek = null;
    repaint();
  }

  async function commitQuickNote({ send = false } = {}) {
    cancelBlurSave();
    if (!quick || quick.busy) return;
    stopMic();
    const text = [quick.text, quick.partial].filter(Boolean).join(' ').trim();
    if (!text) { closeQuick(); return; }
    keepDraft();
    const draft = { ...quick, text, partial: '' };
    quick = { ...draft, busy: true };
    let highlight = draft.existing;
    try {
      highlight ||= await makeHighlight('yellow', { card: false, sel: draft.sel });
      if (!highlight) { quick = { ...draft, busy: false }; error = error || 'That note could not be attached to the text; it is still here.'; return; }
      if (send) {
        const conversationId = await sendToAgent(highlight, text);
        if (!conversationId) {
          quick = { ...draft, existing: highlight, busy: false };
          keepDraft();
          focusQuick(text.length);
          return;
        }
        capture = { highlight, text, partial: '', state: 'idle', sent: conversationId, error: null };
        forgetDraft();
        quick = null;
        return;
      }
      const body = await api('/api/reader/notes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: highlight.id, docId: highlight.docId, note: text })
      });
      highlights = highlights.map((h) => (h.id === body.highlight.id ? body.highlight : h));
      if (doc) docs.drop(docKey(doc.id, section?.idx ?? null));
      repaint();
      loadLibrary();
      forgetDraft();
      quick = null;
    } catch (cause) {
      error = cause.message;
      quick = { ...draft, existing: highlight, busy: false };
      focusQuick(text.length);
      repaint();
    }
  }

  // On a phone the keyboard's checkmark is the only obvious way out of the box, and it arrives as
  // a line break, not as a click on anything. It saves, like Enter does on a desktop.
  let allowBreak = false;

  function onQuickBeforeInput(event) {
    if (event.inputType !== 'insertLineBreak') return;
    if (allowBreak) { allowBreak = false; return; }
    // A phone has no Shift to hold, so Return there is what it is everywhere else in the world:
    // a new line. Saving is the button beside the box; on a keyboard Return still saves.
    if (docked) return;
    event.preventDefault();
    commitQuickNote();
  }

  /** The keyboard going away, or focus leaving the box, keeps the note; it never drops it.
   *
   * On a phone the save has to wait a moment. The save is therefore scheduled, and any press inside
   * the popover, or any commit, cancels it. Nothing is lost either way: the draft is already in
   * local storage, and the pending save still runs if he really did tap away.
   */
  function onQuickBlur(event) {
    cancelBlurSave();
    if (!quick || quick.busy) return;
    if (event.relatedTarget?.closest?.('[data-reader-pop]')) return;   // the mic, still his note
    keepDraft();
    if (!(quick.text || '').trim()) return;
    blurSave = setTimeout(() => { blurSave = null; commitQuickNote(); }, BLUR_SAVE_MS);
  }

  function onQuickKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeQuick(); return; }
    if (event.key !== 'Enter') return;
    if (event.shiftKey) { allowBreak = true; return; }   // a newline, as everywhere else
    // Command-Return still sends from a phone keyboard; a bare Return there is a line break.
    if (docked && !(event.metaKey || event.ctrlKey)) { allowBreak = true; return; }
    event.preventDefault();
    event.stopPropagation();
    commitQuickNote({ send: event.metaKey || event.ctrlKey });
  }

  /** Is this tap on the words he has selected? Every rect of the live range, not its bounding box,
      so a selection that wraps three lines does not claim the empty end of the last one. */
  function tapInsideSelection(event) {
    const live = typeof window === 'undefined' ? null : window.getSelection?.();
    if (!live || live.isCollapsed || !live.rangeCount) return false;
    const range = live.getRangeAt(0);
    if (!article?.contains(range.commonAncestorContainer)) return false;
    const x = event.clientX, y = event.clientY;
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    for (const rect of range.getClientRects()) {
      if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) return true;
    }
    return false;
  }

  /** A click anywhere else puts the pill away; it is not a dialog. */
  function onPointerDown(event) {
    // A tap on the selected words themselves is a request for the pill, not a dismissal: iOS
    // brings its own callout back that way, and ours used to disappear at exactly that tap.
    if (!quick && !event.target?.closest?.('[data-reader-pop]') && tapInsideSelection(event)) {
      event.preventDefault();                 // and the selection he tapped does not collapse
      onSelect();
      return;
    }
    if (!selection && !quick && !peek) return;
    if (quick?.busy) return;
    if (event.target?.closest?.('[data-reader-pop]')) return;
    const had = Boolean(quick);
    if (quick && (quick.text || '').trim()) { keepDraft(); commitQuickNote(); return; }
    quick = null;
    selection = null;
    peek = null;
    if (had) repaint();
  }

  async function saveNote() {
    if (!editing) return;
    const body = await api('/api/reader/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: editing.id, docId: editing.docId, note: noteText })
    });
    highlights = highlights.map((h) => (h.id === body.highlight.id ? body.highlight : h));
    docs.drop(docKey(editing.docId, section?.idx ?? null));
    editing = null;
    noteText = '';
    repaint();
  }

  async function removeHighlight(id) {
    await api(`/api/reader/notes?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    highlights = highlights.filter((h) => h.id !== id);
    if (doc) docs.drop(docKey(doc.id, section?.idx ?? null));
    if (editing?.id === id) { editing = null; noteText = ''; }
    repaint();
  }

  function editNote(highlight) {
    editing = highlight;
    noteText = highlight.note || '';
    rail = 'notes';
    repaint();
    const at = resolveAnchor(index.text, highlight);
    if (!at || !scroller || !article) return;
    const target = article.querySelector('p, li, h1, h2');
    if (target) scrollToOffset(at.start);
  }

  function scrollToOffset(offset) {
    const entry = index.nodes.find((node) => offset >= node.start && offset <= node.end);
    const element = entry?.node.parentElement;
    if (element) element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function onArticleClick(event) {
    const anchor = event.target.closest?.('a[href]');
    const href = anchor?.getAttribute('href') || '';
    // The note comes first. A note written over link text used to be unopenable: the click went
    // to the link every time, so the words carried a note nothing could reach. The link is not
    // lost; it moves into the card, which is the only place it is still reachable from.
    const offset = offsetAtPoint(index, event.clientX, event.clientY);
    const hit = offset === null ? null : highlights.find((highlight) => {
      if (highlight.sectionIdx !== (section?.idx ?? 0)) return false;
      const at = resolveAnchor(index.text, highlight);
      return at && offset >= at.start && offset <= at.end;
    });
    if (hit) {
      event.preventDefault();
      openPeek(hit, event.clientX, event.clientY, /^https?:/u.test(href) ? href : null);
      return;
    }
    if (anchor) {
      if (/^https?:/u.test(href) && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        openUrl(href);
      }
    }
  }

  /** A link under the pointer is a link about to be clicked; start fetching it now. */
  function onArticleHover(event) {
    const anchor = event.target?.closest?.('a[href]');
    const href = anchor?.getAttribute('href') || '';
    if (/^https?:/u.test(href)) warmUrl(href);
  }

  // --- speaking a note over a highlight --------------------------------------------------------
  // The workflow: select, the highlight lands, the microphone arms itself, he talks, and the card
  // shows what it heard with two ways out. Note keeps it on the highlight.

  function startCapture(highlight, { record = autoMic } = {}) {
    capture = { highlight, text: highlight.note || '', partial: '', state: 'idle', sent: null, error: null };
    if (record) armMic();
  }

  function armMic() {
    if (!mic?.available?.()) { capture && (capture = { ...capture, state: 'idle', error: 'no microphone here' }); return; }
    if (mic.isRecording()) return;
    if (mic.holdStart({ fromComposer: false })) capture = { ...capture, state: 'recording', error: null };
  }

  function stopMic({ send = false } = {}) {
    if (mic?.isRecording?.()) mic.holdStop({ send });
    if (capture) capture = { ...capture, state: 'idle' };
  }

  function toggleMic() {
    cancelBlurSave();   // the mic blurs the box on a phone too; dictating is not tapping away
    if (mic?.isRecording?.()) stopMic();
    else armMic();
  }

  const captureText = $derived(capture ? [capture.text, capture.partial].filter(Boolean).join(' ').trim() : '');

  async function captureAsNote() {
    if (!capture) return;
    stopMic();
    const text = captureText;
    if (!text) { closeCapture(); return; }
    const body = await api('/api/reader/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: capture.highlight.id, docId: capture.highlight.docId, note: text })
    });
    highlights = highlights.map((h) => (h.id === body.highlight.id ? body.highlight : h));
    if (doc) docs.drop(docKey(doc.id, section?.idx ?? null));
    closeCapture();
    repaint();
    loadLibrary();
  }

  async function captureToAgent() {
    if (!capture) return;
    stopMic({ send: true });
    const said = captureText;
    if (!said) return;
    const conversationId = await sendToAgent(capture.highlight, said);
    if (conversationId) capture = { ...capture, sent: conversationId, text: said, partial: '' };
  }

  /** Keep the note first, hand it to the agent second. */
  async function sendToAgent(highlight, said) {
    try {
      const body = await api('/api/reader/notes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: highlight.id, docId: highlight.docId, note: said, tags: 'asked' })
      });
      highlights = highlights.map((h) => (h.id === body.highlight.id ? body.highlight : h));
      if (doc) docs.drop(docKey(doc.id, section?.idx ?? null));
      repaint();
    } catch (cause) {
      error = cause.message;
      return null;
    }
    const quote = highlight.quote;
    const where = doc?.url || doc?.title || '';
    const message = [`From ${doc?.title || 'something I am reading'}${where && where !== doc?.title ? ` (${where})` : ''}:`,
      '', `> ${quote.replace(/\n+/gu, '\n> ')}`, '', said].join('\n');
    // One article, one conversation. The first note from a document opens a chat and the document
    // remembers which; every note after it is a message in that same chat, which is what reading
    // with someone is. A document with no chat yet, or one whose chat has been archived away,
    // starts a new one.
    let existing = doc?.state?.chat_id || null;
    if (existing) {
      try {
        const response = await fetch(`/api/conversation/${encodeURIComponent(existing)}?limit=1`);
        if (response.status === 404) existing = null;
        else {
          if (!response.ok) throw new Error('Could not check the reading chat; please retry.');
          const body = await response.json();
          if (body.conversation.archived) existing = null;
        }
      } catch (cause) { error = cause.message; return null; }
    }
    const conversationId = existing || newId();
    const seq = mintDeviceSeq(readerPrefs);
    try {
      const action = makeAction({
        op: existing ? ACTIONS.SEND : ACTIONS.CREATE, conversationId, deviceId: deviceId(), deviceSeq: seq,
        payload: existing ? { text: message } : { text: message, title: (doc?.title || 'Reading').slice(0, 60) }
      });
      const receipt = await api('/api/actions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action)
      });
      if (!receipt.events?.some((event) => event.kind === 'message.user' && event.content?.itemId === action.action_id)) {
        throw new Error('The chat did not acknowledge your message; your note is still here.');
      }
      if (!existing && doc?.id) {
        try {
          await api('/api/reader/chat', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ docId: doc.id, chatId: conversationId })
          });
          doc = { ...doc, state: { ...(doc.state || {}), chat_id: conversationId } };
          docs.drop(docKey(doc.id, section?.idx ?? null));
        } catch { /* the chat is sent; remembering it is the next note's problem */ }
      }
      loadLibrary();
      return conversationId;
    } catch (cause) {
      error = cause.message;
      return null;
    }
  }

  function closeCapture() {
    stopMic();
    capture = null;
  }

  // --- navigation ------------------------------------------------------------------------------

  async function go(rel) {
    const link = linkFor(rel);
    if (link) { await openUrl(link.href); return; }
    if (!sections.length || !section) return;
    const next = section.idx + (rel === 'next' ? 1 : -1);
    if (next >= 0 && next < sections.length) await openDoc(doc.id, { sectionIdx: next });
  }

  const stepOf = (rel) => (section ? sections[section.idx + (rel === 'next' ? 1 : -1)] : null);
  const titleFor = (rel) =>
    linkFor(rel)?.label || stepOf(rel)?.title || (rel === 'next' ? 'Next' : 'Previous');
  const stepHref = (rel) => linkFor(rel)?.href || (doc ? `/reader?doc=${doc.id}&section=${stepOf(rel)?.idx ?? 0}` : '#');
  const canGo = (rel) => Boolean(linkFor(rel)) || (sections.length > 1 && (
    rel === 'next' ? (section?.idx ?? 0) < sections.length - 1 : (section?.idx ?? 0) > 0));

  async function pollIngest(id) {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (!doc || doc.id !== id) return;
      let body;
      try { body = await api(`/api/reader/epub?id=${encodeURIComponent(id)}`); } catch { return; }
      ingest = body.status;
      if (!ingest || ingest.state === 'ready' || ingest.state === 'failed') {
        const refreshed = await api(`/api/reader/doc/${id}?section=${section?.idx ?? 0}`);
        sections = refreshed.sections || sections;
        loadLibrary();
        return;
      }
      sections = (await api(`/api/reader/doc/${id}?section=${section?.idx ?? 0}`)).sections || sections;
    }
  }

  async function uploadEpub(file) {
    busy = `reading ${file.name}`;
    error = null;
    try {
      const body = await api(`/api/reader/epub?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'content-type': 'application/epub+zip' }, body: file,
        duplex: 'half'
      });
      await loadLibrary();
      await openDoc(body.id);
      rail = 'contents';
    } catch (cause) { error = cause.message; } finally { busy = null; }
  }

  function onDrop(event) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) uploadEpub(file);
  }

  function shortcuts(event) {
    const typing = event.target?.tagName === 'INPUT' || event.target?.tagName === 'TEXTAREA' || event.target?.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); openPaste(); return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault(); sheet = !sheet; return;
    }
    // Cmd-Z takes back the last Done, set aside, defer or star, newest first. A field he has
    // typed into keeps its own undo; the empty add-a-link field, which takes the caret on load,
    // does not (core/undo.js), and an empty stack is left to the browser.
    if (isUndoShortcut(event) && undoStack.size) {
      event.preventDefault();
      undoStack.undo().catch((cause) => { error = cause.message; });
      return;
    }
    // Cmd-E is Done, the same action as archive, on whatever row the pointer is over or the
    // document that is open. The empty add/search field autofocuses on mount. Hovering a row
    // must still make Cmd-E act on it; actual input text and other editors retain their
    // shortcuts.
    const idleOmni = event.target === omniInput && !omni.trim();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e' && (!typing || (hoveredDoc && idleOmni))) {
      const row = hoveredDoc ? library.find((entry) => entry.id === hoveredDoc)
        || asideDocs.find((entry) => entry.id === hoveredDoc)
        || deferredDocs.find((entry) => entry.id === hoveredDoc) : doc;
      if (!row) return;
      event.preventDefault();
      archiveDoc(row, true);
      if (doc && row.id === doc.id) clearPane();
      hoveredDoc = null;
      return;
    }
    if (event.key === 'Escape') {
      if (peek) { peek = null; return; }
      if (quick) { closeQuick(); return; }
      if (adding) { adding = false; omniOpen = false; omniResults = null; return; }
      if (sheet) { sheet = false; return; }
      if (capture) { closeCapture(); return; }
      if (editing) { editing = null; repaint(); }
      else if (omniOpen) omniOpen = false;
      else selection = null;
      return;
    }
    if (capture && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); captureToAgent(); return; }
    if (capture && event.key === 'Enter' && !event.shiftKey && event.target?.tagName !== 'TEXTAREA') { event.preventDefault(); captureAsNote(); return; }
    if (typing) return;
    if (event.key === ']' || (event.key === 'ArrowRight' && event.altKey)) { event.preventDefault(); go('next'); }
    if (event.key === '[' || (event.key === 'ArrowLeft' && event.altKey)) { event.preventDefault(); go('prev'); }
    // With words selected, any letter is the start of a note: one gesture, no click.
    if (selection && !quick && !capture && !event.metaKey && !event.ctrlKey && !event.altKey
        && event.key.length === 1 && /\S/u.test(event.key)) {
      event.preventDefault();
      openQuickNote(event.key);
    }
  }

  // EPUB chapters carry images as epub:<path inside the book>; point them at the asset route.
  const renderedHtml = $derived.by(() => {
    if (!doc && page) return page.html || '';
    const html = section?.html || '';
    if (!doc || doc.kind !== 'epub') return html;
    return html.replace(/(src|href)="epub:([^"]+)"/gu, (_, attr, path) =>
      `${attr}="${replica?.assetUrl(doc.id, path) || `/api/reader/asset/${doc.id}/${path.split('/').map(encodeURIComponent).join('/')}`}"`);
  });

  /** A box he is already in keeps the caret; nothing the page does by itself may take it away. */
  function typingSomewhere() {
    const live = typeof document === 'undefined' ? null : document.activeElement;
    if (!live || live === omniInput) return false;
    return live.tagName === 'INPUT' || live.tagName === 'TEXTAREA' || live.isContentEditable === true;
  }

  // Not on a phone, where focusing throws the keyboard over the library before he has looked at
  // it; `docked` is already how this file asks whether it is on a touch screen.
  $effect(() => {
    // The element itself is the dependency. The effect runs before `bind:this` has handed the
    // input over on a cold load, so reading it here is what brings the effect back once it has.
    // The element itself is the dependency: on a cold load this runs before `bind:this` has
    // handed the input over, and reading it here is what brings the effect back once it has.
    const field = omniInput;
    if (!field) return;
    if (!pasting && !(shelf && !docked)) return;
    tick().then(() => { if (!typingSomewhere()) field.focus(); });
  });

  /** Bigger or smaller text, in steps, so he never has to pinch the page to read it. */
  function stepText(direction) {
    const next = stepScale(textScale, direction);
    if (next === textScale) return;
    const ratio = scroller && scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
    readerPrefs.dispatch('textScale.set', { scale: next });
    // Bigger text reflows the article; keep him at the same place in it, not the same pixel.
    tick().then(() => { if (scroller) scroller.scrollTop = ratio * scroller.scrollHeight; });
  }

  $effect(() => {
    renderedHtml; article;        // the element binds a beat after the html on a cold load
    tick().then(() => reindex());
  });

  function openPaste() {
    sheet = false;                      // the pill covers the drawer; two surfaces is one too many
    adding = true;
    omni = '';
    tick().then(() => { omniInput?.focus(); omniInput?.select(); });
  }

  const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/u;

  async function pasteLink() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) { error = 'The clipboard is empty.'; return; }
      const url = isUrl(text);
      if (url) { omni = ''; omniOpen = false; await openUrl(url); return; }
      omni = text;
      omniOpen = true;
      await runOmni();
    } catch {
      // Safari refuses readText outside its own paste gesture; give the field back.
      omniInput?.focus();
      error = 'Tap the field and hold to paste; this browser will not hand over the clipboard.';
    }
  }

  async function shareCurrent(quote = null) {
    const url = view?.url || (view?.saved && doc ? `${location.origin}/reader?doc=${doc.id}` : location.href);
    const data = quote
      ? { title: view?.title || 'Reader', text: `“${quote}”`, url }
      : { title: view?.title || 'Reader', url };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard?.writeText(quote ? `${data.text}\n${url}` : url); error = 'Copied the link; this browser has no share sheet.'; }
    } catch { /* the sheet was dismissed */ }
    selection = null;
  }

  onMount(() => {
    sinceReport = Date.now();
    // Settled once, not only when he selects something: a tap on an existing note opens a card
    // with a box in it, and that box has to know it is on a phone before anything is selected.
    docked = touchScreen();
    canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';
    loadLibrary().catch((cause) => { error = cause.message; });
    const stopSync = replica ? replica.subscribe((next) => { sync = next; }) : () => {};
    replica?.start();
    // A save, archive or star from another device repaints the shelf here within a second or so,
    // instead of at the next open. The replica's own sync (reader-offline.js) hears the same push.
    let shelfTimer = null;
    const stopLive = liveSubscribe('reader', () => {
      if (shelfTimer) return;
      shelfTimer = setTimeout(() => {
        shelfTimer = null;
        if (shelf && !omni.trim()) loadLibrary().catch(() => {});
      }, 400);
    });
    const params = new URLSearchParams(location.search);
    const wanted = params.get('doc');
    // A share sheet sends url, or text holding the url, or only a title.
    const shared = (params.get('url') || '').trim();
    const text = (params.get('text') || '').trim();
    const url = shared || (text.match(URL_IN_TEXT) || [])[0] || '';
    if (wanted) openDoc(wanted, { sectionIdx: params.has('section') ? Number(params.get('section')) : null, push: false });
    else if (url) openUrl(url, { push: false });
    else if (text || params.get('title')) { omni = text || params.get('title'); omniOpen = true; runOmni(); }
    document.addEventListener('selectionchange', onSelect);
    window.addEventListener('keydown', shortcuts);
    window.addEventListener('popstate', onPop);
    window.addEventListener('pointerdown', onPointerDown, true);
    dwellTimer = setInterval(() => { if (!page) return; dwell.tick(); considerKeeping(); }, 10_000);
    const flush = () => {
      rememberScroll();
      dwell.visibility(!document.hidden);
      considerKeeping();
      report({ force: false });
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    // A field he has typed into keeps its own Cmd-Z, even after he clears it (core/undo.js).
    const unwatchFields = watchEditedFields(document);
    return () => {
      stopLive();
      clearTimeout(shelfTimer);
      stopSync();
      replica?.stop();
      unwatchFields();
      document.removeEventListener('selectionchange', onSelect);
      window.removeEventListener('keydown', shortcuts);
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      clearTimeout(reportTimer);
      clearInterval(dwellTimer);
      cancelAnimationFrame(paintFrame);
      clearPaint();
    };
  });
</script>

<svelte:head><title>{doc ? doc.title : 'Reader'}</title></svelte:head>

<!-- One field for a link, a search and a book, standing wherever the reader is: over the words
     while he is reading, and on the library when nothing is open. One field, one save path. -->
{#snippet omnibox()}
  <div class="pill">
    
    <!-- svelte-ignore a11y_autofocus -->
    <input
      autofocus={shelf && !docked}
      bind:this={omniInput}
      bind:value={omni}
      placeholder="Paste a link"
      type="search"
      inputmode="url"
      enterkeyhint="go"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      onkeydown={(e) => { if (e.key === 'Enter') runOmni(); }}
      oninput={onOmniInput}
      onpaste={onOmniPaste}
      data-testid="reader-omni"
    />
    {#if canPaste}
      <button class="glyph paste press focus-ring" onclick={pasteLink} aria-label="Paste a link" title="Paste a link" data-testid="reader-paste">⌘V</button>
    {/if}
    <label class="glyph upload press" title="Open an EPUB">
      <input type="file" accept=".epub,application/epub+zip" onchange={(e) => e.currentTarget.files[0] && uploadEpub(e.currentTarget.files[0])} />
      ⇪
    </label>
  </div>
  {#if omniOpen && omniResults}
    <div class="results" data-testid="reader-results">
      {#if omniResults.docs?.length}
        <h4>Library</h4>
        {#each omniResults.docs as hit (hit.id + hit.section_idx)}
          <button class="result" onpointerenter={() => warmDoc(hit.id, hit.section_idx)} onclick={() => openDoc(hit.id, { sectionIdx: hit.section_idx })}>
            <span class="rtitle">{hit.title}</span>
            <span class="rsnip">{@html hit.snippet}</span>
          </button>
        {/each}
      {/if}
      {#if omniResults.notes?.length}
        <h4>Notes</h4>
        {#each omniResults.notes as hit (hit.id)}
          <button class="result" onclick={() => openDoc(hit.doc_id, { sectionIdx: hit.section_idx })}>
            <span class="rtitle">{hit.title}</span>
            <span class="rsnip">{hit.note || hit.quote}</span>
          </button>
        {/each}
      {/if}
      {#if omniResults.web}
        <h4>Web</h4>
        {#each omniResults.web as hit (hit.url)}
          <button class="result" onpointerenter={() => warmUrl(hit.url)} onclick={() => openUrl(hit.url)}>
            <span class="rtitle">{hit.title}</span>
            <span class="rsnip">{hit.snippet}</span>
          </button>
        {/each}
      {:else}
        <button class="websearch" onclick={searchWeb}>Search the web</button>
      {/if}
    </div>
  {/if}
{/snippet}

<div class="reader" class:drawer={sheet} ondrop={onDrop} ondragover={(e) => e.preventDefault()}>
  <!-- Nothing frames the text: a library on the left, a place to paste, and the words. -->
  <div class="tick" class:on={loading || Boolean(busy)} aria-hidden="true"></div>

  <div class="navspot">
    <Nav current="reader" />
    <button
      class="edge press focus-ring"
      class:on={sheet}
      onclick={() => (sheet = !sheet)}
      aria-label="Library"
      title="Library"
      data-testid="reader-sheet-toggle"
    >☰</button>
    {#if !sync.online || sync.pending}
      <!-- Quiet: one muted word while the server is away, and how much is waiting to go. -->
      <span class="offline" data-testid="reader-offline" title={sync.online ? 'Saving to the server' : 'The server is not reachable; reading from this device'}>
        {sync.online ? 'saving' : 'offline'}{sync.pending ? ` · ${sync.pending}` : ''}
      </span>
    {/if}
  </div>

  {#if view && !view.skeleton}
    <div class="hud">
      {#if !view.saved}
        <button class="glyph press focus-ring save" onclick={addToLibrary} aria-label="Save to library" title="Save to library" data-testid="reader-add">
          <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
            <path d="M6.5 3.75h11a1 1 0 0 1 1 1v15.2a.6.6 0 0 1-.93.5L12 16.6l-5.57 3.85a.6.6 0 0 1-.93-.5V4.75a1 1 0 0 1 1-1Z"
                  fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          </svg>
        </button>
      {/if}
      <button class="glyph press focus-ring" onclick={() => shareCurrent()} aria-label={canShare ? 'Share' : 'Copy link'} title={canShare ? 'Share' : 'Copy link'} data-testid="reader-share">↗</button>
      {#if doc?.id}
        <!-- The glyph above shares where the piece came from; this one makes a page of our own
             that anyone can open, with or without his notes. Same component as the chat header. -->
        <ShareLinks kind="doc" targetId={doc.id} label="Public link" />
      {/if}
    </div>
  {/if}

  {#if error}<div class="error" data-testid="reader-error">{error}</div>{/if}

  {#if pasting}
    <div class="pastelayer" data-reader-pop>
      {#if doc || page}
        <button class="scrim quiet" onclick={() => { adding = false; omniOpen = false; }} aria-label="Close"></button>
      {/if}
      {@render omnibox()}
    </div>
  {/if}

  <div class="body">
    {#if sheet}
      <button class="scrim" onclick={() => (sheet = false)} aria-label="Close the library"></button>
    {/if}

    <aside class="rail" class:open={sheet} inert={!sheet} data-testid="reader-rail">
      <div class="grabber" data-reader-skip></div>
      <div class="railtop">
        <span class="railname">Library</span>
        <button class="add press focus-ring" onclick={openPaste} aria-label="Add an article" title="Add an article" data-testid="reader-new">＋</button>
      </div>
      <div class="textsize">
        <span>Text</span>
        <button class="press focus-ring" onclick={() => stepText(-1)} aria-label="Smaller text" title="Smaller text" data-testid="reader-text-smaller">A−</button>
        <button class="press focus-ring" onclick={() => stepText(1)} aria-label="Bigger text" title="Bigger text" data-testid="reader-text-bigger">A+</button>
      </div>
      <div class="tabs">
        <button class:on={rail === 'library'} onclick={() => (rail = 'library')}>Library</button>
        {#if sections.length > 1}<button class:on={rail === 'contents'} onclick={() => (rail = 'contents')}>Contents</button>{/if}
        {#if (doc ? highlights.length : recentNotes.length) > 0}
          <button class:on={rail === 'notes'} onclick={() => (rail = 'notes')}>Notes</button>
        {/if}
      </div>

      {#if rail === 'library'}
        {@render viewTabs()}
        <ul class="list">
          {#each shown as row (row.id)}
            <li>
              {@render swipeRow(row, 'reader-library-row', doc?.id === row.id)}
            </li>
          {:else}
            <li class="empty">{emptyWord}</li>
          {/each}
        </ul>
        {@render trays()}
        {@render undoBar()}
      {:else if rail === 'contents'}
        {#if ingest && ingest.state !== 'ready'}
          <p class="ingest" data-testid="reader-ingest" title="The book is being read for search">
            {ingest.state === 'failed' ? `not readable: ${ingest.error}` : `${ingest.done}/${ingest.total}`}
          </p>
        {/if}
        <ul class="list">
          {#each sections as entry (entry.idx)}
            <li>
              <button
                class="row"
                class:current={section?.idx === entry.idx}
                onpointerenter={() => warmDoc(doc.id, entry.idx)}
                onclick={() => openDoc(doc.id, { sectionIdx: entry.idx })}
              >
                <span class="title">{entry.title || `Section ${entry.idx + 1}`}</span>
                <span class="meta">{wordCount(entry.words)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <ul class="notes">
          {#each (doc ? highlights : recentNotes) as note (note.id)}
            <li class={`note ${note.color || 'yellow'}`} class:editing={editing?.id === note.id} class:bytophat={note.author === 'tophat'}>
              <button class="quote" onclick={() => (doc ? editNote(note) : openDoc(note.docId, { sectionIdx: note.sectionIdx }))}>
                {note.quote}
              </button>
              {#if note.author === 'tophat'}<span class="byline-tophat" data-testid="reader-note-by-tophat">tophat</span>{/if}
              {#if !doc}<span class="from">{note.docTitle}</span>{/if}
              {#if editing?.id === note.id}
                <textarea bind:value={noteText} placeholder="Note" rows="4"></textarea>
                <div class="noteactions">
                  <button onclick={saveNote}>Save</button>
                  <button onclick={() => { editing = null; repaint(); }}>Cancel</button>
                  <button class="danger" onclick={() => removeHighlight(note.id)}>Delete</button>
                </div>
              {:else if note.note}
                <p class="body">{note.note}</p>
              {/if}
            </li>
          {:else}
            <li class="empty">No notes yet</li>
          {/each}
        </ul>
        {#if orphans.length}
          <p class="orphans" title="These highlights no longer match the text; they are kept, not deleted.">{orphans.length} unmatched</p>
        {/if}
      {/if}
    </aside>

    <main class="pane" bind:this={scroller} onscroll={onScroll}>
      {#if view}
        <article class="doc" style:--text-scale={textScale} data-testid={view.saved ? 'reader-saved' : 'reader-browsing'}>
          <h1 class:ghost={view.skeleton && !view.title}>{view.title}</h1>
          <p class="byline">
            {#if view.byline}{view.byline} · {/if}
            {#if view.site}{#if view.url}<a href={view.url} target="_blank" rel="noreferrer">{view.site}</a>{:else}{view.site}{/if}{/if}
            {#if view.words}· {wordCount(view.words)}{/if}
            {#if view.saved && view.percent > 0}· {view.percent}%{/if}
          </p>
          <hr class="rule" />
          {#if sections.length > 1 && section}<h2 class="chapter">{section.title}</h2>{/if}
          {#if section?.error}<p class="cerror">{section.error}</p>{/if}
          {#if view.skeleton}
            <div class="skeleton" data-testid="reader-skeleton" aria-label="Opening">
              {#each [92, 98, 88, 96, 70, 94, 90, 84] as width, i (i)}
                <span class="line" style:width={`${width}%`}></span>
              {/each}
            </div>
          {:else}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="content" bind:this={article} onmouseup={onSelect} onclick={onArticleClick} onpointerover={onArticleHover} role="document">{@html renderedHtml}</div>

            {#if canGo('prev') || canGo('next') || linkFor('up')}
              <nav class="pager" data-testid="reader-pager">
                {#if canGo('prev')}
                  <a
                    class="pagelink prev"
                    href={stepHref('prev')}
                    title={titleFor('prev')}
                    onclick={(e) => { e.preventDefault(); go('prev'); }}
                    data-testid="reader-prev"
                  ><span class="dir">← Previous</span><span class="ptitle">{titleFor('prev')}</span></a>
                {/if}
                {#if canGo('next')}
                  <a
                    class="pagelink next"
                    href={stepHref('next')}
                    title={titleFor('next')}
                    onclick={(e) => { e.preventDefault(); go('next'); }}
                    data-testid="reader-next"
                  ><span class="dir">Next →</span><span class="ptitle">{titleFor('next')}</span></a>
                {/if}
                {#if linkFor('up')}
                  <a
                    class="pagelink up"
                    href={linkFor('up').href}
                    title={linkFor('up').label || 'Contents'}
                    onclick={(e) => { e.preventDefault(); openUrl(linkFor('up').href); }}
                  ><span class="dir">Contents</span><span class="ptitle">{linkFor('up').label || 'Contents'}</span></a>
                {/if}
              </nav>
            {/if}
          {/if}
        </article>
      {:else}
        <!-- The shelf: what the reader opens on. The order is the store's, most recently read
             first, and the place to paste a link sits at the top of it. -->
        <section class="shelf" data-testid="reader-shelf">
          <h1>Library</h1>
          <div class="shelfbox">{@render omnibox()}</div>
          {@render viewTabs()}
          {#if shown.length}
            <ul class="list">
              {#each shown as row (row.id)}
                <li>
                  {@render swipeRow(row, 'reader-shelf-row', false)}
                </li>
              {/each}
            </ul>
          {:else if libraryLoaded}
            <!-- An empty shelf is a state, not a failure: say what to do with the field above it. -->
            <p class="shelfempty" data-testid="reader-shelf-empty">
              {#if shelfView === 'starred'}
                Nothing starred yet. Swipe a row right, or press its star, to keep it here.
              {:else if shelfView === 'archived'}
                Nothing archived yet. Swipe a row left when you are done with it.
              {:else}
                Nothing saved yet. Paste a link in the field above and press Enter, or open an EPUB with the button beside it.
              {/if}
            </p>
          {/if}
          {@render trays()}
          {@render undoBar()}
        </section>
      {/if}

      {#if capture}
        <div class="capture" data-testid="reader-capture">
          <p class="cquote">{capture.highlight.quote.length > 180 ? `${capture.highlight.quote.slice(0, 180)}…` : capture.highlight.quote}</p>
          {#if capture.sent}
            <p class="csent"><a href={`/?stay&chat=${capture.sent}`}>Open the chat</a></p>
            <div class="cactions"><button onclick={closeCapture}>Done</button></div>
          {:else}
            <div class="cheard" class:live={capture.state === 'recording'}>
              {#if captureText}{captureText}{:else}<span class="hint">{capture.state === 'recording' ? 'Listening' : ''}</span>{/if}
            </div>
            <textarea bind:value={capture.text} placeholder="Note" rows="2"></textarea>
            {#if capture.error}<p class="cerror">{capture.error}</p>{/if}
            <div class="cactions">
              <button class="mic" class:on={capture.state === 'recording'} onclick={toggleMic} aria-label="Microphone" title="Microphone">
                {capture.state === 'recording' ? '■' : '●'}
              </button>
              <button class="primary" onclick={captureAsNote} data-testid="reader-note-btn">Note</button>
              <button class="primary" onclick={captureToAgent} data-testid="reader-send-btn">Send</button>
              <button onclick={closeCapture}>Cancel</button>
              <label class="auto" title="Arm the microphone on every highlight"><input type="checkbox" bind:checked={() => autoMic, (on) => readerPrefs.dispatch('autoMic.set', { on })} /> mic</label>
            </div>
          {/if}
        </div>
      {/if}

      {#if selection && !quick}
        <SelectPill x={selection.x} y={selection.y} below={selection.below} {docked}
                    onroot={(el) => (popEl = el)} testid="reader-popover">
          {#each HIGHLIGHT_COLORS as color (color)}
            <button class={`swatch ${color}`} title={`Highlight ${color}`} onclick={() => makeHighlight(color)} aria-label={`Highlight ${color}`}></button>
          {/each}
          <button onclick={() => openQuickNote()}>Note</button>
          <button onclick={() => { navigator.clipboard?.writeText(selection.quote); selection = null; }}>Copy</button>
          {#if canShare}<button onclick={() => shareCurrent(selection.quote)} data-testid="reader-share-quote">Share</button>{/if}
          <button onclick={() => { omni = selection.quote.slice(0, 80); omniOpen = true; runOmni(); }}>Search</button>
        </SelectPill>
      {/if}

      {#if peek}
        <div
          class="peek"
          bind:this={peekEl}
          data-reader-pop
          class:below={peek.below}
          style:left={`${peek.x}px`}
          style:top={`${peek.y}px`}
          data-testid="reader-note-pop"
        >
          <div class="pthread" data-testid="reader-note-thread">
            {#each threadOf(peek.highlight) as entry (entry.id)}
              <div class="pentry" class:bytophat={entry.author === 'tophat'} data-testid="reader-note-entry">
                <div class="pmeta">
                  <span class="pwho">{entry.author === 'tophat' ? 'tophat' : 'the owner'}</span>
                  <time class="pwhen" datetime={entry.createdAt}>{stamp(entry.createdAt)}</time>
                </div>
                <p class="ptext">{entry.note}</p>
              </div>
            {:else}
              <p class="ptext dim">No note yet</p>
            {/each}
          </div>
          <div class="preply">
            <textarea
              bind:this={replyBox}
              bind:value={replyText}
              rows="1"
              placeholder="Reply"
              disabled={replyBusy}
              enterkeyhint={docked ? 'enter' : 'send'}
              onkeydown={onReplyKey}
              oninput={growReply}
              data-testid="reader-note-reply-box"
            ></textarea>
            <button class="primary" onclick={postReply} disabled={replyBusy || !(replyText || '').trim()} data-testid="reader-note-reply">Reply</button>
          </div>
          <div class="prow">
            {#if peek.link}
              <button onclick={() => { const href = peek.link; peek = null; openUrl(href); }} data-testid="reader-note-link">Open link</button>
            {/if}
            <button onclick={() => editHere(peek.highlight, { x: peek.x, y: peek.y, below: peek.below })} data-testid="reader-note-edit">{peek.highlight.note ? 'Edit' : 'Note'}</button>
            <button class="danger" onclick={() => { const id = peek.highlight.id; peek = null; removeHighlight(id); }} data-testid="reader-note-delete">Delete</button>
          </div>
        </div>
      {/if}

      {#if quick}
        <SelectBox
          x={quick.x} y={quick.y} below={quick.below}
          value={quick.text}
          busy={quick.busy}
          partial={quick.partial || ''}
          enterkeyhint={docked ? 'enter' : 'done'}
          testid="reader-quicknote"
          onroot={(el) => (quickEl = el)}
          onbox={(el) => (quickBox = el)}
          onvalue={(text) => { quick.text = text; }}
          onkeydown={onQuickKey}
          onbeforeinput={onQuickBeforeInput}
          onblur={onQuickBlur}
          oninput={() => { growQuick(); keepDraft(); }}
        >
          {#snippet footer()}
            <button class="qmic" class:on={quick.recording} onclick={toggleMic} aria-label={quick.recording ? 'Stop dictating' : 'Dictate the note'} title={quick.recording ? 'Stop dictating' : 'Dictate the note'} data-testid="reader-quick-mic">
              {#if quick.recording}
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>
              {:else}
                <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
                  <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
                </svg>
              {/if}
            </button>
            <span class="spacer"></span>
            {#if docked}
              <button class="qgo" onclick={() => commitQuickNote()} data-testid="reader-quick-save">Save</button>
              <button class="qgo primary" onclick={() => commitQuickNote({ send: true })} data-testid="reader-quick-send">Send</button>
            {:else}
              <span>↵ save</span><span>⌘↵ send</span>
            {/if}
          {/snippet}
        </SelectBox>
      {/if}
    </main>
  </div>

  <div class="mic-host" data-reader-skip>
    <DictationMic
      bind:this={mic}
      conversationId="reader-draft"
      onbegin={() => { if (quick) quick = { ...quick, recording: true }; else if (capture) capture = { ...capture, state: 'recording', partial: '' }; }}
      onpartial={(token, text) => { if (quick) quick = { ...quick, partial: text }; else if (capture) capture = { ...capture, partial: text }; }}
      oncommit={(token, text) => {
        if (quick) { quick = { ...quick, text: [quick.text, text].filter(Boolean).join(' ').trim(), partial: '', recording: false }; growQuick(); }
        else if (capture) capture = { ...capture, text: [capture.text, text].filter(Boolean).join(' ').trim(), partial: '', state: 'idle' };
      }}
      onextend={(token, text) => {
        if (quick) { quick = { ...quick, text: [quick.text, text].filter(Boolean).join(' ').trim(), partial: '' }; growQuick(); }
        else if (capture) capture = { ...capture, text: [capture.text, text].filter(Boolean).join(' ').trim(), partial: '' };
      }}
      oncancel={() => { if (quick) quick = { ...quick, partial: '', recording: false }; else if (capture) capture = { ...capture, partial: '', state: 'idle' }; }}
      onpermission={() => (micReady = true)}
    />
  </div>
</div>

{#if deferFor}
  <!-- The same popover the chat sidebar opens, so a document and a chat are deferred by the
       same words and the same picks. -->
  <DeferSheet
    title={deferFor.title}
    value={deferFor.defer_condition || ''}
    deferred={Boolean(deferFor.defer_until || deferFor.defer_condition)}
    oncommit={(choice) => deferDoc(deferFor, choice)}
    onclear={() => deferDoc(deferFor, null)}
    onclose={() => (deferFor = null)}
    testid="reader-defer-sheet"
  />
{/if}

{#snippet viewTabs()}
  <!-- Three shelves, one row of pills: what is live, the personal canon, and what has been read
       and put away. Archiving is reachable from here, so nothing he archives is ever lost. -->
  <div class="views" data-testid="reader-views">
    <button class:on={shelfView === 'live'} onclick={() => showView('live')} data-testid="reader-view-live">Library</button>
    <button class:on={shelfView === 'starred'} onclick={() => showView('starred')} data-testid="reader-view-starred">
      <Icon name={shelfView === 'starred' ? 'star-on' : 'star'} size={12} /> Starred
    </button>
    <button class:on={shelfView === 'archived'} onclick={() => showView('archived')} data-testid="reader-view-archived">Archived</button>
  </div>
{/snippet}

{#snippet swipeRow(row, testid, current)}
  <!-- Swipe left to archive ("ok, I read it"), swipe right to star ("worth referring back to"),
       and the same actions on hover. Two fingers on a trackpad, one on a phone. -->
  <SwipeRow
    archived={shelfView === 'archived'}
    starred={Boolean(row.starred)}
    onarchive={() => archiveDoc(row, shelfView !== 'archived')}
    onstar={() => starDoc(row)}
    testid={shelfView === 'archived' ? 'reader-unarchive' : 'reader-archive'}
    startestid="reader-star"
  >
    {#snippet actions()}
      <button
        class="rowbtn"
        onclick={(event) => { event.preventDefault(); event.stopPropagation(); markUnread(row); }}
        title="Mark unread"
        aria-label="Mark unread"
        data-testid="reader-mark-unread"
      ><Icon name="circle" size={13} /></button>
      <button
        class="rowbtn"
        onclick={(event) => { event.preventDefault(); event.stopPropagation(); setAsideDoc(row); }}
        title="Set aside"
        aria-label="Set aside"
        data-testid="reader-set-aside"
      ><Icon name="aside" size={13} /></button>
      <button
        class="rowbtn"
        onclick={(event) => { event.preventDefault(); event.stopPropagation(); deferFor = row; }}
        title="Defer until"
        aria-label="Defer until"
        data-testid="reader-defer"
      ><Icon name="clock" size={13} /></button>
    {/snippet}
    <button
      class="row"
      class:current={current}
      onpointerenter={() => { hoveredDoc = row.id; warmDoc(row.id); }}
      onpointerleave={() => { if (hoveredDoc === row.id) hoveredDoc = null; }}
      onpointerdown={() => warmDoc(row.id)}
      onclick={() => openDoc(row.id)}
      data-testid={testid}
    >
      <span class="title">
        {#if row.starred}<span class="starmark" title="Starred"><Icon name="star-on" size={11} /></span>{/if}{row.title}
      </span>
      <span class="meta">
        {row.byline || row.site || row.kind}
        {#if row.words}· {wordCount(row.words)}{/if}
        {#if row.notes}· {row.notes}{/if}
      </span>
      <span class="track"><span class="fill" style:width={`${percentOf(row)}%`}></span></span>
    </button>
  </SwipeRow>
{/snippet}

{#snippet trayRow(row, kind)}
  <!-- A row he has put down. The hover cluster brings it back; swiping it left still archives
       it, because being done with something is reachable from wherever it is sitting. -->
  <div class="trayrow">
    <SwipeRow onarchive={() => archiveDoc(row, true)} testid="reader-tray-archive">
      {#snippet actions()}
        <button
          class="rowbtn"
          onclick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (kind === 'aside') setAsideDoc(row, false); else deferDoc(row, null);
          }}
          title="Bring it back"
          aria-label="Bring it back"
          data-testid={kind === 'aside' ? 'reader-unaside' : 'reader-undefer'}
        ><Icon name="up" size={13} /></button>
      {/snippet}
      <button
        class="row"
        class:current={doc?.id === row.id}
        onpointerenter={() => warmDoc(row.id)}
        onclick={() => openDoc(row.id)}
        data-testid={`reader-${kind}-row`}
      >
        <span class="title">{row.title}</span>
        <span class="meta">
          {#if kind === 'deferred'}{deferLabel(deferOf(row))}{:else}{row.byline || row.site || row.kind}{/if}
        </span>
      </button>
    </SwipeRow>
  </div>
{/snippet}

{#snippet trays()}
  
  <Tray
    label="Deferred"
    icon="clock"
    count={deferredDocs.length}
    open={deferredOpen}
    onopen={(next) => (deferredOpen = next)}
    testid="reader-tray-deferred"
    listtestid="reader-deferred-list"
  >
    {#each deferredDocs as row (row.id)}{@render trayRow(row, 'deferred')}{/each}
  </Tray>
  <Tray
    label="Set aside"
    icon="tray"
    count={asideDocs.length}
    open={asideOpen}
    onopen={(next) => (asideOpen = next)}
    testid="reader-tray-aside"
    listtestid="reader-aside-list"
  >
    {#each asideDocs as row (row.id)}{@render trayRow(row, 'aside')}{/each}
  </Tray>
{/snippet}

{#snippet undoBar()}
  <!-- One bar for every row gesture, not only the archive: what it names is the last thing he
       did, and Cmd-Z reaches the ones before it. The testid keeps its old name so the archive
       specs that already press it still find it. -->
  <UndoBar label={undoLabel} onundo={undoNow} testid="reader-undo-archive" />
{/snippet}

<style>
  /* The frame: one bar, one column of text, and a library that is out of the way until it is
     wanted. Everything lines up on the same measure as the article, so nothing floats. */
  .reader {
    display: flex; flex-direction: column; height: 100dvh;
    background: var(--bg); color: var(--ink); font-family: var(--sans);
    /* One measure for the article and anything that floats over it, one hairline colour, one
       distance from the words to a card, so nothing sits at an arbitrary offset. */
    --measure: 42rem;
    --hair: color-mix(in srgb, var(--ink) 26%, transparent);
    --float-gap: 10px;
    /* How far anything anchored to the bottom has to stay clear of the hardware. env() reports 0
       in iOS Safari while the toolbar is up, which is how the pill kept landing under the home
       indicator, so on a touch screen there is a floor under it: the indicator is ~21pt tall in a
       ~34pt band. A page cannot hide the indicator, only dodge it. */
    --dodge-bottom: env(safe-area-inset-bottom, 0px);
  }
  @media (pointer: coarse) {
    .reader { --dodge-bottom: max(env(safe-area-inset-bottom, 0px), 28px); }
  }

  /* Where chat keeps it: top left, on every surface. The drawer toggle rides beside it, and both
     step aside together when the drawer they open is out. */
  .navspot {
    position: fixed; top: 20px; left: 20px; z-index: 46;
    display: flex; align-items: center; gap: 8px;
    transition: transform 220ms var(--ease);
  }
  .reader.drawer .navspot { transform: translateX(calc(min(310px, 86vw) - 12px)); }
  .offline { font-size: 11px; letter-spacing: 0.02em; color: var(--ink-faint); user-select: none; }

  /* A hairline at the very top while something is on its way; never a word. */
  .tick {
    position: fixed; left: 0; top: 0; height: 2px; width: 100%; z-index: 60;
    pointer-events: none;
    transform: scaleX(0); transform-origin: left;
    background: color-mix(in srgb, var(--accent) 70%, transparent);
    opacity: 0; transition: opacity 120ms linear;
  }
  .tick.on { opacity: 1; animation: crawl 2.4s var(--ease) infinite; }
  @keyframes crawl {
    0% { transform: scaleX(0); }
    60% { transform: scaleX(0.82); }
    100% { transform: scaleX(1); }
  }

  /* Two pieces of chrome over the text, both quiet until the pointer is near them. */
  .edge {
    position: relative; z-index: 45;
    width: 30px; height: 30px; display: grid; place-items: center;
    border: 0; border-radius: 999px; background: none; cursor: pointer;
    color: var(--ink-faint); font-size: 13px; opacity: 1;
    transition: opacity var(--tap) var(--ease), background var(--tap) var(--ease), transform 220ms var(--ease);
  }
  .edge:hover, .edge:focus-visible, .edge.on { opacity: 1; background: color-mix(in srgb, var(--ink) 8%, transparent); }

  .hud { position: fixed; top: 16px; right: 20px; z-index: 45; display: flex; gap: 4px; opacity: 1; transition: opacity var(--tap) var(--ease); }
  .hud:hover, .hud:focus-within { opacity: 1; }

  .glyph {
    display: inline-grid; place-items: center;
    width: 30px; height: 30px; flex: none;
    border-radius: 999px; border: 1px solid transparent;
    background: none; color: var(--ink-dim);
    font-size: 13px; line-height: 1; cursor: pointer;
  }
  .glyph.save svg { display: block; }
  .glyph:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 8%, transparent); }
  .glyph.paste { font-size: 11px; }
  .upload { position: relative; overflow: hidden; }
  .upload input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }

  /* Adding something to read: one pill, over everything, gone the moment it lands. */
  .pastelayer { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; align-items: center; padding-top: 168px; pointer-events: none; }
  .pastelayer > * { pointer-events: auto; }
  .pastelayer .scrim.quiet { position: fixed; inset: 0; z-index: 0; background: color-mix(in srgb, var(--bg-sunken) 72%, transparent); backdrop-filter: blur(6px); border: 0; }
  .pill:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent), 0 18px 50px rgba(0,0,0,0.22); }
  .pill {
    position: relative; z-index: 1;
    display: flex; align-items: center; gap: 6px;
    width: min(var(--measure), calc(100vw - 24px)); padding: 5px 6px 5px 12px;
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 18px;
    box-shadow: 0 18px 50px rgba(0,0,0,0.22);
  }
  .pill input[type="search"] {
    flex: 1; min-width: 0; border: 0; outline: none; background: none; color: var(--ink);
    font-family: var(--sans); font-size: 15px; line-height: 1.4; padding: 8px 12px;
  }
  .pill input::placeholder { color: var(--ink-faint); }
  .pill input::-webkit-search-cancel-button { display: none; }

  /** A failure only tells him something, so it takes a band of its own directly under the top
   *     chrome rather than sitting on the nav pill and the library button. At top: 14px it covered
   *     nav pill, of its overflow button and of the ☰ toggle, so the reader could not be left.
   */
  .error {
    position: fixed; z-index: 47; left: 50%; top: 60px; transform: translateX(-50%);
    max-width: min(var(--measure), calc(100vw - 120px));
    padding: 8px 14px; border-radius: 999px;
    font-size: 12.5px; color: var(--warn);
    background: color-mix(in srgb, var(--bg-raised) 92%, var(--warn));
    border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
    box-shadow: 0 10px 26px rgba(0,0,0,0.2);
  }

  .results {
    position: relative; z-index: 1; margin-top: 8px;
    width: min(var(--measure), calc(100vw - 24px)); max-height: 52vh; overflow: auto; padding: 8px;
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 18px 50px rgba(0,0,0,0.22);
  }
  .results h4 { margin: 8px 8px 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-faint); font-weight: 500; }
  .result, .websearch { display: block; width: 100%; text-align: left; padding: 7px 8px; border-radius: 9px; background: none; border: 0; color: var(--ink); cursor: pointer; }
  .result:hover, .websearch:hover { background: var(--accent-soft); }
  .rtitle { display: block; font-size: 13.5px; }
  .rsnip { display: block; font-size: 12px; color: var(--ink-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .websearch { font-size: 12.5px; color: var(--ink-faint); }

  .body { position: relative; flex: 1; min-height: 0; display: block; }

  /* The library is a drawer at every size: hidden until he asks for it, over the text, never
     stealing the measure the article is set on. */
  .rail {
    /* Fixed, not absolute: a closed drawer parked off screen by a transform still counts as
       scrollable overflow inside the pane, and he could scroll the article down into it. */
    position: fixed; z-index: 40; top: 0; bottom: 0; left: 0; width: min(310px, 86vw);
    overflow: auto; padding: 14px 12px 20px;
    background: var(--bg-raised);
    border-right: 1px solid var(--line);
    transform: translateX(-101%);
    visibility: hidden; pointer-events: none;
    transition: transform 220ms var(--ease), box-shadow 220ms var(--ease), visibility 0s 220ms;
    overscroll-behavior: contain;
  }
  .rail.open {
    transform: none; box-shadow: 18px 0 40px rgba(0,0,0,0.18);
    visibility: visible; pointer-events: auto; transition-delay: 0s;
  }
  .scrim { position: absolute; inset: 0; z-index: 39; border: 0; background: rgba(0,0,0,0.28); }
  .grabber { display: none; }

  .railtop { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 34px 0 12px; }
  .textsize { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 11px; color: var(--ink-faint); }
  .textsize span { letter-spacing: 0.08em; text-transform: uppercase; }
  .textsize button {
    min-width: 30px; height: 26px; padding: 0 7px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--bg);
    color: var(--ink-dim); font-size: 12px; cursor: pointer;
  }
  .textsize button:hover { color: var(--ink); border-color: var(--ink-faint); }
  .railname { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
  .add {
    width: 28px; height: 28px; flex: none; display: grid; place-items: center;
    border: 1px solid var(--line); border-radius: 999px; background: var(--bg);
    color: var(--ink-dim); font-size: 14px; cursor: pointer;
  }
  .add:hover { color: var(--ink); border-color: var(--ink-faint); }

  .tabs { display: flex; gap: 4px; margin-bottom: 10px; }
  .tabs button {
    font-size: 11.5px; padding: 5px 11px; border-radius: 999px; border: 1px solid transparent;
    background: none; color: var(--ink-faint); cursor: pointer;
  }
  .tabs button.on { background: var(--accent-soft); color: var(--ink); }
  .list, .notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  /* The swipe strip and the hover buttons sit over the row, so they need the list's own
     background to fade into. */
  .rail .list li { --swipe-bg: var(--bg-raised); }
  .trayrow { --swipe-bg: var(--bg-raised); }
  .shelf .list li { --swipe-bg: var(--bg); }
  .views { display: flex; gap: 4px; margin-bottom: 8px; }
  .views button {
    display: inline-flex; align-items: center; gap: 4px;
    border: 0; border-radius: 999px; padding: 4px 10px;
    background: none; color: var(--ink-dim); font: inherit; font-size: 12px; cursor: pointer;
    transition: background-color var(--tap) var(--ease), color var(--tap) var(--ease);
  }
  .views button:hover { color: var(--ink); }
  .views button.on { background: var(--accent-soft); color: var(--ink); }
  .starmark { color: var(--accent); margin-right: 5px; vertical-align: -1px; }
  .rowbtn {
    width: 26px; height: 26px;
    border: 0; border-radius: 6px; background: none;
    display: grid; place-items: center;
    color: var(--ink-faint); cursor: pointer;
  }
  .rowbtn:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 8%, transparent); }
  .row { display: block; width: 100%; text-align: left; padding: 9px 10px; border: 0; border-radius: 10px; background: none; color: var(--ink); cursor: pointer; }
  .row, .tabs button { transition: background-color var(--tap) var(--ease), color var(--tap) var(--ease); }
  .tabs button:hover { color: var(--ink); }
  .row:focus-visible, .tabs button:focus-visible, .result:focus-visible, .pagelink:focus-visible,
  .popover button:focus-visible, .note .quote:focus-visible, .peek .prow button:focus-visible,
  .scrim:focus-visible, .byline a:focus-visible, .content :global(a):focus-visible,
  .textsize button:focus-visible, .websearch:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 8px;
  }
  .row:hover { background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .row.current { background: var(--accent-soft); }
  .row .title { display: block; font-size: 13px; line-height: 1.35; }
  .row .meta { display: block; font-size: 11px; color: var(--ink-faint); margin-top: 3px; }
  .track { display: block; height: 2px; margin-top: 7px; background: var(--line-soft, var(--line)); border-radius: 2px; }
  .fill { display: block; height: 2px; background: var(--ink-faint); border-radius: 2px; }
  .empty { padding: 10px; font-size: 12px; color: var(--ink-faint); }

  .note { border-left: 2px solid var(--line); padding: 6px 9px; margin-bottom: 6px; border-radius: 0 8px 8px 0; }
  .note.yellow { border-left-color: #e3c34a; }
  .note.blue { border-left-color: #5b8dd6; }
  .note.rose { border-left-color: #d67ba8; }
  .note.green { border-left-color: #6fae74; }
  .note.editing { background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .note .quote { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 0; color: var(--ink); font-size: 12.5px; line-height: 1.45; cursor: pointer; }
  .note .from { display: block; font-size: 11px; color: var(--ink-faint); margin-top: 3px; }
  .note p.body { margin: 6px 0 0; font-size: 12.5px; color: var(--ink-dim); }
  .note textarea { width: 100%; margin-top: 6px; padding: 6px; font-family: var(--sans); font-size: 12.5px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); }
  .noteactions { display: flex; gap: 6px; margin-top: 6px; }
  .noteactions button { font-size: 11.5px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg-raised); color: var(--ink-dim); cursor: pointer; }
  .noteactions .danger { color: var(--warn); }
  .orphans { font-size: 11px; color: var(--ink-faint); padding: 8px; }
  .ingest { font-size: 11.5px; color: var(--ink-faint); padding: 4px 10px; }

  .pane { position: relative; height: 100%; overflow: hidden auto; }
  /* The library as a page, on the article's own measure: the field first, then the shelf. */
  .shelf { max-width: var(--measure); margin: 0 auto; padding: 120px 28px 150px; }
  .shelf h1 { margin: 0 0 16px; font-size: 11px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
  .shelfbox { margin-bottom: 20px; }
  /* Standing in the page rather than floating over it, the pill needs neither its own width nor
     the shadow that lifted it off the words. */
  .shelf .pill, .shelf .results { width: 100%; box-shadow: none; }
  .shelfempty { margin: 0; font-size: 13px; line-height: 1.55; color: var(--ink-faint); }

  .doc { max-width: var(--measure); margin: 0 auto; padding: 120px 28px 150px; }
  .doc h1 { font-size: calc(30px * var(--text-scale, 1)); line-height: 1.22; margin: 0 0 15px; font-family: var(--serif, Georgia, serif); font-weight: 400; }
  .doc h1.ghost { min-height: 36px; }
  .byline { font-size: 12px; color: var(--ink-faint); margin: 0 0 15px; }
  .byline a { color: inherit; text-decoration: none; border-bottom: 1px solid var(--line); }
  .byline a:hover { color: var(--ink-dim); }
  /* Thin, and with air under it: the text starts a line below the rule, not against it. */
  .rule { border: 0; height: 1px; background: var(--hair); transform: none; margin: 0 0 30px; }
  .chapter { font-size: calc(17px * var(--text-scale, 1)); color: var(--ink-dim); margin: 0 0 30px; font-weight: 400; }
  .content { font-family: var(--serif, Georgia, serif); font-size: calc(18.5px * var(--text-scale, 1)); line-height: 1.62; }
  .content :global(p) { margin: 0 0 30px; }
  .content :global(h2) { font-size: 22px; margin: 1.6em 0 0.5em; }
  .content :global(h3) { font-size: 18px; margin: 1.4em 0 0.4em; }
  .content :global(img) { max-width: 100%; height: auto; border-radius: 6px; }
  .content :global(figure) { margin: 1.4em 0; }
  .content :global(figcaption) { font-size: 13px; color: var(--ink-faint); font-family: var(--sans); }
  .content :global(blockquote) { margin: 1.2em 0; padding-left: 1em; border-left: 2px solid var(--line); color: var(--ink-dim); }
  .content :global(pre) { overflow: auto; padding: 12px; border-radius: 8px; background: var(--bg-raised); font-size: 13.5px; }
  .content :global(a) { color: inherit; text-decoration: underline; text-decoration-color: var(--ink-faint); text-underline-offset: 2px; }
  .content :global(table) { border-collapse: collapse; font-size: 15px; }
  .content :global(td), .content :global(th) { border: 1px solid var(--line); padding: 5px 8px; }
  .content :global(hr) { border: 0; height: 1px; background: var(--hair); transform: none; margin: 30px 0; }

  /* Supercuts: the author's words are the serif body; ours are never dressed as his.
     .frame labels a passage, .bridge carries the turns that were cut away. */
  .content :global(p.lede) { font-family: var(--sans); font-size: calc(15px * var(--text-scale, 1)); line-height: 1.5; color: var(--ink-dim); margin: 0 0 34px; }
  .content :global(p.frame) { font-family: var(--sans); font-size: calc(13px * var(--text-scale, 1)); letter-spacing: 0.02em; text-transform: none; color: var(--ink-faint); margin: 0 0 10px; }
  .content :global(p.frame em) { font-style: normal; }
  .content :global(p.bridge) {
    font-family: var(--sans); font-size: calc(15px * var(--text-scale, 1)); line-height: 1.55;
    color: var(--ink-dim); margin: 0 0 26px; padding-left: 12px;
    border-left: 2px solid color-mix(in srgb, var(--ink) 18%, transparent);
  }
  .content :global(section.cut) { margin: 0 0 8px; }
  .content :global(p.full) { font-family: var(--sans); font-size: calc(14px * var(--text-scale, 1)); color: var(--ink-dim); }

  /* While the words are on their way, the shape of the words. */
  .skeleton { display: flex; flex-direction: column; gap: 14px; padding-top: 4px; }
  .skeleton .line {
    display: block; height: 13px; border-radius: 4px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--ink) 7%, transparent), color-mix(in srgb, var(--ink) 12%, transparent), color-mix(in srgb, var(--ink) 7%, transparent));
    background-size: 240% 100%;
    animation: sweep 1.4s var(--ease) infinite;
  }
  @keyframes sweep { 0% { background-position: 140% 0; } 100% { background-position: -60% 0; } }

  .pager {
    display: flex; flex-direction: column; gap: 14px; align-items: flex-start;
    margin-top: 60px; padding-top: 30px; position: relative;
  }
  .pager::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: var(--hair);
  }
  .pagelink { display: grid; gap: 3px; text-decoration: none; color: var(--ink); max-width: 100%; }
  .pagelink .dir {
    font-family: var(--sans); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--ink-dim);
  }
  .pagelink .ptitle {
    font-size: 17px; line-height: 1.35; color: var(--ink);
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .pagelink:hover .ptitle { text-decoration: underline; text-underline-offset: 3px; }
  .pagelink.up .ptitle { font-size: 15px; color: var(--ink-dim); }
  .pager .up { font-size: 11px; }

  .popover {
    position: absolute; transform: translate(-50%, calc(-100% - var(--float-gap))); display: flex; gap: 4px; align-items: center;
    flex-wrap: nowrap; white-space: nowrap; max-width: calc(100vw - 16px);
    overflow-x: auto; scrollbar-width: none;
    padding: 5px; background: var(--bg-raised); border: 1px solid var(--line); border-radius: 999px;
    box-shadow: 0 10px 26px rgba(0,0,0,0.22); z-index: 20;
  }
  .popover.below { transform: translate(-50%, var(--float-gap)); }
  /* Docked: a bar at the bottom of the phone, a thumb's distance from the words and nowhere near
     iOS's own callout, standing off the home indicator by the same floor everything else uses. */
  .popover.docked {
    position: fixed; left: 50%; right: auto; top: auto;
    bottom: calc(10px + var(--dodge-bottom));
    transform: translateX(-50%);
    max-width: calc(100vw - 16px); z-index: 44;
  }
  .popover button { font-size: 12px; padding: 4px 9px; border-radius: 999px; border: 0; background: none; color: var(--ink-dim); cursor: pointer; }
  .popover button:hover { background: var(--accent-soft); color: var(--ink); }
  .popover::-webkit-scrollbar { display: none; }
  .popover button { flex: none; }
  .swatch { width: 16px; height: 16px; border-radius: 50%; padding: 0; }
  .swatch.yellow { background: #f1dd8a; }
  .swatch.blue { background: #a8c6ef; }
  .swatch.rose { background: #eeb6cf; }
  .swatch.green { background: #a9d5ad; }

  /* The pill, grown into a box in the same place, at a size nobody has to zoom to read. */
  .peek {
    position: absolute; z-index: 26; transform: translate(-50%, calc(-100% - var(--float-gap)));
    max-width: min(320px, calc(100vw - 24px));
    display: flex; flex-direction: column; gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--line); border-radius: 12px;
    background: var(--bg-raised);
    box-shadow: 0 14px 34px rgba(0,0,0,0.22);
  }
  .peek.below { transform: translate(-50%, var(--float-gap)); }
  .peek .ptext { margin: 0; font-size: 14px; line-height: 1.45; color: var(--ink); white-space: pre-wrap; }
  .peek .ptext.dim { color: var(--ink-faint); }
  /* A thread, not a tooltip: who said it and when, then the words, then the box to answer in. */
  .peek .pthread { display: flex; flex-direction: column; gap: 10px; max-height: 40vh; overflow-y: auto; }
  .peek .pentry { display: flex; flex-direction: column; gap: 3px; }
  .peek .pmeta { display: flex; gap: 8px; align-items: baseline; font-size: 11.5px; color: var(--ink-faint); }
  .peek .pwho { font-weight: 500; color: var(--ink-dim); }
  .peek .pentry.bytophat { border-left: 2px solid color-mix(in srgb, var(--accent) 60%, var(--line)); padding-left: 8px; margin-left: -2px; }
  .peek .pentry.bytophat .pwho { color: var(--accent); }
  .notes .byline-tophat {
    align-self: flex-start; font-size: 10.5px; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: 999px; padding: 1px 6px;
  }
  .peek .preply { display: flex; gap: 6px; align-items: flex-end; }
  .peek .preply textarea {
    flex: 1; min-width: 0; resize: none; overflow-y: auto;
    font-family: var(--sans); font-size: 14px; line-height: 1.4;
    padding: 7px 10px; border: 1px solid var(--line); border-radius: 12px;
    background: var(--bg); color: var(--ink);
  }
  .peek .preply textarea:focus { outline: none; border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
  .peek .preply .primary {
    flex: none; border: 0; border-radius: 999px; cursor: pointer;
    padding: 7px 14px; font-size: 12.5px; background: var(--accent-soft); color: var(--ink);
  }
  .peek .preply .primary:disabled { opacity: 0.45; cursor: default; }
  .peek .prow { display: flex; gap: 4px; }
  .peek .prow button {
    border: 0; background: none; cursor: pointer; border-radius: 8px;
    padding: 4px 8px; font-size: 12.5px; color: var(--ink-dim);
  }
  .peek .prow button:hover { background: color-mix(in srgb, var(--ink) 8%, transparent); color: var(--ink); }
  .peek .prow .danger:hover { color: var(--warn); }

  .quicknote {
    position: absolute; transform: translate(-50%, calc(-100% - var(--float-gap))); z-index: 22;
    width: min(30rem, calc(100vw - 24px));
    padding: 8px 10px 6px;
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 14px 34px rgba(0,0,0,0.24);
  }
  .quicknote.below { transform: translate(-50%, var(--float-gap)); }
  .quicknote textarea {
    display: block; width: 100%; resize: none; overflow: auto;
    border: 0; background: none; color: var(--ink);
    font-family: var(--sans); font-size: 16px; line-height: 1.45;
    outline: none; padding: 2px 2px 4px;
  }
  .quicknote textarea::placeholder { color: var(--ink-faint); }
  .qhint { display: flex; gap: 10px; align-items: center; font-size: 10.5px; color: var(--ink-faint); }
  .qgo {
    font-size: 12.5px; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line);
    background: var(--bg); color: var(--ink-dim); cursor: pointer;
  }
  .qgo.primary { background: var(--accent-soft); color: var(--ink); border-color: transparent; }
  .qhint .spacer { flex: 1; }
  .qmic {
    width: 26px; height: 26px; display: grid; place-items: center; padding: 0;
    border: 1px solid var(--line); border-radius: 999px; background: none; color: var(--ink-dim);
    cursor: pointer;
  }
  .qmic.on { background: var(--warn); color: var(--bg); border-color: transparent; }
  .qpartial { margin: 2px 2px 6px; font-size: 13px; color: var(--ink-faint); }

  .capture {
    position: sticky; bottom: calc(14px + var(--dodge-bottom)); margin: 0 auto; width: min(38rem, 92%);
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 16px;
    padding: 12px 14px; box-shadow: 0 16px 40px rgba(0,0,0,0.24); z-index: 25;
  }
  .cquote { margin: 0 0 8px; font-size: 12.5px; color: var(--ink-faint); border-left: 2px solid #e3c34a; padding-left: 8px; }
  .cheard { min-height: 28px; font-size: 14.5px; line-height: 1.45; color: var(--ink); }
  .cheard .hint { color: var(--ink-faint); font-size: 12.5px; }
  .capture textarea { width: 100%; margin-top: 8px; padding: 7px 10px; font-family: var(--sans); font-size: 13px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--ink); }
  .cerror { margin: 6px 0 0; font-size: 12px; color: var(--warn); }
  .csent { font-size: 13px; color: var(--ink-dim); }
  .cactions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .cactions button { font-size: 12.5px; padding: 5px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg); color: var(--ink-dim); cursor: pointer; }
  .cactions .primary { background: var(--accent-soft); color: var(--ink); border-color: transparent; }
  .cactions .mic { width: 30px; padding: 0; height: 28px; }
  .cactions .mic.on { background: var(--warn); color: var(--bg); border-color: transparent; }
  .cactions .auto { margin-left: auto; font-size: 11.5px; color: var(--ink-faint); display: flex; align-items: center; gap: 4px; }
  .mic-host { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

  @media (max-width: 860px) {
    /* On a phone the pill comes up over the keyboard, and the drawer is a sheet from the bottom. */
    .pastelayer { padding-top: 0; justify-content: flex-end; padding-bottom: calc(12px + var(--dodge-bottom)); }
    .pill { width: calc(100vw - 20px); }
    .pill input[type="search"] { font-size: 16px; padding: 11px 12px; }  /* 16px or iOS zooms on focus */
    .results { max-height: 46vh; order: -1; margin: 0 0 8px; }
    .glyph, .edge, .add { width: 44px; height: 44px; font-size: 15px; }
    .navspot { top: max(10px, env(safe-area-inset-top)); left: 12px; }
    .reader.drawer .navspot { transform: none; }   /* the sheet comes up from the bottom */
    .hud { top: max(10px, env(safe-area-inset-top)); right: 8px; }
    /* The chrome row is 44px tall here, so the band under it starts 54px below its own top. */
    .error { top: calc(max(10px, env(safe-area-inset-top)) + 54px); max-width: calc(100vw - 24px); }
    .doc { padding: 108px 20px 120px; }
    .shelf { padding: 108px 20px 120px; }
    .doc h1 { font-size: 26px; }

    .rail {
      top: auto; left: 0; right: 0; width: auto;
      max-height: 76dvh;
      border-right: 0; border-top: 1px solid var(--line);
      border-radius: 18px 18px 0 0;
      box-shadow: none;
      padding: 6px 14px calc(18px + var(--dodge-bottom));
      transform: translateY(101%);
    }
    .rail.open { transform: none; box-shadow: 0 -12px 40px rgba(0,0,0,0.28); }
    .grabber { display: block; width: 38px; height: 4px; border-radius: 999px; background: var(--line); margin: 6px auto 10px; }
    .tabs button { font-size: 13px; padding: 11px 16px; }
    .row { padding: 12px 10px; }
    .row .title { font-size: 15px; }
    .popover button { font-size: 13.5px; padding: 7px 10px; }
    .popover .wide { display: none; }      /* Copy and Search are a keyboard's job, not a thumb's */
    .qmic { width: 44px; height: 44px; }   /* dictation is the main way a note gets typed on a phone */
    .qhint { gap: 12px; font-size: 11.5px; }
    .pagelink { padding: 6px 0; }        /* a thumb-sized target without a box around it */
  }

  @media (prefers-reduced-motion: reduce) {
    .rail { transition: none; }
    .tick.on, .skeleton .line { animation: none; }
  }
  /* The ::highlight rules moved to app.css: the chat transcript paints with the same names,
     and a page-scoped block only ships with its own route. */
  /* Selecting text is the reader's own colour, not the browser's blue. */
  :global(::selection) { background: color-mix(in srgb, var(--ink) 16%, transparent); color: var(--ink); }
</style>
