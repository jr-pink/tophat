

export const LIVE_RUN = new Set(['queued', 'starting', 'thinking', 'running']);

export const STALL_MS = 30_000;


export const ELAPSED_FLOOR_MS = 2_000;


export function isLive({ online = true, connected = false, runState = 'idle' } = {}) {
  return Boolean(online) && Boolean(connected) && LIVE_RUN.has(runState);
}


export function atMs(at) {
  if (at === null || at === undefined) return null;
  if (typeof at === 'number') return Number.isFinite(at) ? at : null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
}


export function elapsedText(ms) {
  if (!Number.isFinite(ms) || ms < ELAPSED_FLOOR_MS) return '';
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}`;
}

/**
 * How long a rest has to last before it counts as the agent having stopped.
 *
 * The same bound as `SAME_TASK_MS` in core/rowstate.js, measured here against a
 * sampled clock instead of between two event timestamps: when he sends into a
 * running turn the runner retires that turn and starts another, and the row
 * reports idle for a few tens of milliseconds in between, which may or may not
 * land in a rendered frame.
 */
export const SAME_TASK_MS = 2_000;

/** When the current stretch of work began, which is what the clock counts from.
 *
 * (eg, if i send a message and have followup corrections then the timer doesn't
 * reset at followup corrections.
 *
 * A reducer rather than a derivation over the transcript, because the
 * transcript does not mark where the agent stopped: an observation of the run
 * state is the only thing that says a stretch ended.
 *
 * Keyed on the conversation, because one pane shows several of them and an
 * anchor carried across a switch would date the new chat from the old one.
 *
 * `restingSince` is what survives the handover: a rest keeps the anchor and
 * only records when it began, and the next live observation decides from how
 * long that rest lasted whether this is the same task. Lazily, on the next
 * start rather than on a timer, since nothing ticks while the agent rests.
 */
export function busyStretch(prev, {
  conversationId = null,
  live = false,
  at = null,
  now = Date.now(),
  graceMs = SAME_TASK_MS
} = {}) {
  const same = prev && prev.conversationId === conversationId;
  const carried = same ? atMs(prev.at) : null;
  if (!live) {
    // An existing `restingSince` is never overwritten, or a second idle
    // observation would restart the grace and it would never expire.
    const restingSince = same ? (atMs(prev.restingSince) ?? now) : now;
    return { conversationId, at: carried, restingSince };
  }
  const restedFor = same && atMs(prev.restingSince) !== null ? now - atMs(prev.restingSince) : 0;
  const stopped = restedFor >= graceMs;
  return { conversationId, at: (stopped ? null : carried) ?? atMs(at), restingSince: null };
}

export function activityOf({
  online = true,
  connected = false,
  runState = 'idle',
  awaitingFirstToken = false,
  linked = false,
  since = null,
  maintenance = false,
  noteAt = null,
  now = Date.now()
} = {}) {
  const live = isLive({ online, connected, runState });
  const compacting = live && Boolean(maintenance);
  
  
  
  
  const startedAt = compacting ? (atMs(noteAt) ?? atMs(since)) : atMs(since);
  const waited = live && startedAt !== null ? Math.max(0, now - startedAt) : null;
  const clock = live ? elapsedText(waited) : '';
  
  
  const stalled = live && !compacting && waited !== null && waited >= STALL_MS;

  const shape = (phase, caret, label, { spinner = false, tone = 'live' } = {}) => ({
    phase,
    caret,
    spinner,
    
    
    tone: stalled && tone === 'live' ? 'warn' : tone,
    label,
    clock,
    text: clock && label ? `${label} ${clock}` : label,
    live,
    stalled,
    waitedMs: waited
  });

  if (!online) return shape('offline', 'hollow', 'offline', { tone: 'warn' });
  if (!connected) return shape('reconnecting', 'hollow', 'reconnecting', { tone: 'warn' });
  if (!live) return shape('idle', 'solid', '', { tone: 'quiet' });

  
  
  
  
  if (compacting) return shape('compacting', 'blink', 'compacting in background', { spinner: true, tone: 'quiet' });

  
  
  if (runState === 'queued') return shape('queued', 'blink', 'sending', { tone: 'quiet' });

  
  
  
  if (!linked) return shape('starting', 'blink', 'starting up', { tone: 'quiet' });

  
  if (runState === 'thinking') return shape('thinking', 'blink', 'thinking', { spinner: true });

  
  
  
  if (awaitingFirstToken) return shape('waiting', 'blink', 'waiting for response', { spinner: true });

  
  
  
  return shape('working', 'blink', 'working', { spinner: true });
}
