

// Where a turn ends, decided from the level meter rather than from a cloud
// recogniser's own idea of an utterance. The rule is his: speech has to have
// happened, and then the room has to go quiet for long enough that he has
// plainly finished, not merely paused between two clauses.


// Below this an input is the room, not a voice. The same floor the dictation
// meter calls "quiet" in audio-levels.js, so one number governs both surfaces.
export const SPEECH_DB = -45;


// A door closing is louder than the floor for a moment. A turn has to carry
// this much speech before silence can end it.
export const MIN_SPEECH_MS = 250;


// A tab that slept, or a meter that missed frames, must not bank the whole gap
// as silence and cut him off the moment he comes back.
export const MAX_STEP_MS = 400;

export function initialGate() {
  return { speechMs: 0, silenceMs: 0, at: null, spoke: false };
}

/**
 * One meter reading in, the next gate and whether this reading ended the turn.
 * `at` is a millisecond clock; `rmsDb` the reading in dBFS.
 */
export function nextGate(gate, { rmsDb, at, endpointMs = 1_400, floorDb = SPEECH_DB, minSpeechMs = MIN_SPEECH_MS }) {
  const now = Number(at);
  const previous = Number.isFinite(gate.at) ? gate.at : now;
  const step = Math.max(0, Math.min(MAX_STEP_MS, now - previous));
  const loud = Number(rmsDb) > floorDb;
  const speechMs = loud ? gate.speechMs + step : gate.speechMs;
  const silenceMs = loud ? 0 : gate.silenceMs + step;
  const spoke = gate.spoke || speechMs >= minSpeechMs;
  const endpoint = spoke && silenceMs >= endpointMs;
  
  
  if (endpoint) return { gate: { ...initialGate(), at: now }, endpoint: true };
  return { gate: { speechMs, silenceMs, at: now, spoke }, endpoint: false };
}
