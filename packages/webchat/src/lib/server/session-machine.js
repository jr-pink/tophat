

export const PHASES = Object.freeze({
  
  
  IDLE: 'idle',
  
  STARTING: 'starting',
  
  RUNNING: 'running',
  
  INTERRUPTING: 'interrupting',
  
  KILLING: 'killing',
  
  EXHAUSTED: 'exhausted',
});

export const DEADLINES = Object.freeze({
  FIRST_OUTPUT: 'first_output',
  SILENCE: 'silence',
  INTERRUPT_GRACE: 'interrupt_grace',
  KILL_ESCALATION: 'kill_escalation',
  IDLE_SHUTDOWN: 'idle_shutdown',
  
  
  
  
  
  
  
  
  
  SPAWN: 'spawn',
  
  
  
  
  
  
  
  
  
  
  SPAWN_RETRY: 'spawn_retry',
  
  
  
  
  
  
  
  
  TOOL_CEILING: 'tool_ceiling',
  
  COMPACTION: 'compaction',
});

export const DEFAULT_TIMING = Object.freeze({
  
  
  
  
  
  
  
  
  
  
  
  [DEADLINES.FIRST_OUTPUT]: 120_000,
  [DEADLINES.SILENCE]: 600_000,
  [DEADLINES.INTERRUPT_GRACE]: 8_000,
  [DEADLINES.KILL_ESCALATION]: 2_000,
  [DEADLINES.IDLE_SHUTDOWN]: 30 * 60_000,
  
  
  [DEADLINES.TOOL_CEILING]: 660_000,
  
  
  
  
  [DEADLINES.COMPACTION]: 1_800_000,
  
  
  
  [DEADLINES.SPAWN]: 15_000,
  
  
  
  
  [DEADLINES.SPAWN_RETRY]: 500,
});


export const SPAWN_RETRY_MAX = 30_000;


export function retryDelay(failures, timing = DEFAULT_TIMING) {
  const base = timing[DEADLINES.SPAWN_RETRY] ?? DEFAULT_TIMING[DEADLINES.SPAWN_RETRY];
  const grown = base * 2 ** Math.max(0, failures - 1);
  return Math.min(grown, Math.max(base, SPAWN_RETRY_MAX));
}

export const MAX_ESCALATIONS = 3;

export const MAX_REVIVALS = 5;

// How many consecutive failed spawns are tried before the person is told it will not start.
export const MAX_SPAWN_FAILURES = 5;

export const COMPACT_RESERVE = 33_520;
export const COMPACT_MARGIN = 100_000;

export const COMPACT_EARLY_ARM = 300_000;

export const COMPACT_MIN_RECLAIM = 50_000;


export const COMPACT_COMMAND = '/compact';

export function compactArm(window) {
  if (!Number.isFinite(window) || window <= 0) return Infinity;
  
  
  
  
  
  
  const trigger = window - COMPACT_RESERVE;
  const underTrigger = Math.max(Math.floor(trigger / 2), trigger - COMPACT_MARGIN);
  return Math.min(COMPACT_EARLY_ARM, underTrigger);
}

export function reclaimable(state) {
  return state.compactFloor ? state.contextTokens - state.compactFloor : Infinity;
}


export function dueForCompaction(state) {
  return state.phase === PHASES.IDLE
    && state.owed.length === 0
    && !state.compacting
    && !state.maintenance
    && state.contextTokens >= compactArm(state.contextWindow)
    
    
    
    && reclaimable(state) >= COMPACT_MIN_RECLAIM;
}

export const FIRST_OUTPUT_MAX = 600_000;

export const READY_WARMUP = 2;

export function firstOutputMs(state, timing = DEFAULT_TIMING) {
  const cold = timing[DEADLINES.FIRST_OUTPUT] ?? DEFAULT_TIMING[DEADLINES.FIRST_OUTPUT];
  
  
  const base = state.ready ? cold * READY_WARMUP : cold;
  const grown = base * 2 ** Math.max(0, (state.revivals || 1) - 1);
  return Math.min(grown, Math.max(base, FIRST_OUTPUT_MAX));
}

function armBar(next, timing) {
  if (next.compacting) return [];
  const bar = barFor(next, timing);
  return [effect(EFFECTS.SET_DEADLINE, { name: bar.name, ms: bar.ms })];
}


export function barFor(state, timing = DEFAULT_TIMING) {
  return state.everSpoke
    ? { name: DEADLINES.SILENCE, ms: timing[DEADLINES.SILENCE] }
    : { name: DEADLINES.FIRST_OUTPUT, ms: firstOutputMs(state, timing) };
}

