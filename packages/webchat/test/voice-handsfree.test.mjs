// Hands-free voice mode: the conversation loop (listening, sending, waiting, speaking, listening), barge-in, the
// transcript filter that keeps silence from becoming a message, the microphone choice and its fallback, and the
// realtime recogniser against a fake socket and a fake microphone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { initialVoice, nextVoice, voiceViolations } from '../src/lib/services/voice/core/voice.js';
import {
  BARGE_DB, BARGE_MS, initialBarge, makeDownsampler, nextBarge, pcmToBase64, resolveVoiceMic, worthSending
} from '../src/lib/services/voice/core/realtime-voice.js';
import { voiceConstraint, audioConstraint } from '../src/lib/services/voice/core/audio-devices.js';
import { createRealtimeRecogniser } from '../src/lib/services/voice/client/realtime-recogniser.js';
import { createVoiceEars } from '../src/lib/services/voice/client/voice-ears.js';

function drive(voice, ...inputs) {
  const log = [];
  for (const input of inputs) {
    const { voice: after, effects } = nextVoice(voice, { now: 1000, ...input });
    const bad = voiceViolations(voice, after, input, effects);
    assert.deepEqual(bad, [], `${input.type}: ${bad.join('; ')}`);
    log.push({ input: input.type, state: after.state, effects });
    voice = after;
  }
  return { voice, log };
}

test('the loop: open listens, an utterance sends, the reply is spoken, then it listens again', () => {
  const { voice, log } = drive(initialVoice({ handsFree: true }),
    { type: 'open' },
    { type: 'partial', text: 'what is the' },
    { type: 'utterance', text: 'what is the weather' },
    { type: 'turn_ended', reply: 'Sunny and cold.' },
    { type: 'spoke' });
  assert.deepEqual(log.map((step) => step.state), ['listening', 'listening', 'waiting', 'speaking', 'listening']);
  assert.deepEqual(log[0].effects, ['listen']);
  assert.deepEqual(log[2].effects, ['send']);
  assert.deepEqual(log[3].effects, ['speak']);
  assert.deepEqual(log[4].effects, ['listen']);
  assert.equal(voice.state, 'listening');
});

test('an utterance sends exactly what was said and the microphone is not released to send it', () => {
  const { log, voice } = drive(initialVoice(), { type: 'open' }, { type: 'utterance', text: '  send the invoice  ' });
  assert.equal(voice.pendingSend, 'send the invoice');
  assert.ok(!log[1].effects.includes('stop_listening'));
});

test('barge-in during the reply stops speaking and listens, and the next utterance is a new turn', () => {
  const { voice, log } = drive(initialVoice(),
    { type: 'open' },
    { type: 'utterance', text: 'tell me a story' },
    { type: 'turn_ended', reply: 'Once upon a time.' },
    { type: 'barge_in' },
    { type: 'utterance', text: 'actually make it short' });
  assert.deepEqual(log[3].effects, ['stop_speaking', 'listen']);
  assert.equal(log[3].state, 'listening');
  assert.deepEqual(log[4].effects, ['send']);
  assert.equal(voice.pendingSend, 'actually make it short');
  assert.equal(voice.turn, true);
});

test('an utterance that lands while the reply is still playing interrupts it and sends', () => {
  const { log } = drive(initialVoice(),
    { type: 'open' }, { type: 'utterance', text: 'one' }, { type: 'turn_ended', reply: 'Answer.' }, { type: 'utterance', text: 'two' });
  assert.deepEqual(log[3].effects, ['stop_speaking', 'send']);
  assert.equal(log[3].state, 'waiting');
});

test('a correction spoken while the agent is working is sent too', () => {
  const { log } = drive(initialVoice(), { type: 'open' }, { type: 'utterance', text: 'one' }, { type: 'utterance', text: 'no, two' });
  assert.deepEqual(log[2].effects, ['send']);
  assert.equal(log[2].state, 'waiting');
});

