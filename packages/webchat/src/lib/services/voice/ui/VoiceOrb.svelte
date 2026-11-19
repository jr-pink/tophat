<script>
  import { onDestroy, onMount } from 'svelte';
  import { createRecogniser, createSpeaker, speechSupported } from '$lib/services/voice/client/speech.js';
  import { createWhisperRecogniser } from '$lib/services/voice/client/whisper-recogniser.js';
  import { createRealtimeRecogniser } from '$lib/services/voice/client/realtime-recogniser.js';
  import { createVoiceEars } from '$lib/services/voice/client/voice-ears.js';
  import { captureSupported } from '$lib/services/voice/client/voice-capture.js';
  import { listInputs, recordingSupported, watchDevices } from '$lib/services/voice/client/dictation-recorder.js';
  import { preferredMic, preferredMicLabel, setPreferredMic, watchPreferredMic } from '$lib/services/voice/client/mic-preference.js';
  import { choosableInputs, deviceLabel } from '$lib/services/voice/core/audio-devices.js';
  import { resolveVoiceMic } from '$lib/services/voice/core/realtime-voice.js';
  import { initialVoice, nextVoice, pendingText } from '$lib/services/voice/core/voice.js';
  import { replyFromItems, speechChunks, spokenText } from '$lib/services/voice/core/spoken.js';
  import { waited } from '$lib/core/waiting.js';

  let {
    items = [],
    running = false,
    onsend = () => {},
    onclosed = () => {},
    speed = 1,
    handsFree = true,
    onsettings = () => {}
  } = $props();

  let voice = $state(initialVoice({ handsFree }));
  let clockMs = $state(Date.now());
  let sentAt = $state(null);
  let audibleAt = $state(null);
  let armed = $state(false);
  let engineName = $state(null);
  // What the transcription session is doing right now ('connecting', 'ready', 'hearing', 'transcribing') and which
  // recogniser is in use; both only label the panel, the state machine owns the conversation.
  let hearing = $state('connecting');
  let ears_engine = $state('realtime');
  let level = $state(0);
  // The microphone list and the choice live in client/mic-preference.js (one setting for the whole app, shared with
  // the dictation button); the panel only mirrors them.
  let devices = $state([]);
  let micId = $state(preferredMic());
  let micLabel = $state('');
  let micNote = $state('');
  let levelAt = 0;
  let appliedDevice = null;

  const open = $derived(voice.state !== 'closed');
  const heard = $derived(pendingText(voice));
  const reply = $derived(spokenText(replyFromItems(items)));
  const stillWaiting = $derived(voice.state === 'waiting' || (voice.state === 'speaking' && !audibleAt));
  const elapsed = $derived(stillWaiting ? waited(sentAt, clockMs) : '');
  const choices = $derived(choosableInputs(devices));
  const vanished = $derived(Boolean(micId) && !devices.some((device) => device.deviceId === micId));

  const listeningLabel = $derived(
    ears_engine === 'whisper' ? 'Listening' : ({
      connecting: 'Connecting',
      hearing: 'Hearing you',
      transcribing: 'Got it'
    }[hearing] || 'Listening')
  );

  const label = $derived({
    listening: heard ? 'Tap to send' : listeningLabel,
    waiting: 'Working',
    speaking: 'Speaking: talk or tap to interrupt',
    idle: 'Tap to talk',
    blocked: 'Tap to retry',
    closed: ''
  }[voice.state] || '');

  let ears = null;
  let mouth = null;
  let wakeLock = null;
  let unwatchDevices = () => {};
  let unwatchPreference = () => {};

  function canListen() {
    return captureSupported() || recordingSupported() || speechSupported();
  }

  function whisperCallbacks() {
    return {
      onPartial: (text) => dispatch({ type: 'partial', text }),
      onFinal: (text) => dispatch({ type: 'final', text }),
      onEnd: () => dispatch({ type: 'recogniser_ended' }),
      onError: (kind) => dispatch(kind === 'unsupported'
        ? { type: 'unsupported', reason: 'This browser cannot listen. Safari or Chrome can.' }
        : { type: 'recogniser_error', kind }),
      onEndpoint: () => dispatch({ type: 'endpoint' })
    };
  }

  function makeWhisper() {
    const deviceId = resolved().deviceId;
    appliedDevice = deviceId;
    // The decoders load weights for about twelve seconds; only the fallback needs them, so they are warmed when it
    // is first wanted and not every time voice mode opens.
    fetch('/api/voice/warm', { method: 'POST' }).catch(() => {});
    if (recordingSupported() && !(typeof window !== 'undefined' && window.__tophatSpeechRecognition)) {
      return createWhisperRecogniser({ ...whisperCallbacks(), deviceId });
    }
    return createRecogniser(whisperCallbacks());
  }

  function makeRealtime({ onUnavailable }) {
    appliedDevice = resolved().deviceId;
    return createRealtimeRecogniser({
      deviceId: appliedDevice,
      onPartial: (text) => dispatch({ type: 'partial', text }),
      onUtterance: (text) => dispatch({ type: 'utterance', text }),
      onBargeIn: () => dispatch({ type: 'barge_in' }),
      onStatus: (next) => { hearing = next; },
      onLevel: (db) => {
        const at = Date.now();
        if (at - levelAt < 80) return;
        levelAt = at;
        level = Math.max(0, Math.min(1, (db + 60) / 50));
      },
      onDevice: (info) => {
        if (info?.lost) { appliedDevice = undefined; refreshDevices(); return; }
        micLabel = info?.label || '';
        refreshDevices();
      },
      onError: (kind, message) => {
        if (kind === 'realtime-unavailable') onUnavailable(message);
        else dispatch({ type: 'recogniser_error', kind });
      }
    });
  }

  function resolved() {
    return resolveVoiceMic({ devices, preferredId: micId, preferredLabel: preferredMicLabel() });
  }

  function adapters() {
    if (!ears) {
      ears = createVoiceEars({
        makeRealtime,
        makeWhisper,
        online: () => captureSupported() && (typeof navigator === 'undefined' || navigator.onLine !== false),
        onEngine: (engine, reason) => {
          ears_engine = engine;
          engineName = engine === 'whisper' ? `Local transcription: ${reason}` : null;
        }
      });
    }
    if (!mouth) {
      mouth = createSpeaker({
        onDone: () => dispatch({ type: 'spoke' }),
        onError: (message) => { engineName = `voice: ${message}`; dispatch({ type: 'spoke' }); },
        onAudible: () => { if (!audibleAt) audibleAt = Date.now(); }
      });
    }
    return { ears, mouth };
  }

  async function refreshDevices() {
    devices = await listInputs();
    applyMic();
  }

  // The choice he made, or what is actually there when that device has gone. A vanished microphone falls back
  // without touching the stored choice, so the same one comes back when it is plugged in again.
  function applyMic() {
    const pick = resolved();
    micNote = pick.fellBack ? 'That microphone is not connected; using another.' : '';
    if (ears && pick.deviceId !== appliedDevice) {
      appliedDevice = pick.deviceId;
      ears.setDevice(pick.deviceId);
    }
  }

  function chooseMic(id) {
    const device = devices.find((entry) => entry.deviceId === id);
    setPreferredMic(id || null, device ? deviceLabel(device) : null);
    micId = id || null;
    applyMic();
  }

  function perform(effect, after) {
    const { ears: mic, mouth: speaker } = adapters();
    switch (effect) {
      case 'listen':
        speaker.stop();
        mic.start();
        break;
      case 'stop_listening':
        mic.stop();
        break;
      case 'send':
        sentAt = new Date().toISOString();
        audibleAt = null;
        armed = false;
        onsend(after.pendingSend);
        break;
      case 'speak':
        // The microphone stops transcribing before the first sound: the reply must not be heard as a question.
        mic.hold();
        speaker.setSpeed(speed);
        speaker.speak(speechChunks(after.reply));
        break;
      case 'stop_speaking':
        speaker.stop();
        break;
      default:
        break;
    }
  }

  function dispatch(input) {
    const { voice: after, effects } = nextVoice(voice, { ...input, now: input.now ?? Date.now() });
    const closing = voice.state !== 'closed' && after.state === 'closed';
    voice = after;
    for (const effect of effects) perform(effect, after);
    if (closing) onclosed();
  }

  export function openFromTap() {
    if (voice.state !== 'closed') return;
    if (!canListen()) {
      voice = { ...voice, state: 'blocked', error: 'This browser cannot listen. Open the chat in Safari or Chrome.' };
      return;
    }
    const { mouth: speaker } = adapters();
    speaker.unlock();
    speaker.setSpeed(speed);
    hearing = 'connecting';
    dispatch({ type: 'open' });
    refreshDevices();
  }

  export function closeFromTap() {
    dispatch({ type: 'close' });
  }

  export function isOpen() {
    return voice.state !== 'closed';
  }

  // A turn is armed once the run has been seen running: a reply is only the reply after the agent has started,
  // and arming on "no reply yet" (as this once did) ended the turn the instant it was sent, so nothing was spoken.
  $effect(() => {
    if (voice.turn && running) armed = true;
  });

  $effect(() => {
    if (!voice.turn || !armed || running) return;
    dispatch({ type: 'turn_ended', reply });
  });

  $effect(() => {
    if (voice.state !== 'waiting' || armed) return;
    const timer = setTimeout(() => {
      if (voice.state === 'waiting' && !armed) {
        engineName = 'that message never reached the server';
        dispatch({ type: 'turn_failed' });
      }
    }, 20_000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (voice.state !== 'speaking' || audibleAt) return;
    const timer = setTimeout(() => {
      if (voice.state === 'speaking' && !audibleAt) {
        engineName = 'voice: the speech engine never made a sound';
        dispatch({ type: 'spoke' });
      }
    }, 15_000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!stillWaiting) return;
    const timer = setInterval(() => { clockMs = Date.now(); }, 1_000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    if (mouth) mouth.setSpeed(speed);
  });

  $effect(() => {
    if (voice.handsFree !== handsFree) dispatch({ type: 'hands_free', on: handsFree });
  });

  $effect(() => {
    if (!open) return;
    let released = false;
    navigator.wakeLock?.request?.('screen')
      .then((lock) => { if (released) lock.release(); else wakeLock = lock; })
      .catch(() => {});
    return () => {
      released = true;
      wakeLock?.release?.().catch(() => {});
      wakeLock = null;
    };
  });

  // The list follows the hardware: plugging a headset in or out re-resolves the choice.
  $effect(() => {
    if (!open) return;
    refreshDevices();
    unwatchDevices = watchDevices(() => refreshDevices());
    unwatchPreference = watchPreferredMic((id) => { micId = id; applyMic(); });
    return () => { unwatchDevices(); unwatchPreference(); };
  });

  const OWNS_SPACE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A']);

  function ownsSpace(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.isContentEditable || OWNS_SPACE.has(node.tagName);
  }

  function keydown(event) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      dispatch({ type: 'close' });
      return;
    }
    if (event.key !== ' ' || ownsSpace(event.target)) return;
    event.preventDefault();
    dispatch({ type: 'tap' });
  }

  onDestroy(() => {
    ears?.dispose();
    mouth?.dispose();
    wakeLock?.release?.().catch(() => {});
  });
