// The notes page's vim mode: what a keydown is in vim's key notation, and how the engine's state
// follows the page when he moves the caret or edits with vim off. The engine itself is
// src/lib/core/vim.js, checked against a headless Neovim by tests/vim-parity.

import { createVim, vimKey, vimMode } from '../core/vim.js';

export const VIM_STORAGE_KEY = 'notes-vim';

/** The key in vim notation, or null for a key vim mode leaves to the page (⌘ chords, arrows). */
export function vimNotation(event) {
  if (event.metaKey || event.altKey) return null;
  if (event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === 'r') return '<C-r>';
    // Ctrl-C leaves insert and visual mode like Escape.
    if (key === '[' || key === 'c') return '<Esc>';
    return null;
  }
  switch (event.key) {
    case 'Escape': return '<Esc>';
    case 'Enter': return '<CR>';
    case 'Backspace': return '<BS>';
    case 'Tab': return '<Tab>';
    default: return event.key.length === 1 ? event.key : null;
  }
}

/** The view of a plain text with no marker heads: every offset is shown as itself. */
function plainView(text) {
  return {
    project: (offset) => offset,
    words: (offset) => {
      const start = text.lastIndexOf('\n', offset - 1) + 1;
      const next = text.indexOf('\n', offset);
      return { start, end: next < 0 ? text.length : next };
    }
  };
}

/**
 * Where the page draws an engine state, as a selection { start, end } in body offsets: the block
 * cursor in normal mode (one selected character, collapsed past the last one), the caret in insert
 * mode, the selection in visual mode when it stays on one line (otherwise the caret at the cursor,
 * the page edits one line at a time). `view.project(offset)` is where the page can show an offset
 * (never inside a line's marker, and canonical for a formatted line's markup), `view.words(offset)`
 * the body offsets of that line's words.
 */
export function vimDrawn(state, view = plainView(state.text)) {
  const at = view.project(state.cursor);
  const line = view.words(state.cursor);
  if (state.mode === 'insert') return { start: at, end: at };
  if ((state.mode === 'visual' || state.mode === 'visual-line') && state.anchor != null) {
    const other = view.words(state.anchor);
    if (other.start === line.start) {
      if (state.mode === 'visual-line') return { start: line.start, end: line.end };
      const from = view.project(state.anchor);
      return { start: Math.min(from, at), end: Math.min(line.end, Math.max(from, at) + 1) };
    }
    return { start: at, end: at };
  }
  if (state.mode === 'visual' || state.mode === 'visual-line') return { start: at, end: at };
  return { start: at, end: at < line.end ? at + 1 : at };
}

/** The engine state to apply the next key to, derived from the editor, which is the one source of
 * truth for the text and the caret. What vim alone owns (mode, registers, a half-typed command, `.`,
 * its undo history over this exact text) is carried in `state`; text and caret are re-read on every
 * key:
 *
 * - `state` is reused as it is only when the editor shows exactly what it drew for it: the same
 *   block, the same text, and the selection `vimDrawn` says it put there.
 * - The same text with the caret moved by something else (a click, an arrow, a focus change):
 *   what was in progress ends as Neovim ends it when the cursor is moved from outside (insert mode
 *   with its own <Esc>, so its undo step and `.` close; a visual selection or a half-typed command
 *   is dropped), the cursor goes to the caret, and insert mode is entered again there.
 * - Different text (a paste, ⌘Z, a remote edit, another note): the engine starts again on it at
 *   the caret, keeping registers and `.`, and insert mode if it was in insert mode.
 *
 * `at` is the editor's selection { start, end } in body offsets (or one offset); `view` is the
 * page's projection (see vimDrawn); `same` is false when the caret is in another block than the
 * one `state` was made on.
 */
export function syncVim(state, text, at, { view = null, same = true, moved = true } = {}) {
  const sel = typeof at === 'number' ? { start: at, end: at } : at;
  if (!state) return createVim(text, sel.start);
  const sameText = same && state.text === text;
  if (sameText) {
    if (!moved) return state;
    const drawn = vimDrawn(state, view || plainView(text));
    if (drawn.start === sel.start && drawn.end === sel.end) return state;
  }
  const wasInsert = state.mode === 'insert';
  let caret = Math.max(0, Math.min(sel.start, text.length));
  let base;
  if (sameText) {
    base = state;
    for (let i = 0; i < 4 && (base.mode !== 'normal' || base.pending.length); i += 1) base = vimKey(base, '<Esc>');
    if (base.text !== text) {
      // Leaving insert mode took out an autoindent nobody typed after: a caret below that line
      // moves up with the text, one on it stays on it.
      const lineEnd = text.indexOf('\n', state.cursor);
      if (lineEnd >= 0 && caret > lineEnd) caret -= text.length - base.text.length;
      caret = Math.max(0, Math.min(caret, base.text.length));
    }
    const fresh = createVim(base.text, caret);
    base = { ...base, cursor: fresh.cursor, curswant: fresh.curswant, setCurswant: false, vcolCache: fresh.vcolCache };
  } else {
    base = createVim(text, caret, carried(state));
  }
  if (!wasInsert) return base;
  // Back into insert mode at the caret: `i` before the character there, or `a` after the last one
  // when the caret is at the end of a line that has words.
  const lineStart = base.text.lastIndexOf('\n', caret - 1) + 1;
  const atEnd = caret > lineStart && (caret === base.text.length || base.text[caret] === '\n');
  return vimKey(atEnd ? { ...base, cursor: caret - 1 } : base, atEnd ? 'a' : 'i');
}

/** What vim owns and keeps when it starts again on other text: registers (the unnamed one too) and `.`. */
function carried(state) {
  const registers = { ...state._regs };
  if (state.registers?.['"']) registers['"'] = state.registers['"'];
  return { registers, lastChange: state.lastChange };
}

/** What the mode indicator says. */
export function vimLabel(state) {
  if (!state) return 'NORMAL';
  const mode = vimMode(state);
  if (mode === 'insert' || mode === 'insert-pending') return 'INSERT';
  if (mode === 'visual') return 'VISUAL';
  if (mode === 'visual-line') return 'V-LINE';
  const pending = (state.pending || []).join('');
  return pending ? `NORMAL ${pending}` : 'NORMAL';
}