export function initialState() {
  return {
    phase: PHASES.IDLE,
    
    
    compacting: false,
    
    
    owed: [],
    
    
    
    
    
    
    
    
    
    
    
    inTurn: 0,
    // Whether the main lane answered since his latest message was handed over (child_answered); a stop before that says so.
    answered: false,
    
    
    
    
    openTools: [],
    
    
    spoke: false,
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    everSpoke: false,
    
    
    
    
    
    ready: false,
    
    
    revivals: 0,
    
    
    terminating: false,
    
    
    
    escalations: 0,
    
    
    
    spawnFailures: 0,
    
    
    
    
    
    
    
    
    
    
    contextTokens: 0,
    contextWindow: 0,
    
    
    
    
    
    
    
    
    
    
    
    
    compactFloor: null,
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    maintenance: false,
    
    
    
    
    warming: false,
    
    
    
    
    
    
    
    pending: [],
  };
}

const clone = (s) => ({
  ...s,
  
  
  
  
  
  contextTokens: Number.isFinite(s.contextTokens) ? s.contextTokens : 0,
  contextWindow: Number.isFinite(s.contextWindow) ? s.contextWindow : 0,
  
  
  
  compactFloor: Number.isFinite(s.compactFloor) ? s.compactFloor : null,
  maintenance: Boolean(s.maintenance),
  owed: [...s.owed],
  openTools: [...s.openTools],
  pending: [...s.pending],
  
  
  
  
  
  
  
  
  
  
  
  inTurn: Number.isInteger(s.inTurn)
    ? s.inTurn
    : (s.phase === PHASES.RUNNING ? Math.max(1, s.owed.length) : 0),
  
  
  escalations: Number.isInteger(s.escalations) ? s.escalations : 0,
  spawnFailures: Number.isInteger(s.spawnFailures) ? s.spawnFailures : 0,
  warming: Boolean(s.warming),
  answered: Boolean(s.answered),
});

function withDeadlines(next, effects, event) {
  if (event?.type === 'deadline_fired') {
    next.pending = next.pending.filter((n) => n !== event.name);
  }
  for (const e of effects) {
    if (e.type === EFFECTS.SET_DEADLINE && !next.pending.includes(e.name)) next.pending.push(e.name);
    if (e.type === EFFECTS.CLEAR_DEADLINE) {
      next.pending = e.name === 'all' ? [] : next.pending.filter((n) => n !== e.name);
    }
  }
  
  
  
  
  
  
  if ([PHASES.IDLE, PHASES.STARTING, PHASES.EXHAUSTED].includes(next.phase)) next.compacting = false;
  
  
  
  
  
  if (!next.owed.includes(COMPACT_COMMAND)) next.maintenance = false;
  
  
  
  
  if (next.phase !== PHASES.STARTING) next.warming = false;
  return [next, effects];
}


const LIVE_PHASES = [PHASES.STARTING, PHASES.RUNNING, PHASES.INTERRUPTING, PHASES.KILLING];

const ENDS_PHASE = Object.freeze({
  [PHASES.STARTING]: [DEADLINES.SPAWN, DEADLINES.SPAWN_RETRY],
  [PHASES.RUNNING]: [
    DEADLINES.FIRST_OUTPUT, DEADLINES.SILENCE, DEADLINES.TOOL_CEILING, DEADLINES.COMPACTION,
  ],
  [PHASES.INTERRUPTING]: [
    DEADLINES.INTERRUPT_GRACE, DEADLINES.TOOL_CEILING, DEADLINES.FIRST_OUTPUT, DEADLINES.SILENCE,
    DEADLINES.COMPACTION,
  ],
  [PHASES.KILLING]: [DEADLINES.KILL_ESCALATION],
});

export function endableBy(state) {
  const candidates = ENDS_PHASE[state.phase] || [];
  const suspended = state.openTools.length || state.compacting
    ? [DEADLINES.FIRST_OUTPUT, DEADLINES.SILENCE]
    : [];
  return candidates.filter((name) => state.pending.includes(name) && !suspended.includes(name));
}

