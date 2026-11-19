// Voice mode's ears: an OpenAI Realtime transcription session over a WebSocket, opened with a client secret the
// server minted (the API key never reaches the page). The server decides when he has finished (semantic voice
// activity detection reads the words, not just the silence, so a pause mid-sentence does not end the turn) and
// answers with the transcript; this module turns that into `onUtterance(text)`. The model only writes down what he
// said. The reply is the normal agent's, spoken through /api/voice/speak.
//
// Hands-free means the microphone is open the whole conversation, so the loudspeaker is the hard part:
//  - the stream is opened with echo cancellation on (core/audio-devices.js voiceConstraint);
//  - while the reply plays, `hold()` stops sending audio at all, so the reply cannot be transcribed;
//  - while held, the level meter still runs, and his voice over BARGE_DB for BARGE_MS is a barge-in: the audio
//    from just before it is sent, the hold is dropped and `onBargeIn()` tells the state machine to stop talking.

import {
  BARGE_MS, PREROLL_MS, RESUME_HOLDOFF_MS, REALTIME_RATE, initialBarge, nextBarge, pcmToBase64, worthSending
} from '../core/realtime-voice.js';
import { SPEECH_DB } from '../core/speech-gate.js';
import { createVoiceCapture } from './voice-capture.js';

const MAX_QUEUE_MS = 5_000;
const RECONNECTS = 3;
const frameMs = (pcm) => (pcm.length / REALTIME_RATE) * 1000;

async function mintSecret(fetchImpl = fetch) {
  const response = await fetchImpl('/api/voice/realtime', { method: 'POST' });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.secret) {
    throw new Error(body?.error || `The transcription service answered ${response.status}.`);
  }
  return body;
}

