// Whether a dictation in progress is actually capturing him, and how loudly to
// say so.
//
// So there are two different things and they must never be confused. Audio is
// arriving, at a normal level, and whisper has no words yet: he is thinking,
// and nothing is said or retried. Audio is not arriving, or it is arriving as
// silence, or the server has stopped acknowledging it, or the clip came back
// shorter than what was held: that is data going missing and it says so
// loudly, while it is still happening and not after he has lost the sentence.

// Level below which a whole run is silence rather than a quiet voice. His own
// dictations measure -30 to -33 dB RMS; room tone is below -55.
export const DEAD_DBFS = -50;

// A quiet voice: worth a hint, never an alarm.
export const FAINT_DBFS = -42;

// No frame at all for this long, while recording, is a microphone that has
// stopped delivering: a device pulled out, a track ended, a suspended context.
export const NO_AUDIO_MS = 1_500;

// Long enough to be sure the level is the room and not the moment before he
// starts talking.
export const DEAD_AIR_MS = 3_000;

// The server has not acknowledged a byte for this long. The audio is still in
// the browser and the stop will send it, so this is a warning, not a loss; it
// is loud because everything after it depends on him knowing.
export const NO_ACK_MS = 6_000;

// Shorter than this and a clip is a slip of the thumb rather than a sentence.
export const SHORT_SEC = 0.4;

const loud = (code, message) => ({ severity: 'loud', code, message });
const quiet = (code, message) => ({ severity: 'quiet', code, message });
const fine = { severity: 'none', code: 'ok', message: '' };

// Frames are arriving and every one of them is silence: the device is there,
// it is open, and it is handing over zeros. That is the one diagnosis worth
// changing microphone over.
//
// NOT 'no-audio'. No frames at all is a track that never started, a refused
// permission or a suspended context; another microphone would fail the same
// way, and "No audio is reaching the recorder" is already the right sentence.
export function inputIsSilent(health) {
  return Boolean(health) && health.code === 'silent';
}

/** What to say once the app has moved him to another microphone by itself. */
export function switchedInput(from, to) {
  return loud('input-switched', `${from} was delivering silence; switched to ${to}. Say that again.`);
}

/** No other microphone to move to: say that rather than promise a fix. */
export function noReplacementInput(from) {
  return loud('input-dead', `${from} is delivering silence and there is no other microphone to switch to.`);
}

/**
 * The state of a recording in flight.
 *
 * @param {object} run
 * @param {number} run.elapsedMs        since the press
 * @param {number} run.capturedSamples  frames the recorder has produced
 * @param {number} run.loudestDbfs      the loudest RMS seen this run, in dBFS
 * @param {number} run.sinceAckMs       since the server last acknowledged audio
 * @param {boolean} run.acking          whether this run uploads at all
 * @param {boolean} run.gaveUp          the preview stopped asking for words
 * @param {boolean} run.clipped         the input hit full scale
 * @param {number} run.words            words the preview has shown so far
 */
export function recordingHealth(run = {}) {
  const elapsed = Number(run.elapsedMs) || 0;
  const captured = Number(run.capturedSamples) || 0;
  const loudest = Number.isFinite(run.loudestDbfs) ? run.loudestDbfs : -Infinity;

  if (elapsed >= NO_AUDIO_MS && captured <= 0) {
    return loud('no-audio', 'No audio is reaching the recorder. Stop, then start again.');
  }
  if (elapsed >= DEAD_AIR_MS && loudest < DEAD_DBFS) {
    return loud('silent', 'The microphone is delivering silence. Check the input and start again.');
  }
  if (run.acking && Number(run.sinceAckMs) >= NO_ACK_MS) {
    return loud('stalled', 'The recording is not reaching the server. It is held here; keep talking.');
  }
  if (run.gaveUp) {
    return loud('preview-stopped', 'The live preview stopped. The recording is safe and will be read in full.');
  }
  if (run.clipped) return quiet('clipping', 'That is loud enough to distort. Hold it further away.');
  if (elapsed >= DEAD_AIR_MS && loudest < FAINT_DBFS) {
    return quiet('faint', 'That is very quiet. Hold the microphone closer.');
  }
  // Audio is arriving at a sensible level and no words have come back. He is
  // thinking. Say nothing, retry nothing.
  return fine;
}

/**
 * The state of a recording that has just stopped.
 *
 * @param {object} clip
 * @param {number} clip.durationSec  what the recorder handed over
 * @param {number} clip.heldSec      what the machine believes was captured
 * @param {number} clip.loudestDbfs  loudest RMS of the run
 * @param {boolean} clip.kept        the record was written
 * @param {number} clip.words        words the transcript came back with
 */
export function stoppedHealth(clip = {}) {
  const duration = Number(clip.durationSec) || 0;
  const held = Number(clip.heldSec) || 0;
  const loudest = Number.isFinite(clip.loudestDbfs) ? clip.loudestDbfs : -Infinity;

  if (!duration) return loud('empty', 'Nothing was recorded. The microphone gave no audio at all.');
  // The recorder handed back materially less than the run lasted: that is the
  // shape of audio actually going missing, and it is worth an alarm even
  // though the transcript may look fine.
  if (held - duration > 0.75) {
    return loud('truncated', `Only ${duration.toFixed(1)}s of ${held.toFixed(1)}s was captured. Check the microphone.`);
  }
  if (duration < SHORT_SEC) {
    return loud('too-short', 'That recording was too short to hold a word.');
  }
  if (loudest < DEAD_DBFS) {
    return loud('silent', 'That recording is silent. Nothing was captured; the audio is kept.');
  }
  // Silence he chose, or a pause: the audio was fine, whisper just had nothing
  // to read. Not an error.
  if (!Number(clip.words)) return fine;
  return fine;
}

/** The louder of two verdicts, so a stop cannot hide what the run found. */
export function worse(a, b) {
  const rank = { none: 0, quiet: 1, loud: 2 };
  const left = a || fine;
  const right = b || fine;
  return rank[right.severity] > rank[left.severity] ? right : left;
}
