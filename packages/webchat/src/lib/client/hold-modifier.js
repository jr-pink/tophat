// The notes bar's hold-to-modify key, as arithmetic, so the chord table is testable without a
// keyboard or a DOM.
//
// A phone has no ⌘. What the bar gives instead is a segment held down with one thumb while the
// other hand taps the soft keyboard, so "held" is a pointer that went down and has not come up.
// One-handed that is impossible, so a tap that comes straight back up latches instead: the next
// key counts as chorded, the way a sticky modifier works, and the latch expires on its own so a
// forgotten tap never swallows the letter he types a minute later.
//
// The chords are the notes page's own, key for key, so the bar and a hardware keyboard say the
// same thing: ⌘. cycles the marker ring, ⌘/ folds the caret's line, ⌘↵ hands the block to a new
// chat, ⌘F filters, ⌘↑ goes to the top and ⌘↓ back to the present.
//
// c / x / v name the clipboard trio and nothing more: this module decides what was asked for,
// the caller performs it through navigator.clipboard. A paste is the one that constrains the
// caller -- navigator.clipboard.readText() only resolves inside a user gesture, so it has to be
// run from the bar's own pointer handler, not from a keydown that arrives after it.

const CHORDS = {
  '.': 'cycle',
  '/': 'fold',
  Enter: 'chat',
  f: 'find',
  ArrowUp: 'top',
  ArrowDown: 'present',
  c: 'copy',
  x: 'cut',
  v: 'paste'
};

/** How long a tapped cmd stays armed by default, in ms. */
export const LATCH_MS = 2500;

/** What a key means while cmd is held, or null. Case is the shift key's business, not the
 *  chord's: ⇧F is still find, the way the page reads it. */
function action(key) {
  if (typeof key !== 'string' || !key) return null;
  return CHORDS[key] ?? (key.length === 1 ? CHORDS[key.toLowerCase()] ?? null : null);
}

/** One cmd key's state. The caller asks isHeld() first and chordFor() second: reading the
 *  chord is what spends a latch. */
export function holdModifier() {
  let down = false;
  let until = 0;

  const latched = () => until > Date.now();

  return {
    /** The thumb went down. A real hold supersedes whatever a previous tap left armed. */
    press() {
      down = true;
      until = 0;
      return true;
    },

    /** The thumb came up. A latch set for the keys that follow outlives it. */
    release() {
      down = false;
      return latched();
    },

    isHeld() {
      return down || latched();
    },

    /** Arm the sticky modifier for one following key. A ms of zero or less disarms it. */
    latchFor(ms = LATCH_MS) {
      until = Number.isFinite(ms) && ms > 0 ? Date.now() + ms : 0;
      return latched();
    },

    /** What this key asks for while cmd is held, or null for a key that is not a chord. A
     *  latch is spent here, on the first key that actually means something: a stray Shift or
     *  a mistyped letter must not eat the modifier he armed. */
    chordFor(key) {
      const found = action(key);
      if (found && !down) until = 0;
      return found;
    }
  };
}
