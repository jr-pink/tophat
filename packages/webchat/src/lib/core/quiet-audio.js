// What whisper says about silence.
//
// The first window of a recording is usually him getting the phone to his
// mouth, and a decoder given near-silence invents the things its training data
// is full of: "Thanks for watching!", "Thank you.", subtitle credits, a bar of
// music. Those land in the preview as if he had said them.
//
// Two rules, in order of confidence. Audio quiet enough to be nothing at all
// is not decoded and contributes no words, whatever the decoder would have
// said. Audio that is merely quiet is decoded, and a decode that is nothing
// but one of the stock phrases below is dropped; anything else stands, because
// he does say "thank you" and losing a real word is worse than showing a wrong
// one.

// 16-bit signed PCM, full scale.
const FULL_SCALE = 32768;

// Below this a window holds no speech. Measured against his own recordings: his
// quietest dictation in the record sits at -33 dB RMS, and room tone with the
// phone at arm's length is below -55 dB.
export const SILENT_DBFS = -50;

// Quiet enough that a stock phrase is almost certainly the decoder filling in
// silence rather than him speaking softly.
export const QUIET_DBFS = -42;

const STOCK = new Set([
  'thank you', 'thank you very much', 'thanks', 'thanks for watching',
  'thank you for watching', 'thanks for watching!', 'please subscribe',
  'subscribe to my channel', 'you', 'bye', 'bye bye', 'okay', 'ok', 'so',
  'silence', 'music', 'applause', 'blank audio', 'inaudible', 'foreign',
  'beep', 'laughter', 'the end', 'to be continued'
]);

/** The RMS of 16-bit PCM in dBFS. Empty audio is silence. */
export function rmsDbfs(pcm) {
  if (!pcm || !pcm.length) return -Infinity;
  const samples = pcm.length >> 1;
  if (!samples) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    // Little-endian signed 16-bit, read without assuming a Buffer.
    const lo = pcm[i * 2];
    const hi = pcm[i * 2 + 1];
    const raw = (hi << 8) | lo;
    const value = raw >= 0x8000 ? raw - 0x10000 : raw;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples) / FULL_SCALE;
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** The PCM body of a RIFF/WAVE buffer, by its data chunk rather than by a
 *  fixed header length. Anything unparseable is treated as raw PCM. */
export function pcmOf(bytes) {
  if (!bytes || bytes.length < 12) return bytes || null;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag !== 'RIFF') return bytes;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24);
    const from = at + 8;
    if (id === 'data') return bytes.subarray(from, Math.min(bytes.length, from + (size > 0 ? size : bytes.length)));
    if (size <= 0) break;
    at = from + size + (size % 2);
  }
  return bytes;
}

/** True when this window holds nothing worth sending to a decoder. */
export function isSilent(bytes, { threshold = SILENT_DBFS } = {}) {
  return rmsDbfs(pcmOf(bytes)) < threshold;
}

const bare = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/[\p{P}\p{S}]/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

/** True when the whole decode is one of whisper's stock fillers. */
export function isStockPhrase(text) {
  const words = bare(text);
  if (!words) return true;
  return STOCK.has(words);
}

/**
 * What the preview should keep from a decode of this audio: the text as it
 * stands, or nothing at all.
 */
export function keptText(text, bytes) {
  const level = rmsDbfs(pcmOf(bytes));
  if (level < SILENT_DBFS) return '';
  if (level < QUIET_DBFS && isStockPhrase(text)) return '';
  return String(text ?? '');
}
