// Client side of the reading trace: watch a container, sample which line boxes are in the
// reading band, and post what was looked at. Attach it once per surface and forget it.
//
//   const stop = traceReading(() => node, { surface: 'reader', ref: docId, sub: () => sectionIdx });
//
// Granularity is a line box as laid out on the screen he is holding. Sampling is on scroll and on a
// slow timer, both rAF-coalesced, so a long motionless read still accrues time.

import { readingBand, visibleLines, wordsPerLine, accumulate } from '$lib/core/reading-trace.js';
import { uiApp } from '$lib/client/ui-app.js';
import { onceId, idOf } from '../../../../runner/tools/docstore-kit/lib/recipes.js';

const SAMPLE_MS = 400;        // how often the band is re-read while he sits still
const FLUSH_MS = 6000;        // how often rows go to the server
const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, pre, td';

// This tab's reading session: the kit's `onceId` recipe on the tab storage (the old `reading-session` key adopted).
const sessionDecl = onceId('reading-session', { storage: 'tab', legacyKey: 'reading-session' });
export const sessionId = () => {
  try { return idOf(uiApp().use(sessionDecl), () => `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`); }
  catch { return `s_${Date.now().toString(36)}`; }
};

const deviceLabel = () => {
  try { return `${window.innerWidth}x${window.innerHeight}`; } catch { return ''; }
};

export function traceReading(getNode, { surface, ref, sub = () => '', enabled = () => true } = {}) {
  if (typeof window === 'undefined') return () => {};
  const session = sessionId();
  const acc = new Map();
  let last = performance.now();
  let pending = false;
  let timer = null;
  let flusher = null;

  const sample = () => {
    pending = false;
    const node = getNode?.();
    if (!node || !enabled()) { last = performance.now(); return; }
    const now = performance.now();
    const dt = Math.min(now - last, 2000);   // a tab that slept is not reading
    last = now;
    if (dt <= 0) return;
    const band = readingBand(window.innerHeight);
    const at = Date.now();
    const fallbackSub = String(sub() ?? '');
    const blocks = node.querySelectorAll(BLOCK_SELECTOR);
    blocks.forEach((el, index) => {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < band.top || rect.top > band.bottom) return;
      const text = (el.textContent || '').trim();
      if (!text) return;
      const words = text.split(/\s+/u).filter(Boolean).length;
      let rects;
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        rects = Array.from(range.getClientRects()).filter((r) => r.height > 2 && r.width > 2);
      } catch { rects = []; }
      if (!rects.length) rects = [rect];
      const lines = rects.length;
      const perLine = wordsPerLine(words, rects);
      // In chat each paragraph belongs to a different message, so the owning message is read off
      // the element itself; in the reader there is one body and the section index stands in.
      const owner = el.closest('[data-item]')?.dataset?.item;
      const subKey = owner || fallbackSub;
      const key = el.dataset.rt || `${el.tagName.toLowerCase()}#${index}`;
      for (const line of visibleLines(rects, band)) {
        accumulate(acc, {
          key: `${subKey}\u0000${key}\u0000${line}`,
          words: perLine[line] || 0, line, lines, at, dt
        });
      }
    });
  };

  const onScroll = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(sample);
  };

  const flush = (beacon = false) => {
    if (!acc.size) return;
    const rows = [];
    for (const [key, entry] of acc) {
      const [subKey, block, line] = key.split('\u0000');
      rows.push({
        sub: subKey, block, line: Number(line), lines: entry.lines,
        words: entry.words, ms: Math.round(entry.ms), passes: entry.passes,
        firstAt: new Date(entry.firstAt).toISOString(), lastAt: new Date(entry.lastAt).toISOString()
      });
    }
    acc.clear();
    const body = JSON.stringify({
      session, surface, ref: typeof ref === 'function' ? ref() : ref,
      device: deviceLabel(), width: window.innerWidth, height: window.innerHeight, rows
    });
    try {
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon('/api/reading/trace', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/reading/trace', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true })
          .catch(() => {});
      }
    } catch { /* telemetry never breaks reading */ }
  };

  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onScroll, { passive: true });
  timer = setInterval(sample, SAMPLE_MS);
  flusher = setInterval(() => flush(false), FLUSH_MS);
  const onHide = () => { sample(); flush(true); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);

  return () => {
    sample();
    flush(true);
    clearInterval(timer);
    clearInterval(flusher);
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', onScroll);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onHide);
  };
}