test('barge-in outside the reply, and utterances when idle or closed, do nothing', () => {
  const closed = initialVoice();
  assert.deepEqual(nextVoice(closed, { type: 'utterance', text: 'hi' }).effects, []);
  const listening = nextVoice(closed, { type: 'open', now: 1 }).voice;
  assert.deepEqual(nextVoice(listening, { type: 'barge_in' }).effects, []);
  const idle = { ...listening, state: 'idle' };
  assert.deepEqual(nextVoice(idle, { type: 'utterance', text: 'hi' }).effects, []);
});

test('with hands-free off the reply ends in idle, not in listening', () => {
  const { voice } = drive(initialVoice({ handsFree: false }),
    { type: 'open' }, { type: 'utterance', text: 'hello' }, { type: 'turn_ended', reply: 'Hi.' }, { type: 'spoke' });
  assert.equal(voice.state, 'idle');
});

test('a turn with no spoken reply goes straight back to listening', () => {
  const { voice, log } = drive(initialVoice(), { type: 'open' }, { type: 'utterance', text: 'do it' }, { type: 'turn_ended', reply: '' });
  assert.equal(voice.state, 'listening');
  assert.deepEqual(log[2].effects, ['listen']);
});

test('closing sends nothing it has not heard, and a denied microphone blocks with a message', () => {
  const closed = drive(initialVoice(), { type: 'open' }, { type: 'close' });
  assert.equal(closed.voice.state, 'closed');
  const blocked = drive(initialVoice(), { type: 'open' }, { type: 'recogniser_error', kind: 'not-allowed' });
  assert.equal(blocked.voice.state, 'blocked');
  assert.match(blocked.voice.error, /refused/);
});

test('silence does not become a message', () => {
  assert.equal(worthSending('', { speechMs: 2000 }), false);
  assert.equal(worthSending('Thank you.', { speechMs: 300 }), false);
  assert.equal(worthSending('Thanks for watching!', { speechMs: 600 }), false);
  assert.equal(worthSending('[music]', { speechMs: 2000 }), false);
  assert.equal(worthSending('okay send it to Sam', { speechMs: 0 }), false);
  assert.equal(worthSending('a', { speechMs: 2000 }), false);
  assert.equal(worthSending('Thank you.', { speechMs: 1200 }), true);
  assert.equal(worthSending('Send the invoice to Sam', { speechMs: 400 }), true);
});

test('the downsampler gives 24 kHz whatever the frame size and agrees with itself across frames', () => {
  const rate = 48_000;
  const wave = Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
  const whole = makeDownsampler(rate)(wave);
  assert.equal(whole.length, 24_000);
  const cut = makeDownsampler(rate);
  const parts = [];
  for (let at = 0; at < wave.length; at += 1000) parts.push(...cut(wave.subarray(at, at + 1000)));
  assert.deepEqual(Int16Array.from(parts), whole);
  const odd = makeDownsampler(44_100)(Float32Array.from({ length: 44_100 }, () => 0.1));
  assert.ok(Math.abs(odd.length - 24_000) <= 1);
  assert.equal(Buffer.from(pcmToBase64(Int16Array.of(1, 2)), 'base64').length, 4);
});

test('his voice over the reply is a barge-in only when it is loud and lasts', () => {
  let state = initialBarge();
  let at = 0;
  const feed = (db) => { at += 43; const step = nextBarge(state, { db, at }); state = step.state; return step.barge; };
  for (let i = 0; i < 40; i += 1) assert.equal(feed(BARGE_DB - 10), false);
  const hits = [];
  for (let i = 0; i < Math.ceil(BARGE_MS / 43) + 1; i += 1) hits.push(feed(BARGE_DB + 10));
  assert.ok(hits.at(-1) || hits.includes(true));
  state = initialBarge();
  at = 0;
  assert.equal(feed(BARGE_DB + 10), false);
  assert.equal(feed(BARGE_DB - 20), false);
  assert.equal(state.loudMs, 0);
});

test('voice opens the microphone with echo cancellation on; dictation keeps it off', () => {
  assert.equal(voiceConstraint(null).audio.echoCancellation, true);
  assert.equal(voiceConstraint('abc').audio.deviceId.exact, 'abc');
  assert.equal(audioConstraint(null).audio.echoCancellation, false);
});

