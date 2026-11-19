// The pure half of hands-free voice mode on the OpenAI Realtime transcription session: turning microphone frames
// into what the socket wants, deciding which transcripts are worth sending as a message, and deciding when his
// voice over the speaker is a barge-in rather than the speaker's own echo. No browser, no socket, so the rules are
// tested directly (test/voice-handsfree.test.mjs).

import { isStockPhrase } from './quiet-audio.js';
import { SPEECH_DB, MIN_SPEECH_MS } from './speech-gate.js';
import { pickDevice } from './audio-devices.js';

/** The rate the Realtime API takes PCM16 at. */
export const REALTIME_RATE = 24_000;

/**
 * One microphone frame (Float32, any rate) to 24 kHz PCM16. Each output sample averages the input samples that fall
 * inside its slot, which is the low-pass an integer or fractional decimation needs; the carry holds the fraction of
 * a slot a frame ended in, so a stream cut into frames comes out the same as the stream whole.
 */
export function makeDownsampler(inRate, outRate = REALTIME_RATE) {
  const ratio = inRate / outRate;
  let sum = 0;
  let count = 0;
  let phase = 0;
  return function downsample(frame) {
    const out = [];
    for (let i = 0; i < frame.length; i += 1) {
      sum += frame[i];
      count += 1;
      phase += 1;
      if (phase >= ratio) {
        phase -= ratio;
        const mean = sum / count;
        const clipped = Math.max(-1, Math.min(1, mean));
        out.push(clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767));
        sum = 0;
        count = 0;
      }
    }
    return Int16Array.from(out);
  };
}

/** PCM16 to the base64 the `input_audio_buffer.append` event carries. */
export function pcmToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
}

/** RMS of a Float32 frame in dBFS; silence is -100. */
export function frameDb(frame) {
  if (!frame?.length) return -100;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/**
 * A stock phrase ("thank you", "you") needs this much real speech under it to stand; anything else only needs
 * to be real speech at all. Silence decoded as a pleasantry is the one invention a transcriber makes.
 */
export const STOCK_NEEDS_MS = 900;

/**
 * Whether a finished transcript becomes a message. `speechMs` is how long the microphone was actually above the
 * speech floor while the turn was open, measured here and not by the model, so a hallucination from room tone
 * (nothing loud, something written) is dropped whatever it says.
 */
export function worthSending(text, { speechMs = 0 } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return false;
  if (/^[\[(<].*[\])>]$/u.test(body)) return false;
  const letters = body.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length < 2) return false;
  if (speechMs < MIN_SPEECH_MS) return false;
  if (isStockPhrase(body) && speechMs < STOCK_NEEDS_MS) return false;
  return true;
}

/** Above this, with echo cancellation on, the room is his voice and not the reply coming back out of the speaker. */
export const BARGE_DB = -32;

/** And it has to stay there this long, so a cough or a click does not cut the reply off. */
export const BARGE_MS = 280;

/** After the reply stops, this long before the microphone is believed again: the tail of the room. */
export const RESUME_HOLDOFF_MS = 350;

/** How much audio from just before a barge-in is sent with it, so his first word is not clipped. */
export const PREROLL_MS = 450;

export function initialBarge() {
  return { loudMs: 0, at: null };
}

/** One level reading in while the reply plays; whether his voice has been over the line long enough. */
export function nextBarge(state, { db, at, floorDb = BARGE_DB, needMs = BARGE_MS }) {
  const now = Number(at);
  const step = Number.isFinite(state.at) ? Math.max(0, Math.min(400, now - state.at)) : 0;
  const loudMs = Number(db) > floorDb ? state.loudMs + step : 0;
  if (loudMs >= needMs) return { state: { loudMs: 0, at: now }, barge: true };
  return { state: { loudMs, at: now }, barge: false };
}

/** The same floor the end-of-turn gate uses for "this is a voice", exported so the two never drift. */
export const SPEECH_FLOOR_DB = SPEECH_DB;

/**
 * Which microphone to open, from the list the browser gave and the one he picked in the voice panel.
 * Never a refusal: a device that has vanished is a fall back to what is there, with the reason, and the stored
 * choice is left alone so the same microphone returns the moment it is plugged back in.
 */
export function resolveVoiceMic({ devices = [], preferredId = null, preferredLabel = '' } = {}) {
  const pick = pickDevice({ devices, preferredId, preferredLabel });
  const fellBack = Boolean(preferredId) && pick.deviceId !== preferredId && pick.reason !== 'renamed';
  return { deviceId: pick.deviceId || null, reason: pick.reason, label: pick.label || '', fellBack };
}
