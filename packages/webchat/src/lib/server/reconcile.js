

import { LIVE_RUN_STATES, rebuild } from '../core/reducer.js';

export const CUT_OFF_MESSAGE = 'This run was cut off when the server restarted.';

export function stuckRuns(store, { live = [], skip = [] } = {}) {
  const held = new Set([...live, ...skip]);
  const markers = store.runMarkers();
  const out = [];
  for (const conversation of store.conversations()) {
    if (held.has(conversation.id)) continue;
    
    
    
    
    
    
    
    const marker = markers.get(conversation.id);
    if (!marker) continue;
    const tail = store.conversationEvents(conversation.id, { after: marker.ended });
    if (!tail.length) continue;
    const folded = rebuild(tail).conversations[conversation.id];
    if (folded && LIVE_RUN_STATES.has(folded.runState)) out.push(conversation.id);
  }
  return out;
}

export function reconcileStuckRuns({
  store,
  live = [],
  skip = [],
  at = new Date().toISOString(),
  message = CUT_OFF_MESSAGE
} = {}) {
  const ids = stuckRuns(store, { live, skip });
  for (const id of ids) {
    store.append(id, 'run.error', { message, reason: 'server-restart' }, { at });
  }
  return ids;
}
