

import { audioWindow, LIVE_WINDOW_SEC } from '$lib/core/dictation-window.js';
import { acquireMicrophone, releaseMicrophone } from './microphone-session.js';
import { audioConstraint, audioInputs } from '$lib/core/audio-devices.js';
import { clipRun, dbfs, frameLevels } from '$lib/core/audio-levels.js';

export const WANT_RATE = 16_000;

// How much of the audio from before the button is kept. He speaks as he
// reaches for it, and opening a microphone is not instant: the stream, the
// audio context and its resume all happen after the press, and on a phone that
// is most of a second in which nothing is being recorded at all. So the
// microphone stays open between dictations and the frames it hears go into a
// ring; pressing record starts the recording this far back.
export const PREROLL_SEC = 1.5;

// A microphone held open with nothing to record is closed after this long, so
// an app left open all afternoon is not listening all afternoon.
export const IDLE_RELEASE_MS = 120_000;

export async function listInputs() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    
    
    
    
    
    
    return audioInputs(await navigator.mediaDevices.enumerateDevices())
      .map((device) => ({
        kind: 'audioinput',
        deviceId: device.deviceId,
        label: device.label || '',
        groupId: device.groupId || ''
      }));
  } catch {
    return [];
  }
}


export function watchDevices(handler) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return () => {};
  navigator.mediaDevices.addEventListener('devicechange', handler);
  return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
}

export function safeSettings(all) {
  if (!all) return null;
  const want = ['sampleRate', 'channelCount', 'sampleSize', 'echoCancellation', 'noiseSuppression', 'autoGainControl', 'latency'];
  const out = {};
  for (const key of want) if (all[key] !== undefined) out[key] = all[key];
  return Object.keys(out).length ? out : null;
}

export function recordingSupported() {
  if (typeof window === 'undefined') return false;
  if (window.__tophatDictationRecorder) return true;
  return Boolean(navigator?.mediaDevices?.getUserMedia)
    && typeof (window.AudioContext || window.webkitAudioContext) === 'function';
}

