

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MODEL_NAMES } from '../../../../runner/src/speech/recognition.mjs';
import { recognitionSettingsNow } from './recognition-config.js';

const WHISPER_SERVER = process.env.TOPHAT_WHISPER_SERVER_BIN || '/opt/homebrew/bin/whisper-server';


export const FINAL_PORT = Number(process.env.TOPHAT_WHISPER_FINAL_PORT || 8824);
export const LIVE_PORT = Number(process.env.TOPHAT_WHISPER_LIVE_PORT || 8825);

const BOOT_MS = Number(process.env.TOPHAT_WHISPER_BOOT_MS || 12_000);

const WARM_MS = Number(process.env.TOPHAT_WHISPER_WARM_MS || 180_000);

export async function probe(port, { deadlineMs = 700 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(deadlineMs)
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

function modelsIn(dir) {
  return Boolean(dir) && MODEL_NAMES.some((name) => existsSync(join(dir, name)));
}

const booting = new Map();

const spawned = new Map();

function alreadyStarting(port) {
  const child = spawned.get(port);
  if (!child) return false;
  if (child.exitCode !== null || child.signalCode !== null) {
    spawned.delete(port);
    return false;
  }
  return true;
}

// The whisper-server children this process started, watched until they serve.
// A resident decoder outliving one webchat restart is the point of it, so this
// does not kill a server that answers; it kills the one that never did, which
// is the shape the duplicate-server leak took: a slow boot, a second spawn, two
// 1.6 GB processes and one of them permanently unreachable.
export async function reapUnserving(port, bootMs = BOOT_MS) {
  const child = spawned.get(port);
  if (!child) return false;
  const grace = Date.now() + bootMs * 2;
  while (Date.now() < grace) {
    if (child.exitCode !== null || child.signalCode !== null) { spawned.delete(port); return false; }
    if (await probe(port, { deadlineMs: 400 })) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (child.exitCode !== null || child.signalCode !== null) { spawned.delete(port); return false; }
  if (await probe(port, { deadlineMs: 700 })) return false;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {  } }
  spawned.delete(port);
  console.warn(`[webchat] killed a whisper-server that never served on ${port}`);
  return true;
}

// The kernel's answer to "is anything listening on this port", which an HTTP probe cannot give. whisper-server
// binds with SO_REUSEPORT, so a second one on the same port binds without complaint and either may answer; and
// a probe that times out because this process's own event loop is busy at boot reads a live server as absent.
// A bind without SO_REUSEPORT fails with EADDRINUSE whenever any listener holds the port, busy or not.
export function portTaken(port, host = '127.0.0.1') {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', (error) => done(error.code === 'EADDRINUSE' || error.code === 'EACCES'));
    server.once('listening', () => server.close(() => done(false)));
    server.listen({ port, host, exclusive: true });
  });
}

/** ps elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
export function etimeSeconds(etime) {
  const text = String(etime || '').trim();
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const total = Number(days) * 86_400 + parts[0] * 3_600 + parts[1] * 60 + parts[2];
  return Number.isFinite(total) ? total : 0;
}

function processList() {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/u)).filter(Boolean)
    .map(([, pid, etime, command]) => ({ pid: Number(pid), age: etimeSeconds(etime), command }));
}

/** The whisper-server processes started for this port, oldest first, whoever started them. */
export function serversOn(port, list = processList) {
  const portArg = new RegExp(`--port\\s+${Number(port)}(\\s|$)`, 'u');
  return list().filter((p) => /(^|\/)whisper-server(\s|$)/u.test(p.command) && portArg.test(p.command))
    .sort((a, b) => b.age - a.age);
}

/**
 * One server per port. Keeps the oldest running the wanted model (its weights are loaded), else the oldest,
 * and stops the rest: SIGTERM now, SIGKILL for any still there after `graceMs`. Returns the pids stopped.
 */
export function reapDuplicates(port, model, { list = processList, kill = (pid, signal) => process.kill(pid, signal), graceMs = 5_000, log = console } = {}) {
  const servers = serversOn(port, list);
  if (servers.length <= 1) return [];
  const keep = servers.find((p) => model && p.command.includes(` ${model}`)) || servers[0];
  const extra = servers.filter((p) => p.pid !== keep.pid);
  for (const p of extra) { try { kill(p.pid, 'SIGTERM'); } catch { /* already gone */ } }
  const timer = setTimeout(() => {
    for (const p of extra) { try { kill(p.pid, 0); kill(p.pid, 'SIGKILL'); } catch { /* exited on SIGTERM */ } }
  }, graceMs);
  timer.unref?.();
  log.warn(`[webchat] stopped ${extra.length} duplicate whisper-server(s) on ${port} (${extra.map((p) => p.pid).join(', ')}), kept ${keep.pid}`);
  return extra.map((p) => p.pid);
}

function reapQuietly(port, model, reap) {
  try { reap(port, model); } catch { /* ps unavailable: nothing to reap with */ }
}

