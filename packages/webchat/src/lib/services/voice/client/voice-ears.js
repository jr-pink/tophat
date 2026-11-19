// Which recogniser voice mode listens with. The realtime transcription session is the one he wants: it ends a turn
// on meaning, not on a timer. Local whisper stays behind it as the offline fallback, used when the session cannot
// be had (no network, no key on the server, the service refusing), with the reason handed to `onEngine` so the
// panel can say so instead of silently listening worse.

export const RETRY_REALTIME_AFTER_MS = 60_000;

export function createVoiceEars({ makeRealtime, makeWhisper, onEngine = () => {}, onError = () => {}, online = () => true, now = () => Date.now() }) {
  let realtime = null;
  let fallback = null;
  let current = null;
  let failedAt = null;
  let wantedDevice = null;

  function useRealtime() {
    if (failedAt !== null && now() - failedAt < RETRY_REALTIME_AFTER_MS) return false;
    return online();
  }

  function realtimeEars() {
    realtime ||= makeRealtime({
      onUnavailable: (message) => degrade(message),
      onError
    });
    return realtime;
  }

  function whisperEars() {
    fallback ||= makeWhisper(wantedDevice);
    return fallback;
  }

  function degrade(reason) {
    if (current !== 'realtime') return;
    failedAt = now();
    realtime?.stop();
    current = 'whisper';
    onEngine('whisper', reason || 'The realtime transcription service is not reachable.');
    whisperEars().start();
  }

  return {
    get engine() { return current; },
    start() {
      if (current === 'whisper' && !useRealtime()) return whisperEars().start();
      if (useRealtime()) {
        if (current !== 'realtime') { fallback?.stop(); current = 'realtime'; onEngine('realtime', ''); }
        return realtimeEars().start();
      }
      current = 'whisper';
      onEngine('whisper', online() ? 'Using local transcription.' : 'Offline: using local transcription.');
      return whisperEars().start();
    },
    /** Stop transcribing while the reply plays; only the realtime session can still hear a barge-in. */
    hold() { if (current === 'realtime') realtime?.hold(); else fallback?.stop(); },
    stop() {
      realtime?.stop();
      fallback?.stop();
      if (current === 'whisper' && failedAt !== null && now() - failedAt >= RETRY_REALTIME_AFTER_MS) current = null;
    },
    setDevice(id) {
      wantedDevice = id || null;
      if (fallback) {
        const was = fallback.listening;
        fallback.dispose();
        fallback = null;
        if (was) whisperEars().start();
      }
      return realtime?.setDevice?.(wantedDevice);
    },
    get device() { return wantedDevice; },
    dispose() { realtime?.dispose(); fallback?.dispose(); realtime = fallback = null; current = null; }
  };
}