export function violations(state) {
  const out = [];
  if (!Object.values(PHASES).includes(state.phase)) out.push(`unknown phase ${state.phase}`);
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  if (state.phase === PHASES.STARTING && state.owed.length === 0 && !state.warming) {
    out.push('phase starting with nothing owed');
  }
  if (state.phase === PHASES.RUNNING && state.owed.length === 0) {
    out.push('phase running with nothing owed');
  }
  if (state.warming && state.phase !== PHASES.STARTING) {
    out.push(`phase ${state.phase} still marked as warming`);
  }
  if (state.phase === PHASES.IDLE && state.openTools.length) out.push('idle with open tools');
  if (state.phase === PHASES.IDLE && state.spoke) out.push('idle but marked as having spoken');
  
  
  if (state.maintenance && !state.owed.includes(COMPACT_COMMAND)) {
    out.push('maintaining with no compaction owed');
  }
  if (state.maintenance && [PHASES.IDLE, PHASES.EXHAUSTED].includes(state.phase)) {
    out.push(`phase ${state.phase} still marked as maintaining`);
  }
  if (state.owed.filter((t) => t === COMPACT_COMMAND).length > 1) out.push('two compactions queued');
  
  
  
  
  
  
  
  
  
  
  
  
  if (!Number.isFinite(state.contextTokens) || state.contextTokens < 0) out.push('context size is not a count');
  
  
  if (state.compactFloor !== null && (!Number.isFinite(state.compactFloor) || state.compactFloor < 0)) {
    out.push('compaction floor is not a count');
  }
  
  
  
  if (state.compacting && state.pending.some((n) => n === DEADLINES.FIRST_OUTPUT || n === DEADLINES.SILENCE)) {
    out.push('compacting with a silence deadline armed');
  }
  if (state.compacting && [PHASES.IDLE, PHASES.STARTING, PHASES.EXHAUSTED].includes(state.phase)) {
    out.push(`phase ${state.phase} still marked as compacting`);
  }
  if (new Set(state.owed).size !== state.owed.length) out.push('the same message is owed twice');
  
  
  
  
  if (state.inTurn < 0 || state.inTurn > state.owed.length) {
    out.push(`turn carries ${state.inTurn} of ${state.owed.length} owed`);
  }
  if (state.phase === PHASES.RUNNING && state.inTurn < 1) out.push('running but carrying nothing');
  if (new Set(state.openTools).size !== state.openTools.length) out.push('duplicate open tool id');
  if (state.revivals < 0 || state.revivals > MAX_REVIVALS + 1) out.push(`revivals out of range: ${state.revivals}`);
  
  
  
  
  
  
  
  
  
  
  
  if (LIVE_PHASES.includes(state.phase) && !endableBy(state).length) {
    out.push(`phase ${state.phase} has no armed deadline that can end it`
      + `${state.pending.length ? ` (pending: ${state.pending.join(', ')}, none of which acts here)` : ''}`
      + ', so nothing can end it');
  }
  if (new Set(state.pending).size !== state.pending.length) out.push('duplicate pending deadline');
  
  
  
  
  
  
  
  
  
  
  
  
  
  const armed = (name) => state.pending.includes(name);
  
  
  
  
  if (state.everSpoke && armed(DEADLINES.FIRST_OUTPUT)) {
    out.push('first_output is armed on a child that has already answered a turn, so a healthy session can be killed for thinking');
  }
  if (state.spoke && !state.everSpoke) out.push('spoke is set without everSpoke, which should be unreachable');
  if (state.spoke && armed(DEADLINES.FIRST_OUTPUT)) {
    out.push('first_output is still armed after the child has spoken, so a live turn can be killed for silence it already broke');
  }
  if (armed(DEADLINES.FIRST_OUTPUT) && armed(DEADLINES.SILENCE)) {
    out.push('first_output and silence are armed together, so the shorter one decides');
  }
  if (state.openTools.length && (armed(DEADLINES.FIRST_OUTPUT) || armed(DEADLINES.SILENCE))) {
    out.push('a silence deadline is armed while a tool call is open, so a slow command reads as a hang');
  }
  if (!state.openTools.length && armed(DEADLINES.TOOL_CEILING)) {
    out.push('tool_ceiling is armed with no tool open, so nothing it is bounding exists');
  }
  
  
  
  if ([PHASES.IDLE, PHASES.STARTING, PHASES.EXHAUSTED].includes(state.phase) && state.openTools.length) {
    out.push(`open tools in phase ${state.phase}, where no child holds a turn`);
  }
  return out;
}

export function assertInvariants(state, event) {
  const bad = violations(state);
  if (bad.length) {
    throw new Error(`session invariant violated after ${event?.type || 'unknown event'}: ${bad.join('; ')}`);
  }
  return state;
}

const effect = (type, rest = {}) => ({ type, ...rest });


export const EFFECTS = Object.freeze({
  SPAWN: 'spawn',
  DELIVER: 'deliver',
  INJECT: 'inject',
  SIGNAL: 'signal',
  SET_DEADLINE: 'set_deadline',
  CLEAR_DEADLINE: 'clear_deadline',
  EMIT: 'emit',
  
  
  
  
  ABANDON_CHILD: 'abandon_child',
});

function beginSpawn(next, timing) {
  next.phase = PHASES.STARTING;
  
  
  
  
  
  next.compacting = false;
  return [
    effect(EFFECTS.SPAWN, {}),
    effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.SPAWN, ms: timing[DEADLINES.SPAWN] }),
  ];
}