</script>

<svelte:window onkeydown={keydown} />

{#if open}
  
  <section
    class="voice"
    data-testid="voice-overlay"
    data-state={voice.state}
    role="dialog"
    aria-modal="true"
    aria-label="Voice mode"
    tabindex="-1"
  >
    <header>
      <button class="quiet press focus-ring" onclick={() => dispatch({ type: 'close' })} data-testid="voice-close" aria-label="Close voice mode">Done</button>
      <span class="engine" data-testid="voice-engine">{engineName || ''}</span>
    </header>

    <button
      class="orb press"
      data-testid="voice-orb"
      data-state={voice.state}
      style:--level={level}
      onclick={() => dispatch({ type: 'tap' })}
      aria-label={label}
    >
      <span class="ring"></span>
      <span class="ring two"></span>
      <span class="core"></span>
    </button>

    <p class="label" data-testid="voice-label">{label}{elapsed ? ` · ${elapsed}` : ''}</p>

    <div class="said" data-testid="voice-transcript">
      {#if voice.state === 'blocked'}
        <span class="warn">{voice.error}</span>
      {:else if heard}
        {heard}
      {:else if voice.state === 'speaking' && voice.reply}
        <span class="dim">{voice.reply}</span>
      {:else if voice.state === 'waiting'}
        <span class="dim">Working on it.</span>
      {:else}
        <span class="dim">Say what you want done. Naming a subagent works: “kick off a researcher on…”.</span>
      {/if}
    </div>

    <footer>
      <label class="row">
        <span>Microphone</span>
        <select
          class="mic"
          data-testid="voice-mic"
          value={micId || ''}
          onchange={(event) => chooseMic(event.currentTarget.value)}
          aria-label="Microphone for voice mode"
        >
          <option value="">Automatic</option>
          {#each choices as device, index (device.deviceId)}
            <option value={device.deviceId}>{deviceLabel(device, index)}</option>
          {/each}
          {#if vanished}
            <option value={micId}>{preferredMicLabel() || 'Chosen microphone'} (not connected)</option>
          {/if}
        </select>
        <span class="value"></span>
      </label>
      {#if micNote || micLabel}
        <p class="note" data-testid="voice-mic-note">{micNote || `Using ${micLabel}`}</p>
      {/if}
      <label class="row">
        <span>Speed</span>
        <input
          type="range"
          min="0.7"
          max="2"
          step="0.1"
          value={speed}
          data-testid="voice-speed"
          oninput={(event) => onsettings({ speed: Number(event.currentTarget.value) })}
          aria-label="Speaking speed"
        />
        <span class="value">{speed.toFixed(1)}×</span>
      </label>
      <label class="row">
        <span>Hands free</span>
        <input
          type="checkbox"
          checked={handsFree}
          data-testid="voice-handsfree"
          onchange={(event) => onsettings({ handsFree: event.currentTarget.checked })}
          aria-label="Keep listening after each reply"
        />
        <span class="value">{handsFree ? 'on' : 'off'}</span>
      </label>
    </footer>
  </section>
{/if}

<style>
  .voice {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    grid-template-rows: auto 1fr auto auto auto;
    justify-items: center;
    gap: 10px;
    
    background: var(--bg);
    padding: max(14px, env(safe-area-inset-top)) 18px max(18px, env(safe-area-inset-bottom));
    
    height: 100dvh;
  }
  header {
    width: 100%;
    display: flex; align-items: center; justify-content: space-between;
    min-height: 34px;
  }
  .quiet {
    height: 34px; padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 17px;
    color: var(--ink-dim);
    font-size: 13px;
    background: transparent;
  }
  .engine {
    font-size: 11.5px;
    color: var(--ink-faint);
    max-width: 60%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .orb {
    align-self: center;
    position: relative;
    width: min(58vw, 220px);
    aspect-ratio: 1;
    border: 0;
    background: transparent;
    display: grid;
    place-items: center;
    
    border-radius: 50%;
  }
  .core, .ring {
    position: absolute;
    inset: 22%;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--accent) 85%, white), var(--accent));
  }
  .ring {
    inset: 8%;
    background: var(--accent-soft);
    opacity: 0;
  }
  .ring.two { inset: 0; }

  
  .orb[data-state='listening'] .core { transform: scale(calc(1 + var(--level, 0) * 0.16)); transition: transform 90ms linear; }
  .orb[data-state='listening'] .ring { animation: pulse 2.1s var(--ease) infinite; opacity: 1; }
  .orb[data-state='listening'] .ring.two { animation-delay: 0.7s; }
  .orb[data-state='speaking'] .core { animation: talk 0.9s ease-in-out infinite; }
  .orb[data-state='waiting'] .core { animation: breathe 1.8s ease-in-out infinite; }
  .orb[data-state='waiting'] .core,
  .orb[data-state='idle'] .core { background: var(--line); }
  .orb[data-state='blocked'] .core { background: var(--warn); }

  @keyframes pulse {
    0% { transform: scale(0.82); opacity: 0.55; }
    100% { transform: scale(1.12); opacity: 0; }
  }
  @keyframes talk {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.07); }
  }
  @keyframes breathe {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .orb .ring, .orb .core { animation: none !important; }
    .orb[data-state='listening'] .ring { opacity: 0.45; }
  }

  .label {
    margin: 0;
    
    width: 100%;
    text-align: center;
    font-size: 13px;
    color: var(--ink-dim);
    letter-spacing: 0.02em;
    
    min-height: 18px;
  }
  .said {
    width: 100%;
    max-width: 34ch;
    text-align: center;
    font-family: var(--serif);
    font-size: 17px;
    line-height: 1.45;
    color: var(--ink);
    
    height: calc(4 * 1.45em);
    overflow: hidden;
  }
  .said .dim { color: var(--ink-faint); }
  .said .warn { color: var(--warn); }

  footer {
    width: 100%;
    max-width: 320px;
    display: grid;
    gap: 8px;
  }
  .row {
    display: grid;
    grid-template-columns: 6.5em 1fr 3em;
    align-items: center;
    gap: 10px;
    font-size: 12.5px;
    color: var(--ink-dim);
    min-height: 34px;
  }
  .row .value { text-align: right; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
  input[type='range'] { width: 100%; accent-color: var(--accent); }
  select.mic {
    min-width: 0;
    width: 100%;
    height: 30px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
    padding: 0 6px;
    text-overflow: ellipsis;
  }
  .note {
    margin: -4px 0 0;
    font-size: 11.5px;
    color: var(--ink-faint);
    text-align: center;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  input[type='checkbox'] { width: 20px; height: 20px; accent-color: var(--accent); justify-self: start; }
</style>
