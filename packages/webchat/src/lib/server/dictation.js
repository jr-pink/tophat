

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readSecret } from './auth.js';
import { transcribe, whisperModel, transcriptionReady } from './voice.js';

const REPO = process.env.WEBCHAT_REPO || join(homedir(), '.local', 'share', 'tophat', 'workspace');


export function dictationDir() {
  return process.env.TOPHAT_DICTATION_DIR || join(REPO, '.work', 'dictation');
}

function productionDictationDir() {
  return join(REPO, '.work', 'dictation');
}

function underTestRunner() {
  const env = process.env;
  return Boolean(
    env.VITEST                      
    || env.JEST_WORKER_ID           
    || env.NODE_TEST_CONTEXT        
    || env.PLAYWRIGHT_TEST_BASE_URL 
    || env.NODE_ENV === 'test'
    || process.argv.includes('--test')
  );
}

export function assertNotProductionCorpus(what) {
  if (!underTestRunner()) return;
  if (resolve(dictationDir()) !== resolve(productionDictationDir())) return;
  throw new Error(
    `refusing to ${what} in User's real dictation corpus at ${productionDictationDir()}: `
    + 'a test is running and TOPHAT_DICTATION_DIR is not set. Point it at an '
    + 'fs.mkdtempSync directory, and thread it through any child process this '
    + 'test spawns -- a server started by webchat/tests/fixtures.js gets it from '
    + 'serverEnv() in webchat/tests/harness.mjs.'
  );
}

export function manifestPath() {
  
  
  
  return join(dictationDir(), 'webchat-manifest.jsonl');
}

export function flagPath() {
  return process.env.TOPHAT_DICTATION_FLAG
    || join(homedir(), '.config', 'tophat', 'dictation-flag.json');
}

export const MAX_CLIP_BYTES = 24 * 1024 * 1024;
export const MIN_CLIP_BYTES = 45;   

let flagCache = { path: null, mtimeMs: -1, value: null };

export function readFlag() {
  const path = flagPath();
  let stamp;
  try { stamp = statSync(path).mtimeMs; } catch { flagCache = { path: null, mtimeMs: -1, value: null }; return disabled(); }
  if (flagCache.path === path && flagCache.mtimeMs === stamp && flagCache.value) return flagCache.value;
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return disabled('the flag file is not valid JSON'); }
  const value = {
    enabled: parsed.enabled === true,
    engine: typeof parsed.engine === 'string' && parsed.engine ? parsed.engine : 'whisper-local',
    
    
    
    condition: typeof parsed.condition === 'string' ? parsed.condition : null,
    note: typeof parsed.note === 'string' ? parsed.note : null,
    
    
    provenance: parsed.provenance === true
  };
  flagCache = { path, mtimeMs: stamp, value };
  return value;
}

function disabled(why = null) {
  return { enabled: false, engine: 'whisper-local', condition: null, note: why, provenance: false };
}


export function writeFlag(patch) {
  const path = flagPath();
  mkdirSync(dirname(path), { recursive: true });
  const current = readFlag();
  const next = {
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
    engine: patch.engine === undefined ? current.engine : String(patch.engine || 'whisper-local'),
    condition: patch.condition === undefined ? current.condition : (patch.condition || null),
    note: patch.note === undefined ? current.note : (patch.note || null),
    provenance: patch.provenance === undefined ? current.provenance : patch.provenance === true
  };
  
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  flagCache = { path: null, mtimeMs: -1, value: null };
  return next;
}

export function readWavHeader(bytes) {
  if (!bytes || bytes.length < 44) return null;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let fmt = null;
  let dataBytes = null;
  let dataStart = null;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('latin1', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 8 + 16 <= bytes.length) {
      fmt = {
        format: bytes.readUInt16LE(at + 8),
        channels: bytes.readUInt16LE(at + 10),
        sampleRate: bytes.readUInt32LE(at + 12),
        bitsPerSample: bytes.readUInt16LE(at + 22)
      };
    } else if (id === 'data') {
      
      
      dataBytes = Math.min(size || Infinity, bytes.length - (at + 8));
      dataStart = at + 8;
    }
    at += 8 + size + (size % 2);
    if (size === 0) break;
  }
  if (!fmt || dataBytes === null || dataStart === null) return null;
  const bytesPerFrame = Math.max(1, (fmt.bitsPerSample / 8) * fmt.channels);
  
  
  return { ...fmt, dataBytes, dataStart, durationSec: Number((dataBytes / bytesPerFrame / fmt.sampleRate).toFixed(3)) };
}

export const CLIP_THRESHOLD = 32700;

export const SILENT_DB = -120;

function dbfs(magnitude) {
  return magnitude > 0 ? 20 * Math.log10(magnitude / 32768) : SILENT_DB;
}

function round(value, places) {
  const out = Number(value.toFixed(places));
  return Object.is(out, -0) ? 0 : out;
}

const NO_LEVELS = { rms_db: null, peak_db: null, clip_pct: null, duration_s: null };

