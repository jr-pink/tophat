

export const DELIVERY_EFFECTS = Object.freeze({
  POST: 'post',
  PERSIST_OUTBOX: 'persist_outbox',
  ARM_RETRY: 'arm_retry',
  CLEAR_RETRY: 'clear_retry',
  APPLY_EVENTS: 'apply_events',
  COLLECT_UPLOAD: 'collect_upload',
  ARM_UPLOAD_PATIENCE: 'arm_upload_patience',
  CLEAR_UPLOAD_PATIENCE: 'clear_upload_patience',
});

export const UPLOAD_PATIENCE_MS = 4000;

export function conversationOf(action) {
  return String(action?.conversation_id ?? action?.conversationId ?? '');
}

function normalizeUpload(upload) {
  if (typeof upload === 'string') return upload ? { id: upload, name: upload, size: null } : null;
  if (!upload?.id) return null;
  return {
    id: String(upload.id),
    name: upload.name ? String(upload.name) : String(upload.id),
    size: Number.isFinite(upload.size) ? upload.size : null,
  };
}

export function normalizeUploads(uploads) {
  return (uploads || []).map(normalizeUpload).filter(Boolean);
}

export function initialDelivery() {
  return {
    
    
    
    outbox: [],
    
    
    
    inflight: {},
    
    cursor: 0,
    
    seen: [],
    online: true,
    connected: false,
    
    
    
    retryArmed: {},
    
    staged: [],
    
    
    released: [],
    
    failedUploads: [],
  };
}

const clone = (s) => ({
  ...s,
  outbox: s.outbox.map((a) => ({ ...a, uploads: (a.uploads || []).map((u) => ({ ...u })) })),
  seen: [...s.seen],
  staged: [...s.staged],
  inflight: { ...s.inflight },
  retryArmed: { ...s.retryArmed },
  released: [...s.released],
  failedUploads: [...s.failedUploads],
});

const effect = (type, rest = {}) => ({ type, ...rest });


export function referencedUploads(state) {
  const out = new Set();
  for (const action of state.outbox) for (const upload of action.uploads || []) out.add(upload.id);
  return out;
}


export function pendingUploadsOf(state, action) {
  return (action?.uploads || []).filter((upload) => !state.staged.includes(upload.id));
}

export function isDeliverable(state, action) {
  if (state.released.includes(action.id)) return true;
  return pendingUploadsOf(state, action).length === 0;
}


export function oldestFor(state, conversationId) {
  return state.outbox.find((a) => conversationOf(a) === String(conversationId)) || null;
}

/** A read marker or a touch is owed too, and the retry notice still sees it through `queued`, but it is not "a message
 * waiting to send", and how many of them are in flight at an instant depends on how many server events one render
 * absorbed.
 */
export function unsentMessages(state) {
  let n = 0;
  for (const action of state.outbox) if ((action.wire || action).op === 'message.send') n += 1;
  return n;
}

export function waitingUploadsByConversation(state) {
  const out = {};
  for (const action of state.outbox) {
    if (isDeliverable(state, action)) continue;
    const cid = conversationOf(action);
    const seen = new Set((out[cid] || []).map((u) => u.id));
    for (const upload of pendingUploadsOf(state, action)) {
      if (seen.has(upload.id)) continue;
      seen.add(upload.id);
      (out[cid] ||= []).push({ ...upload });
    }
  }
  return out;
}

