import { isIncognito } from '../core/incognito.js';
import { deviceId } from './reading.js';
import { enqueueObservation, flushObservations, deliveryStatus } from './interaction-delivery.js';
import { intersect, textEdit } from '../core/interaction.js';
import { classifyInsertion } from '../core/input-provenance.js';
import { offsetsOfNode, offsetsOfRange, offsetAtPoint } from '../core/textrange.js';
import { noteCall, reportClientLag } from './freeze-watch.js';

// Cost rules:
//  * pointermove and wheel are coalesced to one row per POINTER_MS and never hit-test text offsets
//    (offsetAtPoint walks every text node of the message: O(message) per mouse move);
//  * scroll is coalesced to one viewport snapshot per SCROLL_MS (trailing), the row lists the eventTimes
//    it covers; the snapshot measures only blocks an IntersectionObserver says are on screen, and each
//    block's clipping ancestors are found once, not with getComputedStyle per ancestor per event;
//  * the block list is rebuilt off the event path (idle callback) after DOM mutations;
//  * block definitions (text, offsets, word count) are emitted from an idle callback with the seq number
//    reserved at the moment the id was first used, so readers still see them in order;
//  * the heartbeat sends a full snapshot only when something changed since the last one;
//  * every handler runs under a time budget: one over BUDGET_MS suspends the heavy capture (snapshots,
//    offsets, definitions) for a backoff period that doubles, and is reported to the freeze watchdog.
const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,pre,td,th,blockquote';
const POINTER_MS = 100;
const SCROLL_MS = 200;
const BUDGET_MS = 16;
const REPORT_MS = 100;
const rect = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
const capped = text => ({ text: String(text || '').slice(0, 16000), textLength: String(text || '').length, truncated: String(text || '').length > 16000 });