test('the microphone: automatic follows what is there, a chosen one is used, a vanished one falls back', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - MacBook Pro Microphone' },
    { kind: 'audioinput', deviceId: 'mbp', label: 'MacBook Pro Microphone' },
    { kind: 'audioinput', deviceId: 'usb', label: 'Blue Yeti' }
  ];
  assert.equal(resolveVoiceMic({ devices }).fellBack, false);
  assert.equal(resolveVoiceMic({ devices, preferredId: 'usb' }).deviceId, 'usb');
  const gone = resolveVoiceMic({ devices: devices.filter((d) => d.deviceId !== 'usb'), preferredId: 'usb', preferredLabel: 'Blue Yeti' });
  assert.equal(gone.fellBack, true);
  assert.notEqual(gone.deviceId, 'usb');
  const renamed = resolveVoiceMic({ devices: [...devices.slice(0, 2), { kind: 'audioinput', deviceId: 'usb2', label: 'Blue Yeti' }], preferredId: 'usb', preferredLabel: 'Blue Yeti' });
  assert.equal(renamed.deviceId, 'usb2');
  assert.equal(resolveVoiceMic({ devices: [], preferredId: null }).deviceId, null);
});

// ---- the recogniser, against a fake socket and a fake microphone ----

function rig(options = {}) {
  let clock = 10_000;
  const sent = [];
  const out = { utterances: [], partials: [], barges: 0, errors: [], devices: [] };
  let socket = null;
  const frames = { push: null };
  const capture = {
    open: false,
    started: [],
    async start(id) { this.open = true; this.started.push(id); return { label: 'Fake mic', deviceId: id, fellBack: false }; },
    stop() { this.open = false; }
  };
  const recogniser = createRealtimeRecogniser({
    mint: async () => ({ secret: 'ek_test', url: 'wss://example.test/realtime' }),
    makeSocket: (url, protocols) => {
      socket = {
        url, protocols, closed: false,
        send: (text) => sent.push(JSON.parse(text)),
        close() { this.closed = true; }
      };
      queueMicrotask(() => socket.onopen());
      return socket;
    },
    makeCapture: (callbacks) => { frames.push = callbacks.onFrame; capture.callbacks = callbacks; return capture; },
    onUtterance: (text) => out.utterances.push(text),
    onPartial: (text) => out.partials.push(text),
    onBargeIn: () => { out.barges += 1; },
    onError: (kind, message) => out.errors.push([kind, message]),
    onDevice: (info) => out.devices.push(info),
    now: () => clock,
    ...options
  });
  const frame = (db, ms = 43) => {
    clock += ms;
    frames.push({ pcm: new Int16Array(Math.round(24 * ms)), db, at: clock });
  };
  const event = (body) => socket.onmessage({ data: JSON.stringify(body) });
  const appends = () => sent.filter((e) => e.type === 'input_audio_buffer.append').length;
  return { recogniser, sent, out, capture, frame, event, appends, socket: () => socket, tick: (ms) => { clock += ms; } };
}

test('realtime: the client secret, not the key, goes on the socket, and speech ends in one utterance', async () => {
  const r = rig();
  await r.recogniser.start();
  assert.deepEqual(r.socket().protocols, ['realtime', 'openai-insecure-api-key.ek_test']);
  assert.deepEqual(r.capture.started, [null]);
  for (let i = 0; i < 12; i += 1) r.frame(-20);
  assert.equal(r.appends(), 12);
  r.event({ type: 'input_audio_buffer.speech_started' });
  r.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'send the ' });
  r.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'invoice' });
  assert.equal(r.out.partials.at(-1), 'send the invoice');
  r.event({ type: 'input_audio_buffer.speech_stopped' });
  r.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Send the invoice.' });
  assert.deepEqual(r.out.utterances, ['Send the invoice.']);
});

test('realtime: a transcript of nothing, or of a pleasantry over room tone, is not sent', async () => {
  const r = rig();
  await r.recogniser.start();
  for (let i = 0; i < 30; i += 1) r.frame(-60);
  r.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Thank you.' });
  r.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: '' });
  assert.deepEqual(r.out.utterances, []);
});

