

export const RUNNING_STATES = new Set(['queued', 'starting', 'thinking', 'running']);


export function blankRow() {
  return {
    runState: 'idle',
    awaitingFirstToken: false,
    
    
    
    
    
    
    linked: false,
    // Where the activity clock counts from: when this stretch of work began,
    // and when the row last went quiet. `stretch()` below keeps them.
    runSince: null,
    restingSince: null,
    note: null,
    noteAt: null,
    
    
    
    maintenance: false,
    
    notableCursor: 0,
    
    readCursor: 0,
    
    forcedUnread: false,
    
    
    mutedRun: false
  };
}

/** How long a rest has to last before the next start counts as a new task.
 *
 * (eg, if i send a message and have followup corrections then the timer doesn't
 * reset at followup corrections.
 *
 * A message sent into a running turn makes the runner retire that turn and
 * start another for the steered text, and the row reads idle in between. Two
 * seconds biases toward carrying the anchor: reading a finished answer and
 * typing a new question takes longer than that, and dropping the anchor
 * mid-task is the thing he complained about.
 */
export const SAME_TASK_MS = 2_000;

function gapMs(from, to) {
  const a = Date.parse(from || '');
  const b = Date.parse(to || '');
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

/**
 * Where the clock counts from, after an event has moved the run state.
 *
 * Only the transitions matter. Staying live keeps the anchor, going to rest
 * writes down when the rest began, and coming back decides from the length of
 * that rest whether this is the same task carrying on. A subagent's events do
 * not move the run state at all (their patches are null), so a chatty child
 * cannot restart the number.
 */
function stretch(row, next, at) {
  const was = RUNNING_STATES.has(row.runState);
  const now = RUNNING_STATES.has(next.runState);
  if (!at) return { runSince: row.runSince ?? null, restingSince: row.restingSince ?? null };
  if (!now) return { runSince: row.runSince ?? null, restingSince: was ? at : (row.restingSince ?? at) };
  if (was) return { runSince: row.runSince ?? at, restingSince: null };
  const rested = gapMs(row.restingSince, at);
  const resuming = Boolean(row.runSince) && rested !== null && rested >= 0 && rested < SAME_TASK_MS;
  return { runSince: resuming ? row.runSince : at, restingSince: null };
}

/** How one event moves the run state, or null when it does not move it. */
export function statePatch(row, event) {
  const content = event.content || {};
  const at = event.at;
  switch (event.kind) {
    case 'message.user': {
      
      
      const running = ['starting', 'thinking', 'running'].includes(row.runState);
      return running
        ? { runState: row.runState, awaitingFirstToken: row.awaitingFirstToken }
        : { runState: 'queued', awaitingFirstToken: true, linked: false };
    }
    
    
    case 'assistant.delta':
      // A subagent's stream says nothing about the main run's state, but it does prove the runner is up: without this the
      // indicator sat on its cold label for the whole of a delegated turn.
      return content.agentId ? { linked: true } : { runState: 'running', awaitingFirstToken: false, linked: true };
    case 'assistant.message':
      return content.agentId ? { linked: true } : { awaitingFirstToken: false, linked: true };
    case 'thinking.delta':
      return { runState: row.runState === 'running' ? row.runState : 'thinking', linked: true };
    case 'tool.started':
      return content.agentId ? { linked: true } : { runState: 'running', awaitingFirstToken: false, linked: true };
    case 'agent.started':
      return content.parentAgentId ? { linked: true } : { runState: 'running', awaitingFirstToken: false, linked: true };
    case 'run.status':
      return {
        runState: content.state,
        
        
        
        
        
        
        linked: content.link === 'ready' ? true : (content.link === 'cold' ? false : row.linked),
        note: content.note || null,
        noteAt: content.note ? at : null,
        
        
        
        
        
        
        
        
        
        maintenance: content.maintenance === true ? true
          : (content.maintenance === false ? false : row.maintenance)
      };
    case 'run.cancelled':
      return { runState: 'cancelled', awaitingFirstToken: false };
    case 'run.error':
      return { runState: 'errored', awaitingFirstToken: false };
    case 'run.completed':
      
      return { runState: 'idle', awaitingFirstToken: false, note: null, noteAt: null, maintenance: false };
    default:
      return null;
  }
}

const NOTABLE = new Set(['assistant.message', 'run.completed', 'run.error', 'hook.fired']);
const ENDINGS = new Set(['run.completed', 'run.error', 'run.cancelled']);

export function readPatch(row, event) {
  const content = event.content || {};
  const cursor = Number.isSafeInteger(event.cursor) ? event.cursor : 0;

  
  if (event.kind === 'message.user') {
    return { readCursor: Math.max(row.readCursor, cursor), forcedUnread: false, mutedRun: false };
  }

  
  
  
  if (event.kind === 'conversation.meta' && content.read !== undefined) {
    if (content.read === false) return { forcedUnread: true, mutedRun: false };
    const mark = Math.max(row.readCursor, Number.isSafeInteger(content.cursor) ? content.cursor : cursor);
    return { readCursor: mark, forcedUnread: false, mutedRun: Boolean(content.muteRun) };
  }

  
  
  if (ENDINGS.has(event.kind) && row.mutedRun) {
    return { readCursor: Math.max(row.readCursor, cursor), notableCursor: row.notableCursor, mutedRun: false };
  }

  if (NOTABLE.has(event.kind) && !content.agentId) return { notableCursor: Math.max(row.notableCursor, cursor) };
  return null;
}


/** The run-state patch with the clock anchor it implies. */
export function runPatch(row, event) {
  const patch = statePatch(row, event);
  if (!patch) return null;
  return { ...patch, ...stretch(row, { ...row, ...patch }, event.at) };
}

export function rowPatch(row, event) {
  const run = runPatch(row, event);
  const read = readPatch(row, event);
  if (!run && !read) return null;
  return { ...(run || {}), ...(read || {}) };
}

export function readMark({ seenCursor = null, head = 0, mute = true, busy = false } = {}) {
  const seen = Number.isSafeInteger(seenCursor) ? Math.max(0, Math.min(seenCursor, head)) : head;
  return { read: true, cursor: seen, muteRun: mute !== false && Boolean(busy) };
}

export function bottomIsAbout({ measured = false, measuredIn = null, conversationId = null, hydrated = false } = {}) {
  if (!conversationId || !hydrated) return false;
  return Boolean(measured) && measuredIn === conversationId;
}

export function unreadOf(row) {
  if (!row) return false;
  return Boolean(row.forcedUnread) || (row.notableCursor || 0) > (row.readCursor || 0);
}

export function isLive(row) {
  return RUNNING_STATES.has(row?.runState);
}

export function indicatorOf(row) {
  if (isLive(row)) return row.mutedRun ? 'live-muted' : 'live';
  return unreadOf(row) ? 'unread' : 'idle';
}
