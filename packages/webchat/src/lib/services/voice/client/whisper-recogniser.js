

// Voice mode's ears, on the same local whisper the dictation button uses.
// Chrome's SpeechRecognition sends his audio to Google, takes no prompt or
// vocabulary, cannot be finetuned and ends its own sessions; this one is the
// backend we keep working on, so voice mode and dictation improve together.
//
// The microphone is opened once for the whole session and never handed back
// between turns: a grab per turn is what blinked the recording indicator.

import { createRecorder, listInputs } from './dictation-recorder.js';
import { LIVE_TRIM_SEC, LIVE_WINDOW_SEC, initialWindow, nextWindow } from '$lib/services/voice/core/dictation-window.js';
import { initialGate, nextGate } from '$lib/services/voice/core/speech-gate.js';


// Partials are polled a little slower than the live model decodes, so a poll
// never queues behind the one before it.
export const PARTIAL_EVERY_MS = 400;


// The accurate pass has the whole utterance and a second is plenty;
// large-v3-turbo measured 950 ms on a 3.7 s clip.
export const FINAL_DEADLINE_MS = 15_000;

export const PARTIAL_DEADLINE_MS = 4_000;


// Three hard failures in a row is a broken engine rather than a cold one; the
// state machine hears about it and can stop pretending to listen.
const PARTIAL_GIVE_UP = 3;

export function createWhisperRecogniser({
  onPartial = () => {},
  onFinal = () => {},
  
  onEnd = () => {},
  onError = () => {},
  onEndpoint = () => {},
  endpointMs = 1_400,
  deviceId = null,
  
  fetchImpl = null,
  now = () => Date.now(),
  makeRecorder = createRecorder,
  inputs = listInputs,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id)
} = {}) {
  const http = (...args) => (fetchImpl || fetch)(...args);

  let recorder = null;
  let listening = false;
  let starting = null;
  let gate = initialGate();
  let heard = initialWindow();
  let utteranceStartSec = 0;
  let timer = null;
  let inFlight = null;
  let failures = 0;
  let finishing = false;

  function mic() {
    if (recorder) return recorder;
    recorder = makeRecorder({
      deviceId,
      onLevel: (reading) => {
        if (!listening || finishing) return;
        const rmsDb = typeof reading === 'number' ? reading : reading?.rmsDb;
        if (!Number.isFinite(rmsDb)) return;
        const step = nextGate(gate, { rmsDb, at: now(), endpointMs });
        gate = step.gate;
        if (step.endpoint) void finish();
      },
      onError: (kind, message) => {
        listening = false;
        stopPolling();
        onError(kind === 'denied' ? 'not-allowed' : 'unsupported', message);
      },
      onDevice: () => {}
    });
    return recorder;
  }

  function stopPolling() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    inFlight?.abort();
    inFlight = null;
  }

  async function poll() {
    if (!listening || finishing || inFlight) return;
    const snapshot = recorder?.snapshotWindow?.(heard.startSec, LIVE_WINDOW_SEC);
    if (!snapshot?.blob) return;
    const controller = new AbortController();
    inFlight = controller;
    try {
      const response = await http('/api/voice/transcribe/live', {
        method: 'POST',
        headers: {
          'content-type': 'audio/wav',
          'x-dictation-timestamps': snapshot.durationSec >= LIVE_TRIM_SEC ? '1' : '0'
        },
        body: snapshot.blob,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(PARTIAL_DEADLINE_MS)])
      });
      const body = await response.json().catch(() => null);
      if (inFlight !== controller || !listening) return;
      if (response.ok) {
        failures = 0;
        heard = nextWindow(heard, body, snapshot.durationSec);
        onPartial(heard.text);
        return;
      }
      
      
      if (response.status === 503 || body?.kind === 'warming') return;
      failures += 1;
    } catch {
      
      failures += 1;
    } finally {
      if (inFlight === controller) inFlight = null;
    }
    if (failures >= PARTIAL_GIVE_UP) {
      failures = 0;
      onError('network', 'The local transcription engine is not answering.');
    }
  }

  
  
  async function finish() {
    if (finishing || !listening) return;
    finishing = true;
    stopPolling();
    const spoken = heard.text;
    const elapsed = recorder?.elapsedSec || 0;
    const clip = recorder?.snapshotWindow?.(utteranceStartSec, Math.max(0.2, elapsed - utteranceStartSec + 0.2));
    let text = spoken;
    if (clip?.blob) {
      try {
        const response = await http('/api/voice/transcribe', {
          method: 'POST',
          headers: { 'content-type': 'audio/wav' },
          body: clip.blob,
          signal: AbortSignal.timeout(FINAL_DEADLINE_MS)
        });
        const body = await response.json().catch(() => null);
        
        
        if (response.ok && String(body?.text || '').trim()) text = String(body.text).trim();
      } catch {
        
      }
    }
    
    
    recorder?.reset?.();
    utteranceStartSec = 0;
    heard = initialWindow();
    gate = initialGate();
    finishing = false;
    if (!listening) return;
    if (text) onFinal(text);
    onEndpoint();
  }

  async function begin() {
    const devices = await inputs();
    if (Array.isArray(devices) && devices.length === 0) {
      listening = false;
      onError('audio-capture', 'No microphone is available to this browser.');
      return;
    }
    const engine = mic();
    if (!engine.recording) {
      const ok = await engine.start();
      if (!ok) { listening = false; return; }
    }
    if (!listening) return;
    engine.reset?.();
    utteranceStartSec = 0;
    if (timer === null) timer = setTimer(() => poll(), PARTIAL_EVERY_MS);
  }

  return {
    start() {
      if (listening) return starting;
      listening = true;
      failures = 0;
      gate = initialGate();
      heard = initialWindow();
      starting = begin().finally(() => { starting = null; });
      return starting;
    },

    
    
    stop() {
      if (!listening) return;
      listening = false;
      stopPolling();
      gate = initialGate();
      heard = initialWindow();
      recorder?.reset?.();
      utteranceStartSec = 0;
    },

    get listening() { return listening; },

    
    dispose() {
      listening = false;
      stopPolling();
      const engine = recorder;
      recorder = null;
      return engine?.dispose?.();
    }
  };
}
