<script module>
  const claimed = new Set();
  // Clips whose record this machine is writing from the audio it already
  // holds. Their upload is held back rather than cancelled: if the server
  // cannot keep the record, the bytes are still in the outbox and go the old
  // way. It is shared by every mic on the page for the same reason claimed
  // is: a composer opening beside this one replays the outbox as it mounts,
  // and it would upload the recording this one is already keeping.
  const heldBack = new Set();
  // Only one mic on the page opens the microphone ahead of the press.
  let warmedOne = false;
</script>

<script>
  import { onMount } from 'svelte';
  import { readDraft } from '$lib/core/attachments.js';
  import { applySpokenPunctuation, inFlight, initialDictation, nextDictation } from '$lib/services/voice/core/dictation.js';
  import { initialWindow, PARTIAL_MS } from '$lib/services/voice/core/dictation-window.js';
  import { initialStream, streamStep } from '$lib/services/voice/core/dictation-stream.js';
  import { mergeWordTimes } from '$lib/services/voice/core/tapword.js';
  import { HOLD_CEILING_MS, tooShort } from '$lib/services/voice/core/pushtotalk.js';
  import { classifyLevel, levelAdvice, truncated } from '$lib/services/voice/core/audio-levels.js';
  import {
    inputIsSilent, noReplacementInput, recordingHealth, stoppedHealth, switchedInput, worse
  } from '$lib/services/voice/core/dictation-health.js';
  import {
    choosableInputs, conditionMismatch, deviceLabel, labelsHidden,
    MIC_PRIORITY, pickDevice, priorityInput, replacementInput, shortLabel
  } from '$lib/services/voice/core/audio-devices.js';
  import { createRecorder, listInputs, recordingSupported, watchDevices } from '$lib/services/voice/client/dictation-recorder.js';
  import { preferredMic, preferredMicLabel, setPreferredMic, watchPreferredMic } from '$lib/services/voice/client/mic-preference.js';
  import * as outbox from '$lib/services/voice/client/dictation-outbox.js';

  let {
    conversationId = null,
    onbegin = () => {},
    onpartial = () => {},
    oncommit = () => {},
    onextend = () => {},
    // The word times of a finished run, once its clip is on disk: the composer
    // needs them to know which seconds of audio a word in the draft came out
    // of, which is what a tap on that word asks to have decoded again.
    onwords = () => {},
    oncancel = () => {},
    onmeasurement = () => {},
    onpermission = () => {}
  } = $props();

  function measure(type, detail) {
    try { onmeasurement(type, detail); } catch {  }
  }

  let flag = $state(null);
  let machine = $state(initialDictation({ enabled: false }));
  let level = $state({ peak: 0, rms: 0, peakDb: -100, rmsDb: -100, clipped: false });
  let clipped = $state(false);
  let cutShort = $state(null);
  let heldFrom = 0;
  let startedOutside = false;
  // A stop the send asked for. The words still land in the composer; what they
  // must not do is pull focus, because on the phone that opens the keyboard
  // over the conversation he just sent to.
  let stoppedForSend = false;

  let runToken = null;
  let heardText = '';
  // Where every word of this run sits in the recording, accumulated from the
  // previews as they land. The rolling window re-reads seconds it has already
  // read, so the newest decode of a second is the one that stands.
  let runWords = [];
  let liveWindow = initialWindow();
  // The run as the pure reducer sees it: what has been captured, what the
  // server has acknowledged, the window, whether the preview gave up. The
  // component keeps `liveWindow`, `sentSamples` and `partialGaveUp` in step
  // with it because the markup and the stop path read them.
  let stream = initialStream(null);
  const runs = new Map();
  let partialAbort = null;
  let partialTimer = null;
  let partialInFlight = false;
  let partialGaveUp = false;
  // The run this machine is accumulating audio under, and how much of it the
  // server has acknowledged. The server owns that number; the browser rewinds
  // to it after any failure, which is what makes an aborted or duplicated
  // slice harmless.
  let streamRun = null;
  let sentSamples = 0;
  let lastSlice = null;
  let lost = $state(0);
  let recorder = null;
  let sessionId = '';
  let deviceId = '';
  let popover = $state(null);

  let devices = $state([]);
  let preferredId = $state(null);
  // What the priority order chose for him, when he has picked nothing himself.
  // Deliberately NOT written to the stored preference: a stored id is a
  // decision he made, and the moment the throat mic appears the order has to be
  // free to move to it.
  let autoId = $state(null);
  let liveLabel = $state('');
  let deviceNote = $state(null);
  // Whether this recording is actually capturing him. Loud when audio is
  // going missing, silent when the audio is fine and he is only thinking.
  let health = $state(null);
  let loudestDbfs = -Infinity;
  let lastAckAt = 0;
  let ackedSeen = 0;
  let picker = $state(false);
  let ceiling = null;

  const hidden = $derived(labelsHidden(devices));
  const choices = $derived(choosableInputs(devices));
  // What the order resolves to right now, for the pill and the picker row:
  // the same answer `autoChoice()` acts on, dead microphones excluded.
  const auto = $derived(priorityInput({ devices, skip: deadInputs }));
  const pillLabel = $derived(
    liveLabel
      ? shortLabel(liveLabel)
      : (preferredId ? 'Selected mic' : (auto ? `Auto: ${auto.tier}` : 'Default mic'))
  );
  const autoOrder = MIC_PRIORITY.map((entry) => entry.tier).join(', ');
  const mismatch = $derived(conditionMismatch({ label: liveLabel, condition: flag?.condition }));
  const levelState = $derived(classifyLevel({ peakDb: level.peakDb, rmsDb: level.rmsDb, clipping: clipped }));

  const busy = $derived(inFlight(machine).length);
  const failed = $derived(machine.utterances.filter((u) => u.phase === 'failed' || u.uploadError));
  const visible = $derived(Boolean(flag?.enabled));

  function apply(input) {
    const { dictation, effects } = nextDictation(machine, input);
    const blocked = dictation.state === 'blocked' && machine.state !== 'blocked';
    machine = dictation;
    // A refusal explains itself the moment it happens rather than waiting for
    // another press, because the next press is now a retry.
    if (blocked) popover = 'error';
    for (const effect of effects) perform(effect);
  }


  async function perform(effect) {
    if (effect.type === 'start_mic') {
      clipped = false;
      cutShort = null;
      health = null;
      switchedThisRun = false;
      loudestDbfs = -Infinity;
      lastAckAt = Date.now();
      ackedSeen = 0;
      heardText = '';
      runWords = [];
      liveWindow = initialWindow();
      partialGaveUp = false;
      heldFrom = Date.now();
      runToken = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      onbegin(runToken, { atCaret: !startedOutside });
      const started = await mic().start();   
      if (machine.state !== 'recording') {
        await mic().stop();
        if (runToken) { oncancel(runToken); runToken = null; }
        return;
      }
      if (started !== false) { measure('dictation_capture_start', { token: runToken }); startPartials(); }
      else { oncancel(runToken); runToken = null; }
    } else if (effect.type === 'stop_mic') {
      // Everything not yet acknowledged, read before the recorder lets go of
      // the audio: it travels with the request that asks for the transcript.
      lastSlice = recorder?.pcm16k?.(sentSamples) || null;
      stopPartials();
      const clip = recorder?.stop() || null;
      if (clip) capture(clip);
      else if (runToken) { oncancel(runToken); runToken = null; }
    } else if (effect.type === 'upload') {
      if (heldBack.has(effect.id)) return;
      send(effect.id);
    } else if (effect.type === 'insert') {
      const utterance = machine.utterances.find((u) => u.id === effect.id) || null;
      remember({
        id: effect.id,
        asr: effect.text,
        shown: String(utterance?.heard ?? ''),
        at: new Date().toISOString()
      });
      const run = runs.get(effect.id) || null;
      const wanted = run ? run.focus : !startedOutside;
      oncommit(run?.token ?? null, effect.text, { focus: wanted && !(run ? run.forSend : stoppedForSend) });
      runs.delete(effect.id);
    }
  }


  // Called on every poll and every stop. Cheap, pure, and the only place that
  // decides how loudly to speak.
  function checkHealth() {
    if (machine.state !== 'recording') return;
    health = worse(health?.severity === 'loud' ? health : null, recordingHealth({
      elapsedMs: heldFrom ? Date.now() - heldFrom : 0,
      capturedSamples: stream.captured,
      loudestDbfs,
      sinceAckMs: lastAckAt ? Date.now() - lastAckAt : 0,
      acking: Boolean(streamRun),
      gaveUp: partialGaveUp,
      clipped,
      words: heardText ? heardText.split(/\s+/u).filter(Boolean).length : 0
    }));
    // A microphone handing over silence is not something to tell him to fix by
    // hand while the sentence is going missing: move to one that works.
    if (inputIsSilent(health)) recoverInput();
  }

  // THE MICROPHONE WENT DEAD WHILE HE WAS TALKING.
  //
  // The app said the right thing ("the microphone is delivering silence") and
  // did nothing about it. Now it changes device itself, once per run, and says
  // which one it moved to. A recorder refuses to change device mid-recording,
  // so the switch is applied the moment this run stops.
  let deadInputs = $state([]);
  let switchedThisRun = false;
  let pendingDevice = null;

  async function recoverInput() {
    if (switchedThisRun) return;
    switchedThisRun = true;
    const dying = recorder?.deviceId ?? preferredId ?? null;
    const from = shortLabel(liveLabel || preferredMicLabel() || 'That microphone');
    devices = await listInputs();
    const next = replacementInput({
      devices, currentId: dying, currentLabel: liveLabel, tried: deadInputs
    });
    if (dying) deadInputs = [...deadInputs, dying];
    if (!next) {
      // Both messages are loud and `worse` keeps the one already showing, so
      // the diagnosis is replaced rather than merged: what it DID about the
      // silence is the more useful sentence.
      health = noReplacementInput(from);
      measure('dictation_input_dead', { from, deviceId: dying });
      return;
    }
    // A session he never picked in stays automatic: the swap is recorded as
    // the order's current answer, with the dead one excluded from it, rather
    // than stored as a choice he did not make. Otherwise a microphone that
    // went silent once would outrank the throat mic for ever after.
    if (preferredId) preferredId = setPreferredMic(next.deviceId, next.label);
    autoId = preferredId ? null : next.deviceId;
    pendingDevice = next.deviceId;
    if (await recorder?.setDevice?.(next.deviceId)) pendingDevice = null;
    deviceNote = null;
    health = switchedInput(from, shortLabel(next.label));
    measure('dictation_input_switched', { from, to: next.label, deviceId: next.deviceId });
  }

  // The device change that could not happen while the recorder was running.
  async function applyPendingDevice() {
    if (!pendingDevice) return;
    const next = pendingDevice;
    pendingDevice = null;
    liveLabel = '';
    await recorder?.setDevice?.(next);
  }

  function startPartials() {
    stopPartials();
    streamRun = runToken;
    stream = initialStream(runToken);
    sentSamples = 0;
    lastSlice = null;
    partialTimer = setInterval(pollPartial, PARTIAL_MS);
    pollPartial();
  }

  function stopPartials() {
    clearInterval(partialTimer);
    partialTimer = null;
    partialAbort?.abort();
    partialAbort = null;
    partialInFlight = false;
  }

  // The decisions here live in dictation-stream.js, where every interleaving
  // of them is walked by a model check: which range goes next, what a late or
  // failed answer means, when the preview gives up. This function is the part
  // that cannot be walked, the fetch and the clock.
  function feed(event) {
    const [next, effects] = streamStep(stream, event);
    stream = next;
    liveWindow = stream.window;
    partialGaveUp = stream.gaveUp;
    sentSamples = stream.acked;
    if (stream.acked > ackedSeen) { ackedSeen = stream.acked; lastAckAt = Date.now(); }
    checkHealth();
    return effects;
  }

  async function pollPartial() {
    if (machine.state !== 'recording') return;
    // Before the early returns: a recorder delivering nothing never reaches
    // `feed`, and a microphone that has stopped delivering is exactly the case
    // he must be told about.
    checkHealth();
    if (partialInFlight) return;
    const slice = recorder?.pcm16k?.(sentSamples);
    if (!slice?.bytes?.byteLength) return;
    const token = runToken;
    const run = streamRun;
    const effects = feed({ type: 'captured_to', samples: slice.toSample });
    const ask = effects.find((effect) => effect.type === 'poll');
    if (!ask) return;
    partialInFlight = true;
    const controller = new AbortController();
    partialAbort = controller;
    const requestedAt = performance.now();
    try {
      const response = await fetch('/api/voice/transcribe/live', {
        method: 'POST',
        headers: {
          'content-type': 'audio/pcm;rate=16000',
          'x-dictation-run': run,
          'x-dictation-offset': String(slice.fromSample),
          'x-dictation-start': String(ask.startSec),
          'x-dictation-timestamps': '1',
          // Given up on the preview is not given up on the recording: the
          // audio keeps going so the finished transcript is whole.
          ...(ask.decode ? {} : { 'x-dictation-decode': '0' })
        },
        body: slice.bytes,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)])
      });
      const body = await response.json().catch(() => null);
      measure('dictation_decode', { token, windowStartSec: ask.startSec, durationSec: body?.windowSec, sentSec: slice.durationSec, requestedAt, completedAt: performance.now(), status: response.status, text: body?.text, segments: body?.segments || [], provisional: true });
      if (runToken !== token || run !== streamRun) return;
      if (response.ok) {
        // The window's words, moved from the window's own seconds to the
        // recording's. Nothing else on this path reads them.
        runWords = mergeWordTimes(runWords, body?.segments, ask.startSec);
        feed({ type: 'poll_ok', id: ask.id, body });
      } else feed({ type: 'poll_error', id: ask.id, kind: body?.kind || (response.status === 503 ? 'warming' : 'error'), body });
      if (machine.state === 'recording') showPartial(stream.heard);
    } catch {
      // Nothing landed, or nothing we can trust: the same range goes again,
      // because the server's own count of what it holds is what moves it on.
      feed({ type: 'poll_lost', id: ask.id });
    } finally {
      if (partialAbort === controller) {
        partialInFlight = false;
        partialAbort = null;
      }
    }
  }

  function showPartial(words) {
    if (!runToken) return;
    const text = String(words ?? '');
    heardText = text;
    onpartial(runToken, applySpokenPunctuation(text).text);
  }

  













  // Nothing more is wanted from this run: the last slice travels so the record
  // is whole, and the server lets the audio go rather than holding it to a
  // timeout.
  async function releaseRun(run, slice, meta = null, finish = null) {
    if (!run) return { ok: false, body: null };
    try {
      const response = await fetch('/api/voice/transcribe/final', {
        method: 'POST',
        headers: {
          'content-type': 'audio/pcm;rate=16000',
          'x-dictation-run': run,
          'x-dictation-decode': finish ? 'tail' : '0',
          ...(finish ? { 'x-dictation-start': String(finish.startSec) } : {}),
          ...(finish?.whole ? { 'x-dictation-whole': '1' } : {}),
          ...(slice ? { 'x-dictation-offset': String(slice.fromSample) } : {}),
          ...(meta ? { 'x-clip-meta': btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(meta)))) } : {})
        },
        body: slice?.bytes || new ArrayBuffer(0),
        signal: AbortSignal.timeout(finish ? 90_000 : 20_000)
      });
      const body = await response.json().catch(() => null);
      return { ok: response.ok, body };
    } catch {
      return { ok: false, body: null };
    }
  }


  async function finishRun(token, id, run, slice) {
    if (!run) return;
    try {
      const response = await fetch('/api/voice/transcribe/final', {
        method: 'POST',
        headers: {
          'content-type': 'audio/pcm;rate=16000',
          'x-dictation-run': run,
          ...(slice ? { 'x-dictation-offset': String(slice.fromSample) } : {})
        },
        body: slice?.bytes || new ArrayBuffer(0),
        signal: AbortSignal.timeout(90_000)
      });
      const body = await response.json().catch(() => null);
      const text = String(body?.text ?? '').trim();
      measure('dictation_final', {
        token, clipId: id, status: response.status, latencyMs: body?.latencyMs ?? null,
        engine: body?.engine ?? null, model: body?.model ?? null, durationSec: body?.durationSec ?? null
      });
      if (!response.ok || !text) return;
      if (runs.has(id)) runs.get(id).heard = text;
      if (token === runToken) heardText = text;
      // The clip still goes to the outbox for the record; it carries the
      // transcript with it so the same audio is not decoded a second time.
      outbox.noteTranscript(id, {
        text, engine: body?.engine || 'whisper-local', model: body?.model || null,
        latencyMs: body?.latencyMs ?? null
      });
      apply({ type: 'heard', id, text });
      apply({ type: 'transcribed', id, text, engine: body?.engine || 'whisper-local' });
    } catch {  }
  }

  function mic() {
    if (recorder) return recorder;
    recorder = createRecorder({
      deviceId: preferredId ?? autoId,
      onLevel: (reading) => {
        level = typeof reading === 'number'
          ? { peak: reading, rms: reading, peakDb: -100, rmsDb: -100, clipped: false }
          : (reading || { peak: 0, rms: 0, peakDb: -100, rmsDb: -100, clipped: false });
        if (level.clipped) clipped = true;
        if (machine.state === 'recording' && Number.isFinite(level.rmsDb)) {
          loudestDbfs = Math.max(loudestDbfs, level.rmsDb);
        }
        measure('dictation_level', { token: runToken, ...level });
      },
      onError: (kind, message) => apply({ type: kind === 'denied' ? 'denied' : 'unsupported', reason: message }),
      onDevice: ({ label, fellBack, substituted, wanted }) => {
        liveLabel = label || '';
        onpermission();
        refreshDevices();
        if (substituted) {
          deviceNote = `The browser opened ${shortLabel(label)} instead of the microphone you picked. Reconnect it and choose it again.`;
        } else if (fellBack && wanted) {
          deviceNote = 'The microphone you picked was not connected, so this is the system default.';
        } else {
          deviceNote = null;
        }
      }
    });
    return recorder;
  }

  async function refreshDevices() {
    devices = await listInputs();
    const chosen = pickDevice({ devices, preferredId, preferredLabel: preferredMicLabel() });
    if (chosen.reason === 'renamed') {
      // Same microphone, new id. Adopt it silently; being told to choose the
      // iPhone microphone again on every load is not a decision worth asking
      // him for.
      preferredId = setPreferredMic(chosen.deviceId, chosen.label);
      deviceNote = null;
      await recorder?.setDevice?.(preferredId);
      return;
    }
    if (chosen.reason === 'missing') {
      // It is genuinely not here. Hand it back to the priority order and say
      // so once, as a statement rather than an instruction.
      preferredId = setPreferredMic(null);
      deviceNote = chosen.deviceId
        ? `That microphone is not connected. Recording on ${shortLabel(chosen.label)}.`
        : 'That microphone is not connected. Recording on the system default.';
      await useAuto(autoChoice());
      return;
    }
    // NOBODY HAS PICKED, so the order he gave decides: throat mic, then earbuds,
    // then the iPhone, then this machine's own microphone. It is re-run on
    // every `devicechange` and again the moment permission fills the labels
    // in, which is when connecting the throat mic mid-session moves onto it.
    if (chosen.reason === 'priority' || chosen.reason === 'default') {
      await useAuto(autoChoice());
    }
  }

  /** The order's answer, never a microphone that has already gone silent. */
  function autoChoice() {
    return priorityInput({ devices, skip: deadInputs })?.deviceId || null;
  }

  /**
   * Point the recorder at the automatic choice.
   *
   * A recorder refuses to change device mid-recording rather than splitting a
   * clip across two microphones, so a change that arrives during a run is held
   * and applied when it stops, the same way the silence recovery does it.
   */
  async function useAuto(next) {
    if (next === autoId) return;
    autoId = next;
    if (preferredId) return;
    if (!recorder) return;
    if (await recorder.setDevice(next)) return;
    if (next) pendingDevice = next;
  }

  
  async function chooseDevice(id) {
    const named = choices.find((device) => device.deviceId === id);
    const next = setPreferredMic(id, named ? deviceLabel(named, choices.indexOf(named)) : null);
    preferredId = next;
    // Choosing "Automatic" is choosing the order, not the system default: it
    // opens whatever the order resolves to right now.
    autoId = next ? null : autoChoice();
    deviceNote = null;
    liveLabel = '';
    picker = false;
    await mic().setDevice?.(next ?? autoId);
    await mic().probe?.();
  }

  // The same choice made in another chat, another pane or another tab. Only a
  // recorder that already exists is retargeted: creating one here would ask
  // for the microphone in a pane he is not dictating into.
  async function adoptDevice(next) {
    if (next === preferredId) return;
    preferredId = next;
    autoId = next ? null : autoChoice();
    deviceNote = null;
    liveLabel = '';
    await recorder?.setDevice?.(next ?? autoId);
  }


  async function capture(clip) {
    await applyPendingDevice();
    if (tooShort(clip?.durationSec)) {
      health = worse(health, stoppedHealth({ durationSec: clip?.durationSec || 0, heldSec: 0, loudestDbfs }));
      if (runToken) { oncancel(runToken); runToken = null; }
      return;
    }
    const heldSec = heldFrom ? (Date.now() - heldFrom) / 1_000 : null;
    heldFrom = 0;
    cutShort = truncated({ capturedSec: clip?.durationSec, heldSec })
      ? `That recording captured ${clip.durationSec.toFixed(1)}s of the ${heldSec.toFixed(1)}s you held. Say it again.`
      : null;
    health = worse(health, stoppedHealth({
      durationSec: clip?.durationSec,
      heldSec,
      loudestDbfs,
      words: heardText ? heardText.split(/\s+/u).filter(Boolean).length : 0
    }));
    const id = `w-${new Date().toISOString().replace(/[:.]/gu, '-')}-${Math.random().toString(36).slice(2, 10)}`;
    const entry = {
      id,
      sessionId,
      deviceId,
      conversationId,
      at: new Date().toISOString(),
      durationSec: clip.durationSec,
      sampleRate: clip.sampleRate,
      device: clip.device,
      settings: clip.settings || null
    };
    const token = runToken;
    const run = streamRun;
    const slice = lastSlice;
    const windowAtStop = liveWindow;
    lastSlice = null;
    streamRun = null;
    const shown = heardText;
    measure('dictation_audio', { token, clipId: id, durationSec: clip.durationSec, heldSec, sampleRate: clip.sampleRate, device: clip.device, settings: clip.settings || null });
    if (token) runs.set(id, { token, focus: !startedOutside, forSend: stoppedForSend });
    const stopped = token ? feed({ type: 'stop' }) : [];
    const asked = stopped.find((effect) => effect.type === 'finish') || null;
    const words = String(stopped.find((effect) => effect.type === 'commit')?.text ?? '').trim();
    // Held back before the state machine asks for the upload, because this
    // machine is about to write the record from audio it already has.
    if (words) heldBack.add(id);
    // The recording travels to the outbox beside the words rather than ahead of
    // them.
    const queued = outbox.enqueue(entry, clip.blob);
    apply({ type: 'captured', id, at: entry.at, durationSec: clip.durationSec });
    // The button comes up and the words he has been watching are the
    // transcript, there and then. Nothing decodes after a stop that already
    // has words: a second pass costs seconds and rewrites the sentence under
    // him. The exception is a recording the preview never managed to read,
    // where one decode of the held audio is the only thing standing between
    // him and an empty composer.
    if (!token) { await queued; return; }
    if (!words) {
      finishRun(token, id, run, slice);
      await queued;
      return;
    }
    // It is the same sentence growing by its own end, never a rewrite of what
    // he is already reading.
    apply({ type: 'heard', id, text: words });
    apply({ type: 'transcribed', id, text: words, engine: 'whisper-live' });
    // The audio is already on the machine that will keep it, so the record is
    // written there from what it holds. Only if that fails does the recording
    // travel again, through the outbox that exists for exactly this.
    // The transcript rides with the clip either way: if the held-back upload
    // ever does go out, it carries the words so nothing decodes twice.
    const asr = { text: words, engine: 'whisper-live', model: null, latencyMs: 0 };
    outbox.noteTranscript(id, asr);
    const answer = await releaseRun(run, slice, {
      clipId: id,
      sessionId,
      conversationId,
      at: entry.at,
      inputDevice: clip.device,
      deviceId,
      trackSettings: clip.settings || null,
      asr: { ...asr, window: windowAtStop }
    }, asked);
    const landed = answer.ok
      ? feed({ type: 'final_ok', id: asked?.id, body: answer.body })
      : feed({ type: 'final_error', id: asked?.id });
    const kept = Boolean(landed.find((effect) => effect.type === 'keep')?.kept);
    const decoded = answer.ok;
    const whole = String(landed.find((effect) => effect.type === 'extend' || effect.type === 'commit')?.text || words).trim();
    // The end of the sentence was decoded from seconds the preview never read,
    // so its words finish the run's word times. With the clip on disk beside
    // them, a tap on any word in the draft can name the audio behind it.
    const tailFrom = Number.isFinite(answer.body?.startSec) ? answer.body.startSec : 0;
    const timed = mergeWordTimes(runWords, answer.body?.segments, tailFrom);
    runWords = timed;
    if (answer.body?.stored && answer.body?.clip_id && timed.length) {
      try { onwords(token, { clipId: answer.body.clip_id, words: timed }); } catch {  }
    }
    if (whole !== words) {
      // The same sentence, grown by its own end.
      onextend(token, applySpokenPunctuation(whole).text);
      outbox.noteTranscript(id, { ...asr, text: whole });
      rememberWhole(id, whole);
      measure('dictation_tail', { token, clipId: id, preview: words, text: whole });
    }
    // The bytes are in the outbox before anything decides what becomes of
    // them, so the fallback upload and the settle both have something to work
    // with.
    await queued;
    // Settle before the hold comes off, or a replay tick in between uploads
    // the recording this machine has already kept.
    if (kept) {
      await outbox.settle(id);
      heldBack.delete(id);
      return;
    }
    heldBack.delete(id);
    // The stop never landed, so the preview's words are all there is, and they
    // stop where its last poll reached. The recording goes up without them:
    // the decode on the other side reads the whole thing, and the end of the
    // sentence comes back rather than being thrown away twice.
    if (!decoded) outbox.forgetTranscript(id);
    send(id);
  }

  async function send(id) {
    if (claimed.has(id)) return;
    claimed.add(id);
    const entry = outbox.pending().find((item) => item.id === id);
    if (!entry) { claimed.delete(id); return; }
    let blob = null;
    try { blob = await outbox.getBytes(id); } catch { blob = null; }
    if (!blob) {
      claimed.delete(id);
      apply({ type: 'failed', id, reason: 'Those bytes did not survive the reload.' });
      lost += 1;
      await outbox.settle(id);
      return;
    }
    apply({ type: 'stored', id });
    try {
      const body = await outbox.upload(entry, blob);
      await outbox.settle(id);
      if (body.text === null || body.text === undefined) {
        apply({ type: 'failed', id, reason: body.error || 'No words came back.' });
      } else {
        apply({ type: 'transcribed', id, text: body.text, engine: body.engine });
      }
    } catch (cause) {
      outbox.noteAttempt(id, cause.message);
      if (cause.permanent) await outbox.settle(id);
      apply({ type: 'failed', id, reason: cause.message });
    } finally {
      claimed.delete(id);
    }
  }


  // The tail changed what this utterance said, so the record's hypothesis
  // changes with it: the correction row compares what he sent against the
  // whole transcript, not against the half the preview had reached.
  function rememberWhole(id, text) {
    const open = outbox.openUtterances(conversationId);
    if (!open.some((item) => item.id === id)) return;
    outbox.setOpenUtterances(conversationId, open.map((item) => (item.id === id ? { ...item, asr: text } : item)));
  }

  function remember(utterance) {
    const open = outbox.openUtterances(conversationId);
    if (open.some((item) => item.id === utterance.id)) return;
    outbox.setOpenUtterances(conversationId, [...open, {
      id: utterance.id, asr: utterance.asr, shown: utterance.shown || null, at: utterance.at
    }]);
  }

  









  export function noteSent(text) {
    const clips = outbox.openUtterances(conversationId);
    apply({ type: 'sent' });
    if (!clips.length) { outbox.clearConversation(conversationId); return; }
    const steps = [...outbox.trace(conversationId), { t: Date.now(), text: String(text ?? '') }];
    outbox.clearConversation(conversationId);
    fetch('/api/dictation/sent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clips: clips.map((c) => ({ id: c.id, asr: c.asr, shown: c.shown || null })),
        text: String(text ?? ''),
        trace: steps,
        sent_at: new Date().toISOString()
      }),
      keepalive: true
    }).catch(() => {  });
  }

  
  export function openCount() { return outbox.openUtterances(conversationId).length; }


  
  export function available() {
    return Boolean(flag?.enabled) && machine.state !== 'off' && machine.state !== 'blocked';
  }

  export function isRecording() { return machine.state === 'recording'; }

  
  export function holdStart({ fromComposer = false } = {}) {
    if (machine.state !== 'idle') return false;
    startedOutside = !fromComposer;
    stoppedForSend = false;
    apply({ type: 'press' });
    clearTimeout(ceiling);
    ceiling = setTimeout(() => holdStop('ceiling'), HOLD_CEILING_MS);
    return true;
  }

  
  export function holdStop({ send = false } = {}) {
    clearTimeout(ceiling);
    ceiling = null;
    if (machine.state !== 'recording') return false;
    stoppedForSend = Boolean(send);
    apply({ type: 'press' });
    return true;
  }


  // One microphone, warmed once. Every chat pane mounts one of these, and the
  // first words of a sentence are lost while a stream, a context and a resume
  // are set up after the press, so the pane he is actually in opens the
  // microphone ahead of time when permission is already granted. No prompt is
  // raised: a permission that has not been granted yet is left alone.
  async function warmIfAllowed() {
    if (warmedOne || conversationId === 'background-chat-draft') return;
    if (!flag?.enabled || !recordingSupported()) return;
    try {
      const status = await navigator.permissions?.query?.({ name: 'microphone' });
      if (status?.state !== 'granted') return;
    } catch { return; }
    if (warmedOne) return;
    warmedOne = true;
    try { await mic().warm?.(); } catch {  }
  }

  onMount(() => {
    sessionId = new Date().toISOString().replace(/[:.]/gu, '-');
    try {
      deviceId = localStorage.getItem('tophat.dictation.device') || '';
      if (!deviceId) {
        deviceId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        localStorage.setItem('tophat.dictation.device', deviceId);
      }
    } catch { deviceId = 'unknown'; }
    preferredId = preferredMic();
    const unwatchMic = watchPreferredMic((next) => { adoptDevice(next); });

    let alive = true;
    fetch('/api/dictation/flag')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!alive || !body) return;
        flag = body;
        warmIfAllowed();
        if (body.enabled) apply({ type: 'enable' });
        if (body.enabled && !recordingSupported()) {
          apply({ type: 'unsupported', reason: 'This browser cannot record audio.' });
        }
        if (body.enabled) replay();
        if (body.enabled) refreshDevices();
      })
      .catch(() => {  });

    const retry = setInterval(() => { if (flag?.enabled) replay(); }, outbox.RETRY_MS);
    const wake = () => { if (flag?.enabled) replay(); };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    const unwatch = watchDevices(() => { if (flag?.enabled) refreshDevices(); });

    let lastSeen = null;
    const sampler = setInterval(() => {
      if (!flag?.enabled || !outbox.openUtterances(conversationId).length) return;
      const text = readDraft(conversationId);
      if (text === lastSeen) return;
      lastSeen = text;
      outbox.setTrace(conversationId, [...outbox.trace(conversationId), { t: Date.now(), text }]);
    }, 600);

    return () => {
      alive = false;
      clearInterval(retry);
      clearInterval(sampler);
      stopPartials();
      clearTimeout(ceiling);
      ceiling = null;
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      unwatch();
      unwatchMic();
      recorder?.dispose();
      recorder = null;
    };
  });

  async function replay() {
    for (const item of await outbox.replayable()) {
      if (claimed.has(item.id) || heldBack.has(item.id)) continue;
      if (item.lost) {
        lost += 1;
        await outbox.settle(item.id);
        continue;
      }
      if (machine.utterances.some((u) => u.id === item.id)) { send(item.id); continue; }
      apply({ type: 'captured', id: item.id, at: item.at, durationSec: item.durationSec });
    }
  }


  function press() {
    startedOutside = false;
    // Blocked is a thing that happened once, not a verdict. A refused
    // microphone, or one that was still closing when he pressed again, used to
    // leave the button explaining itself forever with no way back; now the
    // press clears it and tries, and it can only block again if it fails
    // again.
    if (machine.state === 'blocked') {
      popover = null;
      apply({ type: 'dismiss' });
    }
    apply({ type: 'press' });
  }

  function dismiss(event) {
    if (event.type === 'keydown' && event.key !== 'Escape') return;
    if (picker) {
      const insidePicker = event.type === 'pointerdown'
        && (event.target?.closest?.('[data-dictation-picker]') || event.target?.closest?.('[data-dictation-device]'));
      if (!insidePicker) picker = false;
    }
    if (!popover) return;
    if (event.type === 'pointerdown') {
      if (event.target?.closest?.('[data-dictation-popover]')) return;
      if (event.target?.closest?.('[data-dictation-trigger]')) return;
    }
    popover = null;
  }
