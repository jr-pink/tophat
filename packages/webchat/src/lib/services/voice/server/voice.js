

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_AUDIO_BYTES as RECOGNITION_MAX_BYTES, RecognitionError, cleanTranscript,
  recognitionReady, recognitionSettings, resolveModel, stageClip, transcribeSpeech
} from '../../../../../../runner/src/speech/recognition.mjs';
import { readSecret } from '../../../server/auth.js';
import { recognitionConfig, recognitionSettingsNow } from './recognition-config.js';
import { signalTree } from '../../../server/kill-tree.mjs';
import { FINAL_PORT, LIVE_PORT, ensure, modelFor, transcribeBuffer, transcribeVia } from './whisper-service.js';

const TTS_URL = process.env.TOPHAT_TTS_URL || 'http://127.0.0.1:8823';


const ELEVEN_MODEL = process.env.TOPHAT_ELEVEN_MODEL || 'eleven_flash_v2_5';

const ELEVEN_VOICE = process.env.TOPHAT_ELEVEN_VOICE || 'SAz9YHcvj6GT2YYXdXww';

export const MAX_SPEAK_CHARS = 1_200;


// One number for the ceiling on a clip, and it is the recognizer's: a request
// refused here and a decode refused there must agree about how long is too
// long, or the route rejects what the decoder would have accepted.
export const MAX_AUDIO_BYTES = RECOGNITION_MAX_BYTES;


async function guarded(url, options = {}, { deadlineMs = 20_000, signal = null } = {}) {
  const clock = AbortSignal.timeout(deadlineMs);
  const abort = signal ? AbortSignal.any([clock, signal]) : clock;
  try {
    return await fetch(url, { ...options, signal: abort });
  } catch (cause) {
    
    
    const host = (() => { try { return new URL(url).host; } catch { return 'upstream'; } })();
    const reason = cause?.name === 'TimeoutError' || clock.aborted ? `timed out after ${deadlineMs}ms` : cause?.message || 'failed';
    throw new Error(`${host}: ${reason}`);
  }
}

export function elevenKey() {
  return readSecret('elevenlabs-api-key', 'ELEVENLABS_API_KEY');
}