export function deliveryViolations(state) {
  const out = [];
  if (state.cursor < 0) out.push(`negative cursor ${state.cursor}`);
  if (new Set(state.outbox.map((a) => a.id)).size !== state.outbox.length) {
    out.push('the same action is in the outbox twice');
  }
  if (new Set(state.seen).size !== state.seen.length) out.push('duplicate id in seen');

  const claimedBy = new Map();
  for (const [cid, id] of Object.entries(state.inflight)) {
    if (!id) { out.push(`inflight has an empty slot for ${cid}`); continue; }
    if (claimedBy.has(id)) out.push(`${id} is in flight for both ${claimedBy.get(id)} and ${cid}`);
    claimedBy.set(id, cid);
    const posting = state.outbox.find((a) => a.id === id);
    if (!posting) { out.push(`inflight ${id} is not in the outbox`); continue; }
    if (conversationOf(posting) !== cid) {
      out.push(`inflight ${id} is filed under ${cid} but belongs to ${conversationOf(posting)}`);
    }
    
    
    
    if (oldestFor(state, cid)?.id !== id) {
      out.push(`inflight ${id} is not the oldest un-acked action in ${cid}`);
    }
    
    
    if (!state.released.includes(id)) {
      for (const upload of pendingUploadsOf(state, posting)) {
        out.push(`in-flight ${id} names upload ${upload.id}, which is not staged`);
      }
    }
  }

  
  
  
  
  

  
  
  
  
  
  
  if (state.online) {
    for (const cid of new Set(state.outbox.map(conversationOf))) {
      if (state.inflight[cid] || state.retryArmed[cid]) continue;
      const head = oldestFor(state, cid);
      if (head && isDeliverable(state, head)) out.push(`${cid} could post ${head.id} and did not`);
    }
  }

  
  
  
  
  
  
  for (const cid of Object.keys(state.retryArmed)) {
    if (!oldestFor(state, cid)) out.push(`retry armed for ${cid}, which owes nothing`);
  }

  
  
  
  for (const action of state.outbox) {
    if (state.released.includes(action.id)) continue;
    for (const upload of action.uploads || []) {
      if (state.failedUploads.includes(upload.id)) {
        out.push(`${action.id} waits on ${upload.id}, whose bytes failed`);
      }
    }
  }
  return out;
}

function pump(next) {
  if (!next.online) return [];
  const effects = [];
  const considered = new Set();
  for (const action of next.outbox) {
    const cid = conversationOf(action);
    
    
    
    if (considered.has(cid)) continue;
    considered.add(cid);
    
    
    
    if (next.inflight[cid] || next.retryArmed[cid]) continue;
    
    
    
    
    if (!isDeliverable(next, action)) continue;
    next.inflight[cid] = action.id;
    effects.push(effect(DELIVERY_EFFECTS.POST, { action }));
  }
  return effects;
}


function releaseForFailedUploads(next) {
  for (const action of next.outbox) {
    if (next.released.includes(action.id)) continue;
    if ((action.uploads || []).some((u) => next.failedUploads.includes(u.id))) next.released.push(action.id);
  }
}


const blocked = (state) => state.outbox.filter((a) => !isDeliverable(state, a)).map((a) => a.id);

export function deliveryTransition(state, event) {
  const [next, effects] = transition(state, event);
  
  
  
  
  const before = blocked(state);
  const after = blocked(next);
  const patience = [];
  for (const id of after) {
    if (!before.includes(id)) patience.push(effect(DELIVERY_EFFECTS.ARM_UPLOAD_PATIENCE, { actionId: id, ms: UPLOAD_PATIENCE_MS }));
  }
  for (const id of before) {
    if (!after.includes(id)) patience.push(effect(DELIVERY_EFFECTS.CLEAR_UPLOAD_PATIENCE, { actionId: id }));
  }
  return [next, [...patience, ...effects]];
}