</script>

<svelte:window on:keydown={dismiss} on:pointerdown|capture={dismiss} />

{#if visible}
  <div class="wrap">
    
    <button
      class="devpill press focus-ring"
      class:warn={Boolean(deviceNote || mismatch)}
      class:clipping={levelState === 'clipping'}
      class:hot={levelState === 'hot'}
      data-level={levelState}
      onclick={() => { picker = !picker; popover = null; }}
      data-dictation-device
      data-dictation-trigger
      data-testid="dictate-device"
      data-device={liveLabel || ''}
      aria-haspopup="listbox"
      aria-expanded={picker}
      title={`${liveLabel || 'No microphone opened yet'}${flag?.condition ? ` — condition: ${flag.condition}` : ''}\n${levelAdvice(levelState)}`}
    >
      
      <span
        class="fill"
        style="transform:scaleX({machine.state === 'recording' ? Math.min(1, level.peak) : 0})"
        aria-hidden="true"
      ></span>
      <span class="pilltext">{pillLabel}</span>
    </button>

    <button
      class="dictate press focus-ring"
      class:recording={machine.state === 'recording'}
      class:busy={busy > 0}
      class:blocked={machine.state === 'blocked'}
      onclick={press}
      data-dictation-trigger
      data-testid="dictate"
      data-state={machine.state}
      data-busy={busy}
      aria-pressed={machine.state === 'recording'}
      aria-label={machine.state === 'recording' ? 'Stop dictating' : 'Dictate'}
      title={machine.state === 'recording' ? 'Stop dictating' : 'Dictate'}
    >
      
      {#if busy > 0 && machine.state !== 'recording'}
        <span class="spin" aria-hidden="true"></span>
      {:else}
        
        <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
          <path d="M1.6 7.2v1.6M4.3 5.4v5.2M7 2.9v10.2M9.7 5.4v5.2M12.4 6.4v3.2M14.9 7.4v1.2"
                fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      {/if}
      
      <span class="ring" style="opacity:{machine.state === 'recording' ? Math.min(1, 0.25 + level.peak * 1.6) : 0}" aria-hidden="true"></span>
    </button>

    {#if picker}
      <div class="pick" data-dictation-picker data-testid="dictate-picker" role="listbox" aria-label="Microphone">
        <p class="pickhead">Microphone</p>
        {#if hidden}
          
          <p class="hint">Names appear once you allow the microphone. Record once and they fill in.</p>
        {/if}
        <button
          class="row press"
          class:sel={!preferredId}
          role="option"
          aria-selected={!preferredId}
          data-testid="dictate-device-option"
          onclick={() => chooseDevice(null)}
        >{auto ? `Automatic: ${shortLabel(auto.label)}` : 'Automatic (system default)'}</button>
        {#each choices as device, index (device.deviceId)}
          <button
            class="row press"
            class:sel={preferredId === device.deviceId}
            role="option"
            aria-selected={preferredId === device.deviceId}
            data-testid="dictate-device-option"
            data-device-id={device.deviceId}
            onclick={() => chooseDevice(device.deviceId)}
          >{deviceLabel(device, index)}</button>
        {/each}
        {#if !choices.length}
          <p class="hint">No microphone found.</p>
        {/if}
        <p class="hint" data-testid="dictate-auto-order">Automatic order: {autoOrder}.</p>

        <p class="hint" data-testid="dictate-live">Recording on: {liveLabel || 'nothing opened yet'}</p>
        
        <p class="hint" data-testid="dictate-condition">Condition: {flag?.condition || 'not set'}</p>
        <p class="hint" data-testid="dictate-level">
          Level: {level.rmsDb > -100 ? `${level.rmsDb} dB RMS, peak ${level.peakDb} dB` : 'not measured yet'}
        </p>
        <p class:warnline={levelState === 'clipping' || clipped} class:hint={!(levelState === 'clipping' || clipped)} data-testid="dictate-advice">
          {levelAdvice(clipped ? 'clipping' : levelState)}
        </p>
        {#if deviceNote}<p class="warnline" data-testid="dictate-device-note">{deviceNote}</p>{/if}
        {#if mismatch}<p class="warnline" data-testid="dictate-mismatch">{mismatch}</p>{/if}
      </div>
    {/if}

    {#if machine.state === 'blocked' && popover}
      <div class="pop" data-dictation-popover data-testid="dictate-error" role="alert">
        <p>{machine.error}</p>
        <button class="press" onclick={() => { popover = null; apply({ type: 'dismiss' }); }}>OK</button>
      </div>
    {/if}

    {#if health && health.severity === 'loud'}
      <div class="loud" role="alert" data-testid="dictate-health-alert" data-health={health.code}>
        <span>{health.message}</span>
        <button class="press link" onclick={() => { health = null; }} aria-label="Dismiss">dismiss</button>
      </div>
    {:else if health && health.severity === 'quiet'}
      <span class="note" role="status" data-testid="dictate-health-hint" data-health={health.code}>{health.message}</span>
    {/if}

    {#if clipped || cutShort}
      <span class="alert" data-testid="dictate-level-alert" role="status">
        {#if clipped}
          
          <span class="clipnote" data-testid="dictate-clipped">{levelAdvice('clipping')}</span>
        {/if}
        {#if cutShort}<span class="clipnote" data-testid="dictate-cut-short">{cutShort}</span>{/if}
      </span>
    {/if}

    {#if failed.length || lost}
      <span class="note" data-testid="dictate-note">
        {#if failed.length}
          <button class="press link" onclick={() => failed.forEach((u) => apply({ type: 'retry', id: u.id }))}>
            retry {failed.length} clip{failed.length === 1 ? '' : 's'}
          </button>
        {/if}
        {#if lost}<span class="lostnote">{lost} clip{lost === 1 ? '' : 's'} lost</span>{/if}
      </span>
    {/if}
  </div>
{/if}

<style>
  /* Loud means loud: audio is going missing and he needs to know while it is
     still happening, not after the sentence is lost. */
  .loud {
    display: flex; align-items: center; gap: 8px;
    margin-top: 6px; padding: 6px 10px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--bad, #c0392b) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--bad, #c0392b) 55%, transparent);
    color: var(--ink);
    font-size: 12.5px; line-height: 1.35;
  }
  .loud button { margin-left: auto; font-size: 11.5px; opacity: 0.8; }

  
  .wrap { position: relative; width: 36px; height: 36px; flex: none; }
  .dictate {
    position: relative;
    width: 36px; height: 36px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--ink-dim);
    display: grid; place-items: center;
  }
  .dictate:hover { color: var(--ink); border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .dictate.recording { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 60%, var(--line)); }
  .dictate.blocked { color: var(--warn); }
  .ring {
    position: absolute; inset: -3px;
    border-radius: 50%;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--warn) 60%, transparent);
    pointer-events: none;
    transition: opacity 90ms linear;
  }
  .spin {
    width: 12px; height: 12px; border-radius: 50%;
    border: 1.5px solid var(--line);
    border-top-color: var(--accent);
    animation: dictspin 700ms linear infinite;
  }
  @keyframes dictspin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }
  .pop {
    position: absolute; bottom: 44px; right: 0;
    width: 240px; z-index: 40;
    background: var(--bg-raised); border: 1px solid var(--line);
    border-radius: 10px; padding: 10px 12px;
    font-size: 12.5px; color: var(--ink-dim);
    box-shadow: 0 8px 24px rgb(0 0 0 / 28%);
  }
  .pop p { margin: 0 0 8px; }
  .pop button { color: var(--accent); font-size: 12.5px; }
  .note {
    position: absolute; bottom: 96px; right: 0;
    white-space: nowrap; font-size: 11.5px; color: var(--ink-faint);
  }
  
  .devpill {
    position: absolute; bottom: 40px; right: 0;
    height: 18px; max-width: 148px;
    display: block;
    padding: 0 7px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: var(--bg-raised);
    color: var(--ink-faint);
    font-size: 10.5px; line-height: 16px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .devpill { position: absolute; overflow: hidden; }
  .devpill:hover { color: var(--ink-dim); border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .pilltext { position: relative; z-index: 1; }
  .fill {
    position: absolute; inset: 0;
    transform-origin: left center;
    background: color-mix(in srgb, var(--accent) 26%, transparent);
    transition: transform 60ms linear;
    pointer-events: none;
  }
  .devpill.hot .fill { background: color-mix(in srgb, var(--warn) 26%, transparent); }
  .devpill.hot { color: var(--warn); }
  .devpill.clipping .fill { background: color-mix(in srgb, var(--warn) 48%, transparent); }
  .devpill.clipping { color: var(--warn); border-color: var(--warn); }
  .alert {
    position: absolute; bottom: 62px; right: 0;
    width: 250px; text-align: right;
    font-size: 11px; color: var(--warn); line-height: 1.35;
  }
  .clipnote { display: block; }
  .devpill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, var(--line)); }
  @media (max-width: 560px) { .devpill { max-width: 86px; } }
  .pick {
    position: absolute; bottom: 84px; right: 0;
    width: 252px; z-index: 41;
    background: var(--bg-raised); border: 1px solid var(--line);
    border-radius: 10px; padding: 8px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 28%);
    max-height: 320px; overflow-y: auto;
  }
  .pickhead { margin: 0 0 6px; padding: 0 4px; font-size: 11px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.06em; }
  .pick .row {
    display: block; width: 100%; text-align: left;
    padding: 6px 8px; border-radius: 7px;
    font-size: 12.5px; color: var(--ink-dim);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .pick .row:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--ink); }
  
  .pick .row.sel { color: var(--accent); }
  .pick .row.sel::before { content: '✓'; display: inline-block; width: 14px; }
  .pick .row:not(.sel)::before { content: ''; display: inline-block; width: 14px; }
  .hint { margin: 6px 4px 0; font-size: 11px; color: var(--ink-faint); white-space: normal; }
  .warnline { margin: 6px 4px 0; font-size: 11px; color: var(--warn); white-space: normal; }
  .link { color: var(--accent); font-size: 11.5px; }
  .lostnote { color: var(--warn); margin-left: 6px; }
  
  @media (pointer: coarse) {
    .dictate::after { content: ''; position: absolute; inset: -6px; border-radius: 50%; }
  }
</style>
