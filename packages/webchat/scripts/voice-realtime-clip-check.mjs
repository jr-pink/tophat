// Real-service check of hands-free end-of-turn: streams a recorded clip (16-bit mono WAV, any rate) through the actual
// realtime recogniser into the actual OpenAI Realtime transcription session, at microphone pace, with silence
// before and after, and prints what was sent as a message and how long after the last word it arrived.
// Needs the vault key (openai-api-key). Not part of `npm test`: it spends a few cents and needs the network.
//   node scripts/voice-realtime-clip-check.mjs clip.wav [more.wav ...]
import { readFileSync } from 'node:fs';
import { createRealtimeRecogniser } from '../src/lib/services/voice/client/realtime-recogniser.js';
import { mintRealtimeSecret } from '../src/lib/services/voice/server/realtime.js';
import { makeDownsampler } from '../src/lib/services/voice/core/realtime-voice.js';
import { frameDb } from '../src/lib/services/voice/core/realtime-voice.js';

function readWav(path) {
  const b = readFileSync(path);
  let at = 12; let rate = 24000; let data = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4); const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(at + 12);
    if (id === 'data') { data = b.subarray(at + 8, at + 8 + size); break; }
    at += 8 + size + (size % 2);
  }
  const samples = new Float32Array(data.length >> 1);
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, rate };
}

async function run(path, { leadSec = 1.2, tailSec = 8 } = {}) {
  const { samples, rate } = readWav(path);
  const frameLen = Math.round(rate * 0.043);
  const down = makeDownsampler(rate);
  let feed = null;
  const events = [];
  const t0 = Date.now();
  let speechEndedAt = null;
  const rec = createRealtimeRecogniser({
    mint: () => mintRealtimeSecret(),
    makeCapture: (cb) => { feed = cb.onFrame; return { open: true, async start() { return { label: 'recorded clip' }; }, stop() { this.open = false; } }; },
    onUtterance: (text) => events.push({ text, at: Date.now() }),
    onError: (kind, message) => events.push({ error: `${kind}: ${message}` }),
    onStatus: (s) => process.stdout.write(`  [${((Date.now() - t0) / 1000).toFixed(1)}s ${s}]\n`)
  });
  await rec.start();
  const silence = (sec) => new Float32Array(Math.round(rate * sec));
  const all = new Float32Array(samples.length + Math.round(rate * (leadSec + tailSec)));
  all.set(samples, Math.round(rate * leadSec));
  const endOfSpeech = leadSec + samples.length / rate;
  const startAt = Date.now();
  for (let i = 0; i + frameLen <= all.length; i += frameLen) {
    const frame = all.subarray(i, i + frameLen);
    feed({ pcm: down(frame), db: frameDb(frame), at: Date.now() });
    if (events.length && !events.at(-1).error) break;
    const due = startAt + ((i + frameLen) / rate) * 1000;
    await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
  }
  await new Promise((r) => setTimeout(r, 300));
  rec.stop();
  const hit = events.find((e) => e.text);
  const lag = hit ? (hit.at - startAt) / 1000 - endOfSpeech : null;
  console.log(JSON.stringify({ clip: path, sent: hit?.text ?? null, secondsAfterLastWord: lag === null ? null : Number(lag.toFixed(2)), errors: events.filter((e) => e.error) }));
  return hit?.text ?? null;
}

let failed = 0;
for (const clip of process.argv.slice(2)) if (!(await run(clip))) failed += 1;
process.exit(failed ? 1 : 0);
