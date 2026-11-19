// One keymap for the whole viewer. bind({ 'g': fn, 'shift+g': fn, 'mod+z': fn, 'Escape': fn }) returns an
// unbind function; the most recent binding of a key wins; ctx.keys unbinds a part's keys when it swaps.
//
// Rules, because macOS text fields have emacs keys (ctrl-a ctrl-e ctrl-n ctrl-p ctrl-k ...):
//  - nothing fires while focus is in a text-entry control (input except range/checkbox/radio/button,
//    textarea, select, contenteditable); the browser's own handling is never prevented there
//  - a binding fires on a ctrl/meta/alt chord ONLY if its spec names that modifier ("ctrl+", "meta+",
//    "alt+", or "mod+" = meta on macOS, ctrl elsewhere); a bare "g" never fires on ctrl-g
//  - key repeat is ignored unless the binding is declared { repeat: true }
//  - preventDefault only when a binding actually matched
const TYPING_INPUT = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit'])

export function isTyping(el) {
  if (!el || el.nodeType !== 1) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !TYPING_INPUT.has((el.type || 'text').toLowerCase())
  return !!el.isContentEditable
}

export function parseSpec(spec, mac) {
  const parts = spec.split('+')
  let key = parts.pop()
  if (spec.endsWith('++')) key = '+'
  const m = { ctrl: false, meta: false, alt: false, shift: false }
  for (const p of parts) {
    const q = p.toLowerCase()
    if (q === 'mod') m[mac ? 'meta' : 'ctrl'] = true
    else if (q in m) m[q] = true
  }
  return { key, ...m }
}

// What Shift makes of a punctuation key: the browser reports the shifted character ("mod+shift+." arrives as key ">"), so a
// spec naming shift and the unshifted character ("mod+shift+.") also matches the shifted one.
export const SHIFTED = { '.': '>', ',': '<', '/': '?', ';': ':', "'": '"', '[': '{', ']': '}', '\\': '|', '-': '_', '=': '+', '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')' }


// The character a keydown stands for when e.key cannot be trusted. The number row is matched by physical key. With Option held, any
// other key whose character was rewritten to a non-ASCII or dead one falls back to its US-QWERTY physical position.
const CODE_CHARS = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`' }
export function physicalChar(e) {
  const code = e.code || ''
  let m = /^Digit([0-9])$/.exec(code)
  if (m) return m[1]
  if (!e.altKey) return null
  const k = e.key || ''
  if (k.length === 1 && k.charCodeAt(0) < 128 && k !== ' ') return null
  m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1].toLowerCase()
  return CODE_CHARS[code] || null
}

export function matches(e, s) {
  const single = e.key.length === 1
  const letter = single && e.key.toLowerCase() !== e.key.toUpperCase()
  let sameKey = single && s.key.length === 1 ? e.key.toLowerCase() === s.key.toLowerCase() : e.key === s.key
  if (!sameKey && s.key.length === 1) { const c = physicalChar(e); if (c && c === s.key.toLowerCase()) sameKey = true }
  if (!sameKey && s.shift && e.shiftKey && single && s.key.length === 1 && SHIFTED[s.key] === e.key) sameKey = true
  if (!sameKey) return false
  if (!!e.ctrlKey !== s.ctrl || !!e.metaKey !== s.meta || !!e.altKey !== s.alt) return false
  // shift is strict for letters and named keys (g is not shift+g, ArrowUp is not shift+ArrowUp);
  // for punctuation and digits the character already encodes it ("?" is shift+/), so it is ignored
  if (letter || !single) return !!e.shiftKey === s.shift
  return !s.shift || !!e.shiftKey // a spec that names shift needs it held, whichever character it makes
}

export function createKeys(target = globalThis.window, { mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') } = {}) {
  const stack = [] // { spec, fn, repeat }
  function onKey(e) {
    if (e.defaultPrevented || e.isComposing) return
    if (isTyping(e.target) || isTyping(target.document?.activeElement)) return
    for (let i = stack.length - 1; i >= 0; i--) {
      const b = stack[i]
      if (!matches(e, b.spec)) continue
      if (e.repeat && !b.repeat) return
      e.preventDefault()
      b.fn(e)
      return
    }
  }
  target.addEventListener('keydown', onKey)
  return {
    // rank (optional) orders bindings independently of WHEN they were bound: a higher rank wins, equal ranks fall back
    // to newest-wins. Parts bind with their file order as rank, so a part that mounts late (its data arrived last)
    // does not steal a key from a later part; unranked bindings rank above every ranked one, newest first, as before.
    bind(map, { repeat = false, rank = Infinity } = {}) {
      const mine = Object.entries(map).map(([spec, fn]) => ({ spec: parseSpec(spec, mac), fn, repeat, rank }))
      let at = stack.length
      while (at > 0 && stack[at - 1].rank > rank) at--
      stack.splice(at, 0, ...mine)
      return () => { for (const b of mine) { const i = stack.indexOf(b); if (i >= 0) stack.splice(i, 1) } }
    },
    dispose() { target.removeEventListener('keydown', onKey) },
    get size() { return stack.length },
  }
}