async function viaElevenLabs({ text, speed, voice, signal }) {
  const key = elevenKey();
  if (!key) return null;
  const id = voice || ELEVEN_VOICE;
  const response = await guarded(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}/stream?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        
        
        
        voice_settings: { stability: 0.4, similarity_boost: 0.75, speed: Math.min(1.2, Math.max(0.7, speed)) }
      })
    },
    { deadlineMs: 20_000, signal }
  );
  if (!response.ok) {
    
    
    
    const detail = await response.text().catch(() => '');
    throw new Error(`elevenlabs refused with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return { body: response.body, type: 'audio/mpeg', engine: 'elevenlabs' };
}

async function viaKokoro({ text, speed, voice, signal }) {
  const response = await guarded(
    `${TTS_URL}/speak`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, speed, voice: voice || undefined })
    },
    { deadlineMs: 25_000, signal }
  );
  if (!response.ok) throw new Error(`local tts refused with ${response.status}`);
  return { body: response.body, type: 'audio/wav', engine: 'kokoro' };
}

async function viaSay({ text, speed }) {
  
  
  
  const dir = await mkdtemp(join(tmpdir(), 'tophat-say-'));
  const aiff = join(dir, 'out.aiff');
  try {
    await run('say', ['-r', String(Math.round(175 * Math.min(2, Math.max(0.5, speed)))), '-o', aiff, text], { timeoutMs: 20_000 });
    const bytes = await readFile(aiff);
    return { body: bytes, type: 'audio/aiff', engine: 'say' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function speak({ text, speed = 1, voice = null, signal = null, prefer = null }) {
  const body = String(text || '').trim().slice(0, MAX_SPEAK_CHARS);
  if (!body) throw Object.assign(new Error('nothing to say'), { status: 400 });
  const order = prefer ? [prefer] : ['elevenlabs', 'kokoro', 'say'];
  const providers = { elevenlabs: viaElevenLabs, kokoro: viaKokoro, say: viaSay };
  const tried = [];
  for (const name of order) {
    const provider = providers[name];
    if (!provider) continue;
    try {
      const result = await provider({ text: body, speed, voice, signal });
      
      if (result) return { ...result, tried };
    } catch (cause) {
      tried.push(`${name}: ${cause.message}`);
    }
  }
  throw Object.assign(new Error(`no speech engine answered (${tried.join('; ') || 'none configured'})`), { status: 503 });
}


export async function engines() {
  const out = [{ name: 'say', ready: process.platform === 'darwin', why: 'macOS built-in' }];
  out.unshift({
    name: 'kokoro',
    ready: await guarded(`${TTS_URL}/health`, {}, { deadlineMs: 1_500 })
      .then((response) => response.ok)
      .catch(() => false),
    why: 'local, private, free'
  });
  out.unshift({ name: 'elevenlabs', ready: Boolean(elevenKey()), why: 'best sounding; needs a key' });
  return out;
}

// The resident decoder is the default now. `TOPHAT_WHISPER_RESIDENT=off` still forces the
// command-line path, and a resident failure falls back to it by itself.
const RESIDENT = process.env.TOPHAT_WHISPER_RESIDENT || 'on';

const STATUS = {
  'recognition-audio-required': 400,
  'recognition-audio-too-long': 413,
  'recognizer-not-installed': 503,
  'converter-not-installed': 503,
  'recognition-model-required': 503
};
const MESSAGE = {
  'recognition-audio-required': 'no audio',
  'recognition-audio-too-long': 'audio too long',
  'recognizer-not-installed': 'whisper-cli is not installed',
  'converter-not-installed': 'ffmpeg is not installed',
  'recognition-model-required': 'no whisper model on disk',
  'recognition-timeout': 'transcription timed out',
  'audio-conversion-failed': 'could not convert the recording',
  'recognition-failed': 'transcription failed'
};

function asHttpError(cause) {
  if (!(cause instanceof RecognitionError)) return cause;
  return Object.assign(new Error(MESSAGE[cause.code] ?? cause.code),
    { status: STATUS[cause.code] ?? 500, code: cause.code });
}

function settingsNow() {
  try {
    return recognitionSettingsNow();
  } catch (cause) {
    throw asHttpError(cause);
  }
}

/** The model file a transcript would be decoded with, or null if none is on disk. */
export function whisperModel() {
  try {
    return resolveModel(settingsNow());
  } catch {
    return null;
  }
}

/** Whether this machine can transcribe at all: decoder, converter and a model. */
export function transcriptionReady() {
  try {
    return recognitionReady(settingsNow()).ready;
  } catch {
    return false;
  }
}

const liveVoiceChildren = new Set();

let sweepInstalled = false;
function installVoiceSweep() {
  if (sweepInstalled) return;
  sweepInstalled = true;
  const sweep = () => {
    for (const child of [...liveVoiceChildren]) signalTree(child, 'SIGKILL');
  };
  process.on('SIGTERM', sweep);
  process.on('SIGINT', sweep);
}

function run(bin, args, { timeoutMs = 30_000, input = null } = {}) {
  return new Promise((resolve, reject) => {
    installVoiceSweep();
    
    
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    if (child.pid > 0) {
      liveVoiceChildren.add(child);
      const forget = () => { liveVoiceChildren.delete(child); };
      child.once('exit', forget);
      child.once('error', forget);
    }
    let out = '';
    let err = '';
    
    
    
    const timer = setTimeout(() => {
      signalTree(child, 'SIGTERM');
      setTimeout(() => signalTree(child, 'SIGKILL'), 2_000).unref?.();
      reject(new Error(`${bin} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (cause) => { clearTimeout(timer); reject(cause); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      
      
      else reject(new Error(`${bin} exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Transcribe a finished recording. The resident decoder is tried first when it
 * is switched on, and whisper-cli is the path that has to work; both go
 * through `src/speech/recognition.mjs`, which owns the decoder arguments, the
 * conversion and the temporary directory.
 */
export async function transcribe(bytes, { mime = 'audio/webm' } = {}, options = {}) {
  if (!bytes?.length) throw Object.assign(new Error('no audio'), { status: 400 });
  if (bytes.length > MAX_AUDIO_BYTES) throw Object.assign(new Error('audio too long'), { status: 413 });
  const config = recognitionConfig();
  const settings = settingsFrom(config);
  const ready = recognitionReady(settings);
  if (!ready.ready) throw asHttpError(new RecognitionError(ready.reason));
  if (RESIDENT !== 'off') {
    const resident = await viaResident(bytes, mime, settings).catch((cause) => {
      // The resident decoder is an optimisation. Its failure is logged by name
      // and never by transcript, and the request carries on to whisper-cli.
      console.warn('[webchat] resident whisper failed, falling back to whisper-cli:', cause.message);
      return null;
    });
    if (resident) return resident.text;
  }
  try {
    const heard = await transcribeSpeech({ config, audio: bytes, mimeType: mime }, options);
    return heard.text;
  } catch (cause) {
    throw asHttpError(cause);
  }
}

// The same validation `settingsNow` does, against a configuration the caller
// already has in hand: `transcribeSpeech` needs the configuration and the
// readiness check needs the settings, and reading the file twice could see
// two different files.
function settingsFrom(config) {
  try {
    return recognitionSettings(config);
  } catch (cause) {
    throw asHttpError(cause);
  }
}

async function viaResident(bytes, mime, settings) {
  const model = resolveModel(settings);
  if (!model || !await ensure(FINAL_PORT, model)) return null;
  const { directory, file } = await stageClip(bytes, { mimeType: mime, settings });
  try {
    const text = await transcribeVia(FINAL_PORT, file,
      { prompt: settings.prompt ?? '', suppressNst: settings.suppressNst });
    return { text: cleanTranscript(text) };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The word times a verbose decode came back with, kept rather than thrown
 * away: `{word, start, end, probability}` per word, in the seconds of the
 * window that was decoded. They are what lets a tap on a word in the draft
 * name the span of audio it came out of, which is what the alternatives popup
 * asks to have decoded again. Anything that is not a word with two finite
 * times is dropped.
 */
export function keptWords(segment) {
  const words = Array.isArray(segment?.words) ? segment.words : [];
  const out = [];
  for (const word of words) {
    const text = typeof word?.word === 'string' ? word.word : '';
    const start = Number(word?.start);
    const end = Number(word?.end);
    if (!text.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.push({
      word: text,
      start,
      end,
      probability: Number.isFinite(word?.probability) ? word.probability : null
    });
  }
  return out;
}

/**
 * Transcribe a clip from a recording still in progress. This one is resident
 * only: a partial arrives every couple of seconds and a cold decoder cannot
 * keep up, so there is no command-line fallback and a cold server is a 503
 * the client retries.
 */
/**
 * Decode a window of audio this process is already holding for a run in
 * progress. No conversion and no temporary file: the browser sent 16 kHz mono
 * PCM, which is what whisper wants, so the bytes go straight at the live
 * server. Speed first, as everywhere on this path: a partial is rewritten a
 * quarter of a second later, so the cheapest search that reads as speech wins.
 */
export async function decodeWindow(wavBytes, { signal = null, timestamps = false } = {}) {
  const settings = settingsNow();
  const model = modelFor('live');
  if (!model) throw Object.assign(new Error('no whisper model on disk'), { status: 503 });
  if (!await ensure(LIVE_PORT, model)) {
    throw Object.assign(new Error('live transcription is warming up'), { status: 503 });
  }
  const heard = await transcribeBuffer(LIVE_PORT, wavBytes, {
    prompt: settings.prompt ?? '',
    suppressNst: settings.suppressNst,
    beamSize: 1,
    bestOf: 1,
    deadlineMs: 8_000,
    timestamps,
    signal
  });
  if (!timestamps) return cleanTranscript(heard);
  return {
    text: cleanTranscript(heard.text),
    segments: heard.segments.map((s) => ({
      text: cleanTranscript(s.text), start: s.start, end: s.end, words: keptWords(s)
    }))
  };
}

/**
 * The finished transcript for a run whose audio is already here: the accurate
 * model, on the resident server, with nothing to upload. Falls back to nothing;
 * a caller that gets an error still has the ordinary clip upload behind it.
 */
export async function decodeFinished(wavBytes, { signal = null } = {}) {
  const settings = settingsNow();
  const model = resolveModel(settings) || modelFor('final');
  if (!model) throw Object.assign(new Error('no whisper model on disk'), { status: 503 });
  if (!await ensure(FINAL_PORT, model)) {
    throw Object.assign(new Error('the accurate decoder is warming up'), { status: 503 });
  }
  const started = Date.now();
  const text = await transcribeBuffer(FINAL_PORT, wavBytes, {
    prompt: settings.prompt ?? '',
    suppressNst: settings.suppressNst,
    deadlineMs: 60_000,
    signal
  });
  return {
    text: cleanTranscript(text),
    engine: 'whisper-local',
    model: model.split('/').pop(),
    latencyMs: Date.now() - started
  };
}

export async function transcribeLive(bytes, { mime = 'audio/webm', signal = null, timestamps = false } = {}) {
  if (!bytes?.length) throw Object.assign(new Error('no audio'), { status: 400 });
  if (bytes.length > MAX_AUDIO_BYTES) throw Object.assign(new Error('audio too long'), { status: 413 });
  const settings = settingsNow();
  // Speed first for a partial, where the accurate model is too slow to be
  // read as you speak; `transcribe` above takes the accurate one.
  const model = modelFor('live');
  if (!model) throw Object.assign(new Error('no whisper model on disk'), { status: 503 });
  if (!await ensure(LIVE_PORT, model)) {
    // Warming up rather than broken: the server takes seconds to load weights
    // and the client asks again.
    throw Object.assign(new Error('live transcription is warming up'), { status: 503 });
  }
  let staged;
  try {
    staged = await stageClip(bytes, { mimeType: mime, settings, convertTimeoutMs: 10_000 });
  } catch (cause) {
    throw asHttpError(cause);
  }
  try {
    const text = await transcribeVia(LIVE_PORT, staged.file, {
      prompt: settings.prompt ?? '',
      suppressNst: settings.suppressNst,
      // A partial is rewritten a second later, so the cheapest search that
      // reads as speech beats the best one.
      beamSize: 1,
      bestOf: 1,
      deadlineMs: 8_000,
      timestamps,
      signal
    });
    if (timestamps) return { text: cleanTranscript(text.text), segments: text.segments.map((s) => ({
      text: cleanTranscript(s.text), start: s.start, end: s.end, words: keptWords(s)
    })) };
    return cleanTranscript(text);
  } finally {
    await rm(staged.directory, { recursive: true, force: true }).catch(() => {});
  }
}