function spawnFailed(next, timing, fatal = false, why = '', refusal = null) {
  
  
  
  
  if (!next.owed.length) {
    next.phase = PHASES.IDLE;
    next.spawnFailures = 0;
    const said = refusal ? [refusalError(refusal, why, null)] : [];
    return [next, [...said, effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' })]];
  }
  next.spawnFailures += 1;
  // A configuration failure is not contention: the same fork fails the same way every time, so
  // retrying it buys nothing and ends in a message about machine load that is simply untrue.
  if (fatal) return spawnUnavailable(next, timing, why, refusal);
  // Retrying a fork this machine will not perform is an unbounded wait, so it has a floor.
  if (next.spawnFailures >= MAX_SPAWN_FAILURES) return spawnUnavailable(next, timing);
  next.phase = PHASES.STARTING;
  return [next, [
    effect(EFFECTS.EMIT, {
      kind: 'run.status',
      content: {
        state: 'starting',
        note: next.spawnFailures === 1
          ? 'The assistant process could not be started; trying again.'
          : `The assistant process still could not be started after ${next.spawnFailures} attempts; trying again.`,
      },
    }),
    
    
    effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.SPAWN }),
    effect(EFFECTS.SET_DEADLINE, {
      name: DEADLINES.SPAWN_RETRY,
      ms: retryDelay(next.spawnFailures, timing),
    }),
  ]];
}

/** The one run.error for a spawn this process refused because a provider is not configured in it
 *  (runner.js). It carries notReady, which retry-wakes.js reads as "no turn could start here", and
 *  names the message that was not delivered; the runner used to emit its own error beside this one,
 *  so a single refusal showed him two. */
function refusalError(refusal, why, abandoned) {
  const quoted = abandoned && abandoned.length > 60 ? `${abandoned.slice(0, 60)}...` : abandoned;
  const reason = why.replace(/^\S+ is not ready: /u, '');
  return effect(EFFECTS.EMIT, {
    kind: 'run.error',
    content: {
      provider: refusal.provider,
      notReady: refusal.notReady,
      ...(abandoned ? { abandoned } : {}),
      message: `This chat's assistant process is not configured in this server process (${reason}), so nothing was started`
        + (abandoned ? ` and "${quoted}" was not delivered. It is still in the transcript; it will go through once that is configured, or switch this chat to another model.` : '.')
        + ' Anything already running was left alone.',
    },
  });
}

function spawnUnavailable(next, timing, why = '', refusal = null) {
  // One message leaves owed and is named in the error, exactly as giveUp does, so nothing is
  // dropped silently; anything typed behind it gets its own bounded set of attempts.
  const abandoned = next.owed.shift() ?? null;
  next.inTurn = 0;
  next.spawnFailures = 0;
  next.revivals = 0;
  next.spoke = false;
  next.openTools = [];
  const quoted = abandoned && abandoned.length > 60 ? `${abandoned.slice(0, 60)}...` : abandoned;
  // giveUp draws the same line.
  const told = refusal
    ? refusalError(refusal, why, abandoned === COMPACT_COMMAND ? null : abandoned)
    : abandoned === COMPACT_COMMAND
    ? effect(EFFECTS.EMIT, {
      kind: 'run.status',
      content: {
        state: 'idle',
        note: `The background compaction failed to start ${MAX_SPAWN_FAILURES} times; this chat will compact the slow way instead.`,
      },
    })
    : effect(EFFECTS.EMIT, {
      kind: 'run.error',
      content: {
        abandoned,
        message: why
          ? `This chat's assistant cannot be started here (${why}), so "${quoted}" was not delivered. `
            + 'It is still in the transcript; it will go through once that is configured, or switch this chat to another model.'
          : `The assistant process could not be started ${MAX_SPAWN_FAILURES} times in a row, so "${quoted}" `
            + 'was not delivered. It is still in the transcript; send it again once this machine is less loaded.',
      },
    });
  if (next.owed.length) return [next, [told, ...beginSpawn(next, timing)]];
  next.phase = PHASES.IDLE;
  return [next, [
    told,
    effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' }),
    effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.IDLE_SHUTDOWN, ms: timing[DEADLINES.IDLE_SHUTDOWN] }),
  ]];
}

