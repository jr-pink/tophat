// A pure vim emulation engine: plain-data state in, plain-data state out, one key at a time.
//
//   const s0 = createVim('hello world', 0);
//   const s1 = vimKey(s0, 'd'); const s2 = vimKey(s1, 'w');   // s2.text === 'world'
//   vimMode(s2) === 'normal'
//
// The semantics are Neovim's (nvim --clean) with the options in DEFAULTS, and the algorithms
// follow Neovim's own source (normal.c, ops.c, textobject.c, edit.c, undo.c, register.c) so that
// the edge cases match: exclusive motions that become inclusive or linewise, "cw" acting like
// "ce", the small-delete and numbered registers, undo cursor placement, autoindent removal on
// <Esc>, and so on. tests/vim-parity/ compares this engine with a real headless Neovim over
// every key sequence of bounded length; its README lists what is deliberately not modelled.
//
// Positions inside the engine are { l, c }: 0-based line and 0-based column (a UTF-16 index into
// the line, which equals Neovim's byte column for ASCII text). The state exposes the cursor as an
// offset into `text`.

export const MAXCOL = 2147483647;

/** Counts that generate text ({count}i, {count}p) are capped here; Neovim has no such cap. */
export const MAX_REPEAT = 10000;

// A character outside the BMP (an emoji) is two UTF-16 units but one character to Neovim. the
// public state (text, cursor, anchor, registers) is always in real text. The table is per
// process and only grows. A note that already contains one of the allocated PUA characters would
// read back as the emoji it stands for: accepted, and noted in the README.
const INTERN = new Map();   // astral character -> placeholder
const OUTERN = new Map();   // placeholder -> astral character
const WIDE = new Map();     // placeholder -> screen cells
let nextIntern = 0xf8fe;
const ASTRAL = /[\u{10000}-\u{10ffff}]/gu;

function encode(str) {
  if (!/[\ud800-\udbff]/.test(str)) return str;
  return str.replace(ASTRAL, (ch) => {
    let unit = INTERN.get(ch);
    if (!unit) {
      if (nextIntern < 0xe000) return ch;
      unit = String.fromCharCode(nextIntern--);
      INTERN.set(ch, unit);
      OUTERN.set(unit, ch);
      const code = ch.codePointAt(0);
      WIDE.set(unit, (code >= 0x1f000 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd) ? 2 : 1);
    }
    return unit;
  });
}
function decode(str) {
  if (!OUTERN.size || !/[\ue000-\uf8ff]/.test(str)) return str;
  return str.replace(/[\ue000-\uf8ff]/g, (unit) => OUTERN.get(unit) ?? unit);
}
/** An offset into real text as an offset into its interned form. */
function encodeOffset(text, offset) {
  if (!/[\ud800-\udbff]/.test(text)) return offset;
  let out = offset;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    const u = text.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff && INTERN.has(text.slice(i, i + 2))) out -= 1;
  }
  return out;
}
/** An offset into interned text as an offset into the real text. */
function decodeOffset(encoded, offset) {
  if (!OUTERN.size) return offset;
  let out = offset;
  for (let i = 0; i < offset && i < encoded.length; i += 1) if (OUTERN.has(encoded[i])) out += OUTERN.get(encoded[i]).length - 1;
  return out;
}
const encodeReg = (reg) => (reg && typeof reg.text === 'string' ? { ...reg, text: encode(reg.text) } : reg);
const decodeReg = (reg) => (reg && typeof reg.text === 'string' && OUTERN.size ? { ...reg, text: decode(reg.text) } : reg);

export const DEFAULTS = Object.freeze({
  shiftwidth: 2,
  tabstop: 8,
  expandtab: true,
  autoindent: true,
  smarttab: true,
  joinspaces: false,
  startofline: false,
  undolevels: 1000,
  // The window H, M, L, CTRL-D/U/E/Y and z commands scroll: a headless Neovim's 24 lines less the
  // command line and the status line. A note is one window of this height.
  windowHeight: 22
});

const OPERATORS = new Set(['d', 'c', 'y', '<', '>']);
const NUMBERED = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * @param {string} text buffer contents, lines separated by '\n'
 * @param {number} cursor offset into text
 * @param {object} options DEFAULTS overrides, plus `lastChange` (an initial redo command,
 *   { count, keys }) and `registers` (initial register contents)
 */
export function createVim(text, cursor = 0, options = {}) {
  const { lastChange = null, registers = null, ...rest } = options;
  const opts = { ...DEFAULTS, ...rest };
  const real = String(text);
  const lines = encode(real).split('\n');
  let pos = offsetToPos(lines, encodeOffset(real, Math.max(0, Math.min(cursor, real.length))));
  if (pos.c > 0 && pos.c >= lines[pos.l].length) pos = { l: pos.l, c: Math.max(0, lines[pos.l].length - 1) };
  const regs = {};
  if (registers) for (const [k, v] of Object.entries(registers)) if (k !== '"') regs[k] = encodeReg({ ...v });
  const state = {
    text: decode(lines.join('\n')),
    cursor: decodeOffset(lines.join('\n'), posToOffset(lines, pos)),
    mode: 'normal',
    anchor: null,
    registers: {},
    pending: [],
    lastFind: null,
    lastChange: lastChange ? { ...lastChange, keys: [...lastChange.keys] } : null,
    undo: [],
    redo: [],
    curswant: vcolOf(lines[pos.l], pos.c, opts.tabstop) + (lines[pos.l][pos.c] === '\t' ? charWidth('\t', vcolOf(lines[pos.l], pos.c, opts.tabstop), opts.tabstop) - 1 : 0),
    setCurswant: false,
    insert: null,
    change: null,
    visualRedo: null,
    reselect: null,
    unnamed: registers && registers['"'] ? '"' : null,
    unsupported: false,
    options: opts,
    _regs: regs,
    mlEmpty: false,
    topline: 0,
    scrollOpt: 0
  };
  if (registers && registers['"']) state._regs['"'] = encodeReg({ ...registers['"'] });
  state.vcolCache = { l: pos.l, c: pos.c, v: state.curswant, valid: true };
  state.registers = exportRegisters(state._regs, state.unnamed);
  if (OUTERN.size) for (const key of Object.keys(state.registers)) state.registers[key] = decodeReg(state.registers[key]);
  return state;
}

/** Apply one key (vim key notation: 'x', '<Esc>', '<CR>', '<BS>', '<Tab>', '<C-r>'). */
export function vimKey(state, key) {
  const ctx = load(state);
  handleKey(ctx, key);
  return store(ctx);
}

/** Apply a list of keys. */
export function vimKeys(state, keys) {
  const ctx = load(state);
  for (const key of keys) handleKey(ctx, key);
  return store(ctx);
}

/** 'normal' | 'insert' | 'visual' | 'visual-line' | 'operator-pending' | 'replace-pending' | 'pending' */
export function vimMode(state) {
  if (state.mode !== 'normal') {
    if (state.mode === 'insert' && state.pending.length) return 'insert-pending';
    return state.mode;
  }
  const parse = state.pending.length ? parseNormal(state.pending, false) : null;
  if (!parse) return 'normal';
  if (parse.waiting === 'r') return 'replace-pending';
  if (parse.blocking) return 'pending';
  if (parse.op) return 'operator-pending';
  return 'normal';
}

/** The mode string Neovim's nvim_get_mode() reports for the same state. */
export function vimNvimMode(state) {
  if (state.mode === 'insert') return 'i';
  if (state.mode === 'visual') return 'v';
  if (state.mode === 'visual-line') return 'V';
  if (state.pending.length) {
    const parse = parseNormal(state.pending, false);
    if (parse.op && !parse.blocking) return 'no' + (parse.force || '');
  }
  return 'n';
}

/** True when Neovim would be blocked inside a command waiting for another key. */
export function vimBlocking(state) {
  if (!state.pending.length) return false;
  if (state.mode === 'insert') return true; // <C-r> waiting for a register name
  return parseNormal(state.pending, state.mode !== 'normal').blocking;
}

/** Cursor as { line, col } (0-based). */
export function vimCursor(state) {
  const lines = state.text.split('\n');
  const p = offsetToPos(lines, state.cursor);
  return { line: p.l, col: p.c };
}

/** Visual anchor as { line, col }, or null outside visual mode. */
export function vimAnchor(state) {
  if (state.anchor == null) return null;
  const lines = state.text.split('\n');
  const p = offsetToPos(lines, state.anchor);
  return { line: p.l, col: p.c };
}

// ---------------------------------------------------------------------------------------------
// Offsets and columns

function offsetToPos(lines, offset) {
  let rest = offset;
  for (let l = 0; l < lines.length; l += 1) {
    if (rest <= lines[l].length) return { l, c: rest };
    rest -= lines[l].length + 1;
  }
  const l = lines.length - 1;
  return { l, c: lines[l].length };
}

function posToOffset(lines, pos) {
  let offset = 0;
  for (let l = 0; l < pos.l; l += 1) offset += lines[l].length + 1;
  return offset + pos.c;
}

