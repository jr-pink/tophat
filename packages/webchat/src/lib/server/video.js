import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { webchatStorePath } from './paths.js';

// Microscope supplements arrive as MJPEG .avi at 211x181; no browser plays that. Anything the
// browser cannot play is transcoded once to H.264 MP4 and kept under its content hash, so the same
// bytes attached twice, or renamed, are one cache entry. No locks: concurrent requests in this
// process share one promise, and the file appears by temp+rename, so a second process at worst
// transcodes the same bytes again and renames the identical result over the first.
//
// The system ffmpeg (/opt/homebrew/bin/ffmpeg -> ~/.local/opt/ffmpeg-local) is a deliberately
// audio-only build for dictation. Video uses its own full binary, named by
// ~/.config/tophat/webchat-video.json {"ffmpeg": "..."} or TOPHAT_VIDEO_FFMPEG; it is a file of its
// own because config.json refuses keys an older serving release cannot read.

export const DEFAULT_FFMPEG = join(homedir(), '.local/opt/ffmpeg-full-tophat-webchat/bin/ffmpeg');
const SETTINGS_FILE = join(homedir(), '.config/tophat/webchat-video.json');

export function videoSettings({ env = process.env, file = SETTINGS_FILE } = {}) {
  let user = {};
  try { user = JSON.parse(readFileSync(file, 'utf8')); } catch { /* absent: defaults */ }
  return {
    ffmpeg: env.TOPHAT_VIDEO_FFMPEG || user.ffmpeg || DEFAULT_FFMPEG,
    cacheDir: env.WEBCHAT_VIDEO_CACHE || user.cacheDir || webchatStorePath('video-cache')
  };
}

const PLAYABLE_CONTAINERS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv']);
const PLAYABLE_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);

/** What `ffmpeg -i` says about the first video stream. Exported for tests. */
export function parseProbe(text) {
  const out = { width: null, height: null, fps: null, duration: null, codec: null, pixFmt: null };
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(text);
  if (d) out.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const line = String(text).split('\n').find((l) => /Stream #\d+:\d+.*: Video: /u.test(l));
  if (!line) return out;
  const v = /Video: ([a-z0-9_]+)/iu.exec(line);
  if (v) out.codec = v[1].toLowerCase();
  const pix = /Video: [^,]+, ([a-z0-9_]+)[(,]/iu.exec(line);
  if (pix) out.pixFmt = pix[1];
  const dims = /, (\d{2,5})x(\d{2,5})[\s,[]/u.exec(line);
  if (dims) { out.width = Number(dims[1]); out.height = Number(dims[2]); }
  const fps = /([\d.]+(?:k)?) fps/u.exec(line) || /([\d.]+(?:k)?) tbr/u.exec(line);
  if (fps) out.fps = fps[1].endsWith('k') ? Number(fps[1].slice(0, -1)) * 1000 : Number(fps[1]);
  return out;
}

export function needsTranscode(path, probe) {
  if (!PLAYABLE_CONTAINERS.has(extname(path).toLowerCase())) return true;
  if (probe.codec && !PLAYABLE_CODECS.has(probe.codec)) return true;
  // 4:2:2 / 4:4:4 H.264 (yuv422p, yuvj444p) decodes in no browser.
  return probe.codec === 'h264' && !!probe.pixFmt && !/^yuvj?420p$/u.test(probe.pixFmt);
}

export function transcodeArgs(input, output, probe) {
  const gop = Math.max(1, Math.round(probe.fps || 25));
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    // Pad, never scale, to even dimensions: a microscope frame keeps every source pixel.
    '-vf', 'scale=out_range=tv,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p', '-color_range', 'tv', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
    '-pix_fmt', 'yuv420p', '-g', String(gop), '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-f', 'mp4', output];
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err = (err + c).slice(-64_000); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr: err }));
  });
}

const hashes = new Map();
async function contentHash(path, size, mtimeMs) {
  const key = `${path}\u0000${size}\u0000${mtimeMs}`;
  if (!hashes.has(key)) {
    hashes.set(key, new Promise((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    }));
    hashes.get(key).catch(() => hashes.delete(key));
  }
  return hashes.get(key);
}

async function atomicWrite(target, data) {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

// A gallery asks for a dozen videos at once; at most two ffmpeg transcodes run, the rest queue in
// memory (a counter and a FIFO, no lock files).
const MAX_TRANSCODES = 2;
let running = 0;
const waiting = [];
function limited(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      running++;
      task().then(resolve, reject).finally(() => { running--; waiting.shift()?.(); });
    };
    running < MAX_TRANSCODES ? start() : waiting.push(start);
  });
}

const inflight = new Map();
const failures = new Map();

/**
 * The browser-playable form of a video file: its metadata (source resolution, fps, duration) and,
 * once ready, the path to serve. `wait: false` starts a transcode and returns at once with
 * ready:false, so a request never sits behind ffmpeg long enough for the tunnel to time it out.
 */
export async function playable(file, { settings = videoSettings(), wait = true } = {}) {
  const info = await stat(file);
  const hash = await contentHash(file, info.size, info.mtimeMs);
  await mkdir(settings.cacheDir, { recursive: true });
  const metaPath = join(settings.cacheDir, `${hash}.json`);
  let probe;
  try { probe = JSON.parse(await readFile(metaPath, 'utf8')); } catch {
    const { stderr } = await run(settings.ffmpeg, ['-hide_banner', '-nostdin', '-i', file]);
    probe = parseProbe(stderr);
    if (!probe.codec) throw Object.assign(new Error('not a video ffmpeg can read'), { status: 415 });
    await atomicWrite(metaPath, JSON.stringify(probe));
  }
  const meta = { ...probe, hash };
  if (!needsTranscode(file, probe)) return { ...meta, transcoded: false, ready: true, path: file, size: info.size };
  const out = join(settings.cacheDir, `${hash}.mp4`);
  const done = await stat(out).catch(() => null);
  if (done) return { ...meta, transcoded: true, ready: true, path: out, size: done.size };
  if (failures.has(hash)) return { ...meta, transcoded: true, ready: false, error: failures.get(hash) };
  if (!inflight.has(hash)) {
    const tmp = `${out}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const job = limited(() => run(settings.ffmpeg, transcodeArgs(file, tmp, probe))).then(async ({ code, stderr }) => {
      if (code !== 0) { await rm(tmp, { force: true }); throw new Error(`transcode failed (${code}): ${stderr.trim().split('\n').pop() || ''}`); }
      await rename(tmp, out);
    }).catch((error) => { failures.set(hash, error.message); throw error; })
      .finally(() => inflight.delete(hash));
    job.catch(() => {});
    inflight.set(hash, job);
  }
  if (!wait) return { ...meta, transcoded: true, ready: false };
  await inflight.get(hash)?.catch(() => {});
  return playable(file, { settings, wait: false });
}

/** For tests: forget remembered failures and hashes. */
export function resetVideoMemo() { hashes.clear(); failures.clear(); }
