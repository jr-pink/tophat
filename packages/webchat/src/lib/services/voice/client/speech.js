

export function recogniserClass() {
  if (typeof window === 'undefined') return null;
  return window.__tophatSpeechRecognition
    || window.SpeechRecognition
    || window.webkitSpeechRecognition
    || null;
}

export function speechSupported() {
  return Boolean(recogniserClass());
}


export function recordingSupported() {
  return typeof window !== 'undefined'
    && typeof window.MediaRecorder === 'function'
    && Boolean(navigator?.mediaDevices?.getUserMedia);
}

export const ENDPOINT_MS = 1_400;

export function createRecogniser({ onPartial, onFinal, onEnd, onError, onEndpoint, endpointMs = ENDPOINT_MS, lang = 'en-US' }) {
  const Recognition = recogniserClass();
  let active = null;
  let silence = null;
  
  
  let stopping = false;

  function clearSilence() {
    if (silence) { clearTimeout(silence); silence = null; }
  }

  function armSilence() {
    clearSilence();
    silence = setTimeout(() => { silence = null; onEndpoint(); }, endpointMs);
  }

  function start() {
    if (!Recognition) { onError('unsupported'); return; }
    
    
    
    if (active) return;
    stopping = false;
    let recognition;
    try {
      recognition = new Recognition();
    } catch {
      onError('unsupported');
      return;
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      
      
      
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript || '';
        if (result.isFinal) {
          const trimmed = text.trim();
          if (trimmed) onFinal(trimmed);
        } else {
          interim += text;
        }
      }
      onPartial(interim.trim());
      
      armSilence();
    };
    recognition.onerror = (event) => {
      const kind = event?.error || 'unknown';
      if (stopping && (kind === 'aborted' || kind === 'no-speech')) return;
      onError(kind);
    };
    recognition.onend = () => {
      if (active === recognition) active = null;
      clearSilence();
      if (stopping) return;
      
      
      onEnd();
    };
    try {
      recognition.start();
      active = recognition;
    } catch {
      
      
      active = null;
    }
  }

  function stop() {
    stopping = true;
    clearSilence();
    const recognition = active;
    active = null;
    if (!recognition) return;
    try { recognition.abort(); } catch {  }
  }

  return {
    start,
    stop,
    get listening() { return Boolean(active); },
    dispose() { stop(); }
  };
}

const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

export function createSpeaker({ onDone, onError, onAudible }) {
  
  let element = null;
  let queue = [];
  let index = 0;
  let speaking = false;
  let generation = 0;
  let speed = 1;
  let engine = null;
  
  const fetched = new Map();

  function audio() {
    if (element) return element;
    element = new Audio();
    element.preload = 'auto';
    
    
    element.setAttribute('playsinline', '');
    return element;
  }

  

  function unlock() {
    const player = audio();
    player.src = SILENCE;
    
    
    return player.play().then(() => { player.pause(); player.currentTime = 0; }).catch(() => {});
  }

  function url(text) {
    const params = new URLSearchParams({ text, speed: String(speed) });
    if (engine) params.set('engine', engine);
    return `/api/voice/speak?${params.toString()}`;
  }

  function prefetch(at, mine) {
    if (at >= queue.length || fetched.has(at)) return;
    const controller = new AbortController();
    const promise = fetch(url(queue[at]), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.error || `The speech engine answered ${response.status}.`);
        }
        return URL.createObjectURL(await response.blob());
      })
      .catch((cause) => {
        if (controller.signal.aborted || mine !== generation) return null;
        throw cause;
      });
    fetched.set(at, { promise, controller });
  }

  function release(at) {
    const entry = fetched.get(at);
    if (!entry) return;
    fetched.delete(at);
    entry.controller.abort();
    entry.promise.then((href) => { if (href) URL.revokeObjectURL(href); }).catch(() => {});
  }

  async function playFrom(mine) {
    const player = audio();
    while (index < queue.length) {
      if (mine !== generation) return;
      prefetch(index, mine);
      
      
      prefetch(index + 1, mine);
      let href;
      try {
        href = await fetched.get(index)?.promise;
      } catch (cause) {
        if (mine !== generation) return;
        speaking = false;
        onError(cause.message);
        return;
      }
      if (mine !== generation) return;
      if (!href) { index += 1; continue; }
      fetched.delete(index);
      try {
        await new Promise((resolve, reject) => {
          player.onended = resolve;
          
          
          
          player.onplaying = () => onAudible?.();
          player.onerror = () => reject(new Error('The audio could not be played.'));
          player.src = href;
          player.playbackRate = speed;
          player.play().catch(reject);
        });
      } catch (cause) {
        URL.revokeObjectURL(href);
        if (mine !== generation) return;
        speaking = false;
        onError(cause.message || 'The audio could not be played.');
        return;
      } finally {
        player.onended = null;
        player.onplaying = null;
        player.onerror = null;
      }
      URL.revokeObjectURL(href);
      index += 1;
    }
    if (mine !== generation) return;
    speaking = false;
    onDone();
  }

  return {
    unlock,
    
    setSpeed(value) {
      speed = Math.min(2.5, Math.max(0.5, Number(value) || 1));
      
      
      if (element) element.playbackRate = speed;
    },
    setEngine(value) { engine = value || null; },
    get speaking() { return speaking; },
    
    speak(chunks) {
      this.stop();
      queue = chunks.filter((chunk) => chunk && chunk.trim());
      index = 0;
      if (!queue.length) { onDone(); return; }
      speaking = true;
      generation += 1;
      playFrom(generation);
    },
    stop() {
      generation += 1;
      speaking = false;
      queue = [];
      index = 0;
      for (const at of [...fetched.keys()]) release(at);
      if (!element) return;
      try {
        element.pause();
        
        
        element.removeAttribute('src');
        element.load();
      } catch {  }
    },
    dispose() { this.stop(); element = null; }
  };
}
