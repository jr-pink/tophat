// Speech recognition, one local backend behind one call.
//
// Voice mode is half a loop without it. `synthesis.mjs` speaks the reply and
// this transcribes the question, and until it existed a microphone button in
// the webchat pointed at nothing this runtime installs, configures or checks.
//
// ONE PROVIDER, LOCAL, AND IT IS NAMED IN THE ANSWER. Recognition runs on
// whisper.cpp through its own `whisper-cli`, on this machine, with no account
// and no credential; the owner's speech is the most private thing he gives the
// runtime and sending it to a hosted recognizer is a decision rather than a
// fallback. Every result still names the provider and the model file that
// produced it, for the same reason synthesis names the voice that spoke: two
// models do not hear alike, and a transcript is read without knowing which one
// wrote it.
//
// AN INSTALLED BINARY IS NOT A WORKING BACKEND. `probeRecognition` decodes a
// bundled synthetic clip and compares the words that come back, so a binary
// that cannot load its model, a model file that is truncated and a build that
// will not run on this CPU are all caught by the check rather than by the
// owner the first time he speaks. `unavailable` and `failed` are different
// answers: nothing is installed, against something is installed and did not
// transcribe.
//
// Neither goes into an error, an attempt record or a log line. The decoder's
// stderr is deliberately dropped rather than quoted into the failure, because
// whisper.cpp prints what it heard there. Clips are written into an owner-only
// temporary directory and removed in a `finally`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

export const PROVIDER = 'whisper-cpp';
export const DEFAULT_BINARY = 'whisper-cli';
export const DEFAULT_CONVERTER = 'ffmpeg';
// Accuracy first: the most capable model present wins, because a transcript is
// read once and a wrong word costs more than the extra second it took.
export const MODEL_NAMES = ['ggml-large-v3-turbo.bin', 'ggml-small.en.bin', 'ggml-base.en.bin'];
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_CONVERT_TIMEOUT_MS = 20000;
// Twelve megabytes is about ten minutes of the browser's Opus, which is longer
// than anything said into a phone in one turn; past it the call is refused by
// name rather than spending a minute of CPU on something that went wrong.
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

// The bundled probe clip, and the command that made it. It is machine speech,
// generated here, and carries none of the owner's voice:
//
//   say -r 230 -o src/speech/recognition-probe.wav \
//     --data-format=LEI16@16000 "the quick brown fox jumps over the lazy dog"
//
// Resolved from this module's own directory so a copy of the build under test
// finds its own clip rather than the checkout's.
export const PROBE_CLIP = path.join(import.meta.dirname, 'recognition-probe.wav');
export const PROBE_WORDS = ['quick', 'brown', 'fox', 'lazy', 'dog'];
// Three of the five. An empty transcript, a stub and a decode of silence all
// score zero, so this separates real recognition from no recognition; leaving
// room for two lets a small model drop a word without reporting the backend
// broken. Every model tried here returned all five.
export const MIN_PROBE_WORDS = 3;

// A mistyped key in a configuration block reads exactly like a deliberately
// absent one, so the block is closed and an unknown key is named.
const KNOWN_KEYS = ['binary', 'converter', 'model', 'modelDir', 'language', 'timeoutMs', 'maxBytes',
  'prompt', 'suppressNst'];

export class RecognitionError extends Error {
  constructor(code, { action } = {}) {
    super(code);
    this.code = code;
    if (action) this.action = action;
  }
}
const fail = (code, details) => { throw new RecognitionError(code, details); };

// What the caller should do about each way recognition can fail, in the
// vocabulary `src/setup/index.mjs` already reports to the owner.
const ADVICE = {
  'recognizer-not-installed': 'install-recognizer',
  'converter-not-installed': 'install-recognizer',
  'recognition-model-required': 'download-model',
  'recognition-timeout': 'retry',
  'recognition-failed': 'report-defect',
  'audio-conversion-failed': 'report-defect',
  'recognition-audio-required': 'report-defect',
  'recognition-audio-too-long': 'report-defect',
  'probe-clip-missing': 'report-defect',
  'transcript-mismatch': 'download-model',
};
export const recognitionAdvice = code => ADVICE[code] ?? 'report-defect';