export function createRealtimeRecogniser({
  onPartial = () => {},
  onUtterance = () => {},
  onBargeIn = () => {},
  onError = () => {},
  onStatus = () => {},
  onDevice = () => {},
  onLevel = () => {},
  deviceId = null,
  mint = mintSecret,
  makeSocket = (url, protocols) => new WebSocket(url, protocols),
  makeCapture = createVoiceCapture,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  bargeMs = BARGE_MS
} = {}) {
  let active = false;
  let held = false;
  let wanted = deviceId || null;
  let socket = null;
  let socketReady = false;
  let connecting = null;
  let reconnects = 0;
  let reconnectTimer = null;
  let muteUntil = 0;
  let speechMs = 0;
  let partials = new Map();
  let barge = initialBarge();
  let ring = [];
  let ringMs = 0;
  let queue = [];
  let queueMs = 0;
  let starting = null;
  let capture = null;
  let status = 'idle';

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus(next);
  }

  function send(event) {
    if (socket && socketReady) {
      try { socket.send(JSON.stringify(event)); return true; } catch {  }
    }
    return false;
  }

  function append(pcm) {
    if (!pcm?.length) return;
    if (socketReady) { send({ type: 'input_audio_buffer.append', audio: pcmToBase64(pcm) }); return; }
    queue.push(pcm);
    queueMs += frameMs(pcm);
    while (queueMs > MAX_QUEUE_MS && queue.length) queueMs -= frameMs(queue.shift());
  }

  function flushQueue() {
    const pending = queue;
    queue = [];
    queueMs = 0;
    for (const pcm of pending) append(pcm);
  }

  function resetTurn() {
    speechMs = 0;
    partials = new Map();
    onPartial('');
  }

  function onFrame({ pcm, db, at }) {
    onLevel(db);
    if (!active) return;
    const stamp = Number.isFinite(at) ? at : now();
    if (held) {
      ring.push(pcm);
      ringMs += frameMs(pcm);
      while (ring.length > 1 && ringMs - frameMs(ring[0]) >= PREROLL_MS) ringMs -= frameMs(ring.shift());
      const step = nextBarge(barge, { db, at: stamp, needMs: bargeMs });
      barge = step.state;
      if (step.barge) {
        held = false;
        muteUntil = 0;
        const lead = ring;
        ring = [];
        ringMs = 0;
        // His first words are already in the ring; they go ahead of everything live.
        for (const part of lead) append(part);
        speechMs = bargeMs;
        setStatus('hearing');
        onBargeIn();
      }
      return;
    }
    if (stamp < muteUntil) return;
    if (db > SPEECH_DB) speechMs += frameMs(pcm);
    append(pcm);
  }

  function handle(event) {
    switch (event?.type) {
      case 'input_audio_buffer.speech_started':
        setStatus('hearing');
        break;
      case 'input_audio_buffer.speech_stopped':
        setStatus('transcribing');
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const id = event.item_id || 'item';
        const text = `${partials.get(id) || ''}${event.delta || ''}`;
        partials.set(id, text);
        onPartial(text.trim());
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(event.transcript || '').trim();
        const heardFor = speechMs;
        resetTurn();
        setStatus('ready');
        if (worthSending(text, { speechMs: heardFor })) onUtterance(text);
        break;
      }
      case 'conversation.item.input_audio_transcription.failed':
        resetTurn();
        setStatus('ready');
        break;
      case 'error': {
        const message = event.error?.message || 'The transcription service reported an error.';
        // A refused credential or a closed session will not mend by sending more audio.
        if (/api key|authentication|expired|invalid/iu.test(`${event.error?.code} ${message}`)) {
          onError('realtime-unavailable', message);
        }
        break;
      }
      default:
        break;
    }
  }

  function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      const grant = await mint();
      await new Promise((resolve, reject) => {
        const ws = makeSocket(grant.url, ['realtime', `openai-insecure-api-key.${grant.secret}`]);
        let settled = false;
        socket = ws;
        socketReady = false;
        ws.onopen = () => { settled = true; socketReady = true; reconnects = 0; flushQueue(); setStatus('ready'); resolve(); };
        ws.onmessage = (message) => {
          let event = null;
          try { event = JSON.parse(typeof message.data === 'string' ? message.data : ''); } catch {  }
          if (event) handle(event);
        };
        ws.onerror = () => { if (!settled) { settled = true; reject(new Error('The transcription socket could not open.')); } };
        ws.onclose = () => {
          if (socket === ws) { socket = null; socketReady = false; }
          if (!settled) { settled = true; reject(new Error('The transcription socket closed before it opened.')); return; }
          if (active) reconnectLater();
        };
      });
    })().finally(() => { connecting = null; });
    return connecting;
  }

  function reconnectLater() {
    if (reconnectTimer || !active) return;
    if (reconnects >= RECONNECTS) { onError('realtime-unavailable', 'The transcription connection kept dropping.'); return; }
    reconnects += 1;
    setStatus('connecting');
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (!active) return;
      connect().catch(() => reconnectLater());
    }, 400 * reconnects);
  }

  function describe(cause) {
    const name = cause?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return ['not-allowed', 'The microphone was refused.'];
    return ['audio-capture', cause?.message || 'No microphone is available to this browser.'];
  }

  async function openCapture() {
    capture ||= makeCapture({
      onFrame,
      onEnded: () => { if (active) onDevice({ lost: true }); }
    });
    const info = await capture.start(wanted);
    onDevice({ ...info, wanted });
    return info;
  }

  const api = {
    start() {
      if (active) {
        if (held) {
          held = false;
          ring = [];
          ringMs = 0;
          muteUntil = now() + RESUME_HOLDOFF_MS;
          resetTurn();
        }
        return starting;
      }
      active = true;
      held = false;
      reconnects = 0;
      muteUntil = 0;
      resetTurn();
      setStatus('connecting');
      starting = (async () => {
        const [heard, wire] = await Promise.allSettled([openCapture(), connect()]);
        if (!active) return;
        if (heard.status === 'rejected') {
          active = false;
          await capture?.stop?.();
          const [kind, message] = describe(heard.reason);
          onError(kind, message);
          return;
        }
        if (wire.status === 'rejected') {
          active = false;
          await capture?.stop?.();
          socket?.close?.();
          socket = null;
          onError('realtime-unavailable', wire.reason?.message || 'The transcription service is not reachable.');
        }
      })().finally(() => { starting = null; });
      return starting;
    },

    /** The reply is about to play: stop transcribing, keep measuring. */
    hold() {
      if (!active || held) return;
      held = true;
      barge = initialBarge();
      ring = [];
      ringMs = 0;
      send({ type: 'input_audio_buffer.clear' });
      resetTurn();
      setStatus('ready');
    },

    stop() {
      if (!active && !socket && !capture?.open) return;
      active = false;
      held = false;
      if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
      queue = [];
      queueMs = 0;
      ring = [];
      ringMs = 0;
      const ws = socket;
      socket = null;
      socketReady = false;
      try { ws?.close?.(); } catch {  }
      capture?.stop?.();
      resetTurn();
      setStatus('idle');
    },

    /** Move to another microphone without dropping the session. */
    async setDevice(id) {
      wanted = id || null;
      if (!active || !capture?.open) return null;
      return openCapture().catch((cause) => {
        const [kind, message] = describe(cause);
        onError(kind, message);
        return null;
      });
    },

    get listening() { return active && !held; },
    get held() { return held; },
    get status() { return status; },
    dispose() { api.stop(); capture = null; }
  };
  return api;
}
