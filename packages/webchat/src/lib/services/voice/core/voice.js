

export const STATES = ['closed', 'idle', 'listening', 'waiting', 'speaking', 'blocked'];


export const EFFECTS = ['listen', 'stop_listening', 'send', 'speak', 'stop_speaking', 'close'];

export function initialVoice({ handsFree = true } = {}) {
  return {
    state: 'closed',
    
    
    
    heard: '',
    
    
    partial: '',
    
    
    handsFree,
    
    reply: '',
    
    error: null,
    
    
    turn: false,
    
    
    
    pendingSend: '',
    
    
    
    listenAt: null,
    
    
    restarts: 0
  };
}


// A recogniser that dies the instant it starts is the shape of a machine with
// no microphone, or a speech service that cannot be reached: restarting it
// costs a fresh microphone grab every time, which is what blinks the recording
// indicator on and off. Restarts further apart than this are the ordinary
// end-of-utterance kind and are not counted.
export const RESTART_WINDOW_MS = 1_200;


export const RESTART_LIMIT = 5;


function stamp(input) {
  const now = Number(input?.now);
  return Number.isFinite(now) ? now : null;
}


function afresh(input) {
  return { listenAt: stamp(input), restarts: 0 };
}


// Count a restart only when the previous listen started inside the window and
// both instants are known; an input with no clock reads as a slow restart.
function cycled(voice, input) {
  const now = stamp(input);
  if (now === null || voice.listenAt === null) return { listenAt: now ?? voice.listenAt, restarts: 0 };
  const quick = now - voice.listenAt < RESTART_WINDOW_MS;
  return { listenAt: now, restarts: quick ? (voice.restarts || 0) + 1 : 0 };
}


export function pendingText(voice) {
  return [voice.heard, voice.partial].map((part) => part.trim()).filter(Boolean).join(' ');
}

function withEffects(state, effects) {
  return { voice: state, effects };
}

// Listen again after the recogniser stopped by itself, unless it has been
// doing that in a tight loop: then say so and stay put, because another start
// would only grab the microphone for a few milliseconds again.
function restart(voice, input, why) {
  if (voice.state !== 'listening') return withEffects(voice, []);
  const counted = cycled(voice, input);
  if (counted.restarts >= RESTART_LIMIT) {
    return withEffects(
      {
        ...voice,
        ...counted,
        restarts: 0,
        state: 'blocked',
        error: `Listening kept stopping the moment it started (${why}). Check the microphone this browser is using, then tap to retry.`
      },
      ['stop_listening']
    );
  }
  return withEffects({ ...voice, ...counted }, ['listen']);
}