export function recognitionSettings(config) {
  const raw = config?.recognition ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid-recognition-config');
  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.includes(key)) fail(`unknown-recognition-key:${key}`);
  // Models live beside the rest of this runtime's private configuration rather
  // than in the home directory, so a second profile does not silently share
  // the first one's weights.
  const defaultDir = config?.paths?.configDir
    ? path.join(config.paths.configDir, 'whisper')
    : path.join(os.homedir(), '.config', 'tophat', 'whisper');
  return {
    binary: command(raw.binary ?? DEFAULT_BINARY, 'binary'),
    converter: command(raw.converter ?? DEFAULT_CONVERTER, 'converter'),
    model: raw.model === undefined || raw.model === null ? null : absolute(raw.model, 'model'),
    modelDir: absolute(raw.modelDir ?? defaultDir, 'modeldir'),
    language: token(raw.language ?? 'en', 'language'),
    timeoutMs: bound(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 'invalid-recognition-timeout'),
    maxBytes: bound(raw.maxBytes, MAX_AUDIO_BYTES, 'invalid-recognition-max-bytes', 1024, 512 * 1024 * 1024),
    prompt: raw.prompt === undefined || raw.prompt === null ? null : hint(raw.prompt),
    suppressNst: flag(raw.suppressNst, 'suppressnst'),
  };
}

function command(value, field) {
  // A bare name is resolved on PATH and an absolute path is taken as given;
  // anything with a separator in the middle would run a binary out of whatever
  // directory the runtime happened to start in.
  if (typeof value !== 'string' || !(/^[\w.-]{1,64}$/.test(value) || path.isAbsolute(value))) fail(`invalid-recognition-${field}`);
  return value;
}
function absolute(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`invalid-recognition-${field}`);
  return value;
}
function token(value, field) {
  if (typeof value !== 'string' || !/^[a-z]{2,8}$/.test(value)) fail(`invalid-recognition-${field}`);
  return value;
}
// The decoder is biased toward the words given here, so a prompt is whatever
// vocabulary the caller expects to hear. It is configuration rather than
// anything this repository knows, and it is never logged.
function hint(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) fail('invalid-recognition-prompt');
  return value;
}
function flag(value, field) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') fail(`invalid-recognition-${field}`);
  return value;
}
function bound(value, fallback, code, low = 100, high = 600000) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < low || value > high) fail(code);
  return value;
}

