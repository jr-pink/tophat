import { json } from '@sveltejs/kit';
import { MAX_AUDIO_BYTES, decodeFinished, decodeWindow } from '$lib/server/voice.js';
import { append, drop, wav } from '$lib/server/live-runs.js';
import { LIVE_WINDOW_SEC, nextWindow } from '$lib/core/dictation-window.js';
import { appendRows, readFlag, storeClip } from '$lib/server/dictation.js';
import { hypothesisRow } from '$lib/core/dictation.js';
import { wordsFromSegments } from '$lib/core/tapword.js';

// The finished transcript for a run whose audio is already on this machine.
//
// The button comes up, the browser posts the last slice it captured and nothing
// else, and the accurate model decodes what has been accumulating all along.
// Now the decode is the whole wait.
//
// A failure is not fatal to the recording: the clip is in the browser's outbox
// as well, and that path still transcribes it.
export async function POST({ request }) {
  const run = request.headers.get('x-dictation-run');
  if (!run) return json({ error: 'no run named', kind: 'bad-request' }, { status: 400 });
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > MAX_AUDIO_BYTES) return json({ error: 'too long', kind: 'too-large' }, { status: 413 });

  let bytes;
  try {
    bytes = Buffer.from(await request.arrayBuffer());
  } catch (cause) {
    return json({ error: `Could not read the recording: ${cause.message}`, kind: 'bad-request' }, { status: 400 });
  }
  const offsetHeader = request.headers.get('x-dictation-offset');
  const offsetSamples = offsetHeader === null ? null : Number(offsetHeader);
  try {
    append(run, bytes, { offsetSamples: Number.isFinite(offsetSamples) ? offsetSamples : null });
  } catch (cause) {
    return json({
      error: cause.message,
      kind: cause.status === 409 ? 'behind' : 'bad-request',
      heldSamples: cause.heldSamples ?? 0
    }, { status: cause.status || 400 });
  }
  // The words the preview has are the words up to its last poll, which is never
  // the end of the recording: a quarter second of cadence plus the decode is
  // speech nobody has read yet, and a preview that gave up or a window that
  // stopped advancing leaves far more than that. So a stop names where its
  // words run out and this decodes from there to the end. What is short is
  // finished on the preview's own model, which costs a few hundred
  // milliseconds.
  if (request.headers.get('x-dictation-decode') === 'tail') {
    const fromSec = Math.max(0, Number(request.headers.get('x-dictation-start') || '0') || 0);
    const whole = wav(run);
    const tail = wav(run, { startSec: fromSec });
    const heldSec = whole?.durationSec ?? 0;
    if (!tail) {
      drop(run);
      return json({ kind: 'tail', text: '', segments: [], startSec: fromSec, heldSec, ...keepTheRecord(whole, request.headers) },
        { headers: { 'cache-control': 'no-store' } });
    }
    // Either the gap is longer than a window, or the preview says it moved
    // past seconds it never read. Both mean the tail is not enough.
    if (tail.durationSec > LIVE_WINDOW_SEC || request.headers.get('x-dictation-whole') === '1') {
      try {
        const result = await decodeFinished(whole.bytes, { signal: request.signal });
        return json({ kind: 'whole', ...result, empty: !result.text, durationSec: whole.durationSec, heldSec,
          ...keepTheRecord(whole, request.headers, result.text) },
          { headers: { 'cache-control': 'no-store' } });
      } catch (cause) {
        return json({ error: cause.message, kind: cause.status === 503 ? 'unavailable' : 'error',
          ...keepTheRecord(whole, request.headers) }, { status: cause.status || 500 });
      } finally {
        drop(run);
      }
    }
    try {
      const result = await decodeWindow(tail.bytes, { signal: request.signal, timestamps: true });
      // The whole sentence, stitched here rather than in two places: the
      // preview's committed words plus this decode of everything after them,
      // overlapped the same way every partial has been overlapped all along.
      // What the record keeps and what he reads are then the same string.
      const complete = stitch(request.headers, result, tail.durationSec);
      // The word times come back with the tail, in the seconds of the whole
      // recording rather than of the window they were decoded in. The browser
      // needs them to know which seconds of audio a word in the draft came
      // out of, which is what tapping a word for its alternatives asks.
      const words = wordsFromSegments(result.segments, tail.startSec);
      return json({
        kind: 'tail', ...result, complete, words, startSec: tail.startSec, windowSec: tail.durationSec, heldSec,
        ...keepTheRecord(whole, request.headers, complete, words)
      }, { headers: { 'cache-control': 'no-store' } });
    } catch (cause) {
      return json({ error: cause.message, kind: cause.status === 503 ? 'unavailable' : 'error',
        ...keepTheRecord(whole, request.headers) }, { status: cause.status || 500 });
    } finally {
      drop(run);
    }
  }
  // A stop that already has its words wants nothing decoded; it is saying the
  // run is over, so the audio goes now rather than at the ten minute timeout.
  if (request.headers.get('x-dictation-decode') === '0') {
    const held = wav(run);
    drop(run);
    // The record is written from the audio this machine already has.
    const stored = keepTheRecord(held, request.headers);
    return json({
      dropped: true,
      durationSec: held?.durationSec ?? 0,
      ...stored
    }, { headers: { 'cache-control': 'no-store' } });
  }
  const whole = wav(run);
  if (!whole) {
    drop(run);
    return json({ error: 'nothing was held for that run', kind: 'unknown-run' }, { status: 404 });
  }
  try {
    const result = await decodeFinished(whole.bytes, { signal: request.signal });
    return json({
      ...result,
      empty: !result.text,
      durationSec: whole.durationSec
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    if (!cause.status || cause.status >= 500) console.error('[webchat] final decode failed:', cause.message);
    return json({
      error: cause.message,
      kind: cause.status === 503 ? 'unavailable' : 'error'
    }, { status: cause.status || 500 });
  } finally {
    // Held audio has one purpose and it is over: the clip the record keeps
    // travels the outbox, not this.
    drop(run);
  }
}


// The clip and its transcript, written where the dictation record lives. A
// failure here is reported rather than thrown: the browser still holds the
// bytes and its outbox is the fallback, and nothing about the words he is
// looking at depends on this.
function keepTheRecord(held, headers, override = null, words = null) {
  const raw = headers.get('x-clip-meta');
  if (!held?.bytes || !raw) return { stored: false };
  let meta;
  try {
    meta = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return { stored: false, error: 'unreadable clip metadata' };
  }
  try {
    if (!readFlag().enabled) return { stored: false, error: 'dictation is off' };
    const row = storeClip(held.bytes, {
      ...meta,
      userAgent: headers.get('user-agent'),
      // Kept with the clip so the seconds behind a word survive this process:
      // these are the tail's words, which is what this machine decoded.
      words: Array.isArray(words) && words.length ? words : null
    });
    const text = typeof override === 'string' && override.trim()
      ? override
      : (typeof meta.asr?.text === 'string' ? meta.asr.text : null);
    if (text) {
      appendRows([hypothesisRow({
        clipId: row.clip_id,
        asrText: text,
        engine: typeof meta.asr?.engine === 'string' ? meta.asr.engine : 'whisper-live',
        engineModel: typeof meta.asr?.model === 'string' ? meta.asr.model : null,
        latencyMs: Number.isFinite(meta.asr?.latencyMs) ? meta.asr.latencyMs : null,
        at: new Date().toISOString()
      })]);
    }
    return { stored: true, clip_id: row.clip_id, path: row.path };
  } catch (cause) {
    console.error('[dictation] could not keep the record:', cause.message);
    return { stored: false, error: cause.message };
  }
}


// The preview's window, as the browser had it when the button came up, and the
// transcript that continues it.
function readMeta(headers) {
  const raw = headers.get('x-clip-meta');
  if (!raw) return null;
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
  catch { return null; }
}

function stitch(headers, result, windowSec) {
  const meta = readMeta(headers);
  const preview = String(meta?.asr?.text ?? '').trim();
  const window = meta?.asr?.window;
  const text = String(result?.text ?? '').trim();
  if (!text) return preview;
  if (!window || typeof window.prefix !== 'string') return preview;
  const whole = String(nextWindow(window, result, windowSec)?.text ?? '').trim();
  return whole.length >= preview.length ? whole : preview;
}