function startTurn(next, timing) {
  if (next.revivals >= MAX_REVIVALS) return giveUp(next, timing);
  const text = next.owed[0];
  
  
  const bar = barFor(next, timing);
  next.phase = PHASES.RUNNING;
  next.spoke = false;
  next.openTools = [];
  next.terminating = false;
  next.compacting = false;
  next.revivals += 1;
  next.answered = false;
  
  next.spawnFailures = 0;
  next.escalations = 0;
  
  next.inTurn = 1;
  return [next, [
    effect(EFFECTS.DELIVER, { text }),
    
    
    
    
    effect(EFFECTS.EMIT, { kind: 'run.status', content: { state: 'starting', link: next.ready ? 'ready' : 'cold' } }),
    effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.SPAWN }),
    
    
    
    effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.FIRST_OUTPUT }),
    effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.SILENCE }),
    effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.TOOL_CEILING }),
    effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.COMPACTION }),
    effect(EFFECTS.SET_DEADLINE, { name: bar.name, ms: bar.ms }),
    effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.IDLE_SHUTDOWN, ms: timing[DEADLINES.IDLE_SHUTDOWN] }),
  ]];
}

function warmed(next, timing) {
  next.phase = PHASES.IDLE;
  next.spoke = false;
  next.openTools = [];
  next.inTurn = 0;
  next.spawnFailures = 0;
  return [next, [
    effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.SPAWN }),
    
    
    
    
    effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.IDLE_SHUTDOWN, ms: timing[DEADLINES.IDLE_SHUTDOWN] }),
  ]];
}

