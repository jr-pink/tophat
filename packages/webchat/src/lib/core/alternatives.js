// Alternative readings of one span of a dictated recording.
//
// WHY THIS EXISTS. whisper-server returns one reading and no n-best list: per
// word it gives `{word, start, end, probability}` and per segment an
// `avg_logprob`, and nothing else. So "what else could that word have been"
// has one honest answer, which is to decode that span of audio again -- once
// on the accurate model, and a few times on the fast one at temperatures
// above zero, where the sampler is free to take the second-best token. What
// comes back is a handful of readings of the same 1.5 seconds, most of them
// identical; the distinct ones are the alternatives.
//
// Everything here is pure: the span arithmetic, the cut, and the ranking. The
// endpoint at /api/voice/alternatives does the file reading and the HTTP, and
// nothing in this file knows either exists.

export const MAX_SPAN_SEC = 8;
export const PAD_SEC = 0.4;
export const MAX_READINGS = 6;

// Whisper's stock noises for audio that says nothing: a bracketed event, or a
// piece of the training data's boilerplate. They are not readings of his word
// and offering one as an alternative would be worse than offering nothing.
const NOISE = [
  /^\[[^\]]*\]$/u,
  /^\([^)]*\)$/u,
  /^♪+$/u,
  /^thanks? for watching[!.]?$/iu,
  /^thank you[!.]?$/iu,
  /^you$/iu,
  /^bye[!.]?$/iu,
  /^\.+$/u
];

/**
 * The reading as it is compared against another reading: case, surrounding
 * space and punctuation are not differences he can hear, and two decodes that
 * differ only in a trailing full stop are one alternative, not two.
 */
export function normalizeReading(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function isNoise(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return true;
  if (!normalizeReading(trimmed)) return true;
  return NOISE.some((shape) => shape.test(trimmed));
}

/**
 * The span of audio to decode, from the span of the word he tapped.
 *
 * A word is decoded with about four tenths of a second of its neighbours on
 * either side: whisper reads a bare word out of context as a different word,
 * and the padding is what keeps "manubrium" from being read as "man". The
 * answer is clamped to the clip, and a request for more than eight seconds is
 * refused rather than served slowly -- this is a popup under his thumb, not a
 * transcription job.
 *
 * Returns `{ok: true, startSec, endSec, wordStartSec, wordEndSec}` or
 * `{ok: false, status, error}`; it never throws.
 */
export function planSpan({
  startSec, endSec, durationSec, padSec = PAD_SEC, maxSpanSec = MAX_SPAN_SEC
} = {}) {
  const refuse = (status, error) => ({ ok: false, status, error });
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) {
    return refuse(422, 'that clip holds no audio');
  }
  const from = Number(startSec);
  const to = Number(endSec);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return refuse(400, 'a span needs a start and an end, in seconds');
  }
  if (from < 0) return refuse(400, 'a span cannot start before the recording does');
  if (to <= from) return refuse(400, 'a span has to end after it starts');
  if (to - from > maxSpanSec) {
    return refuse(400, `that span is ${(to - from).toFixed(1)}s; ${maxSpanSec}s is the most that is decoded at once`);
  }
  if (from >= duration) return refuse(400, 'that span starts past the end of the recording');
  const pad = Number.isFinite(padSec) && padSec >= 0 ? padSec : PAD_SEC;
  const wordStartSec = Math.min(from, duration);
  const wordEndSec = Math.min(to, duration);
  return {
    ok: true,
    startSec: Math.max(0, wordStartSec - pad),
    endSec: Math.min(duration, wordEndSec + pad),
    wordStartSec,
    wordEndSec
  };
}

function wavHeader(pcmBytes, { sampleRate, channels, bitsPerSample }) {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  const blockAlign = channels * (bitsPerSample / 8);
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, pcmBytes, true);
  return header;
}

/**
 * `[startSec, endSec)` of a 16-bit PCM WAV, as a WAV of its own that can be
 * posted straight at whisper-server.
 *
 * `header` is what `readWavHeader` in $lib/server/dictation.js parsed out of
 * these same bytes -- the parsing lives there, the cutting lives here, and
 * neither is written twice.
 */
export function cutSpan(bytes, header, { startSec, endSec } = {}) {
  if (!bytes || !header) return null;
  const { sampleRate, channels, bitsPerSample, dataStart, dataBytes } = header;
  if (!sampleRate || !channels || bitsPerSample !== 16) return null;
  const frame = channels * 2;
  const frames = Math.floor(dataBytes / frame);
  const first = Math.min(frames, Math.max(0, Math.round(Number(startSec) * sampleRate)));
  const last = Math.min(frames, Math.max(first, Math.round(Number(endSec) * sampleRate)));
  const from = dataStart + first * frame;
  const length = (last - first) * frame;
  if (length <= 0) return null;
  const pcm = bytes.subarray(from, from + length);
  const out = new Uint8Array(44 + pcm.length);
  out.set(wavHeader(pcm.length, { sampleRate, channels, bitsPerSample }), 0);
  out.set(pcm, 44);
  return {
    bytes: out,
    startSec: first / sampleRate,
    endSec: last / sampleRate,
    durationSec: (last - first) / sampleRate
  };
}

/**
 * The distinct readings, in the order they are offered.
 *
 * The accurate model goes first because it is the one worth switching to;
 * after it the fast model's samples, best average log probability first. Two
 * decodes that read the same words are one entry, with a count of how many
 * decodes agreed, and the reading he already has is marked rather than
 * dropped, so the popup can show it as the one in the draft.
 */
export function rankReadings({ current = '', decodes = [], limit = MAX_READINGS } = {}) {
  const usable = (Array.isArray(decodes) ? decodes : [])
    .map((decode, index) => ({
      text: String(decode?.text ?? '').trim(),
      model: decode?.model ? String(decode.model) : null,
      avgLogprob: Number.isFinite(decode?.avgLogprob) ? decode.avgLogprob : null,
      temperature: Number.isFinite(decode?.temperature) ? decode.temperature : null,
      primary: decode?.primary === true,
      index
    }))
    .filter((decode) => !isNoise(decode.text));

  const score = (decode) => (decode.avgLogprob === null ? -Infinity : decode.avgLogprob);
  const ordered = [...usable].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    if (score(a) !== score(b)) return score(b) - score(a);
    return a.index - b.index;
  });

  const here = normalizeReading(current);
  const seen = new Map();
  for (const decode of ordered) {
    const key = normalizeReading(decode.text);
    if (!key) continue;
    const already = seen.get(key);
    if (already) {
      already.votes += 1;
      // The best average log probability of any decode that read it this way,
      // not the first one's.
      if (score(decode) > score(already)) already.avgLogprob = decode.avgLogprob;
      continue;
    }
    seen.set(key, {
      text: decode.text,
      model: decode.model,
      avgLogprob: decode.avgLogprob,
      temperature: decode.temperature,
      votes: 1,
      current: Boolean(here) && key === here
    });
  }
  const out = [...seen.values()];
  const cap = Number.isFinite(limit) && limit > 0 ? limit : MAX_READINGS;
  return out.slice(0, cap);
}

/**
 * The average log probability of a decode, as whisper-server reports it: per
 * segment, so a span that came back as two segments is averaged over them.
 * Null when the decoder said nothing about it.
 */
export function averageLogprob(segments) {
  const values = (Array.isArray(segments) ? segments : [])
    .map((segment) => Number(segment?.avg_logprob ?? segment?.avgLogprob))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
