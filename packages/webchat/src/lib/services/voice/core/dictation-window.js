


// How often the preview asks for words. It is a cadence now rather than a
// hope: the browser sends the quarter second it just captured, about eight
// kilobytes, instead of re-uploading the whole window.
export const PARTIAL_MS = 250;

export const LIVE_WINDOW_SEC = 16;
export const LIVE_TRIM_SEC = 12;
export const LIVE_CONTEXT_SEC = 4;
export const LIVE_OVERLAP_SEC = 4;
const clean = (s) => String(s ?? '').replace(/\s+/gu, ' ').trim();
const join = (a, b) => clean(`${a} ${b}`);
const tokens = (s) => [...s.matchAll(/\S+/gu)].map(m => ({
  key: m[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''), end: m.index + m[0].length
}));

export function overlapEnd(prefix, text) {
  if (!prefix) return 0;
  const a = tokens(prefix).slice(-40), b = tokens(text).slice(0, 60);
  const floor = Math.min(3, a.length);
  for (let size = Math.min(a.length, b.length); size >= floor; size--) {
    for (let end = size; end <= b.length; end++) {
      if (a.slice(-size).every((t, i) => t.key && t.key === b[end - size + i].key)) return b[end - 1].end;
    }
  }
  return null;
}


// The least a forced window moves, so it can never ask twice for the same
// audio; what it steps past without committing is counted as unread.
const MIN_STEP_SEC = LIVE_TRIM_SEC - LIVE_OVERLAP_SEC;

const full = (durationSec) => Number.isFinite(durationSec) && durationSec >= LIVE_WINDOW_SEC - 0.05;

// The part of a window's decode that the committed prefix does not already
// cover, by the clock rather than by the words: a window always carries
// LIVE_OVERLAP_SEC of already-committed speech at its front.
function afterOverlap(result, raw, durationSec) {
  const segments = result?.segments;
  const whole = { text: raw, end: durationSec };
  if (!Array.isArray(segments) || !segments.length) return whole;
  const kept = segments.filter((s) => Number.isFinite(s.start) && s.start >= LIVE_OVERLAP_SEC - 0.5);
  if (!kept.length) return whole;
  const text = clean(kept.map((s) => s.text).join(' '));
  if (!text) return whole;
  const end = kept.reduce((last, s) => (Number.isFinite(s.end) ? Math.max(last, s.end) : last), 0);
  return { text, end: end || durationSec };
}


// The words of a decode that end before the forced cut, which is the speech
// the window is about to stop carrying. By the clock, not by matching text:
// when the decode cannot be lined up with what is committed, its words are the
// only thing that cannot be trusted.
function retired(result, durationSec) {
  const segments = result?.segments;
  if (!Array.isArray(segments) || !segments.length) return null;
  const cut = Math.min(LIVE_TRIM_SEC, Math.max(0, durationSec - LIVE_CONTEXT_SEC));
  const kept = segments.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)
    && s.start >= LIVE_OVERLAP_SEC - 0.5 && s.end <= cut + 0.01);
  const text = clean(kept.map((s) => s.text).join(' '));
  if (!text) return null;
  return { text, end: kept.reduce((last, s) => Math.max(last, s.end), 0) };
}

// The window, moved on by a trim's worth whatever the decode said. It keeps
// LIVE_OVERLAP_SEC of overlap so the next decode has context, and its
// checkpoint is where it was, so a later window that cannot align has
// somewhere to fall back to.
// `committedEnd` is the second, within this window, that the committed text now
// reaches. The next window has to start a single overlap behind it: start
// earlier and the speech in between is committed twice, which is how his hair
// clip came out saying "can I do salt or something? I do salt or something";
// start later and nothing ever decodes the gap.
function forward(state, committed, text, committedEnd = LIVE_TRIM_SEC) {
  const wanted = committed ? Math.max(0, committedEnd - LIVE_OVERLAP_SEC) : 0;
  // Never stand still: a window that does not move asks for the same audio for
  // ever, and everything after it is outside every window there will be.
  const step = Math.max(wanted, MIN_STEP_SEC);
  return {
    startSec: state.startSec + step,
    prefix: committed ? join(state.prefix, committed) : state.prefix,
    previous: '',
    text: clean(text) || state.text,
    // Seconds the window moved past without committing a word of them. They
    // are not lost, but only the stop can go back for them, so it reads the
    // whole recording instead of finishing the tail.
    unread: (Number(state.unread) || 0) + (step - wanted),
    checkpoint: { startSec: state.startSec, prefix: state.prefix, previous: '', text: state.text }
  };
}

export function initialWindow() {
  return { startSec: 0, prefix: '', previous: '', text: '' };
}