export function measureLevels(bytes) {
  try {
    const header = readWavHeader(bytes);
    if (!header || header.format !== 1 || header.bitsPerSample !== 16) return { ...NO_LEVELS };
    const samples = Math.floor(header.dataBytes / 2);
    if (samples < 1) return { ...NO_LEVELS };
    let sumSquares = 0;
    let peak = 0;
    let clipped = 0;
    for (let i = 0; i < samples; i += 1) {
      const sample = bytes.readInt16LE(header.dataStart + i * 2);
      const magnitude = sample < 0 ? -sample : sample;
      sumSquares += sample * sample;
      if (magnitude > peak) peak = magnitude;
      if (magnitude >= CLIP_THRESHOLD) clipped += 1;
    }
    const channels = Math.max(1, header.channels);
    return {
      rms_db: round(dbfs(Math.sqrt(sumSquares / samples)), 1),
      peak_db: round(dbfs(peak), 1),
      clip_pct: round((clipped / samples) * 100, 2),
      
      
      
      
      duration_s: round(samples / channels / header.sampleRate, 3)
    };
  } catch {
    return { ...NO_LEVELS };
  }
}

function appendRow(row) {
  assertNotProductionCorpus('append a manifest row');
  const path = manifestPath();
  mkdirSync(dirname(path), { recursive: true });
  
  
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

export function appendRows(rows) {
  for (const row of rows) appendRow(row);
  return rows.length;
}

export function newClipId() {
  return `w-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
}


export function safeToken(value) {
  const token = String(value ?? '').trim();
  return /^[A-Za-z0-9._-]{1,120}$/u.test(token) ? token : null;
}

/**
 * The word times kept with a clip: `[word, start, end]` per word, rounded to
 * the millisecond, so a tap on a word in the draft can still name the span of
 * audio behind it after a reload. Compact on purpose -- this goes in a
 * manifest line that is read back by the evaluation tooling -- and capped, so
 * a ten minute recording cannot make one row enormous.
 */
export const MAX_STORED_WORDS = 2_000;

export function wordTimes(words) {
  const list = Array.isArray(words) ? words : [];
  const out = [];
  for (const word of list) {
    const text = typeof word?.word === 'string' ? word.word.trim() : '';
    const start = Number(word?.start);
    const end = Number(word?.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.push([text.slice(0, 80), Number(start.toFixed(3)), Number(end.toFixed(3))]);
    if (out.length >= MAX_STORED_WORDS) break;
  }
  return out.length ? out : null;
}

export function storeClip(bytes, meta = {}) {
  
  
  assertNotProductionCorpus('store a clip');
  const header = readWavHeader(bytes);
  if (!header) throw Object.assign(new Error('that is not a WAV file'), { status: 415 });
  if (header.format !== 1 || header.bitsPerSample !== 16) {
    throw Object.assign(new Error('expected 16-bit PCM'), { status: 415 });
  }
  const flag = readFlag();
  const session = safeToken(meta.sessionId) || 'unknown';
  const clipId = safeToken(meta.clipId) || newClipId();
  const relative = join('webchat', session, `${clipId}.wav`);
  const absolute = join(dictationDir(), relative);
  mkdirSync(dirname(absolute), { recursive: true });
  
  const tmp = `${absolute}.${process.pid}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, absolute);

  
  
  
  
  const levels = measureLevels(bytes);

  const row = {
    clip_id: clipId,
    path: relative,
    session_id: session,
    mode: 'dictation',
    source: 'webchat',
    condition: flag.condition,
    input_device: typeof meta.inputDevice === 'string' ? meta.inputDevice.slice(0, 200) : null,
    
    
    
    track_settings: meta.trackSettings && typeof meta.trackSettings === 'object' ? meta.trackSettings : null,
    conversation_id: safeToken(meta.conversationId),
    recorded_at: typeof meta.at === 'string' ? meta.at : new Date().toISOString(),
    duration_sec: header.durationSec,
    sample_rate: header.sampleRate,
    channels: header.channels,
    
    
    ...levels,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    device_id: typeof meta.deviceId === 'string' ? meta.deviceId.slice(0, 120) : null,
    user_agent: typeof meta.userAgent === 'string' ? meta.userAgent.slice(0, 300) : null,
    asr_text: null,
    text: null,
    
    
    
    word_times: wordTimes(meta.words)
  };
  appendRow(row);
  return row;
}

/**
 * The stored clip a request named: where its audio is, how long it is, and the
 * word times kept with it. Null for a clip id this machine has never written,
 * which is a 404 rather than a throw -- the id comes from a browser that may
 * have been reloaded since, or from nowhere at all.
 */
