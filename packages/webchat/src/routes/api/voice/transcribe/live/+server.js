import { json } from '@sveltejs/kit';
import { MAX_AUDIO_BYTES, decodeWindow, transcribeLive } from '$lib/server/voice.js';
import { append, wav } from '$lib/server/live-runs.js';
import { LIVE_WINDOW_SEC } from '$lib/core/dictation-window.js';
import { isSilent, keptText } from '$lib/core/quiet-audio.js';

// A partial for a recording still in progress, in either of two shapes.
//
// STREAMING, which is what the browser does now: `x-dictation-run` names the
// run, the body is the 16 kHz mono PCM captured since the last poll, and the
// window decoded is whatever this machine has already accumulated. A quarter
// of a second of speech is about eight kilobytes, so the request costs nothing
// to send from a phone; re-uploading the whole rolling window every poll is
// what used to make the preview stall as an utterance got longer.
//
// WHOLE-WINDOW, kept for any caller that posts a complete clip: the old path,
// conversion and all.
export async function POST({ request }) {
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > MAX_AUDIO_BYTES) {
    return json({ error: 'too long', kind: 'too-large' }, { status: 413 });
  }
  let bytes;
  try {
    bytes = Buffer.from(await request.arrayBuffer());
  } catch (cause) {
    return json({ error: `Could not read the recording: ${cause.message}`, kind: 'bad-request' }, { status: 400 });
  }
  const timestamps = request.headers.get('x-dictation-timestamps') === '1';
  const run = request.headers.get('x-dictation-run');

  if (run) {
    const startSec = Number(request.headers.get('x-dictation-start') || '0') || 0;
    const offsetHeader = request.headers.get('x-dictation-offset');
    const offsetSamples = offsetHeader === null ? null : Number(offsetHeader);
    let held;
    try {
      held = append(run, bytes, { offsetSamples: Number.isFinite(offsetSamples) ? offsetSamples : null });
    } catch (cause) {
      // A hole: the client is ahead of what this machine holds and must resend
      // from `heldSamples`. It can, because the browser keeps the recording.
      return json({
        error: cause.message,
        kind: cause.status === 409 ? 'behind' : 'bad-request',
        heldSamples: cause.heldSamples ?? 0
      }, { status: cause.status || 400 });
    }
    // A preview that has given up still has to deliver its audio: the finished
    // transcript is decoded from what this machine holds, so a run that stops
    // sending loses the end of the sentence.
    if (request.headers.get('x-dictation-decode') === '0') {
      return json({ text: '', segments: [], partial: true, heldSec: held.durationSec, heldSamples: held.heldSamples });
    }
    const window = wav(run, { startSec, maxSec: LIVE_WINDOW_SEC });
    // Appended but nothing to decode yet: the run is younger than a window of
    // silence. The client keeps sending; this is not an error.
    if (!window) return json({ text: '', segments: [], partial: true, heldSec: held.durationSec, heldSamples: held.heldSamples });
    // Silence is not sent to a decoder: given nothing to read it invents the
    // things its training data is full of, and "Thanks for watching!" in the
    // first window is him lifting the phone to his mouth. Skipping the decode
    // also gives those polls back their 125 to 330 ms.
    if (isSilent(window.bytes)) {
      return json({
        text: '', segments: [], partial: true,
        heldSec: held.durationSec, heldSamples: held.heldSamples, windowSec: window.durationSec
      }, { headers: { 'cache-control': 'no-store' } });
    }
    try {
      const decoded = await decodeWindow(window.bytes, { signal: request.signal, timestamps });
      const text = keptText(timestamps ? decoded.text : decoded, window.bytes);
      const result = timestamps
        ? (text ? decoded : { text: '', segments: [] })
        : text;
      return json({
        ...(timestamps ? result : { text: result }),
        partial: true,
        heldSec: held.durationSec,
        heldSamples: held.heldSamples,
        windowSec: window.durationSec
      }, { headers: { 'cache-control': 'no-store' } });
    } catch (cause) {
      return json({
        error: cause.message,
        kind: cause.status === 503 ? 'warming' : 'error',
        partial: true,
        // The audio is still held, so a warming decoder costs a partial and
        // never a word of the recording.
        heldSec: held.durationSec,
        heldSamples: held.heldSamples
      }, { status: cause.status || 500 });
    }
  }

  try {
    const result = await transcribeLive(bytes, { mime: request.headers.get('content-type') || 'audio/webm', signal: request.signal, timestamps });
    return json({ ...(timestamps ? result : { text: result }), partial: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    return json({
      error: cause.message,
      kind: cause.status === 503 ? 'warming' : 'error',
      partial: true
    }, { status: cause.status || 500 });
  }
}