export function nextWindow(state, result, durationSec) {
  const raw = clean(result?.text);
  // A full window that read nothing is silence, and silence has to move too:
  // hold the button, think for twenty seconds and then speak, and a window
  // that only advances on words it committed would still be showing the first
  // sixteen seconds of nothing when the sentence arrives.
  if (!raw) return full(durationSec) ? forward(state, '', state.text) : state;
  const overlap = overlapEnd(state.prefix, raw);
  if (overlap === null) {
    // A window with room to grow can afford to go back to its last agreed state
    // and try again. A full one cannot: audio past its end is not decoded by
    // anybody, so waiting for the text to line up loses the recording. Measured
    // on a 39.5 s dictation of his: the window stopped advancing at 22.2 s,
    // alternated between two starts for the rest of the recording, and the last
    // 16.4 s were never read at all, 33 words of it. So a full window takes
    // this decode as it stands. What the committed prefix already covers is cut
    // by time rather than by matching words, because the overlap is four
    // seconds by construction. A window with room to grow waits where it is:
    // this decode said nothing that can be joined to what is committed, so it
    // is ignored and the next poll, with more audio, is asked again. It used to
    // reopen the last agreed window instead, and that was a loop: the older
    // window is full, so it commits and steps forward to here, where the decode
    // fails again.
    if (!full(durationSec)) {
      const back = state.checkpoint || initialWindow();
      const wouldBeFull = full(state.startSec - back.startSec + durationSec);
      if (wouldBeFull) return { ...state, previous: '' };
      return { ...back, text: state.text, previous: '' };
    }
    // What the committed prefix already covers is cut by time rather than by
    // matching words, because the overlap is four seconds by construction.
    // Prefer the words that are safely behind the trim; if the decode has no
    // segment ending that early, take what it read and move the window to the
    // end of it rather than a trim's worth.
    const read = afterOverlap(result, raw, durationSec);
    const keep = retired(result, durationSec) || read;
    // Commit only what is safely behind the trim, but show everything it read:
    // the words in the last four seconds are committed by the next window,
    // which starts where this commit ends, so they are shown once and
    // committed once.
    return forward(state, keep.text, join(state.prefix, read.text), keep.end);
  }
  const text = clean(raw.slice(overlap));
  const whole = join(state.prefix, text);
  const next = { ...state, previous: text, text: whole };
  if (!Number.isFinite(durationSec) || durationSec < LIVE_TRIM_SEC) return next;
  const segments = result?.segments;
  // A decode with no usable segment times cannot be cut by the clock, and a
  // full window cannot wait for one: it moves on carrying what it read.
  const blind = !Array.isArray(segments) || !segments.length
    || clean(segments.map((s) => s.text).join(' ')) !== raw;
  // With no segment times the decode covers the whole window, so the window
  // moves to the end of what it just committed.
  if (blind) return full(durationSec) ? forward(state, text, whole, durationSec) : next;
  let accumulated = '', agreed = '', cut = 0, lastEnd = 0;
  for (const s of segments) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)
      || s.start < lastEnd - 0.01 || s.end <= s.start || s.end > durationSec - LIVE_CONTEXT_SEC) break;
    lastEnd = s.end;
    accumulated = join(accumulated, s.text);
    if (accumulated.length <= overlap) continue;
    const candidate = clean(accumulated.slice(overlap));
    if (!candidate || !(state.previous === candidate || state.previous.startsWith(`${candidate} `))) break;
    agreed = candidate;
    cut = s.end;
  }
  // Nothing the window can commit and no room left to grow: it moves anyway.
  // Waiting for agreement while audio runs past the end of the window is how a
  // recording loses its second half, which is what it did to his 39.5 s
  // dictation. A forced cut keeps the last four seconds as context, exactly as
  // an agreed one does, and what it carries over is cut by the clock.
  if (cut <= LIVE_OVERLAP_SEC || !agreed) {
    if (!full(durationSec)) return next;
    const forced = retired(result, durationSec);
    return forced
      ? forward(state, forced.text, whole, forced.end)
      : forward(state, '', whole);
  }
  return {
    startSec: state.startSec + cut - LIVE_OVERLAP_SEC,
    prefix: join(state.prefix, agreed),
    previous: '',
    text: whole,
    checkpoint: { startSec: state.startSec, prefix: state.prefix,
      previous: '', text: whole }
  };
}

export function audioWindow(buffers, ends, rate, startSec = 0, maxSec = LIVE_WINDOW_SEC) {
  const total = ends.at(-1) || 0;
  const from = Math.min(total, Math.max(0, Math.round(startSec * rate)));
  const to = Math.min(total, from + Math.round(maxSec * rate));
  let lo = 0, hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ends[mid] <= from) lo = mid + 1;
    else hi = mid;
  }
  const chunks = [];
  for (let i = lo; i < buffers.length; i += 1) {
    const base = i ? ends[i - 1] : 0;
    if (base >= to) break;
    chunks.push(buffers[i].subarray(Math.max(0, from - base), Math.min(buffers[i].length, to - base)));
  }
  return { chunks, startSec: from / rate, durationSec: (to - from) / rate };
}