test('realtime: while the reply plays nothing is sent, and his voice over it is a barge-in with his first words attached', async () => {
  const r = rig();
  await r.recogniser.start();
  r.frame(-20);
  const before = r.appends();
  r.recogniser.hold();
  assert.ok(r.sent.some((e) => e.type === 'input_audio_buffer.clear'));
  for (let i = 0; i < 20; i += 1) r.frame(-55);
  assert.equal(r.appends(), before);
  assert.equal(r.out.barges, 0);
  for (let i = 0; i < 10; i += 1) r.frame(-15);
  assert.equal(r.out.barges, 1);
  assert.ok(r.appends() > before, 'the loud audio went to the server');
  assert.equal(r.recogniser.held, false);
  const after = r.appends();
  r.frame(-15);
  assert.equal(r.appends(), after + 1, 'audio flows again after the barge-in');
});

test('realtime: after the reply the microphone is believed again only once the room has settled', async () => {
  const r = rig();
  await r.recogniser.start();
  r.recogniser.hold();
  r.recogniser.start();
  const before = r.appends();
  r.frame(-15, 100);
  assert.equal(r.appends(), before, 'the tail of the reply is not sent');
  r.tick(600);
  r.frame(-15);
  assert.equal(r.appends(), before + 1);
});

test('realtime: a denied microphone and an unreachable service are reported as such', async () => {
  const denied = rig({ makeCapture: () => ({ open: false, async start() { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); }, stop() {} }) });
  await denied.recogniser.start();
  assert.equal(denied.out.errors[0][0], 'not-allowed');
  const down = rig({ mint: async () => { throw new Error('no key'); } });
  await down.recogniser.start();
  assert.equal(down.out.errors[0][0], 'realtime-unavailable');
  assert.match(down.out.errors[0][1], /no key/);
});

test('realtime: picking another microphone moves the stream without closing the session', async () => {
  const r = rig();
  await r.recogniser.start();
  await r.recogniser.setDevice('usb');
  assert.deepEqual(r.capture.started, [null, 'usb']);
  assert.equal(r.socket().closed, false);
  r.capture.callbacks.onEnded();
  assert.equal(r.out.devices.at(-1).lost, true);
});

test('ears: the realtime session by default, local whisper when it cannot be had, and back after a minute', () => {
  const log = [];
  let now = 0;
  const realtime = { start: () => log.push('rt'), stop: () => log.push('rt-stop'), hold: () => log.push('rt-hold'), dispose() {}, setDevice() {} };
  const whisper = { start: () => log.push('w'), stop: () => log.push('w-stop'), dispose() {}, listening: false };
  const engines = [];
  let unavailable = null;
  const ears = createVoiceEars({
    makeRealtime: ({ onUnavailable }) => { unavailable = onUnavailable; return realtime; },
    makeWhisper: () => whisper,
    onEngine: (engine, reason) => engines.push([engine, reason]),
    now: () => now
  });
  ears.start();
  assert.deepEqual(log, ['rt']);
  unavailable('no network');
  assert.deepEqual(engines.at(-1), ['whisper', 'no network']);
  assert.deepEqual(log.slice(-2), ['rt-stop', 'w']);
  ears.stop();
  ears.start();
  assert.equal(log.at(-1), 'w', 'still on whisper inside the minute');
  now = 61_000;
  ears.stop();
  ears.start();
  assert.equal(log.at(-1), 'rt');
  assert.equal(ears.engine, 'realtime');
  ears.hold();
  assert.equal(log.at(-1), 'rt-hold');
});

test('ears: offline starts on whisper without trying the network', () => {
  const log = [];
  const ears = createVoiceEars({
    makeRealtime: () => { log.push('made-realtime'); return { start() {}, stop() {}, hold() {}, dispose() {} }; },
    makeWhisper: () => ({ start: () => log.push('w'), stop() {}, dispose() {}, listening: false }),
    online: () => false
  });
  ears.start();
  assert.deepEqual(log, ['w']);
});
