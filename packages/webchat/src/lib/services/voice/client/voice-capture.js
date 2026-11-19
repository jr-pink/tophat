// The microphone for hands-free voice mode: one stream opened with echo cancellation on, handed out as 24 kHz PCM16
// frames plus a level per frame. It is the only thing that touches getUserMedia for the conversation; the
// recogniser above it decides what to do with the frames.

import { acquireMicrophone, releaseMicrophone } from './microphone-session.js';
import { voiceConstraint } from '../core/audio-devices.js';
import { frameDb, makeDownsampler } from '../core/realtime-voice.js';

const FRAME = 2048;

export function captureSupported() {
  return typeof window !== 'undefined'
    && Boolean(navigator?.mediaDevices?.getUserMedia)
    && typeof (window.AudioContext || window.webkitAudioContext) === 'function';
}

/**
 * `onFrame({ pcm, db, at })` for every ~40 ms of audio; `onEnded()` when the device goes away under us. `open`
 * resolves to { label, deviceId, fellBack } and rejects with the browser's own error (NotAllowedError and friends).
 */
export function createVoiceCapture({ onFrame = () => {}, onEnded = () => {} } = {}) {
  let ctx = null;
  let stream = null;
  let source = null;
  let node = null;
  let mute = null;
  let opening = null;

  async function openStream(deviceId) {
    try {
      return { stream: await acquireMicrophone(voiceConstraint(deviceId)), fellBack: false };
    } catch (cause) {
      const gone = cause?.name === 'OverconstrainedError' || cause?.name === 'NotFoundError';
      if (!deviceId || !gone) throw cause;
      return { stream: await acquireMicrophone(voiceConstraint(null)), fellBack: true };
    }
  }

  async function begin(deviceId) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
    const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume().catch(() => {});
    const opened = await openStream(deviceId);
    stream = opened.stream;
    await resumed;
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const downsample = makeDownsampler(ctx.sampleRate);
    source = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(FRAME, 1, 1);
    node.onaudioprocess = (event) => {
      const frame = event.inputBuffer.getChannelData(0);
      onFrame({ pcm: downsample(frame), db: frameDb(frame), at: Date.now() });
    };
    // A script processor only runs while it is connected to something; the gain of zero keeps the microphone
    // out of the speakers.
    mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    const track = stream.getAudioTracks()[0];
    track?.addEventListener?.('ended', () => { if (stream === opened.stream) onEnded(); });
    const settings = track?.getSettings ? track.getSettings() : {};
    return {
      label: track?.label || '',
      deviceId: settings.deviceId || deviceId || null,
      fellBack: opened.fellBack,
      echoCancellation: settings.echoCancellation
    };
  }

  async function close() {
    const done = ctx;
    const held = stream;
    try { node && (node.onaudioprocess = null); } catch {  }
    try { source?.disconnect(); } catch {  }
    try { node?.disconnect(); } catch {  }
    try { mute?.disconnect(); } catch {  }
    ctx = stream = source = node = mute = null;
    if (held) releaseMicrophone(held);
    try { await done?.close?.(); } catch {  }
  }

  return {
    get open() { return Boolean(stream); },
    async start(deviceId = null) {
      if (opening) await opening.catch(() => {});
      if (stream) await close();
      opening = begin(deviceId);
      try { return await opening; } catch (cause) { await close(); throw cause; } finally { opening = null; }
    },
    stop: close
  };
}