function charWidth(ch, vcol, ts) {
  if (ch === '\t') return ts - (vcol % ts);
  const code = ch.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return 2;
  if (code < 0x1100) return 1;
  // Double-width characters (CJK, Hangul, fullwidth forms) take two screen cells, as in Neovim's
  // utf_char2cells; a character outside the BMP stands for itself as one interned unit (below).
  if (code >= 0xe000 && code <= 0xf8ff && WIDE.has(ch)) return WIDE.get(ch);
  if ((code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) return 2;
  return 1;
}

function vcolOf(line, col, ts) {
  let v = 0;
  for (let i = 0; i < col && i < line.length; i += 1) v += charWidth(line[i], v, ts);
  return v;
}

const isWhite = (ch) => ch === ' ' || ch === '\t';

// ---------------------------------------------------------------------------------------------
// Load / store

function load(state) {
  return {
    L: encode(state.text).split('\n'),
    cur: null,
    mode: state.mode,
    vis: null,
    pending: [...state.pending],
    lastFind: state.lastFind,
    lastChange: state.lastChange,
    undo: state.undo,
    redo: state.redo,
    curswant: state.curswant,
    setWant: state.setCurswant,
    ins: state.insert ? { ...state.insert, typed: [...state.insert.typed], insStart: { ...state.insert.insStart } } : null,
    chg: state.change,
    visualRedo: state.visualRedo,
    reselect: state.reselect,
    regs: { ...state._regs },
    unnamed: state.unnamed,
    unsupported: state.unsupported,
    mlEmpty: !!state.mlEmpty,
    vc: state.vcolCache || null,
    o: state.options,
    top: state.topline || 0,
    scrollOpt: state.scrollOpt || 0,
    stuffed: 0,
    rec: null,
    _state: state
  };
}

function store(ctx) {
  ensurePositions(ctx);
  const encoded = ctx.L.join('\n');
  const exported = exportRegisters(ctx.regs, ctx.unnamed);
  if (OUTERN.size) for (const key of Object.keys(exported)) exported[key] = decodeReg(exported[key]);
  return {
    text: decode(encoded),
    cursor: decodeOffset(encoded, posToOffset(ctx.L, ctx.cur)),
    mode: ctx.mode,
    anchor: ctx.vis ? decodeOffset(encoded, posToOffset(ctx.L, ctx.vis)) : null,
    registers: exported,
    pending: ctx.pending,
    lastFind: ctx.lastFind,
    lastChange: ctx.lastChange,
    undo: ctx.undo,
    redo: ctx.redo,
    curswant: ctx.curswant,
    setCurswant: ctx.setWant,
    insert: ctx.ins,
    change: ctx.chg,
    visualRedo: ctx.visualRedo,
    reselect: ctx.reselect,
    unnamed: ctx.unnamed,
    unsupported: ctx.unsupported,
    options: ctx.o,
    _regs: ctx.regs,
    topline: ctx.top,
    scrollOpt: ctx.scrollOpt,
    mlEmpty: ctx.mlEmpty && ctx.L.length === 1 && ctx.L[0] === '',
    vcolCache: ctx.vc
  };
}

function exportRegisters(regs, unnamed) {
  const out = {};
  for (const [k, v] of Object.entries(regs)) out[k] = v;
  out['"'] = unnamed && regs[unnamed] ? regs[unnamed] : null;
  return out;
}

// The cursor and visual anchor are decoded lazily because handleKey needs the lines first.
function ensurePositions(ctx) {
  if (ctx.cur) return;
  const s = ctx._state;
  ctx.cur = offsetToPos(ctx.L, encodeOffset(s.text, s.cursor));
  ctx.vis = s.anchor == null ? null : offsetToPos(ctx.L, encodeOffset(s.text, s.anchor));
}

// ---------------------------------------------------------------------------------------------
// Key dispatch

function handleKey(ctx, key) {
  key = encode(key);
  ensurePositions(ctx);
  if (ctx.mode === 'insert') {
    insertKey(ctx, key, true);
    if (ctx.mode === 'insert') insertCheck(ctx);
    else normalCheck(ctx);
    return;
  }
  ctx.pending.push(key);
  const visual = ctx.mode !== 'normal';
  const p = parseNormal(ctx.pending, visual);
  if (p.status === 'incomplete') return;
  ctx.pending = [];
  if (p.status === 'unsupported') {
    ctx.unsupported = true;
  } else if (p.status === 'done') {
    executeNormal(ctx, p);
  }
  // 'cancel': the command is abandoned (Neovim beeps); nothing changes.
  normalCheck(ctx);
}

// What Neovim does between keys in normal and visual mode: curswant catches up, an undo block
// that is not held open by insert mode is closed, and the cursor is kept on the text.
function normalCheck(ctx) {
  if (ctx.mlEmpty && !(ctx.L.length === 1 && ctx.L[0] === '')) ctx.mlEmpty = false;
  if (ctx.mode === 'insert') {
    insertCheck(ctx);
    return;
  }
  closeChange(ctx);
  if (ctx.keepNul && ctx.mode === 'normal') {
    // the cursor may stay on the end-of-line position until a later command moves it
    const len = ctx.L[ctx.cur.l].length;
    if (ctx.cur.c > len) ctx.cur = { l: ctx.cur.l, c: len };
  } else clampCursor(ctx);
  ctx.keepNul = false;
  updateTopline(ctx);
  const v = cachedVcol(ctx);
  if (ctx.setWant) {
    ctx.curswant = v;
    ctx.setWant = false;
  }
}

/**
 * w_virtcol as Neovim caches it. The cache is a value, a validity bit and the cursor position it
 * was validated at (w_valid_cursor). Between keys the position is checked: if the cursor moved
 * the value is recomputed. A text change at or above the cursor line clears the bit, and
 * coladvance() sets the value and the bit without touching the position. So a value computed in
 * one mode survives a switch to another, and a coladvance() made at another position during a
 * command is what a later curswant sees if the cursor ends where it started.
 */
function cachedVcol(ctx) {
  const c = ctx.vc;
  if (c && c.valid && c.l === ctx.cur.l && c.c === ctx.cur.c) return c.v;
  const v = cursorVcol(ctx);
  ctx.vc = { l: ctx.cur.l, c: ctx.cur.c, v, valid: true };
  return v;
}

/** w_virtcol: in normal and visual mode a cursor on a <Tab> sits on its last cell. */
function cursorVcol(ctx) {
  const line = ctx.L[ctx.cur.l];
  const v = vcolOf(line, ctx.cur.c, ctx.o.tabstop);
  const atOrBeforeAnchor = isVisual(ctx) && ctx.vis && !lt(ctx.vis, ctx.cur);
  if (ctx.mode !== 'insert' && line[ctx.cur.c] === '\t' && !atOrBeforeAnchor) return v + charWidth('\t', v, ctx.o.tabstop) - 1;
  return v;
}

function insertCheck(ctx) {
  if (ctx.mode !== 'insert') return;
  const v = cachedVcol(ctx);
  if (ctx.setWant && (!ctx.ins || ctx.ins.count <= 1)) {
    ctx.curswant = v;
    ctx.setWant = false;
  }
}

function clampCursor(ctx) {
  const n = ctx.L.length;
  if (ctx.cur.l >= n) ctx.cur = { l: n - 1, c: ctx.cur.c };
  if (ctx.cur.l < 0) ctx.cur = { l: 0, c: ctx.cur.c };
  const len = ctx.L[ctx.cur.l].length;
  const max = ctx.mode === 'visual' || ctx.mode === 'visual-line' ? len : Math.max(0, len - 1);
  if (ctx.cur.c > max) ctx.cur = { l: ctx.cur.l, c: max };
  if (ctx.cur.c < 0) ctx.cur = { l: ctx.cur.l, c: 0 };
}

// ---------------------------------------------------------------------------------------------
// Parsing a normal-mode command from its keys

const isCountStart = (k) => k.length === 1 && k >= '1' && k <= '9';
const isDigit = (k) => k.length === 1 && k >= '0' && k <= '9';
const SUPPORTED_REGS = /^[a-zA-Z0-9"\-_]$/;

/**
 * Returns { status: 'incomplete'|'done'|'cancel'|'unsupported', blocking, op, ... }.
 * blocking mirrors Neovim's nvim_get_mode().blocking: true while a command is half-typed
 * (count digits, a character argument), false between commands and while an operator waits.
 */
export function parseNormal(keys, visual) {
  let i = 0;
  let reg = null;
  let op = null;
  let force = null;
  let opcount = 0;
  const n = keys.length;
  for (;;) {
    let count0 = 0;
    while (i < n && (isCountStart(keys[i]) || (count0 > 0 && isDigit(keys[i])))) {
      count0 = Math.min(count0 * 10 + Number(keys[i]), 999999999);
      i += 1;
    }
    if (i === n) {
      return { status: 'incomplete', blocking: count0 > 0, op, reg, force };
    }
    const c = keys[i];
    i += 1;
    if (opcount) count0 = count0 ? Math.min(count0 * opcount, 999999999) : opcount;
    if ((op === 'gu' && c === 'u') || (op === 'gU' && c === 'U') || (op === 'g~' && c === '~')) {
      return done({ reg, op, count0, cmd: c, lineop: true, force });
    }
    if (c === '"') {
      if (op) return { status: 'cancel' };
      if (i === n) return { status: 'incomplete', blocking: true, op, reg, waiting: '"' };
      const r = keys[i];
      i += 1;
      if (r === '<Esc>') return { status: 'cancel' };
      if (r.length !== 1 || !SUPPORTED_REGS.test(r)) return { status: 'unsupported' };
      reg = r;
      opcount = count0;
      continue;
    }
    if (OPERATORS.has(c)) {
      if (visual) return done({ reg, op: c, count0, cmd: c, visualOp: true });
      if (op) {
        if (op === c) return done({ reg, op, count0, cmd: c, lineop: true, force });
        return { status: 'cancel' };
      }
      op = c;
      opcount = count0;
      continue;
    }
    if (op && (c === 'v' || c === 'V')) {
      // o_v / o_V: force the motion characterwise or linewise
      force = c;
      opcount = count0;
      continue;
    }
    let nchar = null;
    let waiting = null;
    if ('fFtTgz'.includes(c) && c.length === 1) waiting = c;
    else if (c === 'r' && !op) waiting = 'r';
    else if ((c === 'i' || c === 'a') && (op || visual)) waiting = 'obj';
    if (waiting) {
      if (i === n) return { status: 'incomplete', blocking: true, op, reg, waiting };
      nchar = keys[i];
      i += 1;
      if (nchar === '<Esc>') return { status: 'cancel' };
      if (c === 'g' && (nchar === 'u' || nchar === 'U' || nchar === '~')) {
        const gop = 'g' + nchar;
        if (visual) return done({ reg, op: gop, count0, cmd: gop, visualOp: true });
        if (op) {
          if (op === gop) return done({ reg, op, count0, cmd: gop, lineop: true, force });
          return { status: 'cancel' };
        }
        op = gop;
        opcount = count0;
        continue;
      }
    }
    return done({ reg, op, count0, cmd: c, nchar, force, opcount });
  }
  function done(x) {
    return { status: 'done', blocking: false, ...x, count1: x.count0 || 1 };
  }
}

// ---------------------------------------------------------------------------------------------
// Undo blocks

/** u_save(): open the undo block for this command (records the cursor at the first change). */
function uSave(ctx, top, bot) {
  if (ctx.vc && top <= ctx.cur.l) ctx.vc = { ...ctx.vc, valid: false };
  if (!ctx.chg) {
    ctx.chg = { before: ctx.L.join('\n'), uh: { ...ctx.cur }, top, botFromEnd: ctx.L.length - bot + 1, empty: !!ctx.mlEmpty };
  } else {
    ctx.chg = { ...ctx.chg, top: Math.min(ctx.chg.top, top), botFromEnd: Math.min(ctx.chg.botFromEnd, ctx.L.length - bot + 1) };
  }
}

const uSaveCursor = (ctx) => uSave(ctx, ctx.cur.l, ctx.cur.l + 2);

function closeChange(ctx) {
  if (!ctx.chg || ctx.mode === 'insert') return;
  // Store only the changed lines: the common prefix (p) and suffix (s) are left in the buffer.
  const bl = ctx.chg.before.split('\n');
  const al = ctx.L;
  const min = Math.min(bl.length, al.length);
  let p = 0;
  while (p < min && bl[p] === al[p]) p += 1;
  let sfx = 0;
  while (sfx < min - p && bl[bl.length - 1 - sfx] === al[al.length - 1 - sfx]) sfx += 1;
  const entry = { p, s: sfx, before: bl.slice(p, bl.length - sfx), after: al.slice(p, al.length - sfx), uh: ctx.chg.uh, top: ctx.chg.top, botFromEnd: ctx.chg.botFromEnd, empty: ctx.chg.empty };
  ctx.chg = null;
  let undo = [...ctx.undo, entry];
  if (undo.length > ctx.o.undolevels) undo = undo.slice(undo.length - ctx.o.undolevels);
  ctx.undo = undo;
  ctx.redo = [];
}

function undoRedo(ctx, undo) {
  const stack = undo ? ctx.undo : ctx.redo;
  if (!stack.length) return false;
  const entry = stack[stack.length - 1];
  const A = ctx.L;
  const B = [...A.slice(0, entry.p), ...(undo ? entry.before : entry.after), ...A.slice(A.length - entry.s)];
  // The changed region: the common prefix and suffix, widened to what the command saved.
  let P = 0;
  const min = Math.min(A.length, B.length);
  while (P < min && A[P] === B[P]) P += 1;
  let S = 0;
  while (S < min - P && A[A.length - 1 - S] === B[B.length - 1 - S]) S += 1;
  let top = Math.min(P, entry.top);
  if (top < 0) top = 0;
  S = 0;
  while (S < min - top && A[A.length - 1 - S] === B[B.length - 1 - S]) S += 1;
  S = Math.min(S, Math.max(0, entry.botFromEnd));
  const oldsize = A.length - top - S;
  const newsize = B.length - top - S;
  const uh = entry.uh; // 0-based line
  const uhl = uh.l + 1;
  let newCur = { ...ctx.cur };
  let lnum1 = ctx.cur.l + 1;
  if (uhl >= top && uhl <= top + newsize + 1) {
    newCur = { ...uh };
    lnum1 = uhl;
  } else {
    let i = 0;
    for (; i < newsize && i < oldsize; i += 1) if (B[top + i] !== A[top + i]) break;
    if (i === newsize) lnum1 = top + 1;
    else lnum1 = top + i + 1;
  }
  // UH_EMPTYBUF: the header remembers whether the buffer was "empty" (all lines deleted) when
  // the state it restores was current, and swaps in the state it is leaving.
  const wasEmpty = !!ctx.mlEmpty;
  ctx.L = B;
  ctx.mlEmpty = !!entry.empty && B.length === 1 && B[0] === '';
  const moved = { ...entry, empty: wasEmpty };
  // Whether undo leaves w_virtcol valid was measured, not derived (Neovim 0.12, see the vim
  // parity README): the cache survives an undo that only replaces lines at the end of a
  // multi-line buffer, and is invalidated otherwise.
  const atEnd = top + newsize === B.length;
  if (ctx.vc && (oldsize !== newsize || !atEnd || B.length === 1)) ctx.vc = { ...ctx.vc, valid: false };
  if (lnum1 > B.length) lnum1 = B.length;
  if (lnum1 < 1) lnum1 = 1;
  if (uhl + 1 === lnum1 && lnum1 > 1) lnum1 -= 1;
  ctx.cur = { l: lnum1 - 1, c: newCur.c };
  if (lnum1 === uhl) ctx.cur.c = uh.c;
  else beginline(ctx, BL_SOL | BL_FIX);
  clampCursor(ctx);
  if (undo) {
    ctx.undo = ctx.undo.slice(0, -1);
    ctx.redo = [...ctx.redo, moved];
  } else {
    ctx.redo = ctx.redo.slice(0, -1);
    ctx.undo = [...ctx.undo, moved];
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Registers

function setReg(ctx, name, text, linewise, append = false) {
  if (append && ctx.regs[name]) {
    const old = ctx.regs[name];
    if (linewise || old.linewise) ctx.regs[name] = { text: old.text + '\n' + text, linewise: true };
    else ctx.regs[name] = { text: old.text + text, linewise: false };
  } else {
    ctx.regs[name] = { text, linewise };
  }
}

function shiftDeleteRegisters(ctx, append) {
  for (let n = 9; n > 1; n -= 1) {
    const from = ctx.regs[String(n - 1)];
    if (from) ctx.regs[String(n)] = from;
    else delete ctx.regs[String(n)];
  }
  delete ctx.regs['1'];
  if (!append) ctx.unnamed = '1';
}

function yankText(ctx, oap) {
  const { start, end } = oap;
  if (oap.motionType === 'line') {
    return { text: ctx.L.slice(start.l, end.l + 1).join('\n'), linewise: true };
  }
  const endc = end.c + (oap.inclusive ? 1 : 0);
  if (start.l === end.l) return { text: ctx.L[start.l].slice(start.c, endc), linewise: false };
  const parts = [ctx.L[start.l].slice(start.c)];
  for (let l = start.l + 1; l < end.l; l += 1) parts.push(ctx.L[l]);
  parts.push(ctx.L[end.l].slice(0, endc));
  return { text: parts.join('\n'), linewise: false };
}

function regIndexName(r) {
  return r.toLowerCase();
}

function opYank(ctx, oap) {
  const reg = oap.reg;
  if (reg === '_') return;
  const { text, linewise } = yankText(ctx, oap);
  if (reg && reg !== '"') {
    const name = regIndexName(reg);
    setReg(ctx, name, text, linewise, reg !== name);
    ctx.unnamed = name;
  } else {
    setReg(ctx, '0', text, linewise);
    ctx.unnamed = '0';
  }
}

function getPutRegister(ctx, reg) {
  if (!reg || reg === '"') return ctx.unnamed ? ctx.regs[ctx.unnamed] || null : null;
  if (reg === '_') return null;
  return ctx.regs[regIndexName(reg)] || null;
}

// ---------------------------------------------------------------------------------------------
// Cursor primitives (memline.c inc/dec, edit.c oneleft/oneright/beginline, cursor.c coladvance)

const BL_WHITE = 1;
const BL_SOL = 2;
const BL_FIX = 4;

function beginline(ctx, flags) {
  if ((flags & BL_SOL) && !ctx.o.startofline) {
    coladvance(ctx, ctx.curswant);
    return;
  }
  const line = ctx.L[ctx.cur.l];
  let c = 0;
  if (flags & (BL_WHITE | BL_SOL)) {
    while (c < line.length && isWhite(line[c]) && !((flags & BL_FIX) && c + 1 === line.length)) c += 1;
  }
  ctx.cur = { l: ctx.cur.l, c };
  ctx.setWant = true;
}

function oneMore(ctx) {
  return ctx.mode === 'insert' || ctx.mode === 'visual' || ctx.mode === 'visual-line' || ctx.forceOneMore;
}

function colFor(ctx, l, wcol) {
  const line = ctx.L[l];
  const more = oneMore(ctx) ? 1 : 0;
  if (wcol >= MAXCOL) return Math.max(0, line.length - 1 + more);
  let col = 0;
  let idx = 0;
  let csize = 0;
  while (col <= wcol && idx < line.length) {
    csize = charWidth(line[idx], col, ctx.o.tabstop);
    col += csize;
    idx += 1;
  }
  if (col > wcol || !more) idx -= 1;
  return Math.max(idx, 0);
}

function coladvance(ctx, wcol) {
  ctx.cur = { l: ctx.cur.l, c: colFor(ctx, ctx.cur.l, wcol) };
  if (!ctx.vc) return;
  // coladvance() succeeds only when the character reached starts exactly at wcol; then the
  // cached virtcol is set (unless it is a <Tab>), otherwise the cache is invalidated
  const line = ctx.L[ctx.cur.l];
  const ok = wcol < MAXCOL && wcol >= 0 && vcolOf(line, ctx.cur.c, ctx.o.tabstop) >= wcol;
  if (!ok) ctx.vc = { ...ctx.vc, valid: false };
  else if (line[ctx.cur.c] !== '\t') ctx.vc = { ...ctx.vc, v: wcol, valid: true };
}

function gchar(ctx, p) {
  const line = ctx.L[p.l];
  return p.c < line.length ? line[p.c] : '';
}

/** inc(): 0 moved within the line, 2 moved onto the NUL, 1 moved to the next line, -1 at end. */
function inc(ctx, p) {
  const line = ctx.L[p.l];
  if (p.c < line.length) {
    p.c += 1;
    return p.c < line.length ? 0 : 2;
  }
  if (p.l < ctx.L.length - 1) {
    p.l += 1;
    p.c = 0;
    return 1;
  }
  return -1;
}

function incl(ctx, p) {
  let r = inc(ctx, p);
  if (r >= 1 && p.c) r = inc(ctx, p);
  return r;
}

function dec(ctx, p) {
  if (p.c > 0) {
    p.c = Math.min(p.c, ctx.L[p.l].length + 1) - 1;
    return 0;
  }
  if (p.l > 0) {
    p.l -= 1;
    p.c = ctx.L[p.l].length;
    return 1;
  }
  return -1;
}

function decl(ctx, p) {
  let r = dec(ctx, p);
  if (r === 1 && p.c) r = dec(ctx, p);
  return r;
}

const lt = (a, b) => a.l < b.l || (a.l === b.l && a.c < b.c);
const eqpos = (a, b) => a.l === b.l && a.c === b.c;

function oneright(ctx) {
  const line = ctx.L[ctx.cur.l];
  if (ctx.cur.c >= line.length) return false;
  if (ctx.cur.c + 1 >= line.length) return false;
  ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + 1 };
  ctx.setWant = true;
  return true;
}

function oneleft(ctx) {
  if (ctx.cur.c === 0) return false;
  ctx.setWant = true;
  ctx.cur = { l: ctx.cur.l, c: ctx.cur.c - 1 };
  return true;
}

function inindent(ctx, extra) {
  const line = ctx.L[ctx.cur.l];
  let col = 0;
  while (col < line.length && isWhite(line[col])) col += 1;
  return col >= ctx.cur.c + extra;
}

function getIndent(line, ts) {
  let v = 0;
  for (const ch of line) {
    if (ch === ' ') v += 1;
    else if (ch === '\t') v += ts - (v % ts);
    else break;
  }
  return v;
}

function indentString(ctx, width) {
  if (ctx.o.expandtab) return ' '.repeat(width);
  const ts = ctx.o.tabstop;
  return '\t'.repeat(Math.floor(width / ts)) + ' '.repeat(width % ts);
}

function leadingWhite(line) {
  let i = 0;
  while (i < line.length && isWhite(line[i])) i += 1;
  return i;
}

// ---------------------------------------------------------------------------------------------
// Word classes and word motions (textobject.c)

// Neovim's utf_class() for characters above Latin-1 (mbyte.c): emoji are a class of their own
// (3), and so is each script without spaces (CJK, kana, Hangul), so "na🙂ve" and "中文item" are
// three and two words. Punctuation and symbol blocks are class 1, spaces 0, the rest 2.
const UTF_CLASSES = [
  [0x037e, 0x037e, 1], [0x0387, 0x0387, 1], [0x055a, 0x055f, 1], [0x0589, 0x0589, 1], [0x05be, 0x05be, 1],
  [0x05c0, 0x05c0, 1], [0x05c3, 0x05c3, 1], [0x05f3, 0x05f4, 1], [0x060c, 0x060c, 1], [0x061b, 0x061b, 1],
  [0x061f, 0x061f, 1], [0x066a, 0x066d, 1], [0x06d4, 0x06d4, 1], [0x0700, 0x070d, 1], [0x0964, 0x0965, 1],
  [0x0970, 0x0970, 1], [0x0df4, 0x0df4, 1], [0x0e4f, 0x0e4f, 1], [0x0e5a, 0x0e5b, 1], [0x0f04, 0x0f12, 1],
  [0x0f3a, 0x0f3d, 1], [0x0f85, 0x0f85, 1], [0x104a, 0x104f, 1], [0x10fb, 0x10fb, 1], [0x1361, 0x1368, 1],
  [0x166d, 0x166e, 1], [0x1680, 0x1680, 0], [0x169b, 0x169c, 1], [0x16eb, 0x16ed, 1], [0x1735, 0x1736, 1],
  [0x17d4, 0x17dc, 1], [0x1800, 0x180a, 1], [0x2000, 0x200b, 0], [0x200c, 0x2027, 1], [0x2028, 0x2029, 0],
  [0x202a, 0x202e, 1], [0x202f, 0x202f, 0], [0x2030, 0x205e, 1], [0x205f, 0x205f, 0], [0x2060, 0x206f, 1],
  [0x2070, 0x207f, 0x2070], [0x2080, 0x2094, 0x2080], [0x20a0, 0x27ff, 1], [0x2800, 0x28ff, 0x2800],
  [0x2900, 0x2998, 1], [0x29d8, 0x29db, 1], [0x29fc, 0x29fd, 1], [0x2e00, 0x2e7f, 1], [0x3000, 0x3000, 0],
  [0x3001, 0x3020, 1], [0x3030, 0x3030, 1], [0x303d, 0x303d, 1], [0x3040, 0x309f, 0x3040],
  [0x30a0, 0x30ff, 0x30a0], [0x3300, 0x9fff, 0x4e00], [0xac00, 0xd7a3, 0xac00], [0xf900, 0xfaff, 0x4e00],
  [0xfd3e, 0xfd3f, 1], [0xfe30, 0xfe6b, 1], [0xff00, 0xff0f, 1], [0xff1a, 0xff20, 1], [0xff3b, 0xff40, 1],
  [0xff5b, 0xff65, 1], [0x1d000, 0x1d24f, 1], [0x1d400, 0x1d7ff, 1], [0x1f000, 0x1f2ff, 1], [0x1f300, 0x1f9ff, 1],
  [0x20000, 0x2a6df, 0x4e00], [0x2a700, 0x2b73f, 0x4e00], [0x2b740, 0x2b81f, 0x4e00], [0x2f800, 0x2fa1f, 0x4e00]
];
// Case mapping one character at a time, as Neovim's utf_toupper/utf_tolower: a mapping that is not
// one character (ß to SS) does not apply, except ß, which Neovim upper-cases to ẞ.
function caseOne(ch, to) {
  if (to === 'upper' && ch === 'ß') return 'ẞ';
  const mapped = to === 'upper' ? ch.toUpperCase() : ch.toLowerCase();
  return [...mapped].length === 1 ? mapped : ch;
}
function caseMap(text, how) {
  return [...text].map((ch) => {
    if (how !== 'swap') return caseOne(ch, how);
    const up = caseOne(ch, 'upper');
    return up !== ch ? up : caseOne(ch, 'lower');
  }).join('');
}

function utfClass(code) {
  // Emoji first, as Neovim checks its emoji table before the class table (the astral pictographs).
  if ((code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f680 && code <= 0x1f6ff) || (code >= 0x1f900 && code <= 0x1faff)) return 3;
  for (const [lo, hi, c] of UTF_CLASSES) if (code >= lo && code <= hi) return c;
  return 2;
}

function clsAt(ctx, p, bigword) {
  const ch = gchar(ctx, p);
  if (ch === '' || ch === ' ' || ch === '\t') return 0;
  const code = ch.charCodeAt(0);
  let c;
  if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || (code >= 0xc0 && code <= 0xff && code !== 0xd7 && code !== 0xf7)) c = 2;
  else if (code < 0x100) c = 1;
  else c = utfClass(OUTERN.has(ch) ? OUTERN.get(ch).codePointAt(0) : code);
  if (c !== 0 && bigword) return 1;
  return c;
}

function fwdWord(ctx, count, bigword, eol) {
  const p = ctx.cur;
  const cls = () => clsAt(ctx, p, bigword);
  while (--count >= 0) {
    const sclass = cls();
    const lastLine = p.l === ctx.L.length - 1;
    let i = inc(ctx, p);
    if (i === -1 || (i >= 1 && lastLine)) return false;
    if (i >= 1 && eol && count === 0) return true;
    if (sclass !== 0) {
      while (cls() === sclass) {
        i = inc(ctx, p);
        if (i === -1 || (i >= 1 && eol && count === 0)) return true;
      }
    }
    while (cls() === 0) {
      if (p.c === 0 && ctx.L[p.l].length === 0) break;
      i = inc(ctx, p);
      if (i === -1 || (i >= 1 && eol && count === 0)) return true;
    }
  }
  return true;
}

function skipChars(ctx, p, cclass, dir, bigword) {
  while (clsAt(ctx, p, bigword) === cclass) {
    if ((dir > 0 ? inc(ctx, p) : dec(ctx, p)) === -1) return true;
  }
  return false;
}

function bckWord(ctx, count, bigword, stop) {
  const p = ctx.cur;
  const cls = () => clsAt(ctx, p, bigword);
  while (--count >= 0) {
    const sclass = cls();
    if (dec(ctx, p) === -1) return false;
    let finished = false;
    if (!stop || sclass === cls() || sclass === 0) {
      let hitStart = false;
      while (cls() === 0) {
        if (p.c === 0 && ctx.L[p.l].length === 0) {
          finished = true;
          break;
        }
        if (dec(ctx, p) === -1) {
          hitStart = true;
          break;
        }
      }
      if (hitStart) return true;
      if (!finished && skipChars(ctx, p, cls(), -1, bigword)) return true;
    }
    if (!finished) inc(ctx, p);
    stop = false;
  }
  return true;
}

function endWord(ctx, count, bigword, stop, empty) {
  const p = ctx.cur;
  const cls = () => clsAt(ctx, p, bigword);
  while (--count >= 0) {
    const sclass = cls();
    if (inc(ctx, p) === -1) return false;
    let finished = false;
    if (cls() === sclass && sclass !== 0) {
      if (skipChars(ctx, p, sclass, 1, bigword)) return false;
    } else if (!stop || sclass === 0) {
      while (cls() === 0) {
        if (empty && p.c === 0 && ctx.L[p.l].length === 0) {
          finished = true;
          break;
        }
        if (inc(ctx, p) === -1) return false;
      }
      if (!finished && skipChars(ctx, p, cls(), 1, bigword)) return false;
    }
    if (!finished) dec(ctx, p);
    stop = false;
  }
  return true;
}

function bckendWord(ctx, count, bigword, eol) {
  const p = ctx.cur;
  const cls = () => clsAt(ctx, p, bigword);
  while (--count >= 0) {
    const sclass = cls();
    let i = dec(ctx, p);
    if (i === -1) return false;
    if (eol && i === 1) return true;
    if (sclass !== 0) {
      while (cls() === sclass) {
        i = dec(ctx, p);
        if (i === -1 || (eol && i === 1)) return true;
      }
    }
    while (cls() === 0) {
      if (p.c === 0 && ctx.L[p.l].length === 0) break;
      i = dec(ctx, p);
      if (i === -1 || (eol && i === 1)) return true;
    }
  }
  return true;
}

function backInLine(ctx, bigword) {
  const p = ctx.cur;
  const sclass = clsAt(ctx, p, bigword);
  for (;;) {
    if (p.c === 0) break;
    dec(ctx, p);
    if (clsAt(ctx, p, bigword) !== sclass) {
      inc(ctx, p);
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Paragraphs (findpar, startPS)

const PARA_MACROS = 'IPLPPPQPP TPHPLIPpLpItpplpipbp';
const SECT_MACROS = 'SHNHH HUnhsh';

function inmacro(opt, s) {
  for (let m = 0; m < opt.length; m += 2) {
    const a = opt[m];
    const b = opt[m + 1] ?? '';
    const s0 = s[0] ?? '';
    const s1 = s[1] ?? '';
    if ((a === s0 || (a === ' ' && (s0 === '' || s0 === ' '))) && (b === s1 || ((b === '' || b === ' ') && (s0 === '' || s1 === '' || s1 === ' ')))) return true;
  }
  return false;
}

function startPS(ctx, l, para, both) {
  const s = ctx.L[l];
  const c0 = s[0] ?? '';
  if (c0 === para || c0 === '\f' || (both && c0 === '}')) return true;
  if (c0 === '.' && (inmacro(SECT_MACROS, s.slice(1)) || (!para && inmacro(PARA_MACROS, s.slice(1))))) return true;
  return false;
}

function findpar(ctx, oap, dir, count) {
  let curr = ctx.cur.l;
  while (count--) {
    let didSkip = false;
    for (let first = true; ; first = false) {
      if (ctx.L[curr] !== '') didSkip = true;
      if (!first && didSkip && startPS(ctx, curr, '', false)) break;
      curr += dir;
      if (curr < 0 || curr >= ctx.L.length) {
        if (count) return false;
        curr -= dir;
        break;
      }
    }
  }
  ctx.cur = { l: curr, c: 0 };
  if (curr === ctx.L.length - 1 && dir > 0) {
    const len = ctx.L[curr].length;
    if (len !== 0) {
      ctx.cur = { l: curr, c: len - 1 };
      if (oap) oap.inclusive = true;
    }
  }
  return true;
}

const linewhite = (ctx, l) => ctx.L[l].trim() === '' && /^[ \t]*$/.test(ctx.L[l]);

// ---------------------------------------------------------------------------------------------
// Matching pairs for % (a reduced findmatchlimit: plain nesting over "(){}[]")

const PAIRS = { '(': [')', 1], ')': ['(', -1], '{': ['}', 1], '}': ['{', -1], '[': [']', 1], ']': ['[', -1] };

function findmatch(ctx) {
  const line = ctx.L[ctx.cur.l];
  let c = ctx.cur.c;
  if (c >= line.length && c > 0) c = line.length - 1;
  while (c < line.length && !PAIRS[line[c]]) c += 1;
  if (c >= line.length) return null;
  const open = line[c];
  const [close, dir] = PAIRS[open];
  let depth = 0;
  const p = { l: ctx.cur.l, c };
  for (;;) {
    const r = dir > 0 ? inc(ctx, p) : dec(ctx, p);
    if (r === -1) return null;
    const ch = gchar(ctx, p);
    if (ch === open) depth += 1;
    else if (ch === close) {
      if (depth === 0) return { l: p.l, c: p.c };
      depth -= 1;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Text objects (current_word, current_quote, current_par)

function currentWord(ctx, oap, count, include, bigword) {
  const visual = isVisual(ctx);
  let startPos = null;
  let inclusive = true;
  let includeWhite = false;
  const cls = () => clsAt(ctx, ctx.cur, bigword);
  if (!visual || eqpos(ctx.cur, ctx.vis)) {
    backInLine(ctx, bigword);
    startPos = { ...ctx.cur };
    if ((cls() === 0) === include) {
      if (!endWord(ctx, 1, bigword, true, true)) return false;
    } else {
      fwdWord(ctx, 1, bigword, true);
      if (ctx.cur.c === 0) decl(ctx, ctx.cur);
      else oneleftRaw(ctx);
      if (include) includeWhite = true;
    }
    if (visual) {
      ctx.vis = { ...startPos };
    } else {
      oap.start = { ...startPos };
      oap.motionType = 'char';
    }
    count -= 1;
  }
  while (count > 0) {
    inclusive = true;
    if (visual && lt(ctx.cur, ctx.vis)) {
      if (decl(ctx, ctx.cur) === -1) return false;
      if (include !== (cls() !== 0)) {
        if (!bckWord(ctx, 1, bigword, true)) return false;
      } else {
        if (!bckendWord(ctx, 1, bigword, true)) return false;
        incl(ctx, ctx.cur);
      }
    } else {
      if (incl(ctx, ctx.cur) === -1) return false;
      if (include !== (cls() === 0)) {
        if (!fwdWord(ctx, 1, bigword, true) && count > 1) return false;
        if (!oneleftRaw(ctx)) inclusive = false;
      } else if (!endWord(ctx, 1, bigword, true, true)) return false;
    }
    count -= 1;
  }
  if (includeWhite && (cls() !== 0 || (ctx.cur.c === 0 && !inclusive))) {
    const pos = { ...ctx.cur };
    ctx.cur = { ...startPos };
    if (oneleftRaw(ctx)) {
      backInLine(ctx, bigword);
      if (cls() === 0 && ctx.cur.c > 0) {
        if (visual) ctx.vis = { ...ctx.cur };
        else oap.start = { ...ctx.cur };
      }
    }
    ctx.cur = pos;
  }
  if (visual) {
    if (ctx.mode === 'visual-line') ctx.mode = 'visual';
  } else {
    oap.inclusive = inclusive;
  }
  return true;
}

function oneleftRaw(ctx) {
  if (ctx.cur.c === 0) return false;
  ctx.cur.c -= 1;
  ctx.setWant = true;
  return true;
}

function findNextQuote(line, col, q, escape) {
  for (;;) {
    const c = line[col];
    if (c === undefined) return -1;
    if (escape && escape.includes(c)) {
      col += 1;
      if (line[col] === undefined) return -1;
    } else if (c === q) break;
    col += 1;
  }
  return col;
}

function findPrevQuote(line, colStart, q, escape) {
  while (colStart > 0) {
    colStart -= 1;
    let n = 0;
    if (escape) while (colStart - n > 0 && escape.includes(line[colStart - n - 1])) n += 1;
    if (n & 1) colStart -= n;
    else if (line[colStart] === q) break;
  }
  return colStart;
}

function currentQuote(ctx, oap, count, include, q) {
  const line = ctx.L[ctx.cur.l];
  const at = (i) => (i >= 0 && i < line.length ? line[i] : '');
  let colStart = ctx.cur.c;
  let colEnd;
  let inclusive = false;
  const visual = isVisual(ctx);
  let visEmpty = true;
  let visBefCurs = false;
  let insideQuotes = false;
  let selectedQuote = false;
  if (visual) {
    if (ctx.vis.l !== ctx.cur.l) return false;
    visBefCurs = lt(ctx.vis, ctx.cur);
    visEmpty = eqpos(ctx.vis, ctx.cur);
  }
  if (!visEmpty) {
    let i;
    if (visBefCurs) {
      insideQuotes = ctx.vis.c > 0 && at(ctx.vis.c - 1) === q && at(ctx.cur.c) !== '' && at(ctx.cur.c + 1) === q;
      i = ctx.vis.c;
      colEnd = ctx.cur.c;
    } else {
      insideQuotes = ctx.cur.c > 0 && at(ctx.cur.c - 1) === q && at(ctx.vis.c) !== '' && at(ctx.vis.c + 1) === q;
      i = ctx.cur.c;
      colEnd = ctx.vis.c;
    }
    while (i <= colEnd) {
      if (at(i) === '') break;
      if (at(i++) === q) {
        selectedQuote = true;
        break;
      }
    }
  }
  if (!visEmpty && at(colStart) === q) {
    if (visBefCurs) {
      colStart = findNextQuote(line, colStart + 1, q, null);
      if (colStart < 0) return false;
      colEnd = findNextQuote(line, colStart + 1, q, '\\');
      if (colEnd < 0) {
        colEnd = colStart;
        colStart = ctx.cur.c;
      }
    } else {
      colEnd = findPrevQuote(line, colStart, q, null);
      if (at(colEnd) !== q) return false;
      colStart = findPrevQuote(line, colEnd, q, '\\');
      if (at(colStart) !== q) {
        colStart = colEnd;
        colEnd = ctx.cur.c;
      }
    }
  } else if (at(colStart) === q || !visEmpty) {
    let firstCol = colStart;
    if (!visEmpty) {
      if (visBefCurs) firstCol = findNextQuote(line, colStart, q, null);
      else firstCol = findPrevQuote(line, colStart, q, null);
    }
    colStart = 0;
    for (;;) {
      colStart = findNextQuote(line, colStart, q, null);
      if (colStart < 0 || colStart > firstCol) return false;
      colEnd = findNextQuote(line, colStart + 1, q, '\\');
      if (colEnd < 0) return false;
      if (colStart <= firstCol && firstCol <= colEnd) break;
      colStart = colEnd + 1;
    }
  } else {
    colStart = findPrevQuote(line, colStart, q, '\\');
    if (at(colStart) !== q) {
      colStart = findNextQuote(line, colStart, q, null);
      if (colStart < 0) return false;
    }
    colEnd = findNextQuote(line, colStart + 1, q, '\\');
    if (colEnd < 0) return false;
  }
  if (include) {
    if (isWhite(at(colEnd + 1))) {
      while (isWhite(at(colEnd + 1))) colEnd += 1;
    } else {
      while (colStart > 0 && isWhite(at(colStart - 1))) colStart -= 1;
    }
  }
  if (!include && count < 2 && (visEmpty || !insideQuotes)) colStart += 1;
  ctx.cur = { l: ctx.cur.l, c: colStart };
  if (visual) {
    if (visEmpty || (visBefCurs && !selectedQuote && (insideQuotes || (at(ctx.vis.c) !== q && (ctx.vis.c === 0 || at(ctx.vis.c - 1) !== q))))) {
      ctx.vis = { ...ctx.cur };
    }
  } else {
    oap.start = { ...ctx.cur };
    oap.motionType = 'char';
  }
  ctx.cur = { l: ctx.cur.l, c: colEnd };
  if ((include || count > 1 || (!visEmpty && insideQuotes)) && inc(ctx, ctx.cur) === 2) inclusive = true;
  if (visual) {
    if (visEmpty || visBefCurs) {
      dec(ctx, ctx.cur);
    } else {
      if (insideQuotes || (!selectedQuote && at(ctx.vis.c) !== q && (at(ctx.vis.c) === '' || at(ctx.vis.c + 1) !== q))) {
        dec(ctx, ctx.cur);
        ctx.vis = { ...ctx.cur };
      }
      ctx.cur = { l: ctx.cur.l, c: colStart };
    }
    if (ctx.mode === 'visual-line') ctx.mode = 'visual';
  } else {
    oap.inclusive = inclusive;
  }
  return true;
}

function currentPar(ctx, oap, count, include) {
  const visual = isVisual(ctx);
  let startL = ctx.cur.l;
  const last = ctx.L.length - 1;
  const extend = () => {
    const dir = startL < ctx.vis.l ? -1 : 1;
    let ok = true;
    for (let i = count; --i >= 0;) {
      if (startL === (dir < 0 ? 0 : last)) {
        ok = false;
        break;
      }
      let prevWhite = -1;
      for (let t = 0; t < 2; t += 1) {
        startL += dir;
        const white = linewhite(ctx, startL) ? 1 : 0;
        if (prevWhite === white) {
          startL -= dir;
          break;
        }
        for (;;) {
          if (startL === (dir < 0 ? 0 : last)) break;
          if (white !== (linewhite(ctx, startL + dir) ? 1 : 0) || (!white && startPS(ctx, startL + (dir > 0 ? 1 : 0), '', false))) break;
          startL += dir;
        }
        if (!include) break;
        if (startL === (dir < 0 ? 0 : last)) break;
        prevWhite = white;
      }
    }
    ctx.cur = { l: startL, c: 0 };
    return ok;
  };
  if (visual && startL !== ctx.vis.l) return extend();
  const whiteInFront = linewhite(ctx, startL);
  while (startL > 0) {
    if (whiteInFront) {
      if (!linewhite(ctx, startL - 1)) break;
    } else if (linewhite(ctx, startL - 1) || startPS(ctx, startL, '', false)) break;
    startL -= 1;
  }
  let endL = startL;
  while (endL <= last && linewhite(ctx, endL)) endL += 1;
  endL -= 1;
  let i = count;
  if (!include && whiteInFront) i -= 1;
  let doWhite = false;
  while (i--) {
    if (endL === last) return false;
    if (!include) doWhite = linewhite(ctx, endL + 1);
    if (include || !doWhite) {
      endL += 1;
      while (endL < last && !linewhite(ctx, endL + 1) && !startPS(ctx, endL + 1, '', false)) endL += 1;
    }
    if (i === 0 && whiteInFront && include) break;
    if (include || doWhite) while (endL < last && linewhite(ctx, endL + 1)) endL += 1;
  }
  if (!whiteInFront && !linewhite(ctx, endL) && include) {
    while (startL > 0 && linewhite(ctx, startL - 1)) startL -= 1;
  }
  if (visual) {
    if (ctx.mode === 'visual-line' && startL === ctx.cur.l) {
      return extend();
    }
    if (ctx.vis.l !== startL) ctx.vis = { l: startL, c: 0 };
    ctx.mode = 'visual-line';
  } else {
    oap.start = { l: startL, c: 0 };
    oap.motionType = 'line';
  }
  ctx.cur = { l: endL, c: 0 };
  return true;
}

const isVisual = (ctx) => ctx.mode === 'visual' || ctx.mode === 'visual-line';

// ---------------------------------------------------------------------------------------------
// Motions. Each returns false when it fails (Neovim beeps and abandons any operator).

function motion(ctx, cap, oap) {
  const c = cap.cmd;
  const count1 = cap.count1;
  const opPending = !!oap.op;
  switch (c) {
    case 'h':
    case '<BS>':
      return nvLeft(ctx, cap, oap);
    case 'l':
    case ' ':
      return nvRight(ctx, cap, oap);
    case 'j':
    case 'k':
    case '<CR>':
    case '+':
    case '-': {
      oap.motionType = 'line';
      const down = c === 'j' || c === '<CR>' || c === '+';
      if (down) {
        if (count1 > 0 && ctx.cur.l >= ctx.L.length - 1) return false;
        ctx.cur = { l: Math.min(ctx.cur.l + count1, ctx.L.length - 1), c: ctx.cur.c };
      } else {
        if (count1 > 0 && ctx.cur.l <= 0) return false;
        ctx.cur = { l: Math.max(ctx.cur.l - count1, 0), c: ctx.cur.c };
      }
      coladvance(ctx, ctx.curswant);
      if (c === '<CR>' || c === '+' || c === '-') beginline(ctx, BL_WHITE | BL_FIX);
      return true;
    }
    case 'w':
    case 'W':
    case 'e':
    case 'E':
      return nvWordcmd(ctx, cap, oap);
    case 'b':
    case 'B':
      oap.motionType = 'char';
      oap.inclusive = false;
      ctx.setWant = true;
      return bckWord(ctx, count1, c === 'B', false);
    case '0':
      oap.motionType = 'char';
      oap.inclusive = false;
      beginline(ctx, 0);
      return true;
    case '^':
      oap.motionType = 'char';
      oap.inclusive = false;
      beginline(ctx, BL_WHITE | BL_FIX);
      return true;
    case '$': {
      oap.motionType = 'char';
      oap.inclusive = true;
      ctx.curswant = MAXCOL;
      ctx.setWant = false;
      if (count1 - 1 > 0 && ctx.cur.l >= ctx.L.length - 1) return false;
      ctx.cur = { l: Math.min(ctx.cur.l + count1 - 1, ctx.L.length - 1), c: ctx.cur.c };
      coladvance(ctx, ctx.curswant);
      return true;
    }
    case 'G':
    case 'g': {
      if (c === 'g' && (cap.nchar === 'e' || cap.nchar === 'E')) {
        oap.motionType = 'char';
        ctx.setWant = true;
        oap.inclusive = true;
        return bckendWord(ctx, count1, cap.nchar === 'E', false);
      }
      if (c === 'g' && cap.nchar === '_') {
        // nv_g_cmd "g_": the last non-blank of the line count - 1 down, inclusive
        oap.motionType = 'char';
        oap.inclusive = true;
        ctx.curswant = MAXCOL;
        if (count1 - 1 > 0 && ctx.cur.l + count1 - 1 >= ctx.L.length) return false;
        ctx.cur = { l: ctx.cur.l + count1 - 1, c: ctx.cur.c };
        coladvance(ctx, MAXCOL);
        const line = ctx.L[ctx.cur.l];
        let col = ctx.cur.c;
        if (col > 0 && col >= line.length) col -= 1;
        while (col > 0 && isWhite(line[col])) col -= 1;
        ctx.cur = { l: ctx.cur.l, c: col };
        ctx.setWant = true;
        return true;
      }
      if (c === 'g' && cap.nchar !== 'g') return null;
      oap.motionType = 'line';
      let lnum = c === 'G' ? ctx.L.length : 1;
      if (cap.count0) lnum = cap.count0;
      lnum = Math.min(Math.max(lnum, 1), ctx.L.length);
      ctx.cur = { l: lnum - 1, c: ctx.cur.c };
      beginline(ctx, BL_SOL | BL_FIX);
      return true;
    }
    case 'f':
    case 'F':
    case 't':
    case 'T':
    case ';':
    case ',':
      return nvCsearch(ctx, cap, oap);
    case '%': {
      oap.inclusive = true;
      if (cap.count0) {
        if (cap.count0 > 100) return false;
        oap.motionType = 'line';
        const lnum = Math.min(Math.max(Math.floor((ctx.L.length * cap.count0 + 99) / 100), 1), ctx.L.length);
        ctx.cur = { l: lnum - 1, c: ctx.cur.c };
        beginline(ctx, BL_SOL | BL_FIX);
        return true;
      }
      oap.motionType = 'char';
      oap.useRegOne = true;
      const pos = findmatch(ctx);
      if (!pos) return false;
      ctx.cur = pos;
      ctx.setWant = true;
      return true;
    }
    case '{':
    case '}':
      oap.motionType = 'char';
      oap.inclusive = false;
      oap.useRegOne = true;
      ctx.setWant = true;
      return findpar(ctx, oap, c === '}' ? 1 : -1, count1);
    case '_': {
      // nv_lineop: count - 1 lines down, to the first non-blank, linewise
      oap.motionType = 'line';
      if (count1 - 1 > 0 && ctx.cur.l + count1 - 1 >= ctx.L.length) return false;
      ctx.cur = { l: ctx.cur.l + count1 - 1, c: ctx.cur.c };
      beginline(ctx, BL_WHITE | BL_FIX);
      return true;
    }
    case '|': {
      // nv_pipe: to screen column count, exclusive
      oap.motionType = 'char';
      oap.inclusive = false;
      beginline(ctx, 0);
      ctx.curswant = Math.max(0, count1 - 1);
      coladvance(ctx, ctx.curswant);
      ctx.setWant = false;
      return true;
    }
    case 'H':
    case 'L':
    case 'M':
      return nvScroll(ctx, cap, oap);
    default:
      return null;
  }
  // eslint-disable-next-line no-unreachable
  void opPending;
}

function nvLeft(ctx, cap, oap) {
  oap.motionType = 'char';
  oap.inclusive = false;
  let n;
  for (n = cap.count1; n > 0; n -= 1) {
    if (!oneleft(ctx)) {
      if (cap.cmd === '<BS>' && ctx.cur.l > 0) {
        ctx.cur = { l: ctx.cur.l - 1, c: ctx.cur.c };
        coladvance(ctx, MAXCOL);
        ctx.setWant = true;
        if ((oap.op === 'd' || oap.op === 'c') && ctx.L[ctx.cur.l].length) {
          if (ctx.cur.c < ctx.L[ctx.cur.l].length) ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + 1 };
          cap.noAdjOpEnd = true;
        }
        continue;
      }
      if (!oap.op && n === cap.count1) return false;
      break;
    }
  }
  return true;
}

function nvRight(ctx, cap, oap) {
  oap.motionType = 'char';
  oap.inclusive = false;
  const pastLine = isVisual(ctx);
  let n;
  for (n = cap.count1; n > 0; n -= 1) {
    const line = ctx.L[ctx.cur.l];
    if ((!pastLine && !oneright(ctx)) || (pastLine && ctx.cur.c >= line.length)) {
      if (cap.cmd === ' ' && ctx.cur.l < ctx.L.length - 1) {
        if (oap.op && !oap.inclusive && line.length) {
          oap.inclusive = true;
        } else {
          ctx.cur = { l: ctx.cur.l + 1, c: 0 };
          ctx.setWant = true;
          oap.inclusive = false;
        }
        continue;
      }
      if (!oap.op) {
        if (n === cap.count1) return false;
      } else if (line.length) {
        oap.inclusive = true;
      }
      break;
    } else if (pastLine) {
      ctx.setWant = true;
      ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + 1 };
    }
  }
  return true;
}

function nvWordcmd(ctx, cap, oap) {
  const c = cap.cmd;
  let wordEnd = c === 'e' || c === 'E';
  const bigword = c === 'W' || c === 'E';
  let flag = false;
  const startpos = { ...ctx.cur };
  oap.inclusive = wordEnd;
  if (!wordEnd && oap.op === 'c') {
    const ch = gchar(ctx, ctx.cur);
    if (ch !== '' && !isWhite(ch)) {
      oap.inclusive = true;
      wordEnd = true;
      flag = true;
    }
  }
  oap.motionType = 'char';
  ctx.setWant = true;
  let ok;
  if (wordEnd) ok = endWord(ctx, cap.count1, bigword, flag, false);
  else ok = fwdWord(ctx, cap.count1, bigword, !!oap.op);
  if (lt(startpos, ctx.cur)) adjustCursor(ctx, oap);
  if (!ok && !oap.op) return false;
  return true;
}

function adjustCursor(ctx, oap) {
  if (ctx.cur.c > 0 && gchar(ctx, ctx.cur) === '' && !isVisual(ctx)) {
    ctx.cur = { l: ctx.cur.l, c: ctx.cur.c - 1 };
    oap.inclusive = true;
  }
}

function nvCsearch(ctx, cap, oap) {
  const c = cap.cmd;
  oap.motionType = 'char';
  let ch;
  let dir;
  let tcmd;
  let stop = true;
  if (c === ';' || c === ',') {
    if (!ctx.lastFind) return false;
    dir = c === ',' ? -ctx.lastFind.dir : ctx.lastFind.dir;
    tcmd = ctx.lastFind.t;
    ch = ctx.lastFind.ch;
    if (cap.count1 === 1 && tcmd) stop = false;
  } else {
    ch = { '<Tab>': '\t', '<C-r>': '\x12', '<CR>': '\r' }[cap.nchar] || cap.nchar;
    if (ch.length !== 1) return false; // special keys (<BS>) beep before the search is remembered
    dir = c === 'f' || c === 't' ? 1 : -1;
    tcmd = c === 't' || c === 'T';
    if (!ctx.stuffed) ctx.lastFind = { ch, dir, t: tcmd };
  }
  oap.inclusive = dir > 0;
  const line = ctx.L[ctx.cur.l];
  let col = ctx.cur.c;
  let count = cap.count1;
  while (count--) {
    for (;;) {
      if (dir > 0) {
        col += 1;
        if (col >= line.length) return false;
      } else {
        if (col === 0) return false;
        col -= 1;
      }
      if (line[col] === ch && stop) break;
      stop = true;
    }
  }
  if (tcmd) col -= dir;
  ctx.cur = { l: ctx.cur.l, c: col };
  ctx.setWant = true;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Executing a parsed normal/visual command

function executeNormal(ctx, p) {
  const cap = { ...p };
  ctx.oldCol = ctx.curswant;
  const visual = isVisual(ctx);
  if (p.visualOp) return visualOperator(ctx, cap, p.op);
  if (p.op) return operatorCommand(ctx, cap);
  if (visual) return visualCommand(ctx, cap);
  return normalCommand(ctx, cap);
}

function recordChange(ctx, change) {
  if (ctx.redoing) return;
  ctx.lastChange = change;
}

function normalCommand(ctx, cap) {
  const c = cap.cmd;
  const count0 = cap.count0;
  const count1 = cap.count1;
  switch (c) {
    case '<Esc>':
      return;
    case 'x':
    case 'X':
    case 'D':
    case 'C':
    case 's': {
      const map = { x: ['d', 'l'], X: ['d', 'h'], D: ['d', '$'], C: ['c', '$'], s: ['c', 'l'] }[c];
      return operatorCommand(ctx, { ...cap, op: map[0], cmd: map[1], stuffedFrom: c });
    }
    case 'S':
      return operatorCommand(ctx, { ...cap, op: 'c', cmd: 'c', lineop: true, stuffedFrom: c });
    case 'r':
      return replaceChars(ctx, cap);
    case 'J':
      return joinCommand(ctx, cap, true);
    case 'g':
      if (cap.nchar === 'J') return joinCommand(ctx, cap, false);
      if (cap.nchar === 'I') {
        beginline(ctx, 0);
        return enterInsert(ctx, { cmd: 'gI', count: cap.count1, redo: { count: cap.count0, keys: ['g', 'I'] } });
      }
      if (cap.nchar === 'p' || cap.nchar === 'P') return putCommand(ctx, cap, cap.nchar === 'P' ? -1 : 1, { cursEnd: true });
      if (motion(ctx, cap, { op: null }) === null) ctx.unsupported = true;
      return;
    case 'p':
    case 'P':
      return putCommand(ctx, cap, c === 'P' ? -1 : 1);
    case '~':
      return swapCaseCommand(ctx, cap);
    case 'Y':
      // Neovim's default mapping: Y is y$
      return operatorCommand(ctx, { ...cap, op: 'y', cmd: '$' });
    case 'z':
      return zCommand(ctx, cap);
    case '<C-e>':
    case '<C-y>':
      return scrollLines(ctx, c === '<C-e>' ? count1 : -count1);
    case '<C-d>':
    case '<C-u>':
      return halfPage(ctx, cap, c === '<C-d>' ? 1 : -1);
    case 'u': {
      for (let i = 0; i < count1; i += 1) if (!undoRedo(ctx, true)) break;
      ctx.setWant = true;
      return;
    }
    case '<C-r>': {
      for (let i = 0; i < count1; i += 1) if (!undoRedo(ctx, false)) break;
      ctx.setWant = true;
      return;
    }
    case '.':
      return dotRepeat(ctx, count0, cap.reg, cap.opcount);
    case 'o':
    case 'O':
      return openCommand(ctx, cap);
    case 'i':
    case 'a':
    case 'I':
    case 'A':
      return editCommand(ctx, cap);
    case 'v':
    case 'V':
      return startVisual(ctx, cap);
    default: {
      const oap = { op: null };
      const r = motion(ctx, cap, oap);
      if (r === null) ctx.unsupported = true;
      else if (!r) ctx.failed = true;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Operators

function operatorCommand(ctx, cap) {
  const op = cap.op;
  const oap = { op, reg: cap.reg, start: { ...ctx.cur }, motionType: 'char', inclusive: false, useRegOne: false };
  const oldCur = { ...ctx.cur };
  let ok;
  if (cap.lineop) {
    oap.motionType = 'line';
    if (cap.count1 - 1 > 0 && ctx.cur.l >= ctx.L.length - 1) ok = false;
    else {
      ctx.cur = { l: Math.min(ctx.cur.l + cap.count1 - 1, ctx.L.length - 1), c: ctx.cur.c };
      coladvance(ctx, ctx.curswant);
      if ((op === 'd' && cap.force !== 'v') || op === '<' || op === '>') beginline(ctx, BL_SOL | BL_FIX);
      else if (op !== 'y') beginline(ctx, BL_WHITE | BL_FIX);
      ok = true;
    }
  } else if (cap.cmd === 'i' || cap.cmd === 'a') {
    ok = textObject(ctx, cap, oap);
    ctx.setWant = true; // nv_object sets it whether or not the object was found
    if (!ok && ctx.cur.c > 0 && ctx.cur.c >= ctx.L[ctx.cur.l].length) ctx.cur = { l: ctx.cur.l, c: ctx.cur.c - 1 };
    if (ok === null) {
      ctx.unsupported = true;
      ctx.cur = oldCur;
      return;
    }
  } else if (['x', 'X', 'D', 'C', 's', 'S', 'J', 'p', 'P', 'u', '<C-r>', '.', 'o', 'O', 'A', 'I', '<Esc>', 'r', '~', 'Y'].includes(cap.cmd) || (cap.cmd === 'g' && (cap.nchar === 'J' || cap.nchar === 'I' || cap.nchar === 'p' || cap.nchar === 'P'))) {
    if (cap.cmd === 'g' && cap.nchar === 'I') {
      // nv_g_cmd moves to column 0 before it notices the pending operator
      beginline(ctx, 0);
      return;
    }
    // Commands that cancel a pending operator (checkclearop / diff commands).
    ctx.cur = oldCur;
    return;
  } else {
    ok = motion(ctx, cap, oap);
    if (ok === null) {
      ctx.unsupported = true;
      ctx.cur = oldCur;
      return;
    }
  }
  if (!ok) {
    ctx.failed = true; // clearopbeep: the cursor stays where the failed motion left it
    return;
  }
  doPendingOperator(ctx, cap, oap);
}

function textObject(ctx, cap, oap) {
  const include = cap.cmd === 'a';
  switch (cap.nchar) {
    case 'w':
      return currentWord(ctx, oap, cap.count1, include, false);
    case 'W':
      return currentWord(ctx, oap, cap.count1, include, true);
    case 'p':
      return currentPar(ctx, oap, cap.count1, include);
    case '"':
    case "'":
    case '`':
      return currentQuote(ctx, oap, cap.count1, include, cap.nchar);
    case 'b':
    case '(':
    case ')':
    case 'B':
    case '{':
    case '}':
    case '[':
    case ']':
    case '<':
    case '>':
    case 't':
    case 's':
      return null;
    default:
      return false;
  }
}

/** The redo record for an operator command, in keys (as Neovim's prep_redo stores it). */
function opRedoKeys(cap) {
  const keys = [];
  if (cap.reg) keys.push('"', cap.reg);
  keys.push(...opKeys(cap.op));
  if (cap.force) keys.push(cap.force);
  if (cap.lineop) keys.push(...opKeys(cap.op));
  else {
    keys.push(cap.cmd);
    if (cap.nchar) keys.push(cap.nchar);
  }
  return keys;
}

const opKeys = (op) => (op.length > 1 ? op.split('') : [op]);

function doPendingOperator(ctx, cap, oap) {
  const op = oap.op;
  oap.force = cap.force || null;
  if (oap.force === 'V') oap.motionType = 'line';
  else if (oap.force === 'v') {
    if (oap.motionType === 'line') oap.inclusive = false;
    else oap.inclusive = !oap.inclusive;
    oap.motionType = 'char';
  }
  if (op !== 'y') {
    recordChange(ctx, { count: cap.count0, keys: opRedoKeys(cap) });
  }
  if (lt(oap.start, ctx.cur)) {
    oap.end = { ...ctx.cur };
    ctx.cur = { ...oap.start };
  } else {
    oap.end = { ...oap.start };
    oap.start = { ...ctx.cur };
  }
  oap.lineCount = oap.end.l - oap.start.l + 1;
  ctx.setWant = true;
  oap.empty = oap.motionType !== 'line' && (!oap.inclusive || (op === 'y' && gchar(ctx, oap.end) === '')) && eqpos(oap.start, oap.end);
  if (oap.motionType === 'char' && !oap.inclusive && !cap.noAdjOpEnd && oap.end.c === 0 && oap.lineCount > 1) {
    oap.lineCount -= 1;
    oap.endAdjusted = true;
    oap.end = { l: oap.end.l - 1, c: 0 };
    if (inindent(ctx, 0)) oap.motionType = 'line';
    else {
      const len = ctx.L[oap.end.l].length;
      oap.end.c = len;
      if (len) {
        oap.end.c = len - 1;
        oap.inclusive = true;
      }
    }
  }
  applyOperator(ctx, cap, oap);
}

function applyOperator(ctx, cap, oap) {
  applyOperatorInner(ctx, cap, oap);
  // With 'nostartofline' a linewise delete or shift returns to the column the command began in.
  if (!ctx.o.startofline && oap.motionType === 'line' && !oap.endAdjusted && (oap.op === 'd' || oap.op === '<' || oap.op === '>')) {
    ctx.curswant = ctx.oldCol;
    coladvance(ctx, ctx.oldCol);
  }
}

function applyOperatorInner(ctx, cap, oap) {
  switch (oap.op) {
    case '<':
    case '>':
      opShift(ctx, oap, true, oap.isVisual ? cap.count1 : 1);
      return;
    case 'd':
      opDelete(ctx, oap);
      return;
    case 'y':
      opYank(ctx, oap);
      clampCursor(ctx);
      return;
    case 'c':
      opChange(ctx, cap, oap);
      return;
    case 'J':
      opJoin(ctx, oap);
      return;
    case 'u':
    case 'gu':
      opTilde(ctx, oap, (t) => caseMap(t, 'lower'));
      return;
    case 'gU':
      opTilde(ctx, oap, (t) => caseMap(t, 'upper'));
      return;
    case 'g~':
      opTilde(ctx, oap, (t) => caseMap(t, 'swap'));
      return;
    case 'r':
      opReplace(ctx, oap, cap.nchar);
      return;
    default:
      ctx.unsupported = true;
  }
}

function opShift(ctx, oap, cursTop, amount) {
  amount = Math.min(amount, MAX_REPEAT);
  uSave(ctx, oap.start.l, oap.end.l + 2);
  const sw = ctx.o.shiftwidth || ctx.o.tabstop;
  for (let l = oap.start.l; l <= oap.end.l; l += 1) {
    const line = ctx.L[l];
    if (line === '') continue;
    let width = getIndent(line, ctx.o.tabstop);
    if (oap.op === '<') width = Math.max(width - sw * amount, 0);
    else width += sw * amount;
    ctx.L[l] = indentString(ctx, width) + line.slice(leadingWhite(line));
  }
  if (cursTop) {
    ctx.cur = { l: oap.start.l, c: ctx.cur.c };
    beginline(ctx, BL_SOL | BL_FIX);
  }
}

function opDelete(ctx, oap) {
  if (ctx.mlEmpty) return true;
  if (oap.empty) {
    uSaveCursor(ctx);
    if (oap.isVisual) ctx.keepNul = true; // returns before anything puts the cursor back on the text
    return true;
  }
  if (oap.motionType === 'char' && !oap.isVisual && oap.lineCount > 1 && !oap.force && oap.op === 'd') {
    const endLine = ctx.L[oap.end.l];
    let k = oap.end.c;
    if (k < endLine.length) k += oap.inclusive ? 1 : 0;
    while (k < endLine.length && isWhite(endLine[k])) k += 1;
    if (k >= endLine.length && inindent(ctx, 0)) oap.motionType = 'line';
  }
  if (oap.motionType !== 'line' && oap.lineCount === 1 && oap.op === 'd' && ctx.L[oap.start.l] === '') {
    return true;
  }
  if (oap.reg !== '_') {
    const { text, linewise } = yankText(ctx, oap);
    if (oap.reg) {
      // an explicit "" names register 0
      const name = oap.reg === '"' ? '0' : regIndexName(oap.reg);
      setReg(ctx, name, text, linewise, oap.reg !== name && oap.reg !== '"');
      ctx.unnamed = name;
    }
    if (oap.motionType === 'line' || oap.lineCount > 1 || oap.useRegOne) {
      const append = !!oap.reg && oap.reg !== regIndexName(oap.reg);
      shiftDeleteRegisters(ctx, append);
      setReg(ctx, '1', text, linewise);
    }
    if (!oap.reg && oap.motionType !== 'line' && oap.lineCount === 1) {
      setReg(ctx, '-', text, linewise);
      ctx.unnamed = '-';
    }
  }
  if (oap.motionType === 'line') {
    if (oap.op === 'c') {
      if (oap.lineCount > 1) {
        const lnum = ctx.cur.l;
        ctx.cur = { l: lnum + 1, c: ctx.cur.c };
        uSave(ctx, lnum + 1, lnum + oap.lineCount + 1);
        ctx.cur = { l: lnum, c: ctx.cur.c };
        ctx.L.splice(lnum + 1, oap.lineCount - 1);
      }
      uSaveCursor(ctx);
      if (ctx.o.autoindent) {
        beginline(ctx, BL_WHITE);
        ctx.didAi = true;
        ctx.aiCol = ctx.cur.c;
      } else {
        beginline(ctx, 0);
      }
      ctx.L[ctx.cur.l] = ctx.L[ctx.cur.l].slice(0, ctx.cur.c);
    } else {
      delLines(ctx, oap.lineCount);
      beginline(ctx, BL_WHITE | BL_FIX);
    }
  } else if (oap.lineCount === 1) {
    uSaveCursor(ctx);
    const n = oap.end.c - oap.start.c + 1 - (oap.inclusive ? 0 : 1);
    const line = ctx.L[ctx.cur.l];
    ctx.L[ctx.cur.l] = line.slice(0, ctx.cur.c) + line.slice(ctx.cur.c + n);
    if (oap.op === 'd' && !oap.isVisual) {
      const len = ctx.L[ctx.cur.l].length;
      if (ctx.cur.c > 0 && ctx.cur.c >= len) ctx.cur = { l: ctx.cur.l, c: len - 1 };
    }
  } else {
    uSave(ctx, ctx.cur.l, ctx.cur.l + oap.lineCount + 1);
    const first = ctx.L[ctx.cur.l].slice(0, ctx.cur.c);
    const endLine = ctx.L[oap.end.l];
    const rest = endLine.slice(Math.min(endLine.length, oap.end.c + (oap.inclusive ? 1 : 0)));
    ctx.L.splice(ctx.cur.l, oap.lineCount, first + rest);
    if (oap.op === 'd' && !oap.isVisual) {
      const len = ctx.L[ctx.cur.l].length;
      if (ctx.cur.c > 0 && ctx.cur.c >= len) ctx.cur = { l: ctx.cur.l, c: len - 1 };
    }
  }
  return true;
}

function delLines(ctx, n) {
  const first = ctx.cur.l;
  n = Math.min(n, ctx.L.length - first);
  uSave(ctx, first, first + n + 1);
  if (n >= ctx.L.length) {
    ctx.L.splice(0, ctx.L.length, '');
    ctx.cur = { l: 0, c: 0 };
    ctx.mlEmpty = true;
    return;
  }
  ctx.L.splice(first, n);
  if (ctx.cur.l >= ctx.L.length) ctx.cur = { l: ctx.L.length - 1, c: ctx.cur.c };
}

function opChange(ctx, cap, oap) {
  const l = oap.motionType === 'line' ? 0 : oap.start.c;
  ctx.didAi = false;
  opDelete(ctx, oap);
  const line = ctx.L[ctx.cur.l];
  if (l > ctx.cur.c && line.length) ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + 1 };
  if (ctx.cur.c > line.length) ctx.cur = { l: ctx.cur.l, c: line.length };
  const keepAi = ctx.didAi;
  enterInsert(ctx, { cmd: 'c', count: 1, redo: ctx.redoBaseForInsert || ctx.lastChange });
  ctx.redoBaseForInsert = null;
  if (keepAi) {
    ctx.ins.didAi = true;
    ctx.ins.aiCol = ctx.aiCol;
  }
  ctx.didAi = false;
}

function opJoin(ctx, oap) {
  const lineCount = Math.max(oap.lineCount, 2);
  if (ctx.cur.l + lineCount - 1 > ctx.L.length - 1) return;
  doJoin(ctx, lineCount, true, true);
}

/** op_tilde: change case over the region; the cursor stays at the start. */
function opTilde(ctx, oap, fn) {
  uSave(ctx, oap.start.l, oap.end.l + 2);
  if (oap.motionType === 'line') {
    for (let l = oap.start.l; l <= oap.end.l; l += 1) ctx.L[l] = fn(ctx.L[l]);
  } else {
    for (let l = oap.start.l; l <= oap.end.l; l += 1) {
      const line = ctx.L[l];
      const s = l === oap.start.l ? oap.start.c : 0;
      const e = l === oap.end.l ? Math.min(line.length, oap.end.c + (oap.inclusive ? 1 : 0)) : line.length;
      ctx.L[l] = line.slice(0, s) + fn(line.slice(s, e)) + line.slice(e);
    }
  }
}

function opReplace(ctx, oap, ch) {
  if (ch.length !== 1) {
    ctx.unsupported = true;
    return;
  }
  uSave(ctx, oap.start.l, oap.end.l + 2);
  for (let l = oap.start.l; l <= oap.end.l; l += 1) {
    const line = ctx.L[l];
    let s = 0;
    let e = line.length;
    if (oap.motionType !== 'line') {
      if (l === oap.start.l) s = oap.start.c;
      if (l === oap.end.l) e = Math.min(line.length, oap.end.c + (oap.inclusive ? 1 : 0));
    }
    ctx.L[l] = line.slice(0, s) + ch.repeat(Math.max(0, e - s)) + line.slice(e);
  }
  ctx.cur = { ...oap.start };
  if (oap.motionType === 'line') ctx.cur.c = 0;
}

// ---------------------------------------------------------------------------------------------
// J

function joinCommand(ctx, cap, insertSpace) {
  let count0 = Math.max(cap.count0, 2);
  if (ctx.cur.l + count0 - 1 > ctx.L.length - 1) {
    if (count0 <= 2) {
      ctx.failed = true;
      return;
    }
    count0 = ctx.L.length - ctx.cur.l;
  }
  recordChange(ctx, { count: count0, keys: [...(cap.reg ? ['"', cap.reg] : []), ...(insertSpace ? ['J'] : ['g', 'J'])] });
  doJoin(ctx, count0, insertSpace, true);
}

function doJoin(ctx, count, insertSpace, saveUndo) {
  if (saveUndo) uSave(ctx, ctx.cur.l, ctx.cur.l + count + 1);
  const l0 = ctx.cur.l;
  const spaces = new Array(count).fill(0);
  const parts = [];
  let endcurr1 = '';
  let endcurr2 = '';
  let sumsize = 0;
  let currsize = 0;
  for (let t = 0; t < count; t += 1) {
    let curr = ctx.L[l0 + t];
    if (insertSpace && t > 0) {
      curr = curr.slice(leadingWhite(curr));
      if (curr !== '' && curr[0] !== ')' && sumsize !== 0 && endcurr1 !== '\t') {
        if (endcurr1 === ' ') endcurr1 = endcurr2;
        else spaces[t] += 1;
        if (ctx.o.joinspaces && (endcurr1 === '.' || endcurr1 === '?' || endcurr1 === '!')) spaces[t] += 1;
      }
    }
    currsize = curr.length;
    sumsize += currsize + spaces[t];
    endcurr1 = endcurr2 = '';
    if (insertSpace && currsize > 0) {
      endcurr1 = curr[currsize - 1];
      if (currsize > 1) endcurr2 = curr[currsize - 2];
    }
    parts.push(' '.repeat(spaces[t]) + curr);
  }
  const col = sumsize - currsize - spaces[count - 1];
  ctx.L.splice(l0, count, parts.join(''));
  ctx.cur = { l: l0, c: col };
  const len = ctx.L[l0].length;
  if (ctx.cur.c > Math.max(0, len - (ctx.mode === 'insert' ? 0 : 1))) ctx.cur.c = Math.max(0, len - (ctx.mode === 'insert' ? 0 : 1));
  ctx.setWant = true;
  return true;
}

// ---------------------------------------------------------------------------------------------
// r

function replaceChars(ctx, cap) {
  const ch = cap.nchar;
  const line = ctx.L[ctx.cur.l];
  if (line.length - ctx.cur.c < cap.count1) {
    ctx.failed = true;
    return;
  }
  if (ch === '<CR>') {
    uSaveCursor(ctx);
    recordChange(ctx, { count: cap.count1, keys: ['r', '<CR>'] });
    ctx.L[ctx.cur.l] = line.slice(0, ctx.cur.c) + line.slice(ctx.cur.c + cap.count1);
    // r<CR>: delete the characters, then insert a line break as Insert mode would.
    enterInsert(ctx, { cmd: 'r', count: 1, redo: null });
    insertKey(ctx, '<CR>', false);
    insertKey(ctx, '<Esc>', false);
    return;
  }
  let c = ch === '<C-r>' ? '\x12' : ch;
  if (c === '<Tab>') {
    ctx.unsupported = true;
    return;
  }
  if (c.length !== 1) return;
  uSaveCursor(ctx);
  recordChange(ctx, { count: cap.count1, keys: [...(cap.reg ? ['"', cap.reg] : []), 'r', c] });
  ctx.L[ctx.cur.l] = line.slice(0, ctx.cur.c) + c.repeat(cap.count1) + line.slice(ctx.cur.c + cap.count1);
  ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + cap.count1 - 1 };
  ctx.setWant = true;
}

// ---------------------------------------------------------------------------------------------
// ~, z, scrolling and H M L (normal.c nv_tilde, nv_zet, nv_scroll_line, nv_halfpage, nv_scroll;
// move.c update_topline, scrollup, scrolldown, pagescroll). Every line is one screen line: the
// engine does not know the window's width, so a long line that wraps on screen counts as one.

const winHeight = (ctx) => ctx.o.windowHeight || 22;

/** update_topline with 'scrolloff' 0: the cursor line stays in the window. */
function updateTopline(ctx) {
  const h = winHeight(ctx);
  const n = ctx.L.length;
  if (ctx.top >= n) ctx.top = Math.max(0, n - 1);
  const l = ctx.cur.l;
  if (l < ctx.top) {
    ctx.top = ctx.top - l >= h / 2 ? Math.max(0, l - Math.floor((h - 1) / 2)) : l;
  } else if (l >= ctx.top + h) {
    ctx.top = l - (ctx.top + h) + 1 >= h / 2 ? Math.max(0, l - Math.floor((h - 1) / 2)) : l - h + 1;
  }
}

/** n_swapchar: ~ swaps the case of count characters and moves past them. */
function swapCaseCommand(ctx, cap) {
  const line = ctx.L[ctx.cur.l];
  if (!line.length) {
    ctx.failed = true;
    return;
  }
  uSaveCursor(ctx);
  recordChange(ctx, { count: cap.count0, keys: ['~'] });
  const from = ctx.cur.c;
  const to = Math.min(line.length, from + cap.count1);
  ctx.L[ctx.cur.l] = line.slice(0, from) + caseMap(line.slice(from, to), 'swap') + line.slice(to);
  ctx.cur = { l: ctx.cur.l, c: Math.min(to, line.length - 1) };
  ctx.setWant = true;
}

/** nv_zet: the scroll-the-window z commands; z<CR>, z. and z- also go to the first non-blank. */
function zCommand(ctx, cap) {
  const ch = cap.nchar;
  const scrolls = { t: 'top', '<CR>': 'top', z: 'mid', '.': 'mid', b: 'bot', '-': 'bot' };
  if (!scrolls[ch]) {
    ctx.unsupported = true;
    return;
  }
  if (cap.count0 && cap.count0 - 1 !== ctx.cur.l) {
    ctx.cur = { l: Math.min(cap.count0, ctx.L.length) - 1, c: ctx.cur.c };
    clampCursor(ctx);
  }
  if (ch === '<CR>' || ch === '.' || ch === '-') beginline(ctx, BL_WHITE | BL_FIX);
  const h = winHeight(ctx);
  const l = ctx.cur.l;
  if (scrolls[ch] === 'top') ctx.top = l;
  else if (scrolls[ch] === 'mid') ctx.top = Math.max(0, l - Math.floor((h - 1) / 2));
  else ctx.top = Math.max(0, l - h + 1);
}

/** CTRL-E / CTRL-Y: the window by count lines, the cursor kept inside it. */
function scrollLines(ctx, n) {
  const h = winHeight(ctx);
  const before = ctx.top;
  ctx.top = Math.max(0, Math.min(ctx.L.length - 1, ctx.top + n));
  if (ctx.top === before) return;
  if (ctx.cur.l < ctx.top) {
    ctx.cur = { l: ctx.top, c: ctx.cur.c };
    coladvance(ctx, ctx.curswant);
  } else if (ctx.cur.l > ctx.top + h - 1) {
    ctx.cur = { l: ctx.top + h - 1, c: ctx.cur.c };
    coladvance(ctx, ctx.curswant);
  }
}

/** pagescroll(half): CTRL-D / CTRL-U scroll 'scroll' lines (count sets it) and move the cursor as far. */
function halfPage(ctx, cap, dir) {
  const h = winHeight(ctx);
  const n = ctx.L.length;
  if (cap.count0) ctx.scrollOpt = Math.min(h, cap.count0);
  const amount = Math.min(h, ctx.scrollOpt || Math.floor(h / 2));
  const prev = { ...ctx.cur };
  const prevTop = ctx.top;
  // The window scrolls only as far as keeps the end of the buffer at its bottom.
  if (dir > 0) ctx.top = Math.min(ctx.top + amount, Math.max(ctx.top, n - h));
  else ctx.top = Math.max(0, ctx.top - amount);
  const l = dir > 0 ? Math.min(n - 1, prev.l + amount) : Math.max(0, prev.l - amount);
  ctx.cur = { l, c: prev.c };
  if (l !== prev.l) coladvance(ctx, ctx.curswant);
  if (ctx.top === prevTop && l === prev.l && ctx.cur.c === prev.c) {
    ctx.failed = true; // beep: neither the window nor the cursor moved
    return;
  }
  beginline(ctx, BL_SOL | BL_FIX);
}

/** nv_scroll: H, L and M, linewise, to a line of the window. */
function nvScroll(ctx, cap, oap) {
  oap.motionType = 'line';
  const h = winHeight(ctx);
  const n = ctx.L.length;
  const bot = Math.min(n, ctx.top + h); // one past the last line shown
  let l;
  if (cap.cmd === 'L') {
    l = bot - 1;
    for (let k = cap.count1 - 1; k > 0 && l > ctx.top; k -= 1) l -= 1;
  } else if (cap.cmd === 'H') {
    l = Math.min(n - 1, ctx.top + cap.count1 - 1);
  } else {
    const shown = bot - ctx.top;
    const half = Math.floor((shown + 1) / 2);
    let k = 0;
    let used = 0;
    for (k = 0; ctx.top + k < n; k += 1) {
      used += 1;
      if (used >= half) break;
    }
    l = ctx.top + k;
  }
  ctx.cur = { l, c: ctx.cur.c };
  beginline(ctx, BL_SOL | BL_FIX);
  return true;
}

// ---------------------------------------------------------------------------------------------
// p / P

function putCommand(ctx, cap, dir, flags = {}) {
  const keys = cap.cmd === 'g' ? ['g', cap.nchar] : [cap.cmd];
  if (!flags.noRecord) recordChange(ctx, { count: cap.count0, keys: [...(cap.reg ? ['"', cap.reg] : []), ...keys] });
  const before = ctx.L.length;
  const at = ctx.cur.l;
  const reg = getPutRegister(ctx, cap.reg);
  const ok = doPut(ctx, reg, dir, cap.count1, flags);
  if (ok && flags.cursEnd && reg) putCursorEnd(ctx, reg, dir, at, before, cap.count1);
}

/** gp / gP: the cursor just after the new text (do_put with PUT_CURSEND). */
function putCursorEnd(ctx, reg, dir, at, before, count) {
  if (reg.linewise) {
    const added = ctx.L.length - before;
    const last = (dir > 0 ? at + 1 : at) + added - 1;
    if (last + 1 < ctx.L.length) ctx.cur = { l: last + 1, c: 0 };
    else ctx.cur = { l: ctx.L.length - 1, c: 0 };
    ctx.setWant = true;
    return;
  }
  const parts = reg.text.split('\n');
  if (parts.length === 1) {
    ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + 1 };
  } else {
    const lastLine = ctx.cur.l + (parts.length - 1) * count;
    ctx.cur = { l: lastLine, c: parts[parts.length - 1].length };
  }
  ctx.keepNul = true;
  ctx.setWant = true;
}

function doPut(ctx, reg, dir, count, flags) {
  count = Math.min(count, MAX_REPEAT);
  if (!reg) {
    uSave(ctx, ctx.cur.l + 1, ctx.cur.l + 2);
    ctx.failed = true; // E353, and an error message flushes typeahead
    return false;
  }
  ctx.setWant = true;
  const yArray = reg.text.split('\n');
  let yType = reg.linewise ? 'line' : 'char';
  if (flags.line) yType = 'line';
  if (yType === 'line' && flags.lineSplit) {
    uSaveCursor(ctx);
    const line = ctx.L[ctx.cur.l];
    let split = ctx.cur.c;
    if (dir > 0 && split < line.length) split += 1;
    ctx.L.splice(ctx.cur.l, 1, line.slice(0, split), line.slice(split));
    dir = 1;
  }
  let lnum = ctx.cur.l;
  if (yType === 'line') {
    const at = dir > 0 ? lnum + 1 : lnum;
    uSave(ctx, at, at + 1);
  } else {
    uSaveCursor(ctx);
  }
  let col = ctx.cur.c;
  if (yType === 'char') {
    const line = ctx.L[lnum];
    const yanklen = yArray[0].length;
    if (dir > 0 && ctx.cur.c < line.length) {
      col += 1;
      if (yanklen) ctx.cur = { l: lnum, c: ctx.cur.c + 1 };
    }
    if (yArray.length === 1) {
      if (yanklen === 0 || count === 0) return true;
      const ins = yArray[0].repeat(count);
      // (Neovim's per-line loop here only runs for blockwise Visual areas, which are not
      // modelled: after a characterwise Visual delete the area's marks collapse onto one line.)
      ctx.L[lnum] = line.slice(0, col) + ins + line.slice(col);
      ctx.cur = { l: lnum, c: ctx.cur.c + ins.length - 1 };
      return true;
    }
    const newCursor = { ...ctx.cur };
    for (let cnt = 1; cnt <= count; cnt += 1) {
      const cur = ctx.L[newCursor.l];
      const head = cur.slice(0, col);
      const tail = cur.slice(col);
      const middle = yArray.slice(1, -1);
      const lastLine = yArray[yArray.length - 1] + tail;
      ctx.L.splice(newCursor.l, 1, head + yArray[0], ...middle, lastLine);
    }
    ctx.cur = newCursor;
    const len = ctx.L[ctx.cur.l].length;
    if (ctx.cur.c > len) ctx.cur.c = len;
    return true;
  }
  // linewise
  const insertAt = dir > 0 ? lnum + 1 : lnum;
  const block = [];
  for (let cnt = 0; cnt < count; cnt += 1) block.push(...yArray);
  ctx.L.splice(insertAt, 0, ...block);
  ctx.cur = { l: insertAt, c: 0 };
  beginline(ctx, BL_WHITE | BL_FIX);
  return true;
}

// ---------------------------------------------------------------------------------------------
// . (redo)

function dotRepeat(ctx, count0, reg, opcount) {
  const change = ctx.lastChange;
  if (!change || ctx.inDot) return; // a redo record never contains '.' as a command
  ctx.inDot = true;
  try {
    dotRepeatInner(ctx, change, count0, reg, opcount);
  } finally {
    ctx.inDot = false;
  }
}

function dotRepeatInner(ctx, change, count0, reg, opcount) {
  let count = count0 || change.count;
  // With a register named, the count of the '.' stays in the operator state (opcount) and the
  // replayed command's own count is multiplied by it again.
  // (nv_regname keeps the count, and normal_execute sets opcount to the '.' count itself)
  if (reg && count0) count = Math.min(count0 * count0, 999999999);
  void opcount;
  const keys = [];
  let replay = change.keys;
  if (replay[0] === '"') {
    // a numbered register advances: "1p... then . puts "2
    const r = replay[1];
    if (r >= '1' && r < '9') replay = ['"', String(Number(r) + 1), ...replay.slice(2)];
  } else if (reg) {
    keys.push('"', reg);
  }
  if (count) keys.push(...String(count).split(''));
  // Re-run the command; it records itself again with the new count, as Neovim's does.
  ctx.stuffed += 1;
  ctx.dotVisual = change.visual || null;
  if (change.visual) {
    redoVisual(ctx, change, count0);
  } else {
    runKeys(ctx, [...keys, ...replay]);
  }
  ctx.dotVisual = null;
  ctx.stuffed -= 1;
}

/**
 * Replay a redo record. As in Neovim, a command that fails with a beep (clearopbeep, an error
 * message) flushes what is left of the stuffed keys, so the rest of the record is dropped.
 */
function runKeys(ctx, keys) {
  for (const key of keys) {
    if (ctx.mode === 'insert') {
      insertKey(ctx, key, true);
      continue;
    }
    ctx.pending.push(key);
    const p = parseNormal(ctx.pending, isVisual(ctx));
    if (p.status === 'incomplete') continue;
    ctx.pending = [];
    if (p.status === 'unsupported') {
      ctx.unsupported = true;
      break;
    }
    if (p.status === 'cancel') break;
    ctx.failed = false;
    executeNormal(ctx, p);
    if (ctx.failed) break;
  }
  ctx.failed = false;
  ctx.pending = [];
}

// ---------------------------------------------------------------------------------------------
// o / O and the insert commands

function openCommand(ctx, cap) {
  const dir = cap.cmd === 'O' ? -1 : 1;
  const l = ctx.cur.l;
  uSave(ctx, dir < 0 ? l - 1 + 0 : l, dir < 0 ? l + 1 : l + 2);
  const indent = ctx.o.autoindent ? getIndent(ctx.L[l], ctx.o.tabstop) : 0;
  const lead = indentString(ctx, indent);
  const at = dir > 0 ? l + 1 : l;
  ctx.L.splice(at, 0, lead);
  ctx.cur = { l: at, c: lead.length };
  enterInsert(ctx, { cmd: cap.cmd, count: cap.count1, redo: { count: cap.count0, keys: [cap.cmd] } });
  ctx.ins.didAi = !!ctx.o.autoindent;
  ctx.ins.aiCol = lead.length;
}

function editCommand(ctx, cap) {
  const c = cap.cmd;
  const line = ctx.L[ctx.cur.l];
  if (c === 'A') {
    ctx.setWant = true;
    ctx.cur = { l: ctx.cur.l, c: line.length };
  } else if (c === 'I') {
    beginline(ctx, BL_WHITE);
  } else if (c === 'a') {
    if (ctx.cur.c < line.length) ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + 1 };
  }
  enterInsert(ctx, { cmd: c, count: cap.count1, redo: { count: cap.count0, keys: [c] } });
}

function enterInsert(ctx, { cmd, count, redo }) {
  ctx.mode = 'insert';
  ctx.vis = null;
  ctx.ins = {
    cmd,
    count: Math.min(count, MAX_REPEAT),
    typed: [],
    insStart: { ...ctx.cur },
    didAi: false,
    aiCol: 0,
    redo: redo || null
  };
  if (redo) recordChange(ctx, { ...redo, keys: [...redo.keys] });
  ctx.setWant = true;
}

function insertKey(ctx, key, record) {
  const ins = ctx.ins;
  if (ctx.pending.length) {
    // <C-r> waiting for a register name
    ctx.pending = [];
    if (key === '<Esc>') return;
    if (key.length !== 1 || !SUPPORTED_REGS.test(key)) {
      ctx.unsupported = true;
      return;
    }
    const reg = getPutRegister(ctx, key === '"' ? null : key);
    if (!reg) return;
    const keys = [];
    const lines = reg.text.split('\n');
    lines.forEach((ln, i) => {
      for (const ch of ln) keys.push(ch === '\t' ? '<Tab>' : ch);
      if (i < lines.length - 1 || reg.linewise) keys.push('<CR>');
    });
    for (const k of keys) insertKey(ctx, k, record);
    return;
  }
  if (key === '<Esc>') {
    insEsc(ctx);
    return;
  }
  if (key === '<C-r>') {
    ctx.pending = ['<C-r>'];
    return;
  }
  if (key === '<CR>') {
    if (record) appendRedo(ctx, key);
    insEol(ctx);
    return;
  }
  if (key === '<BS>') {
    // a <BS> that cannot delete anything beeps and is not recorded for repeating
    if (insBs(ctx) && record) appendRedo(ctx, key);
    return;
  }
  if (key === '<Tab>') {
    if (record) appendRedo(ctx, key);
    insTab(ctx);
    return;
  }
  if (key.length !== 1) {
    ctx.unsupported = true;
    return;
  }
  if (record) appendRedo(ctx, key);
  insertChar(ctx, key);
  void ins;
}

function appendRedo(ctx, key) {
  if (!ctx.ins || ctx.ins.replaying) return;
  ctx.ins.typed.push(key);
}

function insStartChange(ctx) {
  uSaveCursor(ctx);
}

function insertChar(ctx, ch) {
  insStartChange(ctx);
  const line = ctx.L[ctx.cur.l];
  ctx.L[ctx.cur.l] = line.slice(0, ctx.cur.c) + ch + line.slice(ctx.cur.c);
  ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + 1 };
  ctx.ins.didAi = false;
  ctx.setWant = true;
}

function insTab(ctx) {
  insStartChange(ctx);
  ctx.ins.didAi = false;
  const ind = inindent(ctx, 0);
  const line = ctx.L[ctx.cur.l];
  const vcol = vcolOf(line, ctx.cur.c, ctx.o.tabstop);
  let temp;
  if (ctx.o.smarttab && ind) {
    const sw = ctx.o.shiftwidth || ctx.o.tabstop;
    temp = sw - (vcol % sw);
  } else temp = ctx.o.tabstop - (vcol % ctx.o.tabstop);
  const ins = ctx.o.expandtab ? ' '.repeat(temp) : '\t';
  ctx.L[ctx.cur.l] = line.slice(0, ctx.cur.c) + ins + line.slice(ctx.cur.c);
  ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + ins.length };
  ctx.setWant = true;
}

function insEol(ctx) {
  insStartChange(ctx);
  const l = ctx.cur.l;
  const line = ctx.L[l];
  let head = line.slice(0, ctx.cur.c);
  let tail = line.slice(ctx.cur.c);
  const truncLine = ctx.ins.didAi;
  let newindent = 0;
  if (ctx.o.autoindent) {
    newindent = getIndent(head, ctx.o.tabstop);
    tail = tail.slice(leadingWhite(tail));
  }
  if (truncLine) head = head.replace(/[ \t]+$/, '');
  const lead = ctx.o.autoindent ? indentString(ctx, newindent) : '';
  ctx.L.splice(l, 1, head, lead + tail);
  ctx.cur = { l: l + 1, c: lead.length };
  ctx.ins.didAi = !!ctx.o.autoindent;
  ctx.ins.aiCol = lead.length;
  ctx.setWant = true;
}

function insBs(ctx) {
  const ins = ctx.ins;
  if (ctx.cur.l === 0 && ctx.cur.c === 0) return false;
  if (ctx.L.length === 1 && ctx.L[0] === '') return false;
  const inIndent = inindent(ctx, 0);
  if (ctx.cur.c === 0) {
    // join with the previous line
    insStartChange(ctx);
    if (ins.insStart.l === ctx.cur.l) {
      ins.insStart = { l: ctx.cur.l - 1, c: ctx.L[ctx.cur.l - 1].length };
    }
    const temp = gchar(ctx, ctx.cur);
    ctx.cur = { l: ctx.cur.l - 1, c: ctx.cur.c };
    doJoin(ctx, 2, false, false);
    if (temp === '' && gchar(ctx, ctx.cur) !== '') ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + 1 };
    ins.didAi = false;
    ctx.setWant = true;
    return true;
  }
  insStartChange(ctx);
  const line = ctx.L[ctx.cur.l];
  if (ctx.o.smarttab && inIndent) {
    let vcol = vcolOf(line, ctx.cur.c, ctx.o.tabstop);
    let wantVcol = vcol > 0 ? vcol - 1 : 0;
    const sw = ctx.o.shiftwidth || ctx.o.tabstop;
    wantVcol -= wantVcol % sw;
    // find the start of the white run before the cursor
    let spaceCol = 0;
    let spaceVcol = 0;
    let v = 0;
    let prevSpace = false;
    for (let i = 0; i < ctx.cur.c; i += 1) {
      const curSpace = isWhite(line[i]);
      if (!prevSpace && curSpace) {
        spaceCol = i;
        spaceVcol = v;
      }
      v += charWidth(line[i], v, ctx.o.tabstop);
      prevSpace = curSpace;
    }
    for (;;) {
      const size = charWidth(line[spaceCol] ?? ' ', spaceVcol, ctx.o.tabstop);
      if (spaceVcol + size > wantVcol) break;
      spaceVcol += size;
      spaceCol += 1;
    }
    let text = line;
    let c = ctx.cur.c;
    while (c > spaceCol) {
      c -= 1;
      text = text.slice(0, c) + text.slice(c + 1);
    }
    let pad = '';
    for (; spaceVcol < wantVcol; spaceVcol += 1) pad += ' ';
    text = text.slice(0, c) + pad + text.slice(c);
    c += pad.length;
    ctx.L[ctx.cur.l] = text;
    ctx.cur = { l: ctx.cur.l, c };
    void vcol;
  } else {
    ctx.L[ctx.cur.l] = line.slice(0, ctx.cur.c - 1) + line.slice(ctx.cur.c);
    ctx.cur = { l: ctx.cur.l, c: ctx.cur.c - 1 };
  }
  if (ctx.cur.c <= 1) ins.didAi = false;
  ctx.setWant = true;
  return true;
}

function insEsc(ctx) {
  const ins = ctx.ins;
  // {count}i...: the typed text is inserted count-1 more times before insert mode ends
  while (ins.count > 1) {
    ins.count -= 1;
    const again = (ins.cmd === 'o' || ins.cmd === 'O' ? ['<CR>'] : []).concat(ins.typed);
    ins.replaying = true;
    for (const k of again) insertKey(ctx, k, false);
    ins.replaying = false;
  }
  const temp = ctx.cur.c;
  // stop_insert: remove the indent autoindent added if nothing was typed after it
  if (ins.didAi) {
    const endPos = { ...ctx.cur };
    const prevCol = endPos.c;
    const tposLine = ctx.cur.l;
    let cc = '';
    for (;;) {
      const line = ctx.L[ctx.cur.l];
      if (ctx.cur.c >= line.length && ctx.cur.c > 0) ctx.cur = { l: ctx.cur.l, c: line.length - 1 };
      cc = gchar(ctx, ctx.cur);
      if (!isWhite(cc)) break;
      const ln = ctx.L[ctx.cur.l];
      ctx.L[ctx.cur.l] = ln.slice(0, ctx.cur.c) + ln.slice(ctx.cur.c + 1);
    }
    if (ctx.cur.l !== tposLine) {
      // not reachable: deletion stays on the line
    } else if (ctx.cur.c < prevCol) {
      if (cc !== '' && ctx.cur.c + 1 >= ctx.L[ctx.cur.l].length) ctx.cur = { l: ctx.cur.l, c: ctx.cur.c + 1 };
    }
  }
  ins.didAi = false;
  if (temp === ctx.cur.c) ctx.setWant = true;
  if (ctx.cur.c !== 0) ctx.cur = { l: ctx.cur.l, c: ctx.cur.c - 1 };
  // the redo record: the command, then what was typed, then <Esc>
  if (ins.redo) {
    ctx.lastChange = { ...ins.redo, keys: [...ins.redo.keys, ...ins.typed, '<Esc>'], base: ins.redo.keys.length };
  }
  ctx.mode = 'normal';
  ctx.ins = null;
  closeChange(ctx);
}

// ---------------------------------------------------------------------------------------------
// Visual mode

function startVisual(ctx, cap) {
  if (cap.count0 > 0 && ctx.reselect) {
    // "{count}v" reselects an area of the previous visual operation's size.
    ctx.unsupported = true;
    return;
  }
  ctx.mode = cap.cmd === 'V' ? 'visual-line' : 'visual';
  ctx.vis = { ...ctx.cur };
  if (cap.count0 > 0 && cap.count1 - 1 > 0) {
    const c2 = { ...cap, count0: cap.count1 - 1, count1: cap.count1 - 1, cmd: cap.cmd === 'v' ? 'l' : 'j' };
    if (cap.cmd === 'v') nvRight(ctx, c2, { op: null });
    else motion(ctx, c2, { op: null });
  }
}

function visualCommand(ctx, cap) {
  const c = cap.cmd;
  switch (c) {
    case '<Esc>':
      endVisual(ctx);
      ctx.setWant = true;
      clampCursor(ctx);
      return;
    case 'v':
    case 'V': {
      const want = c === 'V' ? 'visual-line' : 'visual';
      if (ctx.mode === want) {
        endVisual(ctx);
      } else ctx.mode = want;
      return;
    }
    case 'o':
    case 'O': {
      const old = ctx.cur;
      ctx.cur = ctx.vis;
      ctx.vis = old;
      ctx.setWant = true;
      return;
    }
    case 'x':
      return visualOperator(ctx, cap, 'd');
    case 'X':
    case 'D':
      ctx.mode = 'visual-line';
      return visualOperator(ctx, cap, 'd');
    case 'Y':
      ctx.mode = 'visual-line';
      return visualOperator(ctx, cap, 'y');
    case 's':
      return visualOperator(ctx, cap, 'c');
    case 'S':
    case 'C':
    case 'R':
      ctx.mode = 'visual-line';
      return visualOperator(ctx, cap, 'c');
    case 'J':
      return visualOperator(ctx, cap, 'J');
    case 'u':
      return visualOperator(ctx, cap, 'u');
    case 'U':
      return visualOperator(ctx, cap, 'gU');
    case 'g':
      if (cap.nchar === 'J') return visualOperator(ctx, cap, 'gJ');
      break;
    case '~':
      return visualOperator(ctx, cap, 'g~');
    case 'r':
      if (cap.nchar === '<C-r>') cap.nchar = '\x12';
      if (cap.nchar.length !== 1) {
        if (cap.nchar === '<CR>' || cap.nchar === '<Tab>') {
          ctx.unsupported = true;
          return;
        }
        return;
      }
      return visualOperator(ctx, cap, 'r');
    case 'p':
    case 'P':
      return visualPut(ctx, cap);
    case 'i':
    case 'a': {
      const oap = { op: null };
      const r = textObject(ctx, cap, oap);
      if (r === null) ctx.unsupported = true;
      ctx.setWant = true;
      return;
    }
    case 'I':
    case 'A':
    case '.':
    case '<C-r>':
    case 'G':
      if (c === 'G') break;
      ctx.unsupported = true;
      return;
    default:
      break;
  }
  const oap = { op: null };
  const r = motion(ctx, cap, oap);
  if (r === null) ctx.unsupported = true;
}

function endVisual(ctx) {
  ctx.mode = 'normal';
  ctx.vis = null;
}

/** do_pending_operator for a visual selection. */
function visualOperator(ctx, cap, op) {
  const vis = { ...ctx.vis };
  const cur = { ...ctx.cur };
  const { vmode } = recordVisual(ctx, cap, op, cap.reg);
  applyVisualRegion(ctx, cap, op, vmode, vis, cur);
}

/** Records what "." needs to repeat a Visual operator on an area of the same size. */
function recordVisual(ctx, cap, op, reg) {
  const vmode = ctx.mode;
  let start = { ...ctx.vis };
  let end = { ...ctx.cur };
  if (lt(end, start)) [start, end] = [end, start];
  const lineCount = end.l - start.l + 1;
  // what '.' needs to repeat this on another area
  let vcol;
  if (ctx.curswant === MAXCOL) vcol = MAXCOL;
  else if (lineCount <= 1) {
    const ev = vcolEnd(ctx, end);
    const sv = vcolOf(ctx.L[start.l], start.c, ctx.o.tabstop);
    vcol = ev - sv + 1;
  } else vcol = vcolEnd(ctx, end);
  const redoInfo = { mode: vmode, lineCount, vcol, count: cap.count0 };
  if (op !== 'y') {
    const keys = [];
    if (reg) keys.push('"', reg);
    keys.push(...opKeys(op));
    if (op === 'r') keys.push(cap.nchar);
    recordChange(ctx, { count: 0, keys, visual: redoInfo, op, nchar: cap.nchar, reg });
  }
  ctx.reselect = redoInfo;
  return { vmode, start, end };
}

function vcolEnd(ctx, p) {
  const line = ctx.L[p.l];
  const v = vcolOf(line, p.c, ctx.o.tabstop);
  if (p.c < line.length) return v + charWidth(line[p.c], v, ctx.o.tabstop) - 1;
  return v;
}

/**
 * do_pending_operator over a Visual area. `anchor` is VIsual (in linewise mode its column is
 * taken as 0) and `cursor` the other end; whichever comes first is the start.
 */
function applyVisualRegion(ctx, cap, op, vmode, anchor, cursor, redo = false) {
  const a = vmode === 'visual-line' && !redo ? { l: anchor.l, c: 0 } : { ...anchor };
  const [start, end] = lt(a, cursor) ? [a, { ...cursor }] : [{ ...cursor }, a];
  const oap = { op, reg: cap.reg, start, end, isVisual: true, inclusive: true, motionType: vmode === 'visual-line' ? 'line' : 'char', useRegOne: false };
  oap.lineCount = end.l - start.l + 1;
  if (vmode === 'visual' && gchar(ctx, oap.end) === '') {
    oap.inclusive = false;
    if (!['<', '>', 'J'].includes(op) && oap.end.l < ctx.L.length - 1) {
      oap.end = { l: oap.end.l + 1, c: 0 };
      oap.lineCount += 1;
    }
  }
  ctx.mode = 'normal';
  ctx.vis = null;
  ctx.cur = { ...oap.start };
  ctx.setWant = true;
  oap.empty = oap.motionType !== 'line' && !oap.inclusive && eqpos(oap.start, oap.end);
  if (op === 'J' || op === 'gJ') {
    oap.lineCount = Math.max(oap.lineCount, 2);
    if (ctx.cur.l + oap.lineCount - 1 > ctx.L.length - 1) {
      ctx.keepNul = true; // Neovim beeps and leaves the cursor where the Visual area began
      return oap.start;
    }
    doJoin(ctx, oap.lineCount, op === 'J', true);
    return oap.start;
  }
  applyOperator(ctx, cap, oap);
  return oap.start;
}

function redoVisual(ctx, change, count0) {
  const info = change.visual;
  const start = { ...ctx.cur };
  let endL = Math.min(start.l + info.lineCount - 1, ctx.L.length - 1);
  ctx.forceOneMore = info.mode === 'visual';
  const save = { ...ctx.cur };
  ctx.cur = { l: endL, c: ctx.cur.c };
  if (info.mode === 'visual') {
    let want;
    if (info.lineCount <= 1) {
      const prevMode = ctx.mode;
      ctx.mode = 'normal';
      const cur = ctx.cur;
      ctx.cur = save;
      // C int arithmetic: with a "$" selection info.vcol is MAXCOL and this wraps negative,
      // which Neovim then treats as column 0
      want = (cachedVcol(ctx) + info.vcol - 1) | 0;
      ctx.cur = cur;
      ctx.mode = prevMode;
    }
    else want = info.vcol;
    ctx.curswant = want;
    coladvance(ctx, want);
  } else if (info.vcol === MAXCOL) {
    ctx.curswant = MAXCOL;
    coladvance(ctx, MAXCOL);
  }
  ctx.forceOneMore = false;
  const end = { ...ctx.cur };
  ctx.cur = save;
  const cap = { count0: count0 || info.count, count1: (count0 || info.count) || 1, reg: change.reg, nchar: change.nchar };
  const base = change.base != null ? change.keys.slice(0, change.base) : change.keys;
  const typed = change.base != null ? change.keys.slice(change.base) : [];
  recordChange(ctx, { ...change, keys: base, base: undefined, visual: { ...info, count: cap.count0 } });
  applyVisualRegion(ctx, cap, change.op, info.mode, start, end, true);
  // a change replays its typed text from the record
  if (ctx.mode === 'insert') for (const k of typed) insertKey(ctx, k, true);
}

function visualPut(ctx, cap) {
  const vmode = ctx.mode;
  const regname = cap.reg;
  const keepRegisters = cap.cmd === 'P';
  // the register is read before the selection is deleted into the unnamed/numbered registers
  const savereg = getPutRegister(ctx, regname);
  const vis0 = { ...ctx.vis };
  const cur0 = { ...ctx.cur };
  let start = { ...ctx.vis };
  let end = { ...ctx.cur };
  if (lt(end, start)) [start, end] = [end, start];
  // "." after a Visual put repeats the Visual delete that preceded the put (as in Neovim)
  recordVisual(ctx, cap, 'd', keepRegisters ? '_' : null);
  ctx.oldCol = 0; // nv_put_opt runs the delete with do_pending_operator(cap, 0, false)
  const opStart = applyVisualRegion(ctx, { ...cap, reg: keepRegisters ? '_' : null }, 'd', vmode, vis0, cur0);
  const empty = !!ctx.mlEmpty;
  let dir = -1;
  if ((vmode !== 'visual-line' && ctx.cur.c < opStart.c) || (vmode === 'visual-line' && ctx.cur.l < opStart.l)) dir = 1;
  const flags = { line: vmode === 'visual-line', lineSplit: vmode === 'visual', visualEndL: end.l };
  ctx.mode = vmode; // do_put runs with Visual active
  doPut(ctx, savereg, dir, cap.count1, flags);
  ctx.mode = 'normal';
  ctx.keepNul = false;

  if (empty && ctx.L.length > 1 && ctx.L[ctx.L.length - 1] === '') {
    ctx.L.pop();
    if (ctx.cur.l > ctx.L.length - 1) {
      ctx.cur = { l: ctx.L.length - 1, c: 0 };
      coladvance(ctx, MAXCOL);
    }
  }
}
