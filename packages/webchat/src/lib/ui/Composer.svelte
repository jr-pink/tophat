<script>
  import { tick } from 'svelte';
  import { filesFromPaste, pendingAttachment, readDraft, reportUploadFailure, reservePaths, stillTransferring, uploadFile, uploadPercent, withAttachments, writeDraft } from '$lib/core/attachments.js';
  import { activeUploads, uploadJournal } from '$lib/client/upload-journal.js';
  import { committedDraft, narrowWrite, nextCaret, nextDraftRuns, runIntact } from '$lib/services/voice/core/dictation.js';
  import { PAD_SEC } from '$lib/services/voice/core/alternatives.js';
  import { fitReplacement, phraseForRange, wordRangeAt } from '$lib/services/voice/core/tapword.js';
  import { readSpans, writeSpans } from '$lib/services/voice/client/dictated-spans.js';
  import { isMod } from '$lib/core/keys.js';
  import { waited } from '$lib/core/waiting.js';
  import { isIncognito } from '$lib/core/incognito.js';

  let {
    onsend = () => {},
    onsubmit = () => {},
    onforksend = null,
    onnewchat = null,
    onstage = null,
    onuploadfail = null,
    onuploadprogress = null,
    waiting = [],
    oninterrupt = () => {},
    running = false,
    queued = 0,
    online = true,
    placeholder = 'Message…',
    autofocus = false,
    pending = false,
    note = null,
    noteAt = null,
    draftKey = null,
    ondraft = null,
    dropZone = null,
    ondragfiles = null,
    dictate = null,
    provenance = null
  } = $props();

  // The draft is kit state, read synchronously, so the first render already shows it (the restore effect below then
  // only adds the dictated spans for this key).
  let text = $state(readDraft(draftKey));
  let field = $state(null);
  let attachments = $state([]);
  let filePicker = $state(null);
  let deferred = $state(null);
  let dragging = $state(false);
  let composerEl = $state(null);

  let runs = $state([]);
  // The dictations sitting in this draft, each with the clip it came from and
  // the seconds of audio behind every word: what a tap on one of those words
  // needs in order to ask what else it could have been. Kept beside the draft
  // so it survives a reload, and dropped when the draft is sent.
  let dictated = [];
  let alternatives = $state(null);
  let altSeq = 0;
  let pressTimer = null;
  const LONG_PRESS_MS = 500;
  const sentTokens = new Set();
  let pendingSpace = null;
  let lastCaret = null;
  let ghost = $state(null);

  let clockMs = $state(Date.now());
  $effect(() => {
    if (!noteAt) return;
    clockMs = Date.now();
    const timer = setInterval(() => { clockMs = Date.now(); }, 1_000);
    return () => clearInterval(timer);
  });
  const waitLabel = $derived(noteAt ? waited(noteAt, clockMs) : '');

  const uploading = $derived(attachments.some((a) => !a.sent && stillTransferring(a)));

  let reserving = $state(0);

  const waitingLabel = $derived((() => {
    if (!waiting.length) return '';
    const say = (file) => (file.failed
      ? `${file.name} did not upload${file.error ? `: ${file.error}` : ''}`
      : `${file.name}${file.percent === null || file.percent === undefined ? '' : ` ${file.percent}%`}`);
    const head = say(waiting[0]);
    const rest = waiting.length - 1;
    return `waiting on ${head}${rest > 0 ? ` and ${rest} more` : ''}`;
  })());

  const UPLOAD_SLOTS = 2;
  let inFlightUploads = 0;
  const pendingUploads = [];

  function queueUpload(job) {
    pendingUploads.push(job);
    pumpUploads();
  }

  function pumpUploads() {
    while (inFlightUploads < UPLOAD_SLOTS && pendingUploads.length) {
      const job = pendingUploads.shift();
      inFlightUploads += 1;
      job().finally(() => {
        inFlightUploads -= 1;
        pumpUploads();
      });
    }
  }

  function patchAttachment(key, patch) {
    attachments = attachments.map((a) => (a.key === key ? { ...a, ...patch } : a));
  }

  async function take(files) {
    const list = [...files];
    if (!list.length) return;
    const entries = list.map((file) => pendingAttachment(file));
    // An incognito chat takes no files: an upload is a file kept on the server and in this device's upload journal.
    if (isIncognito(draftKey)) {
      const reason = 'attachments are off in incognito chats: the file would be saved';
      attachments = [...attachments, ...entries.map((entry) => ({ ...entry, state: 'failed', error: reason }))];
      return;
    }
    attachments = [...attachments, ...entries];

    let reserved = [];
    reserving += 1;
    try {
      reserved = await reservePaths(list.map((file) => file.name || 'pasted'));
    } catch {
      reserved = [];
    } finally {
      reserving -= 1;
    }
    for (const [index, file] of list.entries()) {
      const entry = entries[index];
      const path = reserved[index]?.path || null;
      if (path) {
        patchAttachment(entry.key, { path });
        uploadJournal().start({
          path, key: entry.key, name: entry.name, size: entry.size,
          lastModified: file.lastModified || null, type: file.type || '', owner: draftKey
        }, file);
      }
      queueUpload(() => runUpload(entry, file, path));
    }
  }

  // One attachment's upload, start to finish: chunked and resumable (core/attachments.js), its
  // progress on the chip, and any failure said three ways: red on the chip with the reason, to the
  // chat's delivery state so the model is told "failed: <reason>" rather than "still uploading",
  // and to the server, which leaves `<path>.failed` and steers a running turn.
  function runUpload(entry, file, path, { resumed = false } = {}) {
    const report = (patch) => {
      patchAttachment(entry.key, patch);
      onuploadprogress?.(entry.key, { name: entry.name, size: entry.size, ...patch });
    };
    if (path) activeUploads.add(path);
    report({ state: 'uploading', loaded: 0, total: entry.size || 0, retrying: null });
    return uploadFile(file, {
      path,
      journal: uploadJournal(),
      onprogress: ({ loaded, total }) => report({ state: 'uploading', loaded, total }),
      onstatus: ({ retrying, reason }) => report({ retrying: `retry ${retrying}: ${reason}` })
    })
      .then((saved) => {
        report({ state: 'ready', path: saved.path, loaded: saved.size, total: saved.size, retrying: null });
        onstage?.(entry.key);
        // A resumed upload whose message already went has nothing left to attach: it finished
        // the file the model was pointed at, so its chip goes once it says so.
        if (resumed) setTimeout(() => discard(entry.key), 4000);
      })
      .catch((cause) => {
        const reason = cause?.message || String(cause);
        if (!attachments.some((a) => a.key === entry.key)) {
          attachments = [...attachments, { ...entry, path, state: 'failed', error: reason }];
        }
        report({ state: 'failed', error: reason, retrying: null });
        onuploadfail?.(entry.key, { name: entry.name, error: reason });
        uploadJournal().done(path);
        reportUploadFailure({ path, name: entry.name, reason, conversationId: draftKey });
      })
      .finally(() => { if (path) activeUploads.delete(path); });
  }

  // Uploads a reload interrupted, for this chat: picked up from the journal and continued from the
  // last chunk the server holds. One whose File could not be kept says so instead of vanishing.
  let resumedFor = null;
  $effect(() => {
    const owner = draftKey;
    if (owner == null || resumedFor === owner) return;
    resumedFor = owner;
    uploadJournal().list(owner).then(async (records) => {
      for (const record of records) {
        if (!record?.path || activeUploads.has(record.path)) continue;
        const file = record.stored ? await uploadJournal().file(record.path) : null;
        const entry = { ...pendingAttachment({ name: record.name, size: record.size }), key: record.key || record.path, path: record.path, resumed: true, sent: !!record.sent };
        attachments = [...attachments, entry];
        if (!file) {
          const reason = 'the page reloaded before it finished uploading, and the file was too large to keep for resuming; attach it again';
          patchAttachment(entry.key, { state: 'failed', error: reason });
          onuploadfail?.(entry.key, { name: entry.name, error: reason });
          uploadJournal().done(record.path);
          if (record.sent) reportUploadFailure({ path: record.path, name: record.name, reason, conversationId: owner });
          continue;
        }
        const named = file instanceof File ? file : new File([file], record.name, { type: record.type || '' });
        queueUpload(() => runUpload(entry, named, record.path, { resumed: !!record.sent }));
      }
    });
  });

  function drop(event) {
    event.preventDefault();
    setDragging(false);
    depth = 0;
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    take(files);
    field?.focus();
  }

  let depth = 0;
  function carriesFiles(event) {
    const types = event.dataTransfer?.types;
    return types ? Array.from(types).includes('Files') : false;
  }
  function setDragging(on) {
    if (dragging === on) return;
    dragging = on;
    ondragfiles?.(on);
  }
  $effect(() => {
    const zone = dropZone || composerEl;
    if (!zone) return;
    depth = 0;
    const enter = (event) => { if (!carriesFiles(event)) return; depth += 1; setDragging(true); };
    const over = (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    };
    const leave = (event) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    zone.addEventListener('dragenter', enter);
    zone.addEventListener('dragover', over);
    zone.addEventListener('dragleave', leave);
    zone.addEventListener('drop', drop);
    return () => {
      zone.removeEventListener('dragenter', enter);
      zone.removeEventListener('dragover', over);
      zone.removeEventListener('dragleave', leave);
      zone.removeEventListener('drop', drop);
      setDragging(false);
    };
  });

  function paste(event) {
    const files = filesFromPaste(event);
    if (!files.length) return;
    event.preventDefault();
    take(files);
  }

  function pickFiles(event) {
    const files = [...(event.currentTarget.files || [])];
    // Reset immediately so choosing the same document after removing it works.
    event.currentTarget.value = '';
    take(files);
  }

  function discard(key) {
    attachments = attachments.filter((a) => a.key !== key);
  }

  let restoredFor = $state(null);
  $effect(() => {
    if (draftKey === restoredFor) return;
    restoredFor = draftKey;
    text = readDraft(draftKey);
    dictated = readSpans(draftKey);
    alternatives = null;
    tick().then(resize);
  });

  $effect(() => { if (draftKey === restoredFor) writeDraft(draftKey, committedDraft(text, runs)); });

  $effect(() => {
    text;
    attachments.length;
    if (field) tick().then(resize);
  });

  const COMPOSER_MAX_PX = 200; // the textarea's max-height below

  function resize() {
    if (!field) return;
    // The box is border-box and scrollHeight leaves the border out, so the height has to add it back (two pixels short made the
    // draft scroll by two pixels and show a bar on one line). The bar is for a draft past the max height only.
    field.style.overflowY = 'hidden';
    field.style.height = 'auto';
    const want = field.scrollHeight + (field.offsetHeight - field.clientHeight);
    field.style.height = `${Math.min(want, COMPOSER_MAX_PX)}px`;
    field.style.overflowY = want > COMPOSER_MAX_PX ? 'auto' : 'hidden';
  }


  
  function liveValue() {
    return field ? field.value : text;
  }

  






  // The last dictation this composer committed, so its tail can still land.
  let lastCommit = null;

  function caretNow({ raw = false, retained = false } = {}) {
    if (!field) return { start: text.length, end: text.length };
    const focused = typeof document !== 'undefined' && document.activeElement === field;
    if (focused) {
      const start = field.selectionStart ?? field.value.length;
      return { start, end: field.selectionEnd ?? start };
    }
    if (raw) return { start: null, end: null };
    if (retained && lastCaret) return lastCaret;
    return { start: field.value.length, end: field.value.length };
  }

  








  // WRITING WITHOUT TAKING THE BOX AWAY FROM HIM.
  //
  // Only the characters that differ are written, and the box is asked to keep the
  // selection ('preserve'), so a caret or a highlight anywhere outside those
  // characters survives the write untouched. The caret is moved by hand only when
  // the model says it should follow the words: he was sitting at the end of them,
  // or he is not in the box at all.
  function dictateWrite(write) {
    if (!write) return false;
    const { start, removeLen, text: run } = write.edit || write.range;
    if (!removeLen && !run) return false;
    if (field) {
      const held = heldSelection();
      field.setRangeText(run, start, start + removeLen, 'preserve');
      if (Number.isFinite(write.caret) && (!held || held.start === held.end)) {
        try { field.setSelectionRange(write.caret, write.caret); } catch {  }
      }
      text = field.value;
    } else {
      text = write.value;
    }
    return true;
  }

  // The selection as it stands, when the box is his: a highlight he is holding
  // is never collapsed by a write that lands somewhere else.
  function heldSelection() {
    if (!field) return null;
    if (typeof document !== 'undefined' && document.activeElement !== field) return null;
    const start = field.selectionStart;
    if (!Number.isFinite(start)) return null;
    return { start, end: Number.isFinite(field.selectionEnd) ? field.selectionEnd : start };
  }

  function runStep(input) {
    const at = caretNow({ raw: true });
    const result = nextDraftRuns(runs, { ...input, value: liveValue(), caretStart: at.start, caretEnd: at.end });
    runs = result.runs;
    dictateWrite(result.write);
    tick().then(measureGhost);
    return result;
  }

  








  function measureGhost() {
    if (!field) { ghost = null; return; }
    const value = field.value;
    const live = runs
      .filter((run) => run.mode === 'live' && run.owned && runIntact(value, run))
      .sort((a, b) => a.start - b.start);
    if (!live.length) { ghost = null; return; }
    const parts = [];
    let cut = 0;
    for (const run of live) {
      if (run.start > cut) parts.push({ text: value.slice(cut, run.start), run: false });
      parts.push({ text: value.slice(run.start, run.start + run.owned.length), run: true });
      cut = run.start + run.owned.length;
    }
    if (cut < value.length) parts.push({ text: value.slice(cut), run: false });
    ghost = {
      left: field.offsetLeft,
      top: field.offsetTop,
      width: field.offsetWidth,
      height: field.offsetHeight,
      scroll: field.scrollTop,
      parts
    };
  }


  export function measure(type, detail = {}) {
    try { field?.dispatchEvent(new CustomEvent('tophat-measure', { bubbles: true, detail: { type, ...detail, ...(['send', 'dictation_partial', 'dictation_commit', 'dictation_cancel'].includes(type) ? { valueAfter: text } : {}) } })); } catch {  }
  }

  








  export function dictateBegin(token, { atCaret = true } = {}) {
    measure('dictation_begin', { token });
    const at = pendingSpace || caretNow({ retained: atCaret });
    runStep({ type: 'begin', token, start: at.start, end: at.end });
  }

  
  export function dictatePartial(token, words) {
    runStep({ type: 'partial', token, text: words });
    measure('dictation_partial', { token, text: words });
  }

  






  export function dictateCommit(token, words, { focus = true } = {}) {
    const at = caretNow();
    const result = runStep({
      type: 'commit', token, text: words, start: at.start, end: at.end, dropped: sentTokens.has(token)
    });
    lastCommit = result.write ? { token, text: result.write.range.text, start: result.write.range.start } : null;
    // The same anchor, kept for the tap-a-word popup: its word times arrive a
    // moment later, once the clip is on disk.
    if (lastCommit) rememberDictation({ token, text: lastCommit.text, start: lastCommit.start });
    // The commit now lands in the same breath as the click that ended the
    // recording, so the button is still taking focus when the words arrive.
    // Put the caret back after the browser has settled, or he types his next
    // sentence at position zero.
    if (result.write && focus) {
      const caret = Number.isFinite(result.write.caret) ? result.write.caret : null;
      const place = () => {
        if (!field) return;
        field.focus({ preventScroll: true });
        if (caret === null) return;
        const at = Math.min(caret, field.value.length);
        try { field.setSelectionRange(at, at); } catch {  }
      };
      place();
      tick().then(place);
    }
    measure('dictation_commit', { token, text: words, applied: Boolean(result.write) });
    return Boolean(result.write);
  }


  // The tail of a dictation, arriving after its commit. It replaces exactly the
  // text that commit wrote and nothing else: if he has already edited or sent
  // those words, his version stands and this does nothing.
  export function dictateExtend(token, words) {
    const next = String(words ?? '');
    if (!lastCommit || lastCommit.token !== token || !next || next === lastCommit.text) return false;
    const previous = lastCommit.text;
    const value = field ? field.value : text;
    const from = value.indexOf(previous, Math.max(0, lastCommit.start - 40));
    if (from < 0 || !previous) return false;
    const end = from + previous.length;
    const at = caretNow({ raw: true });
    if (field) {
      // The same delta write as a partial: the tail replaces only the words it
      // actually changes, so an edit he is making earlier in the draft keeps
      // both his caret and his selection.
      const edit = narrowWrite(value, { start: from, removeLen: end - from, text: next });
      const caret = at.start === null
        ? from + next.length
        : nextCaret({ caretStart: at.start, caretEnd: at.end }, {
          start: edit.start,
          oldEnd: edit.start + edit.removeLen,
          newEnd: edit.start + edit.text.length
        });
      const held = heldSelection();
      field.setRangeText(edit.text, edit.start, edit.start + edit.removeLen, 'preserve');
      if (Number.isFinite(caret) && (!held || held.start === held.end)) {
        try { field.setSelectionRange(caret, caret); } catch {  }
      }
      text = field.value;
    } else {
      text = `${value.slice(0, from)}${next}${value.slice(end)}`;
    }
    lastCommit = { token, text: next, start: from };
    rememberDictation({ token, text: next, start: from });
    // Any run still live sits somewhere in a draft that just changed length;
    // this is the same relocation typing triggers.
    if (runs.length) runStep({ type: 'typed' });
    tick().then(measureGhost);
    measure('dictation_extend', { token, text: next });
    return true;
  }

  







  // WHAT ELSE THAT WORD COULD HAVE BEEN.
  //
  // The draft is a textarea, so there is no per-word element to hang a popup
  // on and no way to know which word a tap landed on except by asking the
  // field where its caret ended up. That is enough: the caret names a word,
  // the dictation that wrote that word knows which clip it came from and
  // which seconds of it every word took, and the server decodes those seconds
  // again. On a desktop the popup is Alt+A, or Alt+click on the word; on a
  // touch screen it is a long press.
  //
  // Nothing here writes to the draft until he picks a reading, and picking one
  // writes only if the text it was offered for is still exactly where it was.

  function rememberDictation(patch) {
    if (!patch?.token) return;
    const previous = dictated.find((entry) => entry.token === patch.token) || {};
    dictated = [...dictated.filter((entry) => entry.token !== patch.token), { ...previous, ...patch }].slice(-6);
    writeSpans(draftKey, dictated);
  }

  








  export function dictateWords(token, info) {
    const words = Array.isArray(info?.words) ? info.words : [];
    const clipId = typeof info?.clipId === 'string' ? info.clipId : null;
    if (!token || !clipId || !words.length) return false;
    if (!dictated.some((entry) => entry.token === token)) return false;
    rememberDictation({ token, clipId, words });
    return true;
  }

  // Where a remembered dictation sits in the draft now. He may have typed in
  // front of it, so it is looked for rather than assumed; if the text it
  // wrote is not there any more it is not offered alternatives at all.
  function anchoredAt(entry, value) {
    if (!entry?.text) return null;
    if (value.slice(entry.start, entry.start + entry.text.length) === entry.text) return entry.start;
    const near = value.indexOf(entry.text, Math.max(0, entry.start - 60));
    if (near >= 0) return near;
    const anywhere = value.indexOf(entry.text);
    return anywhere >= 0 ? anywhere : null;
  }

  function dictationAround(value, from, to) {
    for (const entry of [...dictated].reverse()) {
      if (!entry.clipId || !entry.words?.length) continue;
      const at = anchoredAt(entry, value);
      if (at === null) continue;
      if (from >= at && to <= at + entry.text.length) return { ...entry, start: at };
    }
    return null;
  }

  export function dictationUnderCaret() {
    if (!field) return null;
    return dictationAround(field.value, field.selectionStart ?? 0, field.selectionEnd ?? 0);
  }

  function popupAnchor(point) {
    const box = field?.getBoundingClientRect?.();
    const x = Number.isFinite(point?.x) ? point.x : (box ? box.left + 48 : 120);
    const y = Number.isFinite(point?.y) ? point.y : (box ? box.top + 4 : 200);
    const width = typeof window === 'undefined' ? 800 : window.innerWidth;
    return { x: Math.max(120, Math.min(width - 24, x)), y: Math.max(140, y) };
  }

  export async function openAlternatives(point = null) {
    if (!field) return false;
    const value = field.value;
    const caret = { start: field.selectionStart ?? 0, end: field.selectionEnd ?? 0 };
    const entry = dictationAround(value, caret.start, caret.end);
    const at = popupAnchor(point);
    if (!entry) {
      alternatives = { id: ++altSeq, at, loading: false, items: [], note: 'that text was not dictated here', range: null };
      return false;
    }
    const word = wordRangeAt(entry.text, caret.start - entry.start, caret.end - entry.start);
    const phrase = word && phraseForRange({
      text: entry.text, start: word.start, end: word.end, words: entry.words, padSec: PAD_SEC
    });
    if (!phrase) {
      alternatives = { id: ++altSeq, at, loading: false, items: [], note: 'there are no times for that word', range: null };
      return false;
    }
    const range = {
      start: entry.start + phrase.charStart,
      end: entry.start + phrase.charEnd,
      text: phrase.phrase
    };
    const id = ++altSeq;
    alternatives = { id, at, loading: true, items: [], note: null, range, token: entry.token, clipId: entry.clipId };
    measure('dictation_alternatives_open', {
      token: entry.token, clipId: entry.clipId, text: phrase.phrase, startSec: phrase.startSec, endSec: phrase.endSec
    });
    const asked = Date.now();
    try {
      const response = await fetch('/api/voice/alternatives', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clip_id: entry.clipId, start: phrase.startSec, end: phrase.endSec, text: phrase.phrase
        }),
        signal: AbortSignal.timeout(20_000)
      });
      const body = await response.json().catch(() => null);
      // A reading that arrives after he has moved on is not allowed to open a
      // popup over what he is doing now.
      if (alternatives?.id !== id) return false;
      if (!response.ok) {
        alternatives = { ...alternatives, loading: false, note: body?.error || 'that could not be decoded again' };
        return false;
      }
      const items = (Array.isArray(body?.alternatives) ? body.alternatives : []).slice(0, 6);
      alternatives = {
        ...alternatives,
        loading: false,
        items,
        note: items.length ? null : (body?.note || 'nothing else was heard there')
      };
      measure('dictation_alternatives', {
        token: entry.token, clipId: entry.clipId, count: items.length,
        latencyMs: Date.now() - asked, serverMs: body?.latency_ms ?? null
      });
      return true;
    } catch (cause) {
      if (alternatives?.id === id) {
        alternatives = { ...alternatives, loading: false, note: 'that could not be decoded again' };
      }
      return false;
    }
  }

  export function closeAlternatives() {
    alternatives = null;
  }

  







  export function chooseAlternative(item) {
    const open = alternatives;
    alternatives = null;
    if (!open?.range || !field || !item) return false;
    const before = field.value;
    let start = open.range.start;
    if (before.slice(start, start + open.range.text.length) !== open.range.text) {
      const near = before.indexOf(open.range.text, Math.max(0, start - 60));
      if (near < 0) {
        measure('dictation_alternative_stale', { token: open.token, text: item.text });
        return false;
      }
      start = near;
    }
    const end = start + open.range.text.length;
    const replacement = fitReplacement(open.range.text, item.text);
    if (!replacement) return false;
    field.setRangeText(replacement, start, end, 'end');
    text = field.value;
    const caret = start + replacement.length;
    try { field.setSelectionRange(caret, caret); } catch {  }
    // The dictation that wrote those words now reads differently, so its
    // anchor is rewritten with it; its word times still hold, because the
    // audio did not change.
    const entry = dictated.find((one) => one.token === open.token);
    if (entry) {
      const anchor = anchoredAt(entry, before);
      if (anchor !== null && start >= anchor && end <= anchor + entry.text.length) {
        rememberDictation({
          token: entry.token,
          start: anchor,
          text: `${entry.text.slice(0, start - anchor)}${replacement}${entry.text.slice(end - anchor)}`
        });
      }
    }
    // Any run still live sits in a draft that just changed length, which is
    // the same relocation typing triggers.
    if (runs.length) runStep({ type: 'typed' });
    tick().then(measureGhost);
    measure('dictation_alternative', { token: open.token, from: open.range.text, to: replacement });
    field.focus({ preventScroll: true });
    return true;
  }

  function cancelPress() {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  }

  function touchStart(event) {
    cancelPress();
    const touch = event.touches?.length === 1 ? event.touches[0] : null;
    if (!touch) return;
    const at = { x: touch.clientX, y: touch.clientY };
    pressTimer = setTimeout(() => {
      pressTimer = null;
      openAlternatives(at);
    }, LONG_PRESS_MS);
  }

  function fieldClick(event) {
    if (alternatives) alternatives = null;
    if (!event.altKey) return;
    event.preventDefault();
    openAlternatives({ x: event.clientX, y: event.clientY });
  }

  export function dictateCancel(token) {
    runStep({ type: 'cancel', token });
    measure('dictation_cancel', { token });
  }

  
  export function dictateAnchored() { return runs.length > 0; }


  
  export function holdSpace() {
    const at = caretNow();
    pendingSpace = { start: at.start, end: at.end };
    return true;
  }

  export function spacePending() { return Boolean(pendingSpace); }

  






  export function flushSpace() {
    const at = pendingSpace;
    pendingSpace = null;
    if (!at || !field) return false;
    const start = Math.max(0, Math.min(field.value.length, at.start));
    const end = Math.max(start, Math.min(field.value.length, at.end));
    field.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertText', data: ' ', bubbles: true, composed: true, cancelable: true
    }));
    field.setRangeText(' ', start, end, 'end');
    text = field.value;
    field.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText', data: ' ', bubbles: true, composed: true
    }));
    return true;
  }

  
  export function dropSpace() { pendingSpace = null; }

  function submit({ fork = false, split = false } = {}) {
    const value = text.trim();
    const outgoing = attachments.filter((a) => a.state !== 'failed' && !a.sent);
    if (!value && !outgoing.length) return;
    onsubmit();
    if (reserving && outgoing.some((a) => !a.path)) {
      deferred = { fork, split, value, outgoing, reason: 'reserve' };
      return;
    }
    if (!onstage && uploading) {
      deferred = { fork, split, value, outgoing };
      return;
    }
    dispatchSend(fork, value, outgoing, split);
  }

  function dispatchSend(fork, value, outgoing, split = false) {
    for (const run of runs) sentTokens.add(run.token);
    runs = [];
    ghost = null;
    alternatives = null;
    text = '';
    dictated = [];
    writeSpans(draftKey, []);
    writeDraft(draftKey, '');
    uploadJournal().markSent(outgoing.map((a) => a.path));
    // What is still uploading keeps its chip-less upload going; only resumed uploads of an already
    // sent message stay on screen, since they belong to no draft.
    attachments = attachments.filter((a) => a.sent && !outgoing.includes(a));
    const send = fork && onforksend ? (text, files) => onforksend(text, files, { split }) : onsend;
    measure('send', { text: value });
    try { provenance?.noteSent?.(value); } catch {  }
    send(withAttachments(value, outgoing), outgoing);
  }

  $effect(() => {
    if (!deferred) return;
    if (deferred.reason === 'reserve' ? reserving : uploading) return;
    const pending = deferred;
    deferred = null;
    dispatchSend(pending.fork, pending.value, attachments.filter((a) => a.state !== 'failed' && !a.sent), pending.split);
  });

  



  // The first typed character in a chat, once per chat. The transient chat the app opens into
  // has no sidebar row until it is committed, and typing is what commits it; focusing it is
  // not.
  let draftedFor = null;
  function noteDraft() {
    if (!ondraft || draftKey == null || draftedFor === draftKey) return;
    const value = field?.value ?? text;
    if (!String(value ?? '').trim()) return;
    draftedFor = draftKey;
    ondraft(value);
  }

  function input() {
    noteDraft();
    if (runs.length) runStep({ type: 'typed' });
  }

  function keydown(event) {
    const meta = isMod(event);
    if (event.key === 'Escape' && alternatives) {
      event.preventDefault();
      alternatives = null;
      return;
    }
    // Alt+A is the keyboard way in: it works on the word the caret is already
    // in, which is also the only way to reach this without a pointer.
    if (event.altKey && !event.ctrlKey && !meta && (event.code === 'KeyA' || event.key === 'a' || event.key === '\u00e5')) {
      event.preventDefault();
      openAlternatives();
      return;
    }
    if (event.key === 'Enter' && meta && !event.isComposing) {
      event.preventDefault();
      const split = event.shiftKey;
      const empty = !text.trim() && !attachments.length;
      if (empty) onnewchat?.({ split });
      else submit({ fork: true, split });
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
    if (event.key === 'Escape' && running) oninterrupt();
  }

  $effect(() => { if (autofocus && field) field.focus(); });

  $effect(() => {
    if (!provenance || !field) return;
    try { return provenance.attach(field); } catch { return undefined; }
  });

  export function focus() { field?.focus(); }
  export function textField() { return field; }
  export function draftText() { return text; }
  export function staged() { return attachments; }
  export function acceptFiles(files) {
    const list = [...(files || [])];
    if (!list.length) return;
    take(list);
    field?.focus();
  }

  








  export function insert(snippet, { separator = '\n\n', focus = true } = {}) {
    if (!snippet) return;
    const body = text.trim();
    text = body ? `${body}${separator}${snippet}` : snippet;
    tick().then(() => {
      if (!field) return;
      if (!focus) return;
      field.focus({ preventScroll: true });
      const at = field.value.length;
      field.setSelectionRange(at, at);
    });
  }
</script>


<div class="run-row">
    
    <span class="left">
      
      {#if waiting.length}
        <span class="offline" data-testid="upload-waiting">{waitingLabel}</span>
      {:else if queued > 0 || !online}
        <span class="offline" data-testid="outbox-note">{online ? `${queued} message${queued === 1 ? '' : 's'} waiting to send` : 'offline — messages will send when you reconnect'}</span>
      {:else if deferred && deferred.reason !== 'reserve'}
        
        <span class="offline" data-testid="deferred-note">sending as soon as the upload finishes…</span>
      {/if}
    </span>
    <span class="right">
      
      
      {#if pending || note}
        <span class="pending" data-testid="pending">
          <span class="spinner"></span>
          <span>{note || 'working…'}</span>
          {#if waitLabel}<span class="waited" data-testid="waited">{waitLabel}</span>{/if}
        </span>
      {/if}
      {#if running}
        <button class="interrupt press focus-ring" onclick={oninterrupt} data-testid="interrupt" title="Stop (Esc): stops everything this chat is doing, background work included">
          <span class="stop"></span> stop
        </button>
      {/if}
    </span>
</div>
{#if attachments.length}
  <div class="chips" data-testid="attachments">
    {#each attachments as chip (chip.key)}
      <span class="chip" class:failed={chip.state === 'failed'} data-testid="attachment" data-state={chip.state} data-path={chip.path || ""} title={chip.error || chip.path || ''}>
        {#if stillTransferring(chip)}
          <span class="spinner"></span>
          
          <span class="pct" data-testid="attachment-pct">{uploadPercent(chip) === null ? '' : `${uploadPercent(chip)}%`}</span>
        {/if}
        <span class="chip-name">{chip.name}</span>
        {#if chip.state === 'failed' && chip.error}
          <span class="chip-error" data-testid="attachment-error">{chip.error}</span>
        {:else if stillTransferring(chip) && chip.retrying}
          <span class="chip-error" data-testid="attachment-retrying">{chip.retrying}</span>
        {:else if chip.sent && stillTransferring(chip)}
          <span class="chip-note">resuming</span>
        {/if}
        <button class="chip-x press" onclick={() => discard(chip.key)} aria-label="Remove {chip.name}">×</button>
      </span>
    {/each}
  </div>
{/if}
<div
  class="composer"
  class:dragging
  role="group"
  bind:this={composerEl}
>
  <input bind:this={filePicker} type="file" multiple hidden onchange={pickFiles} data-testid="file-picker" />
  <button type="button" class="attach press focus-ring" onclick={() => filePicker?.click()} aria-label="Attach files" title="Attach files">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8L15 6" /></svg>
  </button>
  <textarea
    bind:this={field}
    bind:value={text}
    onkeydown={keydown}
    oninput={input}
    onclick={fieldClick}
    ontouchstart={touchStart}
    ontouchmove={cancelPress}
    ontouchend={cancelPress}
    ontouchcancel={cancelPress}
    onblur={() => { if (field) lastCaret = { start: field.selectionStart ?? 0, end: field.selectionEnd ?? 0 }; }}
    onscroll={() => { if (ghost) measureGhost(); }}
    onpaste={paste}
    {placeholder}
    rows="1"
    data-testid="composer"
    aria-label="Message"
  ></textarea>
  {#if ghost}
    
    <div
      class="ghost"
      aria-hidden="true"
      data-testid="dictate-ghost"
      style="left:{ghost.left}px; top:{ghost.top}px; width:{ghost.width}px; height:{ghost.height}px;"
    ><div style="transform:translateY({-ghost.scroll}px)">{#each ghost.parts as part, i (i)}{#if part.run}<span class="ghost-run">{part.text}</span>{:else}{part.text}{/if}{/each}</div></div>
  {/if}
  {#if alternatives}
    
    
    <div
      class="alt-backdrop"
      data-testid="alternatives-backdrop"
      role="presentation"
      onclick={() => { alternatives = null; }}
    ></div>
    <div
      class="alts"
      data-testid="alternatives"
      role="menu"
      aria-label="Other readings"
      tabindex="-1"
      style="left:{alternatives.at.x}px; top:{alternatives.at.y}px;"
    >
      {#if alternatives.range}
        <div class="alt-head" data-testid="alternatives-heard">“{alternatives.range.text}”</div>
      {/if}
      {#if alternatives.loading}
        <div class="alt-note" data-testid="alternatives-loading"><span class="spinner"></span> listening again…</div>
      {:else if alternatives.note}
        <div class="alt-note" data-testid="alternatives-note">{alternatives.note}</div>
      {/if}
      {#each alternatives.items as item, i (i)}
        <button
          class="alt press"
          class:here={item.current}
          role="menuitem"
          data-testid="alternative"
          data-model={item.model || ''}
          data-current={item.current ? '1' : '0'}
          onclick={() => chooseAlternative(item)}
        >
          <span class="alt-text">{item.text}</span>
          <span class="alt-model">{item.current ? 'as written' : (item.model || '')}</span>
        </button>
      {/each}
    </div>
  {/if}
  
  {@render dictate?.()}
  
  <button class="send press focus-ring" onclick={submit} disabled={!text.trim() && !attachments.some((a) => a.state !== 'failed')} data-testid="send" aria-label="Send">↑</button>
</div>

<style>
  .run-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 var(--column-pad) 6px;
    
    min-height: 42px;
    box-sizing: border-box;
  }
  .run-row .left, .run-row .right {
    display: flex; align-items: center; gap: 10px;
    min-width: 0;
  }
  .run-row .left { overflow: hidden; }
  .pending {
    display: flex; align-items: center; gap: 7px;
    font-size: 12px; color: var(--ink-faint);
  }
  
  .waited { font-variant-numeric: tabular-nums; opacity: 0.75; }
  .spinner {
    width: 11px; height: 11px; border-radius: 50%;
    border: 1.5px solid var(--line);
    border-top-color: var(--accent);
    animation: spin 700ms linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation-duration: 2.4s; }
  }
  .chips {
    display: flex; flex-wrap: wrap; gap: 6px;
    padding: 0 var(--column-pad) 6px;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    max-width: 240px;
    background: var(--bg-raised); border: 1px solid var(--line);
    border-radius: 14px; padding: 4px 6px 4px 10px;
    font-size: 12px; color: var(--ink-dim);
  }
  .chip.failed { border-color: color-mix(in srgb, var(--warn) 50%, transparent); color: var(--warn); }
  .chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip-error, .chip-note { font-size: 11px; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 28em; }
  
  .pct { width: 30px; flex: none; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.8; }
  .chip-x { color: var(--ink-faint); font-size: 14px; line-height: 1; padding: 0 2px; }
  .chip-x:hover { color: var(--ink); }
  .composer.dragging { background: color-mix(in srgb, var(--accent) 12%, var(--bg)); }
  .composer {
    
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    
    padding: 10px var(--column-pad);
    padding-bottom: max(10px, env(safe-area-inset-bottom));
    border-top: 1px solid var(--line-soft);
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(12px);
  }
  .attach { width: 44px; height: 44px; flex: none; display: grid; place-items: center; color: var(--ink-dim); border-radius: 50%; }
  .attach:hover { background: var(--bg-raised); color: var(--ink); }
  textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 9px 14px;
    color: var(--ink);
    font-family: var(--sans);
    
    font-size: 16px;
    line-height: 1.4;
    max-height: 200px;
    outline: none;
    transition: border-color var(--tap) var(--ease);
  }
  textarea:focus { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
  /* a bar only once the draft passes the max height (resize() switches overflow on then): thin, round, no track or gutter */
  textarea { overflow-y: hidden; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--ink) 28%, transparent) transparent; }
  textarea::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  textarea::-webkit-scrollbar-track { background: transparent; }
  textarea::-webkit-scrollbar-corner { background: transparent; }
  textarea::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--ink) 28%, transparent); border-radius: 3px; border: 0; }
  textarea::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--ink) 45%, transparent); }
  
  .ghost {
    position: absolute;
    box-sizing: border-box;
    overflow: hidden;
    pointer-events: none;
    border: 1px solid transparent;
    border-radius: 18px;
    padding: 9px 14px;
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    color: transparent;
  }
  .ghost-run {
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent) 20%, transparent);
  }
  /* The popup of other readings. It is fixed to the point he tapped and sits
     above it, because on a phone the thing under his thumb is the thing he
     wants to see. */
  .alt-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .alts {
    position: fixed;
    z-index: 41;
    transform: translate(-50%, -100%);
    min-width: 180px;
    max-width: min(340px, calc(100vw - 24px));
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--bg-raised);
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.38);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .alt-head {
    font-size: 11.5px;
    color: var(--ink-faint);
    padding: 4px 8px 6px;
    border-bottom: 1px solid var(--line-soft);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .alt-note {
    display: flex; align-items: center; gap: 7px;
    font-size: 12px; color: var(--ink-faint);
    padding: 7px 8px;
  }
  .alt {
    display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
    width: 100%;
    padding: 7px 8px;
    border-radius: 8px;
    text-align: left;
    color: var(--ink);
    font-size: 14.5px;
  }
  .alt:hover { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .alt.here { color: var(--ink-dim); }
  .alt-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alt-model { font-size: 10.5px; color: var(--ink-faint); flex: none; }
  .send {
    width: 36px; height: 36px; flex: none;
    border-radius: 50%;
    background: var(--accent);
    color: #14100d;
    font-size: 17px; font-weight: 600;
    display: grid; place-items: center;
  }
  .send:disabled { background: var(--line); color: var(--ink-faint); cursor: default; transform: none; }
  .interrupt {
    display: flex; align-items: center; gap: 6px;
    height: 36px; padding: 0 12px; flex: none;
    border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
    border-radius: 18px;
    color: var(--warn);
    font-size: 12.5px;
  }
  .stop { width: 8px; height: 8px; background: var(--warn); border-radius: 2px; }
  .offline {
    font-size: 11.5px; color: var(--ink-faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* On a phone the run row was a 42px bar above the composer that stood empty whenever
     nothing was running -- dead space in the one place there is none to spare -- and it
     pushed the transcript up by its own height while a run was live. Here it keeps its
     place in the flow but carries no height: the stop button hangs out of it, floating
     over the bottom of the transcript between the new-chat button and the nav pill, and
     the notices float a band higher. Taps pass through the empty parts to the text under. */
  @media (max-width: 860px) {
    .run-row {
      position: relative;
      min-height: 0;
      height: 0;
      padding: 0 var(--column-pad);
      align-items: flex-end;
      
      
      justify-content: flex-start;
      padding-left: 72px;
      pointer-events: none;
    }
    .run-row .right { pointer-events: auto; }
    /** Nothing in the left slot is tappable -- it is the upload, outbox and offline lines -- so
     *       it never takes a tap from the transcript it floats over, and it rides the same
     *       --notif-lift the nav pill and the new-chat button ride, since without that a standing
     *       strip y 692-717).
     */
    .run-row .left {
      position: absolute;
      left: var(--column-pad); right: var(--column-pad);
      bottom: calc(62px + var(--notif-lift, 0px));
      justify-content: center;
      pointer-events: none;
    }
    .run-row .right { transform: translateY(-11px); }
    
    .pending { display: none; }
    .interrupt {
      background: var(--bg-raised);
      box-shadow: 0 6px 18px rgb(0 0 0 / 0.34);
    }
    .offline {
      background: var(--bg-raised);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 10px;
    }
  }
</style>
