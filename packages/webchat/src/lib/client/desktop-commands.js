// The tophat-desktop shell (~/projects/tophat/apps/tophat-desktop) owns the browser chords a web page must never claim.
// Its native menu takes each chord as an accelerator and sends the page one command over the preload bridge
// `window.tophatDesktop.onCommand(cb)`. This module is the page's only contact with that bridge: in a plain browser
// `window.tophatDesktop` is absent, nothing is bound, and every chord stays the browser's.
//
// A command is {type, ...}: tab {n} (1..8 the nth tab of the focused group, 9 its last, as in a browser), close,
// next, prev, new, split. Anything else is ignored.

export const DESKTOP_COMMANDS = ['tab', 'close', 'next', 'prev', 'new', 'split'];

/** The bridge the desktop preload exposes, or null in a plain browser. */
export function desktopBridge(win = globalThis.window) {
  const bridge = win?.tophatDesktop;
  return bridge && typeof bridge.onCommand === 'function' ? bridge : null;
}

/** Which tab of `tabs` Cmd-n names: 1..8 by position, 9 the last; null when there is none. */
export function tabForDigit(tabs, n) {
  if (!Array.isArray(tabs) || !tabs.length || !Number.isInteger(n) || n < 1 || n > 9) return null;
  if (n === 9) return tabs[tabs.length - 1];
  return n <= tabs.length ? tabs[n - 1] : null;
}

/**
 * Route the desktop shell's commands to `handlers` ({tab(n), close(), next(), prev(), new(), split()}).
 * Returns an unsubscribe; a no-op when there is no desktop bridge.
 */
export function listenDesktop(win, handlers) {
  const bridge = desktopBridge(win);
  if (!bridge) return () => {};
  const off = bridge.onCommand((command) => {
    const type = command && typeof command === 'object' ? command.type : null;
    if (!DESKTOP_COMMANDS.includes(type) || typeof handlers[type] !== 'function') return;
    if (type === 'tab') { if (Number.isInteger(command.n)) handlers.tab(command.n); return; }
    handlers[type]();
  });
  return typeof off === 'function' ? off : () => {};
}
