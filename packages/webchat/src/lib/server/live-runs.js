// Audio an utterance is still being spoken into, held on this machine.
//
// WHY THIS EXISTS. The browser used to re-upload the whole rolling window on
// every partial and the whole clip again when the button came up. The wait was
// the upload, not whisper. Now the recorder sends 16 kHz mono PCM in the slice
// it just captured, this module keeps the run, and both the partial and the
// finished transcript decode out of memory here with nothing further to upload.
//
// The audio is the owner's speech: it lives in this process, is never written
// to disk by this module, and a run is dropped as soon as it is decoded or
// abandoned. The clip that is kept for the record still travels the ordinary
// dictation outbox, off the critical path.

export const RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

// Ten minutes of audio per run, which is past the push-to-talk ceiling, and a
// handful of runs: one phone, one laptop, a stale one or two. Past either the
// oldest run goes rather than the process growing without bound.
export const MAX_RUN_SEC = 600;
export const MAX_RUN_BYTES = MAX_RUN_SEC * RATE * BYTES_PER_SAMPLE;
export const RUN_TTL_MS = 10 * 60_000;
export const MAX_RUNS = 8;

const runs = new Map();

function sweep(now = Date.now()) {
  for (const [id, run] of runs) {
    if (now - run.updatedAt > RUN_TTL_MS) runs.delete(id);
  }
}

// Called once the run being spoken into is in the map, so the one evicted is
// never the one in hand.
function trim() {
  while (runs.size > MAX_RUNS) {
    // Oldest by last append, which is the one nobody is speaking into.
    let oldest = null;
    for (const [id, run] of runs) if (!oldest || run.updatedAt < oldest[1].updatedAt) oldest = [id, run];
    if (!oldest) break;
    runs.delete(oldest[0]);
  }
}

/**
 * Append the slice just captured, addressed by where it starts in the run's
 * own 16 kHz stream. The offset is what makes this idempotent: a retried
 * chunk, an aborted request that landed anyway and a duplicate all reduce to
 * the same held audio, and a chunk that starts past the end is refused as a
 * hole rather than silently splicing a gap into the middle of a sentence.
 */
export function append(id, bytes, { offsetSamples = null, now = Date.now() } = {}) {
  if (!id) throw Object.assign(new Error('a live run needs an id'), { status: 400 });
  sweep(now);
  const run = runs.get(id) || { chunks: [], bytes: 0, dropped: 0, startedAt: now, updatedAt: now };
  if (!Number.isFinite(run.dropped)) run.dropped = 0;
  // An odd trailing byte would shift every later sample by half a frame.
  let slice = bytes?.length ? (bytes.length % 2 === 0 ? bytes : bytes.subarray(0, bytes.length - 1)) : null;
  // Where the audio held for this run ends, counted from the start of the
  // recording rather than from the start of the buffer. Past the ten minute
  // ceiling the oldest seconds are dropped, and if this were the buffer's size
  // the client's offsets and this module's addressing would silently mean
  // different things: the preview would decode a different minute.
  const heldSamples = run.dropped + run.bytes / BYTES_PER_SAMPLE;
  if (slice && offsetSamples !== null) {
    // An offset is a position in a stream of whole samples. A fraction of one
    // splices the slice half a frame out and every sample after it is two
    // halves of two different samples; anything that is not a count is not an
    // answer this module can act on.
    if (!Number.isInteger(offsetSamples) || offsetSamples < 0) {
      const error = new Error('an offset is a whole number of samples from the start of the run');
      throw Object.assign(error, { status: 400, heldSamples });
    }
    if (offsetSamples > heldSamples) {
      const error = new Error('that slice starts past the audio held for this run');
      throw Object.assign(error, { status: 409, heldSamples });
    }
    if (offsetSamples < run.dropped) {
      // The audio that slice belongs to has aged out of the ceiling. Saying so
      // is the only honest answer: appending it here would put old speech
      // after new.
      const error = new Error('that slice belongs to audio this run no longer holds');
      throw Object.assign(error, { status: 409, heldSamples });
    }
    const overlap = (heldSamples - offsetSamples) * BYTES_PER_SAMPLE;
    slice = overlap >= slice.length ? null : slice.subarray(overlap);
  }
  if (slice?.length) {
    run.chunks.push(Buffer.from(slice));
    run.bytes += slice.length;
    while (run.bytes > MAX_RUN_BYTES && run.chunks.length > 1) {
      const gone = run.chunks.shift();
      run.bytes -= gone.length;
      run.dropped += gone.length / BYTES_PER_SAMPLE;
    }
  }
  run.updatedAt = now;
  runs.set(id, run);
  trim();
  return {
    bytes: run.bytes,
    heldSamples: run.dropped + run.bytes / BYTES_PER_SAMPLE,
    droppedSamples: run.dropped,
    durationSec: (run.dropped + run.bytes / BYTES_PER_SAMPLE) / RATE
  };
}

export function has(id) {
  return runs.has(id);
}

export function durationSec(id) {
  const run = runs.get(id);
  return run ? (run.dropped + run.bytes / BYTES_PER_SAMPLE) / RATE : 0;
}

export function drop(id) {
  return runs.delete(id);
}

export function clear() {
  runs.clear();
}

export function stats() {
  return { runs: runs.size, bytes: [...runs.values()].reduce((n, r) => n + r.bytes, 0) };
}

function header(samples) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples * BYTES_PER_SAMPLE, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * BYTES_PER_SAMPLE, 28);
  buf.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples * BYTES_PER_SAMPLE, 40);
  return buf;
}

/**
 * A 16 kHz mono WAV of `[startSec, startSec + maxSec)` of this run, ready to
 * post at whisper-server with no conversion step in between.
 */
export function wav(id, { startSec = 0, maxSec = Infinity } = {}) {
  const run = runs.get(id);
  if (!run) return null;
  const pcm = Buffer.concat(run.chunks, run.bytes);
  // `startSec` is a position in the recording, not in the buffer. Once the
  // ceiling has dropped the oldest seconds those are not the same number, and
  // asking for a second that is gone gives the oldest audio still held rather
  // than silently answering with a different minute.
  const dropped = Number.isFinite(run.dropped) ? run.dropped : 0;
  const wanted = Math.round(Math.max(0, startSec) * RATE) - dropped;
  const from = Math.min(pcm.length, Math.max(0, wanted) * BYTES_PER_SAMPLE);
  const span = Number.isFinite(maxSec) ? Math.round(maxSec * RATE) * BYTES_PER_SAMPLE : pcm.length;
  const body = pcm.subarray(from, Math.min(pcm.length, from + span));
  if (!body.length) return null;
  return {
    bytes: Buffer.concat([header(body.length / BYTES_PER_SAMPLE), body]),
    durationSec: body.length / (RATE * BYTES_PER_SAMPLE),
    startSec: (dropped + from / BYTES_PER_SAMPLE) / RATE,
    droppedSec: dropped / RATE
  };
}