export function encodeWav(chunks, sampleRate) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i += 1, o += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function createRecorder({
  onLevel = () => {}, onError = () => {}, onDevice = () => {}, deviceId = null,
  prerollSec = PREROLL_SEC, idleReleaseMs = IDLE_RELEASE_MS
} = {}) {
  if (typeof window !== 'undefined' && window.__tophatDictationRecorder) {
    return window.__tophatDictationRecorder({ onLevel, onError, onDevice, deviceId });
  }

  let ctx = null;
  let stream = null;
  let node = null;
  let source = null;
  let analyser = null;
  let buffers = [];
  let bufferEnds = [];
  let recording = false;
  let rate = 0;
  let deviceLabel = '';
  let settings = null;
  let meter = null;
  let wanted = deviceId || null;
  let closing = null;
  // Audio heard while not recording, newest last, trimmed to PREROLL_SEC.
  let ring = [];
  let ringSamples = 0;
  let idleTimer = null;
  let hideWatch = null;
  const preroll = Math.max(0, Number(prerollSec) || 0);
  // Where the live stream has read up to, as a source-sample index, and a
  // cursor into `buffers` so reading forward is not a binary search per sample.
  let readFrame = 0;

  // One source sample by absolute index, across the frames as captured.
  function sampleAt(index) {
    if (index < 0) return null;
    const inFrame = readFrame < bufferEnds.length
      && bufferEnds[readFrame] > index
      && (readFrame === 0 || bufferEnds[readFrame - 1] <= index);
    if (!inFrame) {
      let lo = 0;
      let hi = bufferEnds.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (bufferEnds[mid] <= index) lo = mid + 1;
        else hi = mid;
      }
      readFrame = lo;
    }
    if (readFrame >= buffers.length) return null;
    const start = readFrame > 0 ? bufferEnds[readFrame - 1] : 0;
    const value = buffers[readFrame][index - start];
    return value === undefined ? null : value;
  }

  

  async function openStream() {
    try {
      return { stream: await acquireMicrophone(audioConstraint(wanted)), fellBack: false };
    } catch (cause) {
      const gone = cause?.name === 'OverconstrainedError' || cause?.name === 'NotFoundError';
      if (!wanted || !gone) throw cause;
      
      const stream = await acquireMicrophone(audioConstraint(null));
      return { stream, fellBack: true };
    }
  }


  // Whether the context is running, waiting up to three seconds for the resume
  // to settle. A rejected resume on a context that is running anyway is not a
  // failure; a context that never gets there is, and `report` asks for the
  // error rather than the verdict so the caller can throw the real one.
  async function contextRunning(resumeResult, { report = false } = {}) {
    let deadline;
    const timedOut = Symbol('deadline');
    const outcome = await Promise.race([
      resumeResult,
      new Promise(resolve => { deadline = setTimeout(() => resolve(timedOut), 3000); })
    ]).finally(() => clearTimeout(deadline));
    if (ctx?.state === 'running') return true;
    if (!report) return false;
    if (outcome === timedOut) return new Error('Audio did not start. Tap the microphone again.');
    return outcome || new Error('Audio is paused. Tap the microphone again to resume.');
  }

  async function open() {
    // The previous run may still be tearing its audio context down. Opening a
    // microphone across that teardown is how iOS answers with a refusal, and a
    // refusal used to block the button for good.
    if (closing) { try { await closing; } catch {  } }
    if (stream) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    
    
    ctx = new Ctx(); 
    const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    
    const resumeResult = Promise.resolve(resumed).then(() => null, error => error);
    const opened = await openStream();
    stream = opened.stream;
    // The turn that asks for permission is the one that used to fail. The
    // context is created before the prompt, because iOS only lets a gesture
    // unlock audio, and a context created behind that prompt comes back
    // suspended with its resume never settling. Telling him the browser could
    // not open a microphone, which he then fixes by turning the microphone off
    // and on again, is describing a retry we can do ourselves: permission is
    // granted by now, so a second context opens cleanly.
    if (!(await contextRunning(resumeResult))) {
      const failed = ctx;
      ctx = new Ctx();
      try { failed?.close?.(); } catch {  }
      const again = ctx.state === 'running'
        ? Promise.resolve(null)
        : Promise.resolve(ctx.resume()).then(() => null, error => error);
      const error = await contextRunning(again, { report: true });
      if (error !== true) throw error || new Error('Audio is paused. Tap the microphone again to resume.');
    }
    source = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(1024, 1, 1);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    node.onaudioprocess = (event) => {
      const frame = new Float32Array(event.inputBuffer.getChannelData(0));
      if (!recording) {
        if (!preroll) return;
        ring.push(frame);
        ringSamples += frame.length;
        const keep = Math.round(preroll * (rate || ctx.sampleRate || WANT_RATE));
        while (ring.length > 1 && ringSamples - ring[0].length >= keep) {
          ringSamples -= ring.shift().length;
        }
        return;
      }
      buffers.push(frame);
      bufferEnds.push((bufferEnds.at(-1) || 0) + frame.length);
    };
    source.connect(analyser);
    source.connect(node);
    
    
    node.connect(ctx.destination);
    rate = ctx.sampleRate;
    const track = stream.getAudioTracks()[0];
    deviceLabel = track ? track.label : '';
    
    
    
    
    
    const live = track?.getSettings ? track.getSettings() : {};
    settings = track?.getSettings ? safeSettings(live) : null;
    
    
    
    
    
    
    
    
    const moved = !wanted || !live.deviceId || live.deviceId === wanted;
    deviceLabel = track ? track.label : '';
    onDevice({
      label: deviceLabel,
      fellBack: opened.fellBack || !moved,
      substituted: !opened.fellBack && !moved,
      wanted
    });
  }

  

  async function probe() {
    try {
      await open();
      return deviceLabel;
    } catch (cause) {
      report(cause);
      return null;
    } finally {
      if (!recording) await release();
    }
  }

  function report(cause) {
    const kind = cause?.name === 'NotAllowedError' || cause?.name === 'SecurityError'
      ? 'denied'
      : 'unsupported';
    onError(kind, kind === 'denied'
      ? 'The microphone was refused. Allow it in the browser and press the button again.'
      : `This browser could not open a microphone: ${cause?.message || cause}.`);
  }

  

  function runMeter() {
    if (!analyser || meter) return;
    const buf = new Uint8Array(analyser.fftSize);
    let run = 0;
    const tick = () => {
      if (!analyser || !recording) { meter = null; return; }
      analyser.getByteTimeDomainData(buf);
      const { peak, rms } = frameLevels(buf);
      const step = clipRun(run, peak);
      run = step.run;
      
      
      
      
      
      onLevel({ peak, rms, peakDb: dbfs(peak), rmsDb: dbfs(rms), clipped: step.clipped });
      meter = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopMeter() {
    if (meter) { cancelAnimationFrame(meter); meter = null; }
    onLevel({ peak: 0, rms: 0, peakDb: -100, rmsDb: -100, clipped: false });
  }

  function idle(on) {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!on || !idleReleaseMs) return;
    idleTimer = setTimeout(() => { if (!recording) void release(); }, idleReleaseMs);
  }

  // A microphone held open across a page the phone has put away is a battery
  // complaint waiting to happen, and iOS suspends the context anyway.
  function watchVisibility() {
    if (hideWatch || typeof document === 'undefined' || !document.addEventListener) return;
    hideWatch = () => { if (document.visibilityState === 'hidden' && !recording) void release(); };
    document.addEventListener('visibilitychange', hideWatch);
  }

  async function release() {
    if (closing) { try { await closing; } catch {  } }
    recording = false;
    idle(false);
    if (hideWatch && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', hideWatch);
      hideWatch = null;
    }
    ring = [];
    ringSamples = 0;
    stopMeter();
    if (node) { try { node.disconnect(); } catch {  } }
    if (source) { try { source.disconnect(); } catch {  } }
    if (stream) releaseMicrophone(stream);
    const context = ctx;
    ctx = null; stream = null; node = null; source = null; analyser = null;
    buffers = []; bufferEnds = []; readFrame = 0; rate = 0; deviceLabel = ''; settings = null;
    if (context) {
      closing = context.close().catch(() => {}).finally(() => { closing = null; });
      await closing;
    }
  }

  

  async function setDevice(id) {
    const next = id || null;
    if (next === wanted) return false;
    if (recording) return false;
    wanted = next;
    await release();
    return true;
  }

  return {
    get recording() { return recording; },
    // Open the microphone before he needs it, so the press records from the
    // first syllable. Safe to call when it is already open.
    async warm() {
      if (stream) { idle(true); return true; }
      try {
        await open();
        watchVisibility();
        idle(true);
        return true;
      } catch (cause) {
        await release();
        report(cause);
        return false;
      }
    },
    get warmed() { return Boolean(stream); },
    get prerollSec() { return preroll; },
    get device() { return deviceLabel; },
    get deviceId() { return wanted; },
    setDevice,
    probe,

    async start() {
      try {
        await open();
      } catch (cause) {
        await release();
        report(cause);
        return false;
      }
      idle(false);
      watchVisibility();
      // The recording starts before the press: whatever the open microphone
      // heard in the last PREROLL_SEC is the front of the clip.
      buffers = [];
      bufferEnds = [];
      readFrame = 0;
      const keep = Math.round(preroll * (rate || WANT_RATE));
      let carried = 0;
      for (let i = ring.length - 1; i >= 0 && carried < keep; i -= 1) {
        const frame = ring[i];
        buffers.unshift(frame);
        carried += frame.length;
      }
      let at = 0;
      for (const frame of buffers) { at += frame.length; bufferEnds.push(at); }
      ring = [];
      ringSamples = 0;
      recording = true;
      runMeter();
      return true;
    },

    
    
    get elapsedSec() {
      const samples = bufferEnds.at(-1) || 0;
      return samples / (rate || WANT_RATE);
    },

    
    
    
    reset() {
      buffers = [];
      bufferEnds = [];
      readFrame = 0;
    },

    
    snapshotWindow(startSec = 0, maxSec = LIVE_WINDOW_SEC) {
      if (!recording || !bufferEnds.length) return null;
      const window = audioWindow(buffers, bufferEnds, rate || WANT_RATE, startSec, maxSec);
      if (!window.durationSec) return null;
      return { ...window, chunks: undefined, blob: encodeWav(window.chunks, rate || WANT_RATE) };
    },

    snapshot() {
      return this.snapshotWindow()?.blob || null;
    },

    /**
     * The recording from `fromSample` onward as 16 kHz mono 16-bit PCM: what
     * the live decoder wants, about eight kilobytes a quarter second, and a
     * quarter of what the same audio costs at the capture rate.
     *
     * Addressed by output sample rather than by "what is new", so it is
     * deterministic: output sample i is always the average of source samples
     * [i*ratio, (i+1)*ratio), and the same range asked for twice comes back
     * byte for byte. That is what lets the server hold the authoritative
     * offset and the browser resend across an aborted request.
     */
    pcm16k(fromSample = 0) {
      const total = bufferEnds.at(-1) || 0;
      const source = rate || WANT_RATE;
      const ratio = source / WANT_RATE;
      const from = Math.max(0, Math.floor(fromSample));
      const count = Math.max(0, Math.floor(total / ratio) - from);
      if (!count) return null;
      const out = new Int16Array(count);
      for (let i = 0; i < count; i += 1) {
        const at = (from + i) * ratio;
        const end = at + ratio;
        // Box average over the source span, which is a cheap anti-alias:
        // plain decimation folds hiss down on top of the speech.
        let sum = 0;
        let n = 0;
        for (let j = Math.floor(at); j < end; j += 1) {
          const value = sampleAt(j);
          if (value === null) break;
          sum += value;
          n += 1;
        }
        const s = n ? sum / n : 0;
        const clamped = Math.max(-1, Math.min(1, s));
        out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
      return {
        bytes: out.buffer,
        sampleRate: WANT_RATE,
        fromSample: from,
        toSample: from + count,
        durationSec: count / WANT_RATE
      };
    },

    
    stop() {
      if (!recording) { void release(); return null; }
      recording = false;
      stopMeter();
      // The microphone stays open: the next press records from the first
      // syllable instead of paying for a stream, a context and a resume while
      // he is already talking. It closes itself after IDLE_RELEASE_MS, when
      // the page is hidden, or on dispose.
      idle(true);
      const frames = buffers;
      buffers = [];
      bufferEnds = [];
      readFrame = 0;
      let samples = 0;
      for (const chunk of frames) samples += chunk.length;
      const clip = samples ? {
        blob: encodeWav(frames, rate || WANT_RATE),
        sampleRate: rate || WANT_RATE,
        durationSec: Number((samples / (rate || WANT_RATE)).toFixed(3)),
        device: deviceLabel,
        settings,
        prerollSec: preroll
      } : null;
      if (!clip) void release();
      return clip;
    },

    release,
    dispose() { return release(); }
  };
}