export function observeInteraction(root, { conversation, emit = enqueueObservation, flush = flushObservations, heartbeatMs = 5000 } = {}) {
  // An incognito chat is not observed: these rows carry text and are queued in IndexedDB (core/incognito.js).
  if (isIncognito(conversation)) return { record() {}, gaze() {}, destroy() {} };
  const doc = root.ownerDocument, win = doc.defaultView;
  const session = crypto.randomUUID();
  let seq = 0, blockSeq = 0, fieldSeq = 0, snapshotSeq = 0, generation = 0;
  let dirty = true, nodes = [], lastViewport = null, dictationToken = null, changed = true, destroyed = false;
  const known = new WeakMap(), fields = new WeakMap(), clippers = new WeakMap(), listeners = [], timers = new Set();
  const onscreen = new Set();
  const clock = () => win.performance.now();
  const idle = (fn, timeout = 1000) => {
    if (win.requestIdleCallback) { const id = win.requestIdleCallback(() => { timers.delete(cancel); fn(); }, { timeout }); const cancel = () => win.cancelIdleCallback(id); timers.add(cancel); }
    else { const id = win.setTimeout(() => { timers.delete(cancel); fn(); }, 50); const cancel = () => win.clearTimeout(id); timers.add(cancel); }
  };
  const later = (fn, ms) => { const id = win.setTimeout(() => { timers.delete(cancel); fn(); }, ms); const cancel = () => win.clearTimeout(id); timers.add(cancel); return cancel; };

  // Time budget: heavy capture is suspended after a handler overruns, for a backoff that doubles.
  let suspendedUntil = 0, backoff = 10_000;
  const heavy = () => clock() >= suspendedUntil;
  function overran(label, ms) {
    suspendedUntil = clock() + backoff;
    backoff = Math.min(backoff * 2, 300_000);
    record('capture_gap', { reason: 'over_budget', handler: label, ms, suspendedMs: suspendedUntil - clock() });
    if (ms > REPORT_MS) reportClientLag({ kind: 'capture_slow', durationMs: Math.round(ms), handler: label, nodes: nodes.length, onscreen: onscreen.size, suspendedMs: Math.round(suspendedUntil - clock()) });
  }

  function record(type, body = {}, number = seq++) {
    try {
      const payload = JSON.stringify(body).length > 180000 ? { originalType: type, reason: 'event_exceeds_180k_characters' } : body;
      emit({ ...payload, schema: 1, session, seq: number, id: `${session}:${number}`, conversation, type: payload === body ? type : 'capture_gap', mono: clock(), at: new Date().toISOString() });
    } catch {  }
  }
  const safe = (fn, label = 'capture') => (...args) => {
    const started = clock();
    try { fn(...args); } catch (error) { record('capture_error', { message: String(error?.message).slice(0, 200) }); }
    const ms = clock() - started;
    if (ms > 4) noteCall(`interaction.${label}`, ms);
    if (ms > BUDGET_MS) overran(label, ms);
  };
  function listen(target, type, fn) {
    const handler = safe(fn, type);
    target.addEventListener(type, handler, { capture: true, passive: true });
    listeners.push(() => target.removeEventListener(type, handler, true));
  }

  // Block ids are assigned synchronously; the definition row (text, offsets) is written when idle with the
  // seq reserved now, so it sorts before the viewport that first names it.
  const pendingDefinitions = new Map();
  let definitionsScheduled = false;
  function definition(node) {
    let saved = known.get(node);
    if (saved && saved.generation === generation) return saved.id;
    const content = node.textContent || '';
    if (saved && saved.content === content) { saved.generation = generation; return saved.id; }
    saved = { id: `${session}:block:${++blockSeq}`, content, generation, seq: seq++ };
    known.set(node, saved);
    pendingDefinitions.set(saved.id, { node, saved });
    if (!definitionsScheduled) { definitionsScheduled = true; idle(writeDefinitions); }
    return saved.id;
  }
  const writeDefinitions = safe(() => {
    definitionsScheduled = false;
    for (const [id, { node, saved }] of pendingDefinitions) {
      pendingDefinitions.delete(id);
      const message = node.closest('[data-item]');
      const prose = node.closest('.prose') || node;
      const content = saved.content;
      record('block', { blockId: id, message: message?.dataset.item || null, thread: node.closest('[data-thread]')?.dataset.thread, role: message?.dataset.role || null, tag: node.tagName, offsets: heavy() ? offsetsOfNode(prose, node) : null, words: content.match(/\S+/gu)?.length || 0, streaming: message?.dataset.streaming === 'true', ...capped(content) }, saved.seq);
    }
  }, 'definitions');

  // Clipping ancestors of a node inside the pane, found once per node per rebuild.
  function clippersOf(node) {
    let list = clippers.get(node);
    if (list) return list;
    list = [];
    for (let parent = node.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement) {
      const style = win.getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/u.test(`${style.overflowX} ${style.overflowY}`)) list.push(parent);
    }
    clippers.set(node, list);
    return list;
  }
  function clip(node, bounds, pane) {
    let area = intersect(bounds, pane);
    for (const parent of clippersOf(node)) { if (!area) break; area = intersect(area, rect(parent.getBoundingClientRect())); }
    return area;
  }

  // On-screen tracking without layout reads on the event path.
  const io = win.IntersectionObserver ? new win.IntersectionObserver(entries => { for (const e of entries) { if (e.isIntersecting) onscreen.add(e.target); else onscreen.delete(e.target); } changed = true; }) : null;
  function rebuild() {
    const started = clock();
    const next = [...root.querySelectorAll('.prose, [data-role="user"] .bubble')].flatMap(prose => {
      const blocks = [...prose.querySelectorAll(BLOCKS)].filter(n => !n.querySelector(BLOCKS));
      return blocks.length ? blocks : [prose];
    });
    if (io) {
      const keep = new Set(next);
      for (const node of nodes) if (!keep.has(node)) { io.unobserve(node); onscreen.delete(node); }
      const had = new Set(nodes);
      for (const node of next) if (!had.has(node)) io.observe(node);
    }
    nodes = next; dirty = false; changed = true;
    noteCall('interaction.rebuild', clock() - started, { nodes: nodes.length });
  }
  let rebuildScheduled = false;
  function scheduleRebuild() { if (rebuildScheduled) return; rebuildScheduled = true; idle(safe(() => { rebuildScheduled = false; if (dirty && !destroyed) rebuild(); }, 'rebuild')); }

  function viewport(reason, target = null) {
    const started = clock();
    const v = win.visualViewport;
    const windowRect = { left: v?.offsetLeft || 0, top: v?.offsetTop || 0, right: (v?.offsetLeft || 0) + (v?.width || win.innerWidth), bottom: (v?.offsetTop || 0) + (v?.height || win.innerHeight) };
    const pane = intersect(rect(root.getBoundingClientRect()), windowRect);
    if (dirty && !nodes.length) rebuild();
    const blocks = [];
    const measure = heavy();
    if (pane && !doc.hidden && measure) for (const node of (io && onscreen.size ? onscreen : nodes)) {
      if (!node.isConnected) continue;
      const bounds = rect(node.getBoundingClientRect());
      if (!intersect(bounds, pane)) continue;
      const visible = clip(node, bounds, pane);
      if (!visible) continue;
      const area = (visible.right - visible.left) * (visible.bottom - visible.top);
      blocks.push({ id: definition(node), bounds, clip: visible, area, fraction: area / Math.max(1, (bounds.right - bounds.left) * (bounds.bottom - bounds.top)) });
    }
    lastViewport = `${session}:view:${++snapshotSeq}`;
    changed = false;
    record('viewport', { viewportId: lastViewport, reason, visible: !doc.hidden, focused: doc.hasFocus(), occlusion: 'not_measured', measured: measure, window: windowRect, pane, scale: v?.scale || 1, dpr: win.devicePixelRatio, scroll: target ? { top: target.scrollTop, left: target.scrollLeft, height: target.scrollHeight, width: target.scrollWidth, clientHeight: target.clientHeight, clientWidth: target.clientWidth, target: target.dataset?.testid || target.tagName } : null, blocks, captureMs: clock() - started });
    return lastViewport;
  }
  function point(event, full = true) {
    const node = event.target?.closest?.(BLOCKS);
    const prose = node?.closest('.prose');
    const control = event.target?.closest?.('button,a,[role="button"],input,textarea');
    const deep = full && heavy();
    return { x: event.clientX, y: event.clientY, pointerType: event.pointerType, control: control ? { tag: control.tagName, testId: control.dataset.testid, label: (control.getAttribute('aria-label') || control.getAttribute('title') || (control.tagName === 'TEXTAREA' ? '' : control.textContent) || '').slice(0, 200) } : null, block: deep && prose && node && root.contains(node) ? definition(node) : null, offset: deep && prose ? offsetAtPoint(prose, event.clientX, event.clientY) : null, viewportId: lastViewport };
  }
  function field(node) {
    if (!node?.matches?.('textarea')) return null;
    let value = fields.get(node);
    if (!value) { value = { id: `${session}:field:${++fieldSeq}`, text: node.value, keys: 0 }; fields.set(node, value); record('field', { field: value.id, thread: node.closest('[data-thread]')?.dataset.thread, ...capped(node.value) }); }
    return value;
  }

  // Scroll: one snapshot per SCROLL_MS, trailing, naming every native scroll eventTime it covers.
  let scrollTimes = [], scrollTarget = null, scrollTrusted = true, scrollCancel = null;
  const scrollFlush = safe(() => {
    scrollCancel = null;
    if (!scrollTimes.length || destroyed) return;
    const eventTimes = scrollTimes; scrollTimes = [];
    const id = viewport('scroll', scrollTarget);
    record('scroll', { viewportId: id, eventTime: eventTimes.at(-1), eventTimes, coalesced: eventTimes.length, trusted: scrollTrusted });
    scrollTrusted = true;
  }, 'scroll_snapshot');
  listen(root, 'scroll', e => {
    scrollTimes.push(e.timeStamp); scrollTarget = e.target; scrollTrusted &&= e.isTrusted; changed = true;
    if (!scrollCancel) scrollCancel = later(scrollFlush, SCROLL_MS);
  });

  // Pointer moves and wheel: coalesced per POINTER_MS, cheap fields only.
  let move = null, moveCancel = null, wheel = null, wheelCancel = null;
  const moveFlush = safe(() => { moveCancel = null; if (move) { const m = move; move = null; record('pointermove', m); } }, 'pointermove_flush');
  const wheelFlush = safe(() => { wheelCancel = null; if (wheel) { const w = wheel; wheel = null; record('wheel', w); } }, 'wheel_flush');
  listen(root, 'pointermove', e => {
    const samples = (e.getCoalescedEvents?.() || []).map(s => ({ x: s.clientX, y: s.clientY, eventTime: s.timeStamp }));
    const prior = move?.samples || [];
    move = { ...point(e, false), eventTime: e.timeStamp, buttons: e.buttons, pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY, samples: [...prior, ...(samples.length ? samples : [{ x: e.clientX, y: e.clientY, eventTime: e.timeStamp }])].slice(-64), events: (move?.events || 0) + 1 };
    if (!moveCancel) moveCancel = later(moveFlush, POINTER_MS);
  });
  for (const type of ['pointerdown', 'pointerup', 'pointerleave', 'click', 'dblclick', 'contextmenu']) listen(root, type, e => {
    if (move) { moveCancel?.(); moveFlush(); }
    record(type, { ...point(e, type !== 'pointerleave'), eventTime: e.timeStamp, buttons: e.buttons, pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY, samples: [] });
  });
  listen(root, 'wheel', e => {
    wheel = wheel ? { ...wheel, x: e.clientX, y: e.clientY, dx: wheel.dx + e.deltaX, dy: wheel.dy + e.deltaY, eventTime: e.timeStamp, events: wheel.events + 1, viewportId: lastViewport } : { ...point(e, false), dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, eventTime: e.timeStamp, events: 1 };
    if (!wheelCancel) wheelCancel = later(wheelFlush, POINTER_MS);
  });
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) listen(root, type, e => record(type, { eventTime: e.timeStamp, touches: [...e.changedTouches].map(t => ({ id: t.identifier, x: t.clientX, y: t.clientY })), viewportId: lastViewport }));
  listen(root, 'keydown', e => {
    const f = field(e.target);
    if (f && e.key.length === 1 && !e.metaKey && !e.ctrlKey) f.keys++;
    record('keydown', { field: f?.id, key: e.key.length === 1 ? 'character' : e.key, code: e.code, repeat: e.repeat, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey, eventTime: e.timeStamp });
  });
  listen(root, 'keyup', e => record('keyup', { field: field(e.target)?.id, key: e.key.length === 1 ? 'character' : e.key, code: e.code, eventTime: e.timeStamp }));
  listen(root, 'beforeinput', e => { const f = field(e.target); if (f) record('beforeinput', { field: f.id, inputType: e.inputType, data: e.data, start: e.target.selectionStart, end: e.target.selectionEnd, composing: e.isComposing, eventTime: e.timeStamp }); });
  listen(root, 'input', e => {
    const f = field(e.target); if (!f) return;
    const edit = textEdit(f.text, e.target.value);
    const classification = classifyInsertion({ inputType: e.inputType, text: edit.inserted, keystrokes: f.keys });
    record('input', { field: f.id, edit, classification, keys: f.keys, inputType: e.inputType, start: e.target.selectionStart, end: e.target.selectionEnd, composing: e.isComposing, eventTime: e.timeStamp });
    f.text = e.target.value; f.keys = 0;
  });
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'focusin', 'focusout', 'copy', 'cut', 'paste']) listen(root, type, e => { const f = field(e.target); record(type, { field: f?.id, data: e.data, viewportId: lastViewport }); });
  // Selection: trailing 250 ms, since dragging a selection fires this per pixel and offsets walk the message.
  let selectionCancel = null;
  const selectionFlush = safe(() => {
    selectionCancel = null;
    const selection = doc.getSelection();
    const start = selection?.anchorNode?.parentElement;
    if (!start || !root.contains(start) || !selection.rangeCount || selection.isCollapsed) return;
    const prose = start.closest('.prose');
    record('selection', { ...capped(selection.toString()), message: start.closest('[data-item]')?.dataset.item, offsets: prose && heavy() ? offsetsOfRange(prose, selection.getRangeAt(0)) : null, viewportId: lastViewport });
  }, 'selection');
  listen(doc, 'selectionchange', () => { if (!selectionCancel) selectionCancel = later(selectionFlush, 250); });
  listen(root, 'tophat-measure', e => {
    const f = field(e.target);
    const { valueAfter, ...detail } = e.detail;
    if (detail.type === 'dictation_begin') dictationToken = detail.token;
    record(detail.type, { ...detail, field: f?.id, viewportId: lastViewport });
    if (f && typeof valueAfter === 'string') { f.text = valueAfter; f.keys = 0; }
  });
  for (const type of ['focus', 'blur', 'resize', 'pageshow', 'pagehide', 'online', 'offline']) listen(win, type, () => { viewport(type); record(type); flush(); });
  listen(doc, 'visibilitychange', () => { viewport('visibilitychange'); record('visibility', { visible: !doc.hidden }); flush(); });
  if (win.visualViewport) for (const type of ['resize', 'scroll']) listen(win.visualViewport, type, () => { changed = true; });
  const observer = new win.MutationObserver(safe(changes => {
    for (const change of changes) {
      if (change.type === 'attributes') {
        record('dictation_state', { token: dictationToken, state: change.target.dataset.state, previous: change.oldValue, timing: 'UI_state_transition' });
      } else { dirty = true; changed = true; generation++; }
    }
    if (dirty) scheduleRebuild();
  }, 'mutation'));
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-state'], attributeOldValue: true });
  let resizeCancel = null;
  const resize = new win.ResizeObserver(safe(() => { changed = true; if (!resizeCancel) resizeCancel = later(safe(() => { resizeCancel = null; viewport('layout'); }, 'layout'), SCROLL_MS); }, 'resize'));
  resize.observe(root);
  record('session', { actor: new URL(win.location.href).searchParams.has('interaction-probe') ? 'verification' : win.navigator.webdriver ? 'automation' : 'browser', device: deviceId(), userAgent: win.navigator.userAgent, timeOrigin: win.performance.timeOrigin, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, coordinateSpace: 'layout_viewport_css_pixels', ...deliveryStatus() });
  // The first snapshot waits for idle, so mounting a long chat never pays for capture before it paints.
  idle(safe(() => { if (destroyed) return; rebuild(); viewport('mount'); }, 'mount'), 500);
  const heartbeat = win.setInterval(safe(() => { if (changed) viewport('heartbeat'); else record('heartbeat', { viewportId: lastViewport, visible: !doc.hidden, focused: doc.hasFocus() }); flush(); }, 'heartbeat'), heartbeatMs);
  return {
    record,
    gaze(sample) { safe(() => record('gaze', { ...point({ clientX: sample.x, clientY: sample.y, target: doc.elementFromPoint(sample.x, sample.y) }), ...sample, viewportId: lastViewport, coordinateSpace: 'layout_viewport_css_pixels' }), 'gaze')(); },
    destroy() {
      if (move) moveFlush(); if (wheel) wheelFlush(); if (scrollTimes.length) scrollFlush();
      safe(() => viewport('unmount'), 'unmount')();
      if (pendingDefinitions.size) writeDefinitions();
      destroyed = true;
      record('end'); observer.disconnect(); resize.disconnect(); io?.disconnect(); win.clearInterval(heartbeat);
      for (const cancel of timers) cancel(); timers.clear();
      listeners.forEach(fn => fn()); flush();
    }
  };
}
