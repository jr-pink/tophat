<script>
  import { onDestroy } from 'svelte';
  import { createRecogniser, createSpeaker, speechSupported } from '$lib/services/voice/client/speech.js';
  import { createWhisperRecogniser } from '$lib/services/voice/client/whisper-recogniser.js';
  import { recordingSupported } from '$lib/services/voice/client/dictation-recorder.js';
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

  const open = $derived(voice.state !== 'closed');
  const heard = $derived(pendingText(voice));
  const reply = $derived(spokenText(replyFromItems(items)));
  const stillWaiting = $derived(voice.state === 'waiting' || (voice.state === 'speaking' && !audibleAt));
  const elapsed = $derived(stillWaiting ? waited(sentAt, clockMs) : '');

  const label = $derived({
    listening: heard ? 'Tap to send' : 'Listening',
    waiting: 'Working',
    speaking: 'Tap to interrupt',
    idle: 'Tap to talk',
    blocked: 'Tap to retry',
    closed: ''
  }[voice.state] || '');

  
  let ears = null;
  
  let mouth = null;
  let wakeLock = null;

  
  
  
  
  function canListen() {
    return recordingSupported() || speechSupported();
  }

  function makeEars(callbacks) {
    
    
    if (recordingSupported() && !(typeof window !== 'undefined' && window.__tophatSpeechRecognition)) {
      return createWhisperRecogniser(callbacks);
    }
    return createRecogniser(callbacks);
  }

  function adapters() {
    if (!ears) {
      ears = makeEars({
        onPartial: (text) => dispatch({ type: 'partial', text }),
        onFinal: (text) => dispatch({ type: 'final', text }),
        onEnd: () => dispatch({ type: 'recogniser_ended' }),
        onError: (kind) => dispatch(kind === 'unsupported'
          ? { type: 'unsupported', reason: 'This browser cannot listen. Safari or Chrome can.' }
          : { type: 'recogniser_error', kind }),
        onEndpoint: () => dispatch({ type: 'endpoint' })
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
    
    
    fetch('/api/voice/warm', { method: 'POST' }).catch(() => {});
    const { mouth: speaker } = adapters();
    speaker.unlock();
    speaker.setSpeed(speed);
    dispatch({ type: 'open' });
  }

  export function closeFromTap() {
    dispatch({ type: 'close' });
  }

  export function isOpen() {
    return voice.state !== 'closed';
  }

  $effect(() => {
    if (!voice.turn) return;
    if (running || !reply) { armed = true; return; }
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
    grid-template-columns: 5.5em 1fr 3em;
    align-items: center;
    gap: 10px;
    font-size: 12.5px;
    color: var(--ink-dim);
    min-height: 34px;
  }
  .row .value { text-align: right; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
  input[type='range'] { width: 100%; accent-color: var(--accent); }
  input[type='checkbox'] { width: 20px; height: 20px; accent-color: var(--accent); justify-self: start; }
</style>