export async function ensure(port, model, { threads = 4, bootMs = BOOT_MS, taken = portTaken, reap = reapDuplicates } = {}) {
  if (await probe(port)) { reapQuietly(port, model, reap); return true; }
  if (!existsSync(WHISPER_SERVER) || !model || !existsSync(model)) return false;
  if (booting.has(port)) return booting.get(port);
  
  
  if (alreadyStarting(port)) return false;
  // Something holds the port but did not answer in time: a server that is busy, still loading its weights, or
  // one this process cannot hear because its own boot is hogging the event loop. Never a reason for another.
  if (await taken(port)) { reapQuietly(port, model, reap); return false; }

  const attempt = (async () => {
    try {
      
      
      
      
      
      
      
      const child = spawn(WHISPER_SERVER, [
        '-m', model,
        '--host', '127.0.0.1',
        '--port', String(port),
        '-t', String(threads)
      ], { stdio: 'ignore', detached: true });
      child.unref();
      child.on('error', () => spawned.delete(port));
      child.on('exit', () => spawned.delete(port));
      spawned.set(port, child);
    } catch {
      return false;
    }
    const until = Date.now() + bootMs;
    while (Date.now() < until) {
      if (await probe(port, { deadlineMs: 400 })) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    // A child that has not answered by now is either slow to load its weights
    // or a duplicate that lost the port. Slow is allowed to finish, because
    // large-v3-turbo is 1.6 GB and `alreadyStarting` stops a second spawn
    // meanwhile; a duplicate is killed rather than left holding a model no
    // request will ever reach. Either way nothing is left running unwatched.
    reapUnserving(port, bootMs).catch(() => {});
    return false;
  })().finally(() => booting.delete(port));

  booting.set(port, attempt);
  return attempt;
}

export async function transcribeVia(port, wavPath, options = {}) {
  const bytes = await (await import('node:fs/promises')).readFile(wavPath);
  return transcribeBuffer(port, bytes, options);
}

/**
 * The same decode against bytes that are already 16 kHz mono WAV in memory.
 * The live path holds its audio in this process, so writing it to a temporary
 * file and reading it back only to post it is latency for nothing.
 */
export async function transcribeBuffer(port, bytes, {
  prompt = '',
  language = 'en',
  suppressNst = true,
  beamSize = 5,
  bestOf = 5,
  deadlineMs = 30_000,
  signal = null,
  timestamps = false,
  // Above zero the decoder samples rather than taking the best token every
  // time, which is the only way this server will give a second reading of the
  // same audio: it has no n-best list to ask for. Nothing on the transcript
  // path passes this; the alternatives popup does.
  temperature = 0,
  // The segments and their `avg_logprob`, without the word-level timestamps.
  // Measured on a 1.8 s span on base.en: 130 ms this way against 745 ms with
  // `timestamps`, because the word times are a DTW pass over the decode.
  scores = false
} = {}) {
  const verbose = timestamps || scores;
  const form = new FormData();
  form.append('file', new Blob([bytes]), 'audio.wav');
  form.append('temperature', String(Number.isFinite(temperature) ? temperature : 0));
  form.append('response_format', verbose ? 'verbose_json' : 'json');
  form.append('language', language);
  form.append('no_timestamps', timestamps ? 'false' : 'true');
  
  form.append('max_len', timestamps ? '40' : '0');
  form.append('split_on_word', timestamps ? 'true' : 'false');
  if (suppressNst) form.append('suppress_nst', 'true');
  if (prompt) form.append('prompt', prompt);
  form.append('beam_size', String(beamSize));
  form.append('best_of', String(bestOf));

  const clock = AbortSignal.timeout(deadlineMs);
  const abort = signal ? AbortSignal.any([clock, signal]) : clock;
  const response = await fetch(`http://127.0.0.1:${port}/inference`, {
    method: 'POST',
    body: form,
    signal: abort
  });
  if (!response.ok) throw new Error(`whisper-server on ${port} refused with ${response.status}`);
  const body = await response.json();
  if (typeof body?.text !== 'string') throw new Error(`whisper-server on ${port} returned no text`);
  return verbose ? { text: body.text, segments: body.segments || [] } : body.text;
}

export function warm({ bootMs = WARM_MS } = {}) {
  
  
  
  
  
  if (process.env.VITEST || process.env.NODE_ENV === 'test' || process.env.WEBCHAT_TEST_PORT) return;
  for (const [port, tier] of [[LIVE_PORT, 'live'], [FINAL_PORT, 'final']]) {
    const model = modelFor(tier);
    if (model) ensure(port, model, { bootMs }).catch(() => {});
  }
}


// Where this machine keeps its weights, as the request path resolves it. Warming
// one directory and decoding out of another is how a warm server ends up holding
// a model no request will ever ask it for.
function configuredModelDir() {
  try {
    const settings = recognitionSettingsNow();
    // `modelDir` and `model` are two settings that can disagree, and on this
    // machine they did: `model` named a file in one directory while `modelDir`
    // kept its default, which holds nothing. The live tier then had no weights
    // to name and answered "warming up" forever, so the preview never showed a
    // word. The weights live where the named model lives.
    if (modelsIn(settings.modelDir)) return settings.modelDir;
    if (settings.model && existsSync(settings.model)) return dirname(settings.model);
    return settings.modelDir;
  } catch {
    return process.env.TOPHAT_WHISPER_MODELS || join(homedir(), '.config', 'tophat', 'whisper');
  }
}

// One override, so the preview's model is a decision he can change without a
// deploy: TOPHAT_WHISPER_LIVE_MODEL names the weights the partials decode with.
const LIVE_MODEL = process.env.TOPHAT_WHISPER_LIVE_MODEL || '';

export function modelFor(tier, modelDir = configuredModelDir()) {
  if (tier === 'live' && LIVE_MODEL && existsSync(LIVE_MODEL)) return LIVE_MODEL;
  // One preference list, read in the direction the tier wants: accuracy first
  // for a finished transcript, speed first for a partial that is rewritten a
  // quarter of a second later.
  const order = tier === 'live' ? [...MODEL_NAMES].reverse() : MODEL_NAMES;
  for (const name of order) {
    const path = join(modelDir, name);
    if (existsSync(path)) return path;
  }
  return null;
}
