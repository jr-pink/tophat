// When a page he is only looking at becomes a page he is reading.
//
// Browsing keeps nothing, which is right for a link followed out of curiosity and wrong for the
// piece he then spends ten minutes inside. This decides the difference from three cheap signals:
// time with the page actually visible, how far down the text he has got, and whether the scrolling
// looks like reading rather than a flick to the bottom.
//
// No timers and no DOM live here; the page ticks it.

// A quarter of the way down is where a glance has stopped being a glance.
export const READ_RATIO = 0.22;
// Reading runs at about 240 words a minute in this app, so a fifth of the estimated time is a
// real investment in the piece; a minute for anything short enough to have no estimate.
export const READ_FRACTION = 0.2;
export const MIN_VISIBLE_MS = 40_000;
export const MAX_VISIBLE_MS = 150_000;
// Long enough on one screen is reading even with no scrolling at all: a short post, or the top of
// a long one read slowly.
export const PATIENT_MS = 100_000;
// A window closed in the first seconds was a mistake, not a read.
export const MIN_OPEN_MS = 2_500;
// Straight to the bottom in the first moments is a look for the end, not a read.
export const FLICK_RATIO = 0.85;
export const FLICK_MS = 4_000;

const WORDS_PER_MINUTE = 240;

export function createDwell({
  now = () => Date.now(),
  readRatio = READ_RATIO,
  readFraction = READ_FRACTION,
  minVisibleMs = MIN_VISIBLE_MS,
  maxVisibleMs = MAX_VISIBLE_MS,
  patientMs = PATIENT_MS,
  minOpenMs = MIN_OPEN_MS,
  flickRatio = FLICK_RATIO,
  flickMs = FLICK_MS
} = {}) {
  let page = null;

  function target() {
    if (!page?.words) return minVisibleMs;
    const estimate = (page.words / WORDS_PER_MINUTE) * 60_000 * readFraction;
    return Math.min(maxVisibleMs, Math.max(minVisibleMs, estimate));
  }

  function accrue(at) {
    if (!page || !page.visible) return;
    const since = at - page.lastAt;
    if (since > 0) page.visibleMs += since;
    page.lastAt = at;
  }

  return {
    /** A new thing on screen. Anything known about the old one is gone. */
    open({ url, words = 0, visible = true } = {}, at = now()) {
      page = { url, words, visible, visibleMs: 0, openedAt: at, lastAt: at, maxRatio: 0, flicked: false, promoted: false };
    },

    close() { page = null; },

    visibility(visible, at = now()) {
      if (!page) return;
      accrue(at);
      page.visible = Boolean(visible);
      page.lastAt = at;
    },

    scroll({ ratio = 0 } = {}, at = now()) {
      if (!page) return;
      accrue(at);
      const seen = Math.max(0, Math.min(1, Number(ratio) || 0));
      if (seen > page.maxRatio) page.maxRatio = seen;
      if (seen >= flickRatio && at - page.openedAt <= flickMs) page.flicked = true;
    },

    tick(at = now()) { accrue(at); },

    /** Marked once it has been acted on, so a page is never promoted twice. */
    promoted() { if (page) page.promoted = true; },

    state() { return page ? { ...page, target: target() } : null; },

    verdict(at = now()) {
      if (!page) return { state: 'browsing', reason: 'nothing open' };
      accrue(at);
      if (page.promoted) return { state: 'browsing', reason: 'already kept' };
      if (at - page.openedAt < minOpenMs) return { state: 'browsing', reason: 'only just opened' };
      // A flick is forgiven once he comes back and reads: dwell past the target overrides it.
      if (page.flicked && page.visibleMs < patientMs) return { state: 'browsing', reason: 'flicked to the end' };
      if (page.visibleMs >= patientMs) return { state: 'reading', reason: 'a long time on it' };
      if (page.visibleMs >= target() && page.maxRatio >= readRatio) {
        return { state: 'reading', reason: 'time on it and into the text' };
      }
      return { state: 'browsing', reason: 'not yet' };
    }
  };
}
