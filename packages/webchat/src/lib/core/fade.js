

export const FADE_AFTER_MS = 60_000;


export const FADE_DURATION_MS = 1_500;


export const FADED_OPACITY = 0.05;

export function isStale(at, now) {
  const sent = Date.parse(at ?? '');
  if (!Number.isFinite(sent)) return false;
  return now - sent >= FADE_AFTER_MS;
}

export function opacityFor(message, now, { browsing = false, hovered = false } = {}) {
  if (browsing || hovered) return 1;
  return isStale(message?.at, now) ? FADED_OPACITY : 1;
}

export function msUntilNextFade(messages, now) {
  let soonest = null;
  for (const message of messages || []) {
    const sent = Date.parse(message?.at ?? '');
    if (!Number.isFinite(sent)) continue;
    const due = sent + FADE_AFTER_MS - now;
    if (due <= 0) continue;
    if (soonest === null || due < soonest) soonest = due;
  }
  return soonest;
}