export function clipRecord(clipId) {
  const id = safeToken(clipId);
  if (!id) return null;
  const path = manifestPath();
  if (!existsSync(path)) return null;
  let found = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes(`"clip_id":"${id}"`)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.clip_id !== id) continue;
    if (row.type && row.type !== 'clip') continue;
    found = row;
  }
  if (!found?.path) return null;
  
  
  
  const root = resolve(dictationDir());
  const absolute = resolve(root, found.path);
  if (absolute !== root && !absolute.startsWith(`${root}/`)) return null;
  if (!existsSync(absolute)) return null;
  return {
    clipId: id,
    path: absolute,
    relative: found.path,
    durationSec: Number.isFinite(found.duration_sec) ? found.duration_sec : null,
    sampleRate: Number.isFinite(found.sample_rate) ? found.sample_rate : null,
    words: Array.isArray(found.word_times) ? found.word_times : null,
    asrText: typeof found.asr_text === 'string' ? found.asr_text : null
  };
}

export function clipExists(clipId) {
  const id = safeToken(clipId);
  if (!id) return false;
  const path = manifestPath();
  if (!existsSync(path)) return false;
  
  
  
  return readFileSync(path, 'utf8').includes(`"clip_id":"${id}"`);
}

function asrUrl() { return process.env.TOPHAT_DICTATION_ASR_URL || ''; }

export function launder(message) {
  return String(message ?? '').replace(/\bhttps?:\/\/[^\s)'"]+/giu, (match) => {
    try {
      const url = new URL(match);
      const keys = [...url.searchParams.keys()];
      return `${url.host}${url.pathname}${keys.length ? `?${keys.map((k) => `${k}=…`).join('&')}` : ''}`;
    } catch { return '[url]'; }
  });
}

async function viaWhisperLocal(bytes) {
  if (!transcriptionReady()) {
    throw Object.assign(new Error('no local transcription engine on this machine'), { status: 503 });
  }
  const text = await transcribe(bytes, { mime: 'audio/wav' });
  const model = whisperModel();
  return { text, engine: 'whisper-local', model: model ? model.split('/').pop() : 'unknown' };
}

async function viaElevenLabsScribe(bytes, { signal } = {}) {
  const key = readSecret('elevenlabs-api-key', 'ELEVENLABS_API_KEY');
  if (!key) throw Object.assign(new Error('no elevenlabs key installed'), { status: 503 });
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'clip.wav');
  form.append('model_id', 'scribe_v1');
  const clock = AbortSignal.timeout(60_000);
  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
    signal: signal ? AbortSignal.any([clock, signal]) : clock
  }).catch((cause) => {
    
    
    throw new Error(`api.elevenlabs.io: ${cause?.name === 'TimeoutError' ? 'timed out' : launder(cause.message)}`);
  });
  if (!response.ok) throw new Error(`elevenlabs refused with ${response.status}`);
  const body = await response.json();
  return { text: String(body.text || '').trim(), engine: 'elevenlabs-scribe', model: 'scribe_v1' };
}

async function viaCustom(bytes, { signal } = {}) {
  const url = asrUrl();
  if (!url) throw Object.assign(new Error('TOPHAT_DICTATION_ASR_URL is not set'), { status: 503 });
  const clock = AbortSignal.timeout(120_000);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: bytes,
    signal: signal ? AbortSignal.any([clock, signal]) : clock
  }).catch((cause) => {
    const host = (() => { try { return new URL(url).host; } catch { return 'asr'; } })();
    throw new Error(`${host}: ${cause?.name === 'TimeoutError' ? 'timed out' : launder(cause.message)}`);
  });
  if (!response.ok) throw new Error(`the transcription service answered ${response.status}`);
  const body = await response.json();
  return {
    text: String(body.text || '').trim(),
    engine: 'custom',
    model: String(body.model || 'custom')
  };
}

export const ENGINES = {
  'whisper-local': viaWhisperLocal,
  'elevenlabs-scribe': viaElevenLabsScribe,
  custom: viaCustom
};


export function engineStatus() {
  return [
    { name: 'whisper-local', ready: transcriptionReady(), why: 'local, private, free; nothing leaves this Mac' },
    { name: 'elevenlabs-scribe', ready: Boolean(readSecret('elevenlabs-api-key', 'ELEVENLABS_API_KEY')), why: 'sends his voice to a third party' },
    { name: 'custom', ready: Boolean(asrUrl()), why: 'our own finetuned model, once there is one' }
  ];
}

export async function runEngine(bytes, { engine = null, signal = null } = {}) {
  const name = engine || readFlag().engine;
  const run = ENGINES[name] || ENGINES['whisper-local'];
  const started = Date.now();
  const result = await run(bytes, { signal });
  return { ...result, latencyMs: Date.now() - started };
}

export function hypothesesFor(ids) {
  const want = new Set(ids.map((id) => safeToken(id)).filter(Boolean));
  const out = new Map();
  const path = manifestPath();
  if (!want.size || !existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!want.has(row.clip_id)) continue;
    if (row.type === 'correction') {
      if (typeof row.asr_text === 'string') out.set(row.clip_id, row.asr_text);
    } else if (!row.type || row.type === 'clip') {
      
      out.set(row.clip_id, typeof row.asr_text === 'string' ? row.asr_text : null);
    }
  }
  return out;
}