function giveUp(next, timing) {
  const abandoned = next.owed.shift() ?? null;
  next.inTurn = 0;
  next.revivals = 0;
  next.spoke = false;
  next.compacting = false;
  next.openTools = [];
  
  
  
  const quoted = abandoned && abandoned.length > 60 ? `${abandoned.slice(0, 60)}...` : abandoned;
  
  
  
  
  const told = abandoned === COMPACT_COMMAND
    ? effect(EFFECTS.EMIT, {
      kind: 'run.status',
      content: {
        state: 'idle',
        note: `The background compaction failed ${MAX_REVIVALS} times; this chat will compact the slow way instead.`,
      },
    })
    : effect(EFFECTS.EMIT, {
      kind: 'run.error',
      content: {
        abandoned,
        message: `The assistant stopped ${MAX_REVIVALS} times in a row on "${quoted}", so it was not delivered. `
          + 'It is still in the transcript, and anything you typed after it is being answered now.',
      },
    });
  
  if (next.owed.length) {
    const [after, effects] = startTurn(next, timing);
    return [after, [told, ...effects]];
  }
  
  
  
  
  
  
  
  
  
  if (abandoned === COMPACT_COMMAND) {
    next.phase = PHASES.IDLE;
    return [next, [
      told,
      effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' }),
      effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.IDLE_SHUTDOWN, ms: timing[DEADLINES.IDLE_SHUTDOWN] }),
    ]];
  }
  next.phase = PHASES.EXHAUSTED;
  
  
  
  
  next.terminating = true;
  return [next, [told, effect(EFFECTS.SIGNAL, { signal: 'SIGTERM' }), effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' })]];
}

function abandonChild(next, timing) {
  next.escalations = 0;
  next.spoke = false;
  next.everSpoke = false;
  next.ready = false;
  next.openTools = [];
  next.terminating = false;
  const stuck = 'That process would not stop even when forced, which usually means it is stuck on a disk or a network mount.';
  const clear = effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' });
  if (!next.owed.length) {
    // Nothing follows, so the status has to settle the run here rather than announce a start that never comes.
    next.phase = PHASES.IDLE;
    const told = effect(EFFECTS.EMIT, {
      kind: 'run.status',
      content: { state: 'idle', note: `${stuck} Leaving it behind; nothing was waiting to be picked up.` },
    });
    return [next, [told, effect(EFFECTS.ABANDON_CHILD, {}), clear]];
  }
  const told = effect(EFFECTS.EMIT, {
    kind: 'run.status',
    content: { state: 'starting', note: `${stuck} Leaving it behind and starting a fresh one.` },
  });
  return [next, [told, effect(EFFECTS.ABANDON_CHILD, {}), clear, ...beginSpawn(next, timing)]];
}

export function transition(state, event, options) {
  const [next, effects] = decide(state, event, options);
  return withDeadlines(next, effects, event);
}

function decide(state, event, { timing = DEFAULT_TIMING } = {}) {
  const next = clone(state);

  switch (event.type) {
    
    
    case 'user_message': {
      const text = event.text;
      
      
      
      if (next.owed.includes(text)) return [next, []];
      next.owed.push(text);

      if (next.phase === PHASES.IDLE) {
        return [next, beginSpawn(next, timing)];
      }
      if (next.phase === PHASES.RUNNING) {
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        next.inTurn += 1;
        next.answered = false;
        const effects = [
          effect(EFFECTS.INJECT, { text }),
          effect(EFFECTS.EMIT, {
            kind: 'run.status',
            content: {
              
              
              
              
              
              
              
              
              
              
              state: 'running',
              note: 'delivered mid-turn',
            },
          }),
        ];
        if (!next.openTools.length) effects.push(...armBar(next, timing));
        return [next, effects];
      }
      
      
      if (next.phase === PHASES.EXHAUSTED) {
        
        next.revivals = 0;
        return [next, beginSpawn(next, timing)];
      }
      return [next, []];
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    case 'warm_requested': {
      if (next.phase !== PHASES.IDLE || next.owed.length) return [next, []];
      next.warming = true;
      return [next, beginSpawn(next, timing)];
    }

    case 'child_spawned': {
      if (next.phase !== PHASES.STARTING) return [next, []];
      
      
      
      if (!next.owed.length) return warmed(next, timing);
      return startTurn(next, timing);
    }

    
    
    
    
    case 'spawn_failed': {
      if (next.phase !== PHASES.STARTING) return [next, []];
      return spawnFailed(next, timing, Boolean(event.fatal), event.fatal ? String(event.reason || '') : '',
        event.fatal && event.notReady ? { notReady: String(event.notReady), provider: event.provider ?? null } : null);
    }

    
    
    case 'child_spoke': {
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      if (next.phase === PHASES.IDLE) {
        return [next, [
          effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.IDLE_SHUTDOWN, ms: timing[DEADLINES.IDLE_SHUTDOWN] }),
        ]];
      }
      if (next.phase !== PHASES.RUNNING) return [next, []];
      next.spoke = true;
      next.everSpoke = true;
      
      
      const doneCompacting = next.compacting
        ? [effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.COMPACTION })]
        : [];
      next.compacting = false;
      if (next.openTools.length) {
        return [next, [
          ...doneCompacting,
          effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.FIRST_OUTPUT }),
          effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.SILENCE }),
          effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.TOOL_CEILING, ms: timing[DEADLINES.TOOL_CEILING] }),
        ]];
      }
      
      
      
      
      
      
      
      
      return [next, [
        ...doneCompacting,
        effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.FIRST_OUTPUT }),
        effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.SILENCE, ms: timing[DEADLINES.SILENCE] }),
      ]];
    }

    case 'tool_started': {
      if (next.phase !== PHASES.RUNNING) return [next, []];
      
      
      
      
      
      
      
      
      
      
      
      if (event.background) {
        next.openTools = next.openTools.filter((id) => id !== event.id);
        if (next.openTools.length) return [next, []];
        return [next, [
          effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.TOOL_CEILING }),
          ...armBar(next, timing),
        ]];
      }
      if (!next.openTools.includes(event.id)) next.openTools.push(event.id);
      
      
      return [next, [
        effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.FIRST_OUTPUT }),
        effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.SILENCE }),
        effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.TOOL_CEILING, ms: timing[DEADLINES.TOOL_CEILING] }),
      ]];
    }

    case 'tool_completed': {
      if (next.phase !== PHASES.RUNNING) return [next, []];
      next.openTools = next.openTools.filter((id) => id !== event.id);
      if (next.openTools.length) return [next, []];
      return [next, [
        effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.TOOL_CEILING }),
        ...armBar(next, timing),
      ]];
    }

    
    
    
    case 'turn_completed': {
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      if (next.phase === PHASES.INTERRUPTING) {
        next.spoke = false;
        next.openTools = [];
        next.terminating = false;
        next.compacting = false;
        next.inTurn = 0;
        if (next.owed.length) {
          const [after, effects] = startTurn(next, timing);
          return [after, [effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' }), ...effects]];
        }
        next.phase = PHASES.IDLE;
        return [next, [
          effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' }),
          effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.IDLE_SHUTDOWN, ms: timing[DEADLINES.IDLE_SHUTDOWN] }),
        ]];
      }
      if (next.phase !== PHASES.RUNNING) return [next, []];
      
      
      
      
      
      const wasMaintenance = next.maintenance;
      next.owed.splice(0, Math.max(1, next.inTurn));
      next.inTurn = 0;
      next.revivals = 0;
      next.spoke = false;
      next.openTools = [];
      next.terminating = false;
      next.compacting = false;
      if (next.owed.length) {
        
        
        
        
        
        
        
        
        
        
        
        
        const [after, effects] = startTurn(next, timing);
        return [after, [effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' }), ...effects]];
      }
      next.phase = PHASES.IDLE;
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      if (!wasMaintenance && dueForCompaction(next)) {
        next.maintenance = true;
        next.owed.push(COMPACT_COMMAND);
        
        
        next.revivals = 0;
        const [after, effects] = startTurn(next, timing);
        return [after, [
          effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' }),
          ...effects,
          
          
          
          
          
          
          effect(EFFECTS.EMIT, {
            kind: 'run.status',
            
            
            
            
            
            content: { state: 'running', maintenance: true, note: 'compacting the context while nothing is waiting' },
          }),
        ]];
      }
      return [next, [
        effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' }),
        effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.IDLE_SHUTDOWN, ms: timing[DEADLINES.IDLE_SHUTDOWN] }),
      ]];
    }

    
    
    
    
    
    case 'child_aborted': {
      if (next.phase !== PHASES.RUNNING) return [next, []];
      next.phase = PHASES.KILLING;
      next.terminating = true;
      return [next, [
        effect(EFFECTS.EMIT, {
          kind: 'run.status',
          content: { state: 'running', note: 'It abandoned that turn; restarting and asking again.' },
        }),
        effect(EFFECTS.SIGNAL, { signal: 'SIGTERM' }),
        effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' }),
        effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.KILL_ESCALATION, ms: timing[DEADLINES.KILL_ESCALATION] }),
      ]];
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    case 'interrupt_requested': {
      if (![PHASES.RUNNING, PHASES.STARTING].includes(next.phase)) return [next, []];
      
      
      
      if (next.phase === PHASES.STARTING && !next.owed.length) return [next, []];
      next.phase = PHASES.INTERRUPTING;
      
      
      
      
      
      const carried = Math.max(1, next.inTurn);
      const abandoned = next.owed.shift() ?? null;
      next.owed.splice(0, carried - 1);
      next.inTurn = 0;
      return [next, [
        effect(EFFECTS.SIGNAL, { signal: 'interrupt' }),
        
        
        // unanswered: the model never answered it.
        effect(EFFECTS.EMIT, { kind: 'run.cancelled', content: { abandoned, ...(abandoned && abandoned !== COMPACT_COMMAND && !next.answered ? { unanswered: true } : {}) } }),
        effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.INTERRUPT_GRACE, ms: timing[DEADLINES.INTERRUPT_GRACE] }),
      ]];
    }

    case 'deadline_fired': {
      const which = event.name;
      if (which === DEADLINES.IDLE_SHUTDOWN) {
        
        if (next.phase !== PHASES.IDLE) return [next, []];
        
        
        
        
        
        
        next.terminating = true;
        return [next, [effect(EFFECTS.SIGNAL, { signal: 'SIGTERM' })]];
      }
      
      if (which === DEADLINES.SPAWN) {
        if (next.phase !== PHASES.STARTING) return [next, []];
        return spawnFailed(next, timing);
      }
      
      
      
      if (which === DEADLINES.SPAWN_RETRY) {
        if (next.phase !== PHASES.STARTING) return [next, []];
        return [next, beginSpawn(next, timing)];
      }
      if (which === DEADLINES.KILL_ESCALATION) {
        if (next.phase !== PHASES.KILLING) return [next, []];
        next.escalations += 1;
        
        
        
        if (next.escalations >= MAX_ESCALATIONS) return abandonChild(next, timing);
        return [next, [
          effect(EFFECTS.EMIT, {
            kind: 'run.status',
            content: {
              state: 'running',
              note: next.owed.length
                ? 'It did not stop when asked; forcing it and picking the message up again.'
                : 'It did not stop when asked; forcing it to stop.',
            },
          }),
          effect(EFFECTS.SIGNAL, { signal: 'SIGKILL' }),
          
          
          
          effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.KILL_ESCALATION, ms: timing[DEADLINES.KILL_ESCALATION] }),
        ]];
      }
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      if (next.compacting && (which === DEADLINES.FIRST_OUTPUT || which === DEADLINES.SILENCE)) {
        return [next, []];
      }
      const ignoresTools = which === DEADLINES.INTERRUPT_GRACE
        || which === DEADLINES.TOOL_CEILING
        || which === DEADLINES.COMPACTION;
      if (!ignoresTools && next.openTools.length) return [next, []];
      if (![PHASES.RUNNING, PHASES.INTERRUPTING].includes(next.phase)) return [next, []];
      next.phase = PHASES.KILLING;
      next.terminating = true;
      // After a stop nothing may be owed; then there is no message to pick up and the note must not say so.
      const note = which === DEADLINES.INTERRUPT_GRACE
        ? (next.owed.length
          ? 'It did not stop when asked; restarting and picking the message up again.'
          : 'It did not stop when asked; forcing it to stop.')
        : which === DEADLINES.TOOL_CEILING
          ? `A tool call has been running for ${Math.round(timing[which] / 60000)} minutes with no result; restarting and asking again.`
          : which === DEADLINES.COMPACTION
            ? `The conversation has been compacting for ${Math.round(timing[which] / 60000)} minutes with no result; restarting and asking again.`
            : `No ${next.spoke ? 'output' : 'first token'} for ${Math.round((which === DEADLINES.FIRST_OUTPUT ? firstOutputMs(next, timing) : timing[which]) / 1000)}s; restarting and asking again.`;
      return [next, [
        effect(EFFECTS.EMIT, { kind: 'run.status', content: { state: 'running', note } }),
        effect(EFFECTS.SIGNAL, { signal: 'SIGTERM' }),
        effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.KILL_ESCALATION, ms: timing[DEADLINES.KILL_ESCALATION] }),
      ]];
    }

    
    
    
    case 'child_exited': {
      const wasTerminating = next.terminating;
      // A kill the machine ordered was announced to the store as "running" (the deadline note); with nothing
      // owed no turn follows to end that, so the exit itself has to say the run is over. Without this the
      // conversation read "running" until the next server start.
      const forcedStop = next.phase === PHASES.KILLING;
      next.spoke = false;


      next.everSpoke = false;
      next.ready = false;
      next.openTools = [];
      next.terminating = false;
      next.compacting = false;
      if (!next.owed.length) {
        next.phase = PHASES.IDLE;
        next.revivals = 0;
        const effects = [effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' })];
        if (forcedStop) {
          effects.push(effect(EFFECTS.EMIT, {
            kind: 'run.status',
            content: { state: 'idle', note: 'It stopped once forced; nothing was waiting to be picked up.' },
          }));
        }
        return [next, effects];
      }
      if (next.phase === PHASES.EXHAUSTED) return [next, [effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' })]];
      const effects = [effect(EFFECTS.CLEAR_DEADLINE, { name: 'all' })];
      if (!wasTerminating) {
        
        
        
        effects.push(effect(EFFECTS.EMIT, {
          kind: 'run.status',
          content: { state: 'starting', note: 'Picking this up again; the last attempt was cut off.' },
        }));
      }
      effects.push(...beginSpawn(next, timing));
      return [next, effects];
    }

    
    
    
    
    
    case 'child_answered': {
      if (next.phase === PHASES.RUNNING) next.answered = true;
      return [next, []];
    }
    case 'context_observed': {
      if (Number.isFinite(event.window) && event.window > 0) next.contextWindow = event.window;
      if (Number.isFinite(event.tokens) && event.tokens > 0) {
        
        
        
        
        
        if (next.compactFloor === 0) next.compactFloor = event.tokens;
        next.contextTokens = event.tokens;
      }
      return [next, []];
    }

    
    
    
    
    case 'child_compacting': {
      if (![PHASES.RUNNING, PHASES.INTERRUPTING].includes(next.phase)) return [next, []];
      const arm = effect(EFFECTS.SET_DEADLINE, {
        name: DEADLINES.COMPACTION, ms: timing[DEADLINES.COMPACTION],
      });
      
      if (next.compacting) return [next, [arm]];
      next.compacting = true;
      return [next, [
        effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.FIRST_OUTPUT }),
        effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.SILENCE }),
        arm,
      ]];
    }

    
    
    
    
    
    
    
    
    case 'child_ready': {
      
      
      if (next.ready) return [next, []];
      next.ready = true;
      
      
      
      
      
      const spokeYet = next.spoke || next.everSpoke;
      const announce = next.phase === PHASES.RUNNING && !spokeYet
        ? [effect(EFFECTS.EMIT, { kind: 'run.status', content: { state: 'starting', link: 'ready' } })]
        : [];
      
      
      
      if (next.phase !== PHASES.RUNNING) return [next, announce];
      if (spokeYet || next.compacting || next.openTools.length) return [next, announce];
      if (!next.pending.includes(DEADLINES.FIRST_OUTPUT)) return [next, announce];
      
      
      
      return [next, [
        ...announce,
        effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.FIRST_OUTPUT }),
        effect(EFFECTS.SET_DEADLINE, { name: DEADLINES.FIRST_OUTPUT, ms: firstOutputMs(next, timing) }),
      ]];
    }

    
    
    case 'child_compacted': {
      if (!next.compacting) return [next, []];
      next.compacting = false;
      
      
      
      next.contextTokens = 0;
      
      
      next.compactFloor = 0;
      const effects = [effect(EFFECTS.CLEAR_DEADLINE, { name: DEADLINES.COMPACTION })];
      if (next.phase === PHASES.RUNNING && !next.openTools.length) effects.push(...armBar(next, timing));
      return [next, effects];
    }

    default:
      return [next, []];
  }
}


export function step(state, event, options) {
  const [next, effects] = transition(state, event, options);
  assertInvariants(next, event);
  return [next, effects];
}