function transition(state, event) {
  const next = clone(state);

  switch (event.type) {
    
    
    
    case 'dispatch': {
      if (next.outbox.some((a) => a.id === event.action.id)) return [next, []];
      const action = { ...event.action, uploads: normalizeUploads(event.action.uploads) };
      
      
      
      
      
      next.outbox.push(action);
      releaseForFailedUploads(next);
      return [next, [effect(DELIVERY_EFFECTS.PERSIST_OUTBOX, {}), ...pump(next)]];
    }

    case 'upload_staged': {
      if (!next.staged.includes(event.id)) next.staged.push(event.id);
      
      return [next, pump(next)];
    }

    
    
    
    case 'upload_failed': {
      if (!next.failedUploads.includes(event.id)) next.failedUploads.push(event.id);
      releaseForFailedUploads(next);
      return [next, pump(next)];
    }

    
    
    
    case 'release_action': {
      const waiting = next.outbox.find((a) => a.id === event.id && !isDeliverable(next, a));
      if (!waiting) return [next, []];
      next.released.push(event.id);
      return [next, pump(next)];
    }

    
    case 'collect_uploads': {
      const referenced = referencedUploads(next);
      const collectable = next.staged.filter((id) => !referenced.has(id));
      next.staged = next.staged.filter((id) => referenced.has(id));
      return [next, collectable.map((id) => effect(DELIVERY_EFFECTS.COLLECT_UPLOAD, { id }))];
    }

    
    
    case 'send_ok': {
      const cid = inflightConversation(next, event.id);
      if (cid === null) return [next, []];
      next.outbox = next.outbox.filter((a) => a.id !== event.id);
      delete next.inflight[cid];
      next.released = next.released.filter((id) => id !== event.id);
      const effects = [effect(DELIVERY_EFFECTS.PERSIST_OUTBOX, {})];
      
      
      const [, absorbed] = absorb(next, event.events, { contiguous: false });
      effects.push(...absorbed);
      effects.push(effect(DELIVERY_EFFECTS.CLEAR_RETRY, { conversationId: cid }));
      delete next.retryArmed[cid];
      return [next, [...effects, ...pump(next)]];
    }

    
    
    
    
    case 'send_failed': {
      const cid = inflightConversation(next, event.id);
      if (cid === null) return [next, []];
      delete next.inflight[cid];
      next.retryArmed[cid] = true;
      return [next, [effect(DELIVERY_EFFECTS.ARM_RETRY, { conversationId: cid })]];
    }

    // The server has read this exact body and refused it: a 400 from the action route, a 409
    // from a conversation that will not take it. Retrying it is not resilience, it is a loop. A
    // refusal is terminal for the action and only for the action: it leaves the outbox so the
    // rest of the chat can move, and the caller reports it.
    case 'send_rejected': {
      const cid = inflightConversation(next, event.id);
      if (cid === null) return [next, []];
      next.outbox = next.outbox.filter((a) => a.id !== event.id);
      delete next.inflight[cid];
      delete next.retryArmed[cid];
      next.released = next.released.filter((id) => id !== event.id);
      return [next, [effect(DELIVERY_EFFECTS.PERSIST_OUTBOX, {}), ...pump(next)]];
    }

    
    
    
    
    
    case 'retry_fired': {
      next.retryArmed = {};
      return [next, pump(next)];
    }

    case 'online': {
      next.online = true;
      return [next, pump(next)];
    }

    case 'offline': {
      next.online = false;
      
      
      
      next.inflight = {};
      return [next, []];
    }

    case 'connected': {
      next.connected = true;
      return [next, pump(next)];
    }

    case 'disconnected': {
      next.connected = false;
      return [next, []];
    }

    
    
    case 'events_received': {
      return absorb(next, event.events);
    }

    default:
      return [next, []];
  }
}

function inflightConversation(state, id) {
  const action = state.outbox.find((a) => a.id === id);
  if (!action) return null;
  const cid = conversationOf(action);
  return state.inflight[cid] === id ? cid : null;
}

// The wire calls it event_id (store.js builds every row that way, and the action route answers
// with those rows); a locally made event and this file's own tests call it id. Reading only `id`
// meant every real event deduplicated as `undefined`: the first one folded, the second was either
// discarded as already seen or pushed a second `undefined` into `seen`, which is the
// 'duplicate id in seen' this file refuses to be in. Found by the transport walk
// (server/transport.model.test.js), which feeds the machine the rows the server actually sends.
const eventIdOf = (event) => event?.event_id ?? event?.id;

// `contiguous` is what the streaming path needs and what the send_ok path cannot have. The
// transcript still arrived over the stream, so nothing was lost; what was lost was the speed.
// Applying those rows out of the contiguity order is safe because the fold dedups by event id per
// conversation (core/reducer.js seenBucket), so the stream's copy of the same row is skipped rather
// than folded twice; the cursor stays where it was, because it is the frontier of what arrived in
// order and these rows say nothing about that.
function absorb(next, incoming, { contiguous = true } = {}) {
  const fresh = (incoming || []).filter((e) => !next.seen.includes(eventIdOf(e)) && e.cursor > next.cursor);
  if (!contiguous) {
    const applied = [...fresh].sort((a, b) => a.cursor - b.cursor);
    if (!applied.length) return [next, []];
    next.seen.push(...applied.map(eventIdOf));
    return [next, [effect(DELIVERY_EFFECTS.APPLY_EVENTS, { events: applied })]];
  }
  
  
  
  
  
  
  
  
  
  let cursor = next.cursor;
  const applied = [];
  for (const e of [...fresh].sort((a, b) => a.cursor - b.cursor)) {
    if (e.cursor !== cursor + 1) break;
    cursor = e.cursor;
    applied.push(e);
  }
  if (!applied.length) return [next, []];
  next.cursor = cursor;
  next.seen.push(...applied.map(eventIdOf));
  return [next, [effect(DELIVERY_EFFECTS.APPLY_EVENTS, { events: applied })]];
}

export function deliveryStep(state, event) {
  const [next, effects] = deliveryTransition(state, event);
  const bad = deliveryViolations(next);
  if (bad.length) {
    throw new Error(`delivery invariant violated after ${event?.type || 'unknown'}: ${bad.join('; ')}`);
  }
  return [next, effects];
}
