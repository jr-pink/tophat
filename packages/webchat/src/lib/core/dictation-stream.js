// The decisions a dictation makes while it is being spoken, as a function.
//
// WHY THIS EXISTS. The recorder, the poll loop, the held audio on the server,
// the window stitch and the stop all interleave, and the ways they interleave
// are where the words go missing: a poll that lands after the one behind it, a
// response that arrives after the button came up, a network that drops for four
// seconds, a stop pressed twice, a second recording started while the first is
// still finishing. Written inside the component, none of that could be walked;
// the bugs were found by measuring his own lost recordings after the fact.
//
// This module decides; it never fetches. The caller performs the effects and
// feeds the answers back in, so the same decisions run in the browser and in
// the checker.

import { initialWindow, LIVE_WINDOW_SEC, nextWindow } from './dictation-window.js';

export const EFFECTS = ['poll', 'finish', 'commit', 'extend', 'keep'];

const clean = (s) => String(s ?? '').replace(/\s+/gu, ' ').trim();

export function initialStream(runId = null) {
  return {
    phase: runId ? 'recording' : 'idle',
    runId,
    // Samples the recorder has produced, and the count the server has
    // acknowledged holding. The difference is what the next poll carries.
    captured: 0,
    acked: 0,
    window: initialWindow(),
    // A preview that has given up still ships audio, so the stop can decode
    // what the preview never read.
    gaveUp: false,
    poll: null,
    finish: null,
    heard: '',
    committed: null,
    whole: null
  };
}

// Only one poll is ever in flight: a second would decode a window the first
// has already moved past, and the answers could land in either order.
const canPoll = (s) => s.phase === 'recording' && !s.poll && s.captured > s.acked;

