

const APPLE_RE = /mac|iphone|ipad|ipod/i;

let apple = null;

export function isApple() {
  if (apple === null) {
    if (typeof navigator === 'undefined') return false; 
    apple = APPLE_RE.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
  }
  return apple;
}


export function isMod(event) {
  return isApple() ? event.metaKey : event.ctrlKey;
}


export const MAC_TEXT_KEYS = new Set(['a', 'b', 'd', 'e', 'f', 'h', 'k', 'n', 'o', 'p', 't', 'v', 'y']);

export function isMacTextBinding(event, { listNavigation = false } = {}) {
  if (!isApple()) return false;
  if (!event.ctrlKey || event.metaKey || event.altKey) return false;
  const key = String(event.key || '').toLowerCase();
  if (listNavigation && (key === 'n' || key === 'p')) return false;
  return MAC_TEXT_KEYS.has(key);
}


export function isListDown(event) {
  return event.key === 'ArrowDown' || (event.ctrlKey && !event.metaKey && !event.altKey && event.key?.toLowerCase() === 'n');
}


export function isListUp(event) {
  return event.key === 'ArrowUp' || (event.ctrlKey && !event.metaKey && !event.altKey && event.key?.toLowerCase() === 'p');
}


// ---- the pane prefix, as in tmux ----------------------------------- Ctrl-Q, then one key, works the panes and their
// tabs. The panes are one row of columns (core/panels.js), so there is no up/down: no stacked split, no focus up or down.
// One table is the source of truth for the key, what it does, and the label the hint bar, the help overlay (Ctrl-Q ?) and
// the menus show beside an action.
export function isPanePrefix(event) {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && String(event.key || '').toLowerCase() === 'q';
}

// [key as event.key gives it (letters lowercase unless the entry says shift), chord name, what it does]. A `shift: true`
// entry is the shifted letter (Shift-H); the brace keys are already shifted characters and need no flag.
export const PANE_CHORDS = [
  { key: 'h', chord: 'split', label: 'new chat in a pane beside' },
  { key: '\\', chord: 'split-tab', label: 'this tab again in a pane beside' },
  { key: 'x', chord: 'close', label: 'close the pane' },
  { key: 'w', chord: 'close-tab', label: 'close the tab' },
  { key: 'o', chord: 'next', label: 'next pane (wraps)' },
  { key: 'ArrowLeft', chord: 'focus-left', label: 'pane to the left', show: '←' },
  { key: 'ArrowRight', chord: 'focus-right', label: 'pane to the right', show: '→' },
  { key: '1-9', chord: 'focus-n', label: 'pane 1 to 9' },
  { key: 'n', chord: 'next-tab', label: 'next tab in the pane' },
  { key: 'p', chord: 'prev-tab', label: 'previous tab in the pane' },
  { key: 'h', shift: true, chord: 'resize-left', label: 'divider 5% left', show: '⇧H' },
  { key: 'l', shift: true, chord: 'resize-right', label: 'divider 5% right', show: '⇧L' },
  { key: '{', chord: 'move-left', label: 'swap the pane with its left neighbour' },
  { key: '}', chord: 'move-right', label: 'swap the pane with its right neighbour' },
  { key: 'm', chord: 'tab-to-pane', label: 'move the tab out into a new pane' },
  { key: 'j', chord: 'pane-to-tabs', label: 'join the pane\'s tabs into its neighbour' },
  { key: 'z', chord: 'zoom', label: 'zoom the pane (the others fold to rails); again to unfold' },
  { key: 'Tab', chord: 'cycle-list', label: 'chat list ⇄ pane', show: '⇥' },
  { key: 'c', chord: 'new', label: 'new chat' },
  { key: 'f', chord: 'search', label: 'search everything' },
  { key: '?', chord: 'help', label: 'this list' }
];

/** The chord's label for a menu or a tooltip, e.g. "⌃Q x". */
export function chordHint(chord) {
  const entry = PANE_CHORDS.find((c) => c.chord === chord);
  return entry ? `⌃Q ${entry.show ?? entry.key}` : '';
}

// The key after Ctrl-Q: { chord, n? } or null for one with nothing bound. Ctrl may still be down from the prefix; Cmd or Alt
// make it some other shortcut.
export function paneChord(event) {
  if (event.metaKey || event.altKey) return null;
  const key = String(event.key || '');
  if (/^[1-9]$/u.test(key)) return { chord: 'focus-n', n: Number(key) };
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const shifted = key.length === 1 && /[a-z]/iu.test(key) && event.shiftKey;
  const entry = PANE_CHORDS.find((c) => c.key === lower && Boolean(c.shift) === shifted);
  return entry ? { chord: entry.chord } : null;
}

// Ctrl-Shift-U / Ctrl-Shift-D: half a screen up (-1) or down (1) in the focused transcript, as in vim; 0 for anything
// else. Shift keeps plain Ctrl-D the text field's delete forward (an emacs binding he keeps, docs/UI-SHIPPING-CHECKLIST 7.2).
export function transcriptScroll(event) {
  if (!event.ctrlKey || !event.shiftKey || event.metaKey || event.altKey || event.isComposing) return 0;
  const key = String(event.key || '').toLowerCase();
  return key === 'u' ? -1 : key === 'd' ? 1 : 0;
}

// Ctrl-C stops the focused chat's turn, as in a terminal, on a Mac only: there copy is Cmd-C. Everywhere else Ctrl-C is copy.
export function isStopShortcut(event, apple = isApple()) {
  return apple && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.isComposing
    && String(event.key || '').toLowerCase() === 'c';
}