/** The model file this configuration would decode with, or null if none is on disk. */
export function resolveModel(settings) {
  if (settings.model) return existsSync(settings.model) ? settings.model : null;
  for (const name of MODEL_NAMES) {
    const file = path.join(settings.modelDir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

// One injected boundary for both child processes, so a test exercises every
// branch without a decoder installed and without spawning anything.
async function runCommand(binary, args, { timeoutMs }) {
  return exec(binary, args, {
    timeout: timeoutMs,
    // SIGTERM is the polite signal and a decoder wedged inside a compute loop
    // can outlive it, so the bound escalates rather than hoping.
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

function childCode(error, missing) {
  if (error?.code === 'ENOENT') return missing;
  if (error?.killed === true) return 'recognition-timeout';
  return null;
}

/** Already what the decoder wants: 16 kHz, one channel, 16-bit PCM in a canonical WAV. */
export function decodableWav(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length > 44
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 16) === 'WAVEfmt '
    && bytes.readUInt16LE(20) === 1 && bytes.readUInt16LE(22) === 1
    && bytes.readUInt32LE(24) === 16000 && bytes.readUInt16LE(34) === 16;
}

// Container before codec: the browser records `audio/webm;codecs=opus`, whose
// container is webm, and matching the codec parameter first names it an Ogg.
const EXTENSIONS = [[/webm|matroska/, '.webm'], [/mp4|m4a|aac/, '.m4a'], [/ogg|opus/, '.ogg'],
  [/wav/, '.wav'], [/mpeg|mp3/, '.mp3']];
export function extensionFor(mimeType) {
  const type = String(mimeType ?? '').toLowerCase();
  for (const [pattern, extension] of EXTENSIONS) if (pattern.test(type)) return extension;
  return '.webm';
}

// whisper.cpp brackets what it did not hear as speech, `[BLANK_AUDIO]` and
// `[MUSIC]` among them.
export const cleanTranscript = text => String(text).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
const clean = cleanTranscript;

/** Decode one file the decoder can already read. Returns the cleaned transcript. */
async function decode(file, model, settings, run) {
  let result;
  try {
    const args = ['-m', model, '-f', file, '--no-timestamps', '--no-prints',
      '--language', settings.language, '--threads', '4'];
    // Refusing to emit `[BLANK_AUDIO]` at all is cheaper than stripping it
    // afterwards, and stops silence being scored as a word.
    if (settings.suppressNst) args.push('--suppress-nst');
    if (settings.prompt) args.push('--prompt', settings.prompt);
    result = await run(settings.binary, args, { timeoutMs: settings.timeoutMs });
  } catch (error) {
    fail(childCode(error, 'recognizer-not-installed') ?? 'recognition-failed');
  }
  return clean(result?.stdout ?? '');
}

/**
 * Write one clip somewhere the decoder can read it: an owner-only temporary
 * directory holding 16 kHz mono WAV, converted with the configured converter
 * when the bytes are not already that. The caller removes `directory` in a
 * `finally`, because a clip left behind is a recording of him sitting in a
 * temporary directory.
 *
 * It is one function rather than one per decoder. Both the resident server
 * and the command-line decoder need exactly this, and a second copy of the
 * conversion is a second set of converter arguments to keep in step.
 */
export async function stageClip(audio, { mimeType = 'audio/webm', settings,
  run = runCommand, convertTimeoutMs = DEFAULT_CONVERT_TIMEOUT_MS } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tophat-stt-'));
  await fs.chmod(directory, 0o700);
  let file = path.join(directory, `clip${extensionFor(mimeType)}`);
  try {
    await fs.writeFile(file, audio, { mode: 0o600 });
    if (!decodableWav(audio)) {
      const converted = path.join(directory, 'clip.16k.wav');
      try {
        await run(settings.converter, ['-y', '-loglevel', 'error', '-i', file,
          '-ar', '16000', '-ac', '1', '-f', 'wav', converted], { timeoutMs: convertTimeoutMs });
      } catch (error) {
        fail(childCode(error, 'converter-not-installed') ?? 'audio-conversion-failed');
      }
      file = converted;
    }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { directory, file };
}

/**
 * Is this command runnable from here: an absolute path that exists, or a bare
 * name on `PATH`. A service started by launchd inherits a `PATH` that does not
 * carry Homebrew, so the question is asked against the environment the call is
 * made in rather than assumed.
 */
export function commandOnDisk(value, { env = process.env } = {}) {
  if (path.isAbsolute(value)) return existsSync(value);
  return String(env.PATH ?? '').split(path.delimiter).filter(Boolean)
    .some(directory => existsSync(path.join(directory, value)));
}

/**
 * Can this machine transcribe at all, and if not, which of the three pieces is
 * missing. Synchronous, for a caller answering it inside a request that has
 * not spawned anything yet; `probeRecognition` is the honest check and costs a
 * decode.
 */
export function recognitionReady(settings, options = {}) {
  if (!commandOnDisk(settings.binary, options)) return { ready: false, reason: 'recognizer-not-installed' };
  if (!commandOnDisk(settings.converter, options)) return { ready: false, reason: 'converter-not-installed' };
  if (!resolveModel(settings)) return { ready: false, reason: 'recognition-model-required' };
  return { ready: true, reason: null };
}

/**
 * Transcribe one clip. Resolves with the text and the backend that produced
 * it; rejects with a `RecognitionError` carrying a code and the one action
 * that answers it.
 */
export async function transcribeSpeech({ config, audio, mimeType = 'audio/webm' } = {}, options = {}) {
  const settings = recognitionSettings(config);
  if (!Buffer.isBuffer(audio) || !audio.length) fail('recognition-audio-required');
  if (audio.length > settings.maxBytes) fail('recognition-audio-too-long');
  const model = resolveModel(settings);
  if (!model) fail('recognition-model-required', { action: 'download-model' });
  const run = options.run ?? runCommand;
  const clock = options.clock ?? Date.now;
  const started = clock();

  const { directory, file } = await stageClip(audio, { mimeType, settings, run });
  try {
    const text = await decode(file, model, settings, run);
    return { provider: PROVIDER, model: path.basename(model), language: settings.language,
      text, bytes: audio.length, elapsedMs: clock() - started };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The read probe. It decodes a bundled synthetic clip and compares the words
 * that come back, so what it establishes is that this machine transcribes
 * speech, not that a file exists somewhere.
 *
 * `unavailable` means nothing is installed to check; `failed` means something
 * is installed, it ran, and it did not transcribe. Reporting those as one
 * answer is what lets a broken decoder read as a missing one.
 */
export async function probeRecognition(settings, options = {}) {
  const model = resolveModel(settings);
  if (!model) return { status: 'unavailable', reason: 'recognition-model-required', action: 'download-model' };
  if (!existsSync(PROBE_CLIP)) return { status: 'failed', reason: 'probe-clip-missing', action: 'report-defect' };
  const run = options.run ?? runCommand;
  const clock = options.clock ?? Date.now;
  const started = clock();
  let text;
  try {
    text = await decode(PROBE_CLIP, model, settings, run);
  } catch (error) {
    const code = error?.code ?? 'recognition-failed';
    // Nothing to run is nothing to judge; anything else ran and went wrong.
    const status = code === 'recognizer-not-installed' ? 'unavailable' : 'failed';
    return { status, reason: code, action: recognitionAdvice(code), model: path.basename(model) };
  }
  const heard = new Set(text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/));
  const matched = PROBE_WORDS.filter(word => heard.has(word));
  const base = { model: path.basename(model), matched: matched.length, expected: PROBE_WORDS.length, elapsedMs: clock() - started };
  if (matched.length < MIN_PROBE_WORDS) {
    return { status: 'failed', reason: 'transcript-mismatch', action: recognitionAdvice('transcript-mismatch'), ...base };
  }
  return { status: 'verified', verification: 'decoded-a-bundled-clip', ...base };
}

/**
 * Doctor coverage for recognition, in the shape `setupStatus` already reports:
 * `status`, plus `blocked` and `action` when someone has to do something.
 * Unlike the hosted half of synthesis this check is free, so it runs the real
 * decode every time rather than reporting a reference it never used.
 */
export async function recognitionStatus(config, options = {}) {
  let settings;
  try { settings = recognitionSettings(config); }
  catch (error) {
    return { status: 'needs-user', blocked: 'owner', action: 'owner-choice', reason: error.code ?? 'invalid-recognition-config' };
  }
  const probe = await probeRecognition(settings, options);
  const { status, reason, action, ...evidence } = probe;
  const base = { providers: [{ provider: PROVIDER, status, binary: settings.binary, modelDir: settings.modelDir,
    ...evidence, ...(reason ? { reason } : {}) }] };
  if (status === 'verified') return { status: 'verified', ...base };
  // Installing a decoder and choosing a model are the owner's: they cost his
  // disk and his machine's consent, and nothing here can do either for him.
  return { status: 'needs-user', blocked: 'owner', action: action ?? recognitionAdvice(reason), reason, ...base };
}
