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

export function matches(e, s) {
  const single = e.key.length === 1
  const letter = single && e.key.toLowerCase() !== e.key.toUpperCase()
  const sameKey = single && s.key.length === 1 ? e.key.toLowerCase() === s.key.toLowerCase() : e.key === s.key
  if (!sameKey) return false
  if (!!e.ctrlKey !== s.ctrl || !!e.metaKey !== s.meta || !!e.altKey !== s.alt) return false
  // shift is strict for letters and named keys (g is not shift+g, ArrowUp is not shift+ArrowUp);
  // for punctuation and digits the character already encodes it ("?" is shift+/), so it is ignored
  if (letter || !single) return !!e.shiftKey === s.shift
  return true
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
    bind(map, { repeat = false } = {}) {
      const mine = Object.entries(map).map(([spec, fn]) => ({ spec: parseSpec(spec, mac), fn, repeat }))
      stack.push(...mine)
      return () => { for (const b of mine) { const i = stack.indexOf(b); if (i >= 0) stack.splice(i, 1) } }
    },
    dispose() { target.removeEventListener('keydown', onKey) },
    get size() { return stack.length },
  }
}