export function nextVoice(voice, input) {
  const at = voice.state;
  switch (input.type) {
    
    case 'open': {
      if (at !== 'closed') return withEffects(voice, []);
      
      
      
      
      
      const opened = { ...initialVoice({ handsFree: voice.handsFree }), state: 'listening', ...afresh(input) };
      return withEffects(opened, ['listen']);
    }
    case 'close': {
      if (at === 'closed') return withEffects(voice, []);
      
      
      
      const text = pendingText(voice);
      const effects = ['stop_listening', 'stop_speaking'];
      if (text) effects.push('send');
      return withEffects(
        { ...voice, state: 'closed', heard: '', partial: '', reply: '', pendingSend: text || '' },
        effects
      );
    }

    
    case 'denied':
      return withEffects(
        { ...voice, state: 'blocked', error: input.reason || 'The microphone was refused.' },
        ['stop_listening']
      );
    case 'unsupported':
      return withEffects(
        { ...voice, state: 'blocked', error: input.reason || 'This browser cannot listen.' },
        ['stop_listening']
      );
    case 'retry': {
      if (at !== 'blocked') return withEffects(voice, []);
      return withEffects({ ...voice, state: 'listening', error: null, ...afresh(input) }, ['listen']);
    }

    
    case 'partial': {
      if (at !== 'listening') return withEffects(voice, []);
      
      
      return withEffects({ ...voice, partial: input.text || '', restarts: 0 }, []);
    }
    case 'final': {
      
      
      
      
      
      
      
      
      
      if (at === 'closed') return withEffects(voice, []);
      const heard = [voice.heard, (input.text || '').trim()].filter(Boolean).join(' ');
      return withEffects({ ...voice, heard, partial: '', restarts: 0 }, []);
    }
    case 'recogniser_ended': {
      
      
      
      
      return restart(voice, input, 'ended');
    }
    case 'recogniser_error': {
      if (at !== 'listening') return withEffects(voice, []);
      if (input.kind === 'not-allowed' || input.kind === 'service-not-allowed') {
        return withEffects(
          { ...voice, state: 'blocked', error: 'The microphone was refused. Allow it in Settings and tap to retry.' },
          ['stop_listening']
        );
      }
      
      
      
      if (input.kind === 'audio-capture') {
        return withEffects(
          {
            ...voice,
            state: 'blocked',
            error: 'No microphone reached the browser. Connect one, pick it in the browser, then tap to retry.'
          },
          ['stop_listening']
        );
      }
      return restart(voice, input, input.kind || 'unknown');
    }

    
    case 'endpoint': {
      
      
      
      if (at !== 'listening') return withEffects(voice, []);
      const text = pendingText(voice);
      if (!text) return withEffects(voice, []);
      return withEffects(
        { ...voice, state: 'waiting', heard: '', partial: '', turn: true, pendingSend: text },
        ['stop_listening', 'send']
      );
    }

    
    // The realtime recogniser decides the end of a turn itself (semantic voice activity detection on the server)
    // and hands over the finished transcript in one piece. That is one input rather than final-then-endpoint: the
    // microphone stays open through it, so a correction spoken while the agent is still working goes out too.
    case 'utterance': {
      const text = [voice.heard, (input.text || '').trim()].map((part) => part.trim()).filter(Boolean).join(' ');
      if (!text) return withEffects(voice, []);
      if (at === 'listening' || at === 'waiting') {
        return withEffects(
          { ...voice, state: 'waiting', heard: '', partial: '', turn: true, pendingSend: text, restarts: 0 },
          ['send']
        );
      }
      if (at === 'speaking') {
        return withEffects(
          { ...voice, state: 'waiting', heard: '', partial: '', turn: true, reply: '', pendingSend: text, restarts: 0 },
          ['stop_speaking', 'send']
        );
      }
      return withEffects(voice, []);
    }
    // His voice, over the level that echo cannot reach, while the reply is being spoken: stop talking and listen.
    case 'barge_in': {
      if (at !== 'speaking') return withEffects(voice, []);
      return withEffects({ ...voice, state: 'listening', reply: '', heard: '', partial: '', ...afresh(input) }, ['stop_speaking', 'listen']);
    }

    case 'turn_ended': {
      
      
      if (!voice.turn) return withEffects({ ...voice, turn: false }, []);
      const reply = (input.reply || '').trim();
      if (at === 'closed') return withEffects({ ...voice, turn: false }, []);
      if (!reply) {
        
        
        return voice.handsFree
          ? withEffects({ ...voice, state: 'listening', turn: false }, ['listen'])
          : withEffects({ ...voice, state: 'idle', turn: false }, []);
      }
      return withEffects({ ...voice, state: 'speaking', turn: false, reply }, ['speak']);
    }
    case 'turn_failed': {
      if (!voice.turn) return withEffects(voice, []);
      if (at === 'closed') return withEffects({ ...voice, turn: false }, []);
      return voice.handsFree
        ? withEffects({ ...voice, state: 'listening', turn: false }, ['listen'])
        : withEffects({ ...voice, state: 'idle', turn: false }, []);
    }

    
    case 'spoke': {
      if (at !== 'speaking') return withEffects(voice, []);
      return voice.handsFree
        ? withEffects({ ...voice, state: 'listening', reply: '' }, ['listen'])
        : withEffects({ ...voice, state: 'idle', reply: '' }, []);
    }

    
    case 'tap': {
      
      
      
      if (at === 'speaking') return withEffects({ ...voice, state: 'listening', reply: '' }, ['stop_speaking', 'listen']);
      if (at === 'idle') return withEffects({ ...voice, state: 'listening' }, ['listen']);
      if (at === 'blocked') return withEffects({ ...voice, state: 'listening', error: null }, ['listen']);
      if (at === 'waiting') return withEffects(voice, []);
      if (at === 'listening') {
        const text = pendingText(voice);
        if (!text) return withEffects({ ...voice, state: 'idle' }, ['stop_listening']);
        return withEffects(
          { ...voice, state: 'waiting', heard: '', partial: '', turn: true, pendingSend: text },
          ['stop_listening', 'send']
        );
      }
      return withEffects(voice, []);
    }

    case 'hands_free': {
      const handsFree = Boolean(input.on);
      if (handsFree === voice.handsFree) return withEffects(voice, []);
      
      
      return withEffects({ ...voice, handsFree }, []);
    }

    default:
      return withEffects(voice, []);
  }
}

export function voiceViolations(before, after, input, effects = []) {
  const bad = [];
  if (!STATES.includes(after.state)) bad.push(`unknown state ${after.state}`);

  
  
  if (effects.includes('listen') && effects.includes('speak')) bad.push('listening and speaking in the same step');
  if (after.state === 'speaking' && effects.includes('listen')) bad.push('listening while speaking');
  if (after.state === 'listening' && effects.includes('speak')) bad.push('speaking while listening');

  
  if (effects.includes('send') && !String(after.pendingSend || '').trim()) bad.push('sending nothing');

  
  if (after.state !== 'listening' && effects.includes('listen')) bad.push(`listening while ${after.state}`);
  if (after.state === 'listening' && effects.includes('stop_listening') && !effects.includes('listen')) {
    bad.push('listening state with the microphone released');
  }

  
  
  
  
  
  
  
  
  
  
  
  const revision = input?.type === 'partial' || input?.type === 'final' || input?.type === 'utterance';
  const was = revision ? String(before.partial ? before.heard : pendingText(before)).trim() : pendingText(before);
  if (was) {
    const survives = pendingText(after);
    const sent = effects.includes('send') ? String(after.pendingSend || '') : '';
    const kept = `${survives} ${sent}`;
    for (const word of was.split(/\s+/).filter(Boolean)) {
      if (!kept.includes(word)) { bad.push(`dropped "${word}" on ${input?.type}`); break; }
    }
  }
  return bad;
}