export function streamStep(state, event) {
  const type = event?.type;

  if (type === 'start') {
    // A new recording, whatever the last one was doing. Its run id is new, so
    // an answer still in flight for the old one cannot be mistaken for this.
    return [{ ...initialStream(event.runId), captured: 0 }, []];
  }

  // What the recorder has produced, as an absolute sample count. The browser
  // knows this by asking the recorder; the checker counts seconds. Same event.
  if (type === 'captured_to') {
    if (state.phase !== 'recording') return [state, []];
    const captured = Math.max(state.captured, Math.max(0, Number(event.samples) || 0));
    const next = { ...state, captured };
    return canPoll(next) ? poll(next) : [next, []];
  }

  if (type === 'chunk') {
    if (state.phase !== 'recording') return [state, []];
    const next = { ...state, captured: state.captured + Math.max(0, Number(event.samples) || 0) };
    return canPoll(next) ? poll(next) : [next, []];
  }

  if (type === 'tick') {
    return canPoll(state) ? poll(state) : [state, []];
  }

  // A poll that landed. `body.heldSamples` is the server's own count of what
  // it holds, and it is the truth in success and in failure alike: anything
  // past it goes again on the next poll, which is what closes the hole when a
  // request is lost, retried, duplicated or delivered out of order.
  if (type === 'poll_ok' || type === 'poll_error' || type === 'poll_lost') {
    if (!state.poll || state.poll.id !== event.id) return [state, []];
    const sent = state.poll;
    let next = { ...state, poll: null };
    if (type !== 'poll_lost') {
      const held = Number(event.body?.heldSamples);
      if (Number.isFinite(held) && held >= 0) next.acked = Math.max(next.acked, held);
    }
    if (type === 'poll_ok' && !state.gaveUp && state.phase === 'recording') {
      // The window the answer was asked for, not whatever the window has
      // become: a late answer must not be folded into a window it never saw.
      if (sent.startSec === state.window.startSec) {
        const window = nextWindow(state.window, event.body, event.body?.windowSec);
        next = { ...next, window, heard: clean(window.text) };
      }
    }
    if (type === 'poll_error' && !(event.kind === 'warming' || event.kind === 'behind')) {
      // Given up on the preview is not given up on the recording: the audio
      // keeps going so the stop can decode what nobody read.
      next.gaveUp = true;
    }
    return [next, []];
  }

  if (type === 'stop') {
    if (state.phase !== 'recording') return [state, []];
    // Pressed and released with nothing recorded: there is no utterance, so
    // there is nothing to commit, nothing to keep and nothing to finish.
    if (!state.captured) return [{ ...initialStream(null), phase: 'idle' }, []];
    const heard = clean(state.heard);
    const id = `f-${state.runId}`;
    const next = {
      ...state,
      phase: 'finishing',
      poll: null,
      committed: heard || null,
      finish: { id, startSec: state.window.startSec, from: state.acked }
    };
    // The recording is finished from where those words ran out, which is never
    // the end: the cadence and the decode behind it are speech nobody has read.
    const effects = [{
      type: 'finish', id, runId: state.runId,
      startSec: state.window.startSec, from: state.acked, preview: heard,
      // Seconds the preview moved past without reading them: the stop goes
      // back for the whole recording rather than finishing its tail.
      whole: Boolean(Number(state.window.unread) || state.gaveUp)
    }];
    return [next, heard ? [{ type: 'commit', text: heard }, ...effects] : effects];
  }

  if (type === 'final_ok') {
    if (state.phase !== 'finishing' || state.finish?.id !== event.id) return [state, []];
    const preview = clean(state.committed);
    const whole = complete(state, event.body, preview);
    const next = { ...state, phase: 'done', finish: null, whole, committed: whole || preview || null };
    const effects = [{ type: 'keep', kept: Boolean(event.body?.stored), transcript: whole }];
    if (!preview && whole) effects.unshift({ type: 'commit', text: whole });
    else if (whole && whole !== preview) effects.unshift({ type: 'extend', text: whole });
    return [next, effects];
  }

  if (type === 'final_error' || type === 'final_lost') {
    if (state.phase !== 'finishing' || state.finish?.id !== event.id) return [state, []];
    // Nothing came back, so what he watched being typed stands for now. The
    // recording goes up the ordinary way and carries no transcript with it:
    // the preview's words stop at its last poll, and passing them off as the
    // transcript would lose the end of the sentence a second time. The decode
    // on the other side reads the whole recording, and `recovered` is it
    // coming back.
    return [
      { ...state, phase: 'recovering', finish: null, whole: null },
      [{ type: 'keep', kept: false, transcript: null }]
    ];
  }

  if (type === 'recovered') {
    if (state.phase !== 'recovering') return [state, []];
    const text = clean(event.text);
    const preview = clean(state.committed);
    const better = text.split(/\s+/u).filter(Boolean).length >= preview.split(/\s+/u).filter(Boolean).length;
    const whole = text && better ? text : preview;
    const effects = [];
    if (whole && whole !== preview) effects.push({ type: preview ? 'extend' : 'commit', text: whole });
    return [{ ...state, phase: 'done', whole, committed: whole || null }, effects];
  }

  if (type === 'unrecoverable') {
    // The bytes are gone (a reload that outlived them, a permanent refusal).
    // What he watched is what there is.
    if (state.phase !== 'recovering') return [state, []];
    return [{ ...state, phase: 'done', whole: state.committed }, []];
  }

  return [state, []];
}

function poll(state) {
  const id = `p-${state.runId}-${state.acked}-${state.window.startSec}`;
  const next = { ...state, poll: { id, from: state.acked, startSec: state.window.startSec } };
  return [next, [{
    type: 'poll', id, runId: state.runId,
    from: state.acked, to: state.captured,
    startSec: state.window.startSec,
    decode: state.gaveUp ? 0 : 1
  }]];
}

// The whole sentence at the stop: the preview's words plus everything said
// after the last poll reached. A tail continues the window it was cut from, a
// whole decode read the entire recording and replaces it, and neither may come
// back shorter than what he already watched.
function complete(state, body, preview) {
  const text = clean(body?.text);
  if (!text) return preview;
  if (body?.kind === 'whole') {
    return text.split(/\s+/u).length >= preview.split(/\s+/u).filter(Boolean).length ? text : preview;
  }
  const server = clean(body?.complete);
  const stitched = server || clean(nextWindow(state.window, body, body?.windowSec)?.text);
  return stitched.length >= preview.length ? stitched : preview;
}

// What the stop asks the server to decode: a gap shorter than a window is
// finished on the preview's own model, a longer one means the preview lost the
// thread and the whole recording is read accurately instead.
export function finishKind(heldSec, startSec) {
  return heldSec - startSec > LIVE_WINDOW_SEC ? 'whole' : 'tail';
}

export const resting = (s) => s.phase === 'idle' || s.phase === 'done';
export const recovering = (s) => s.phase === 'recovering';
export const armed = (s) => Boolean(s.poll || s.finish);
