// Pure geometry for the lightbox zoom: a view is { s, x, y } meaning translate(x, y) scale(s) about the
// image's own centre. s = 1 is the fit size; x, y are screen pixels.
export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const DOUBLE_TAP_SCALE = 3;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Keep the image from leaving the stage: when the scaled image is larger than the stage along an axis it
// may pan until its edge meets the stage edge; when smaller it stays centred.
export function clampView(view, fit, stage, max = MAX_SCALE) {
  const s = clamp(view.s, MIN_SCALE, max);
  const lx = Math.max(0, (fit.w * s - stage.w) / 2);
  const ly = Math.max(0, (fit.h * s - stage.h) / 2);
  return { s, x: s === MIN_SCALE ? 0 : clamp(view.x, -lx, lx), y: s === MIN_SCALE ? 0 : clamp(view.y, -ly, ly) };
}

// Scale to `s2` keeping the content point under screen point `p` fixed. `c` is the image centre on
// screen when the view is untransformed (x = y = 0, s = 1).
export function zoomAbout(view, s2, p, c) {
  const ux = (p.x - c.x - view.x) / view.s;
  const uy = (p.y - c.y - view.y) / view.s;
  return { s: s2, x: p.x - c.x - ux * s2, y: p.y - c.y - uy * s2 };
}

// Two-finger pinch: start view v0 with finger midpoint m0 and spread d0; now midpoint m1 and spread d1.
// The content under the starting midpoint follows the current midpoint (pinch and two-finger pan).
export function pinchView(v0, m0, d0, m1, d1, c, max = MAX_SCALE) {
  const s2 = clamp(v0.s * (d1 / Math.max(d0, 1)), MIN_SCALE, max);
  const ux = (m0.x - c.x - v0.x) / v0.s;
  const uy = (m0.y - c.y - v0.y) / v0.s;
  return { s: s2, x: m1.x - c.x - ux * s2, y: m1.y - c.y - uy * s2 };
}

// A second tap close in time and place to the first is a double tap.
export function isDoubleTap(prev, now, ms = 320, px = 32) {
  return !!prev && now.t - prev.t <= ms && Math.hypot(now.x - prev.x, now.y - prev.y) <= px;
}
