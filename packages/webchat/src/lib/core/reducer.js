

import { RUN_STATES, compareEvents, normalizeSettings, validateEvent } from './contract.js';
import { blankRow, rowPatch, runPatch } from './rowstate.js';
import { parseWhenClosed, streamingPreview } from './partial-json.js';
import { summarize } from './summary.js';
import { automatedTitle } from './title.js';
import { backgroundEventText } from './automated-event.js';

export const REPLICA_VERSION = 4;

export function emptyState() {
  return {
    version: REPLICA_VERSION,
    cursor: 0,
    rev: 0,
    conversations: {},
    items: {},
    itemIndex: {},
    
    
    
    seen: new Map()
  };
}

function blankConversation(id, at) {
  return {
    id,
    title: 'New chat',
    pinned: false,
    archived: false,
    // Two quieter ways to put a chat down than archiving it: set aside (a folded tray above
    // the archive) and deferred until an hour or a condition (its own tray above that).
    aside: false,
    workspace: null,
    deferUntil: null,
    deferCondition: null,
    deferredAt: null,
    createdAt: at,
    updatedAt: at,
    
    
    activeAt: at,
    lastOpened: at,
    opens: 0,
    turns: 0,
    toolCalls: 0,
    
    
    
    
    
    
    
    ...blankRow(),
    
    
    
    snapshotCursor: 0,
    preview: '',
    sessionId: null,
    parentId: null,
    forkedFromCursor: null,
    
    
    
    sidechat: null,
    // The scope the chat is bound to (core/scopes.js); null until the server names one. `revoked` is set when
    // the chat moved to a scope this account cannot open: the tab hides it and forgets its history.
    scope: null,
    revoked: false,
    
    
    splicedThrough: 0,
    settings: normalizeSettings({}),
    cost: 0,
    error: null,
    rev: 0,
    hydrated: false
  };
}

export function settledText(existing, settled) {
  if (settled === undefined || settled === null) return existing;
  if (!existing) return settled;
  return settled.startsWith(existing) ? settled : existing;
}

/** Streamed text belongs where its cursor puts it, not where it happened to arrive.
 *
 * A fresh device folds the same block out of two different event windows: /api/bootstrap sends the
 * last hundred settled events of each recent conversation, then hydrate() asks for the newest 1500
 * of the one being opened. Keeping the chunks in cursor-ordered segments makes the fold
 * independent of window order; the ordinary case, deltas arriving in order, stays one segment and
 * one string concatenation.
 */
export function placeChunk(segments, cursor, text) {
  if (!text) return segments || [];
  const segs = segments || [];
  const last = segs[segs.length - 1];
  if (!last) return [{ from: cursor, to: cursor, text }];
  if (cursor >= last.to) {
    const next = segs.slice(0, -1);
    next.push({ from: last.from, to: cursor, text: last.text + text });
    return next;
  }
  let at = 0;
  while (at < segs.length && segs[at].to < cursor) at += 1;
  const next = segs.slice();
  if (at > 0 && next[at - 1].to < cursor) {
    const prior = next[at - 1];
    next[at - 1] = { from: prior.from, to: cursor, text: prior.text + text };
  } else if (at < next.length && cursor >= next[at].from) {
    const hit = next[at];
    next[at] = { from: hit.from, to: Math.max(hit.to, cursor), text: hit.text + text };
  } else {
    next.splice(at, 0, { from: cursor, to: cursor, text });
  }
  return next;
}

export function joinChunks(segments) {
  if (!segments || !segments.length) return '';
  if (segments.length === 1) return segments[0].text;
  let text = '';
  for (const segment of segments) text += segment.text;
  return text;
}

// A block the server has already settled carries its whole text in `assistant.message`. Deltas that
// turn up afterwards -- the head of the block, fetched by "load earlier" or by a wider window than
// the one that settled it -- are already inside that text, so folding them again is how the same
// paragraphs used to appear twice. `settledWhole` is set only when the settled text was actually
// taken, so a block whose streamed text diverged keeps accumulating positionally instead.
function chunked(existing, cursor, text, patch) {
  if (existing.settledWhole) return { ...existing, ...patch };
  const chunks = placeChunk(existing.chunks, cursor, text || '');
  return { ...existing, ...patch, chunks, text: joinChunks(chunks) };
}

function previewOf(text) {
  return String(text || '').replace(/\s+/gu, ' ').trim().slice(0, 180);
}

// A fork is born as "<parent> ↳" and takes its name from the first message he sends in it.
export const FORK_PLACEHOLDER = / ↳$/u;

function derivedTitle(current, text) {
  if (current && current !== 'New chat' && !FORK_PLACEHOLDER.test(current)) return current;
  const line = automatedTitle(text).text.replace(/\s+/gu, ' ').trim();
  return line ? line.slice(0, 72) : current;
}

function makeDraft(state) {
  return {
    base: state,
    version: state.version,
    cursor: state.cursor,
    rev: state.rev,
    conversations: state.conversations,
    items: state.items,
    itemIndex: state.itemIndex,
    seen: state.seen,
    ownedConversations: false,
    ownedItems: false,
    ownedLists: new Set(),
    ownedSeen: false,
    touched: new Set(),
    eventCursor: 0
  };
}

function ownConversations(draft) {
  if (!draft.ownedConversations) { draft.conversations = { ...draft.conversations }; draft.ownedConversations = true; }
  return draft.conversations;
}

function ownItems(draft) {
  if (!draft.ownedItems) {
    draft.items = { ...draft.items };
    draft.itemIndex = { ...draft.itemIndex };
    draft.ownedItems = true;
  }
  return draft.items;
}

function ownList(draft, id) {
  const items = ownItems(draft);
  if (!draft.ownedLists.has(id)) {
    items[id] = (items[id] || []).slice();
    draft.itemIndex[id] = new Map(draft.itemIndex[id] || []);
    draft.ownedLists.add(id);
  }
  return items[id];
}

/**
 * A thinking row streams (shows live in the transcript) only until the model's next block begins. Nothing else ends
 * it: the server sends no settle event for thinking, so without this the row stayed "streaming" until the whole run
 * completed. Scans the tail only; thinking is always the newest row of its lane while it is live.
 */
function settleThinking(draft, conversationId, agentId) {
  const list = ownList(draft, conversationId);
  const lane = agentId ?? null;
  for (let at = list.length - 1, seen = 0; at >= 0 && seen < 12; at -= 1, seen += 1) {
    const item = list[at];
    if (item.type === 'thinking' && item.streaming && (item.agentId ?? null) === lane) list[at] = { ...item, streaming: false };
  }
}

function seenBucket(draft, conversationId) {
  let bucket = draft.seen.get(conversationId);
  if (!bucket) {
    bucket = new Set();
    draft.seen.set(conversationId, bucket);
  }
  return bucket;
}

function conversationOf(draft, id, at) {
  const map = ownConversations(draft);
  if (!map[id]) map[id] = blankConversation(id, at);
  return map[id];
}

function patchConversation(draft, id, at, patch, { quiet = false, force = false } = {}) {
  const map = ownConversations(draft);
  const prior = map[id] || blankConversation(id, at);
  
  
  
  
  
  
  
  if (!force && draft.eventCursor && draft.eventCursor <= prior.snapshotCursor) {
    draft.touched.add(id);
    return prior;
  }
  const next = { ...prior, ...patch, rev: prior.rev + 1 };
  if (!quiet && at && (!next.updatedAt || at > next.updatedAt)) next.updatedAt = at;
  map[id] = next;
  draft.touched.add(id);
  return next;
}

export const UNPLACED = Number.MAX_SAFE_INTEGER;

function placeFor(list, cursor) {
  if (!list.length || list[list.length - 1].cursor <= cursor) return list.length;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid].cursor <= cursor) low = mid + 1;
    else high = mid;
  }
  return low;
}

function reindex(draft, conversationId, from) {
  const list = draft.items[conversationId];
  const index = draft.itemIndex[conversationId];
  for (let at = from; at < list.length; at += 1) index.set(list[at].id, at);
}

/**
 * A row's identity: the agent it belongs to and the id the model gave the message, never arrival position.
 *
 * One conversation is one child process, and inside it the parent turn and several subagents stream at
 * once. A block id like `m3:0` only means anything inside the agent that sent it, so keying rows by the id
 * alone merged two agents' paragraphs into one row and let one agent's final message land on the row
 * another agent had streamed — the text then showed twice, once on each. An agent row is the exception:
 * its id is the Agent tool_use id, unique across the whole conversation, and the transcript looks a
 * subagent's children up by exactly that id (ui/Transcript.svelte groups by item.agentId).
 */
export function rowKey(itemId, agentId, type) {
  return agentId && type !== 'agent' ? `${itemId}@${agentId}` : String(itemId);
}

function upsert(draft, conversationId, itemId, seed, update) {
  const list = ownList(draft, conversationId);
  const index = draft.itemIndex[conversationId];
  const key = rowKey(itemId, seed.agentId, seed.type);
  const at = index.get(key);
  if (at === undefined) {
    const created = update({ ...seed, id: key });
    const place = placeFor(list, created.cursor ?? UNPLACED);
    list.splice(place, 0, created);
    if (place === list.length - 1) index.set(key, place);
    else reindex(draft, conversationId, place);
    return created;
  }
  // A row sits at the earliest cursor it has ever been seen under, not the first one that happened to
  // reach this device. The bootstrap tail creates a row out of the middle of a block, and the wider
  // hydrate window that follows carries that block's real first event; keeping the later cursor put
  // the row after rows that genuinely started after it.
  const incoming = Number.isSafeInteger(seed.cursor) ? seed.cursor : UNPLACED;
  const settled = incoming !== UNPLACED && (list[at].cursor === UNPLACED || incoming < list[at].cursor);
  const updated = update({ ...list[at], ...(settled ? { cursor: incoming } : {}) });
  if (!settled) { list[at] = updated; return updated; }
  list.splice(at, 1);
  const place = placeFor(list, updated.cursor);
  list.splice(place, 0, updated);
  reindex(draft, conversationId, Math.min(at, place));
  return updated;
}

function applyEvent(draft, event) {
  const id = event.conversation_id;
  const at = event.at;
  const content = event.content || {};
  conversationOf(draft, id, at);
  draft.eventCursor = event.cursor;

  switch (event.kind) {
    case 'conversation.created':
      patchConversation(draft, id, at, {
        createdAt: at,
        title: content.title || draft.conversations[id].title,
        settings: normalizeSettings(content.settings || {}),
        parentId: content.parentId ?? null,
        forkedFromCursor: content.forkedFromCursor ?? null,
        sidechat: content.sidechat ?? null,
        cwd: content.cwd ?? null,
        // A chat still pending here was created by this tab, and a scope move he made on it right away is already
        // applied locally; the server's created event names the scope it was created in, which is the old one, and
        // must not flick the dropdown back before the move's own marker arrives.
        scope: draft.conversations[id].pending && draft.conversations[id].scope
          ? draft.conversations[id].scope
          : (content.scope ?? draft.conversations[id].scope),
        // Same for the workspace: a chat this tab filed right after creating it keeps that filing.
        workspace: draft.conversations[id].pending && draft.conversations[id].workspace
          ? draft.conversations[id].workspace
          : (content.workspace ?? draft.conversations[id].workspace ?? null),
        pending: false
      });
      break;
    case 'conversation.renamed':
      if (content.title) patchConversation(draft, id, at, { title: content.title });
      break;
    case 'conversation.pinned':
      patchConversation(draft, id, at, { pinned: Boolean(content.pinned) });
      break;
    case 'conversation.archived':
      patchConversation(draft, id, at, { archived: Boolean(content.archived) });
      break;
    case 'conversation.aside':
      patchConversation(draft, id, at, { aside: Boolean(content.aside) });
      break;
    case 'conversation.workspace':
      patchConversation(draft, id, at, { workspace: content.workspace || null });
      break;
    case 'conversation.deferred':
      patchConversation(draft, id, at, {
        deferUntil: content.until || null,
        deferCondition: content.condition || null,
        deferredAt: content.until || content.condition ? at : null
      });
      break;
    case 'conversation.meta':
      patchConversation(draft, id, at, {
        sessionId: content.sessionId ?? draft.conversations[id].sessionId,
        splicedThrough: content.splicedThrough ?? draft.conversations[id].splicedThrough,
        settings: normalizeSettings(content.settings || {}, draft.conversations[id].settings),
        // A scope move (server/scopes.js). A marker with no scope and `revoked` is the account losing the chat.
        ...(content.scope ? { scope: content.scope, revoked: false } : {}),
        ...(content.revoked ? { revoked: true } : {})
      });
      break;
    case 'conversation.opened':
      patchConversation(draft, id, at, { opens: draft.conversations[id].opens + 1, lastOpened: at }, { quiet: true });
      break;
    case 'message.user': {
      upsert(draft, id, content.itemId || event.event_id,
        { type: 'user', at, cursor: event.cursor, agentId: null },
        (item) => ({ ...item, text: content.text || '', participantId: content.participantId ?? null, queued: false }));
      const current = draft.conversations[id];
      patchConversation(draft, id, at, {
        turns: current.turns + 1,
        
        activeAt: at,
        preview: previewOf(content.text),
        title: content.lineage?.copied ? current.title : derivedTitle(current.title, content.text),
        ...(current.turns === 0 && automatedTitle(content.text).automated ? { automated: true } : {}),
        error: null
      });
      break;
    }
    case 'assistant.delta': {
      const item = upsert(draft, id, content.itemId,
        { type: 'assistant', text: '', at, cursor: event.cursor, agentId: content.agentId ?? null, streaming: true },
        (existing) => chunked(existing, event.cursor, content.text, { streaming: true }));
      settleThinking(draft, id, content.agentId);
      
      
      if (!content.agentId) patchConversation(draft, id, at, { preview: previewOf(item.text.slice(-180)) });
      else patchConversation(draft, id, at, {});
      break;
    }
    case 'assistant.message': {
      // The settling event says where its block began (runner.js writes `firstCursor`), so a window
      // that carries the message without the deltas that streamed it still places the row above the
      // tool cards of its own step. An event from before that field existed places as it always did.
      const began = Number.isSafeInteger(content.firstCursor) && content.firstCursor > 0
        ? Math.min(content.firstCursor, event.cursor)
        : event.cursor;
      const item = upsert(draft, id, content.itemId,
        { type: 'assistant', text: '', at, cursor: began, agentId: content.agentId ?? null },
        (existing) => {
          const text = settledText(existing.text, content.text);
          const settledWhole = existing.settledWhole || text === content.text;
          return {
            ...existing,
            text,
            settledWhole,
            chunks: settledWhole ? [{ from: existing.chunks?.[0]?.from ?? event.cursor, to: event.cursor, text }] : existing.chunks,
            streaming: false
          };
        });
      
      
      if (!content.agentId) patchConversation(draft, id, at, { preview: summarize(item.text) });
      else patchConversation(draft, id, at, {});
      break;
    }
    
    
    
    
    
    case 'hook.fired': {
      upsert(draft, id, content.itemId,
        { type: 'hook', source: content.source || 'hook', text: '', at, cursor: event.cursor, agentId: content.agentId ?? null },
        (item) => ({ ...item, text: content.text || item.text }));
      patchConversation(draft, id, at, {});
      break;
    }
    case 'pace.check': {
      upsert(draft, id, content.itemId || event.event_id,
        { type: 'pace', at, cursor: event.cursor, agentId: null, elapsedMs: null, text: '' },
        (item) => ({
          ...item,
          elapsedMs: content.elapsedMs ?? item.elapsedMs,
          text: content.text || item.text
        }));
      patchConversation(draft, id, at, {});
      break;
    }
    case 'context.compacted': {
      upsert(draft, id, content.itemId || event.event_id,
        {
          type: 'compaction', at, cursor: event.cursor, agentId: null,
          trigger: 'auto', preTokens: null, messages: null, summary: '', summaryAt: null, model: null
        },
        (item) => ({
          ...item,
          trigger: content.trigger || item.trigger,
          preTokens: content.preTokens ?? item.preTokens,
          messages: content.messages ?? item.messages,
          summary: content.summary || item.summary,
          summaryAt: content.summaryAt ?? item.summaryAt,
          model: content.model ?? item.model
        }));
      patchConversation(draft, id, at, {});
      break;
    }
    // Nothing is drawn while it runs; when it ends its report is one automated-event bubble (Message.svelte: muted,
    // collapsed, on the left). It is not a message of his: no turn count, no run state, no preview, no title.
    case 'background.turn': {
      if (!content.state || content.state === 'running') break;
      upsert(draft, id, content.itemId || event.event_id,
        { type: 'user', at, cursor: event.cursor, agentId: null },
        (item) => ({ ...item, text: backgroundEventText(content), participantId: null, queued: false }));
      patchConversation(draft, id, at, {});
      break;
    }
    case 'thinking.delta': {
      const row = upsert(draft, id, content.itemId,
        { type: 'thinking', text: '', at, cursor: event.cursor, agentId: content.agentId ?? null },
        (existing) => chunked(existing, event.cursor, content.text, { streaming: true }));
      // A delta that lands behind a newer row of its lane (a window hydrated out of order) is history, not live thinking.
      const list = ownList(draft, id), lane = content.agentId ?? null;
      let newer = false, here = -1;
      for (let at2 = list.length - 1; at2 >= 0 && here < 0; at2 -= 1) {
        if (list[at2].id === row.id) here = at2;
        else if ((list[at2].agentId ?? null) === lane) newer = true;
        if (list.length - 1 - at2 > 40) break;
      }
      if (here >= 0 && newer) list[here] = { ...list[here], streaming: false };
      patchConversation(draft, id, at, {});
      break;
    }
    case 'tool.started': {
      upsert(draft, id, content.itemId,
        {
          type: 'tool', at, cursor: event.cursor, agentId: content.agentId ?? null,
          tool: content.tool, rawInput: '', input: content.input ?? null,
          preview: null, output: '', state: 'running', isError: false
        },
        (existing) => ({ ...existing, tool: content.tool || existing.tool, input: content.input ?? existing.input, state: 'running' }));
      settleThinking(draft, id, content.agentId);
      
      
      
      
      
      
      
      
      
      
      
      
      
      patchConversation(draft, id, at, { toolCalls: draft.conversations[id].toolCalls + 1 });
      break;
    }
    case 'tool.input_delta':
      upsert(draft, id, content.itemId,
        { type: 'tool', at, cursor: event.cursor, agentId: content.agentId ?? null, tool: content.tool, rawInput: '', output: '', state: 'running', isError: false },
        (existing) => {
          const inputChunks = placeChunk(existing.inputChunks, event.cursor, content.partial || '');
          const rawInput = joinChunks(inputChunks);
          return { ...existing, inputChunks, rawInput, preview: streamingPreview(existing.tool, rawInput), input: parseWhenClosed(rawInput) ?? existing.input };
        });
      patchConversation(draft, id, at, {});
      break;
    case 'tool.completed':
      upsert(draft, id, content.itemId,
        { type: 'tool', at, cursor: event.cursor, agentId: content.agentId ?? null, tool: content.tool, rawInput: '', output: '', state: 'running' },
        (existing) => ({
          ...existing,
          output: content.output ?? existing.output,
          input: content.input ?? existing.input,
          isError: Boolean(content.isError),
          
          
          endedAt: at,
          state: content.isError ? 'failed' : 'completed'
        }));
      patchConversation(draft, id, at, {});
      break;
    case 'agent.started':
      upsert(draft, id, content.agentId,
        { type: 'agent', at, cursor: event.cursor, agentId: content.parentAgentId ?? null, state: 'running' },
        (existing) => ({
          ...existing,
          agentType: content.agentType || existing.agentType || 'agent',
          description: content.description || existing.description || 'Subagent',
          prompt: content.prompt ?? existing.prompt,
          state: 'running'
        }));
      
      
      
      patchConversation(draft, id, at, {});
      break;
    case 'agent.completed':
      upsert(draft, id, content.agentId,
        { type: 'agent', at, cursor: event.cursor, agentId: null, state: 'running' },
        (existing) => ({ ...existing, state: content.isError ? 'failed' : 'completed', result: content.result ?? existing.result }));
      patchConversation(draft, id, at, {});
      break;
    case 'run.status':
      if (!RUN_STATES.includes(content.state)) throw new TypeError(`Invalid run state: ${content.state}`);
      break;
    case 'run.cancelled': {
      const list = ownList(draft, id);
      for (let index = 0; index < list.length; index += 1) {
        const item = list[index];
        if (item.streaming) list[index] = { ...item, streaming: false };
        else if (item.state === 'running') list[index] = { ...item, state: 'cancelled' };
      }
      patchConversation(draft, id, at, {});
      break;
    }
    case 'run.error': {
      upsert(draft, id, event.event_id,
        { type: 'error', at, cursor: event.cursor, agentId: null },
        (item) => ({ ...item, text: content.message || 'The run failed.' }));
      patchConversation(draft, id, at, { error: content.message || 'The run failed.' });
      break;
    }
    case 'run.completed': {
      const list = ownList(draft, id);
      for (let index = 0; index < list.length; index += 1) {
        if (list[index].streaming) list[index] = { ...list[index], streaming: false };
      }
      patchConversation(draft, id, at, { cost: draft.conversations[id].cost + (content.costUsd || 0) });
      break;
    }
    default:
      break;
  }

  
  
  
  
  
  
  
  const patch = rowPatch(draft.conversations[id] || blankRow(), { ...event, at });
  if (patch) patchConversation(draft, id, at, patch, { quiet: event.kind === 'conversation.meta' });
}

function seal(draft) {
  return {
    version: draft.version,
    cursor: draft.cursor,
    rev: draft.rev + 1,
    conversations: draft.conversations,
    items: draft.items,
    itemIndex: draft.itemIndex,
    seen: draft.seen
  };
}

export function reduceEvents(state, events) {
  if (!events.length) return state;
  const draft = makeDraft(state);
  const ordered = events.length > 1 ? [...events].sort(compareEvents) : events;
  let changed = false;
  // Conversations and items are copied into the draft on write and thrown away if this fold
  // does not finish, but `seen` is the live state's own Map -- nothing copies it. So a batch
  // that threw halfway used to leave the events before the bad one marked as folded while
  // their effects were discarded: folded according to the ledger, absent from the transcript,
  // and unrecoverable, because every later fold skips an id it has already seen. Undo the
  // marks on the way out, so a fold is all or nothing and a caller can retry event by event.
  const marked = [];
  try {
    for (const raw of ordered) {
      const event = validateEvent(raw);
      const bucket = seenBucket(draft, event.conversation_id);
      if (bucket.has(event.event_id)) continue;
      bucket.add(event.event_id);
      marked.push([bucket, event.event_id]);
      applyEvent(draft, event);
      draft.cursor = Math.max(draft.cursor, event.cursor);
      changed = true;
    }
  } catch (cause) {
    for (const [bucket, id] of marked) bucket.delete(id);
    throw cause;
  }
  return changed ? seal(draft) : state;
}

export function reduceEvent(state, event) {
  return reduceEvents(state, [event]);
}

export function rebuild(events) {
  return reduceEvents(emptyState(), events);
}

export function hasSeen(state, conversationId, eventId) {
  return Boolean(state.seen.get(conversationId)?.has(eventId));
}

export function seenCount(state) {
  let total = 0;
  for (const bucket of state.seen.values()) total += bucket.size;
  return total;
}

export function foldedItemCount(state) {
  let total = 0;
  for (const id of Object.keys(state.items)) total += state.items[id].length;
  return total;
}

// A chat that was never created on the server (the transient chat the app opens into, see
// core/transient.js) leaves no trace when it is dropped: evictConversations keeps the header
// row so a cached chat can be rehydrated, but there is nothing on the far end to rehydrate
// here, and a leftover row would put a phantom "New chat" in the sidebar for the life of the
// tab. So this one really deletes.
export function forgetConversation(state, id) {
  if (!id || !state.conversations[id]) return state;
  const conversations = { ...state.conversations };
  const items = { ...state.items };
  const itemIndex = { ...state.itemIndex };
  const seen = new Map(state.seen);
  delete conversations[id];
  delete items[id];
  delete itemIndex[id];
  seen.delete(id);
  return { ...state, rev: state.rev + 1, conversations, items, itemIndex, seen };
}

export function evictConversations(state, ids) {
  const drop = [];
  for (const id of ids) if (state.items[id] || state.seen.has(id)) drop.push(id);
  if (!drop.length) return state;
  const items = { ...state.items };
  const itemIndex = { ...state.itemIndex };
  const conversations = { ...state.conversations };
  const seen = new Map(state.seen);
  for (const id of drop) {
    delete items[id];
    delete itemIndex[id];
    seen.delete(id);
    const prior = conversations[id];
    if (prior) {
      conversations[id] = {
        ...prior,
        hydrated: false,
        snapshotCursor: Math.max(prior.snapshotCursor, state.cursor),
        rev: prior.rev + 1
      };
    }
  }
  return { ...state, rev: state.rev + 1, conversations, items, itemIndex, seen };
}

// A default parameter only fires on `undefined`, so a payload field that came back as an
// explicit null used to throw here and take the whole caller's tail with it (bootstrap stopped
// before it could clear `syncing` or replay the outbox; the delta path swallowed it entirely).
// A snapshot that is not an object is a snapshot with nothing in it.
export function mergeSidebar(state, snapshot) {
  const { cursor = 0, rows = [] } = snapshot && typeof snapshot === 'object' ? snapshot : {};
  if (!Array.isArray(rows) || !rows.length) return state;
  const conversations = { ...state.conversations };
  for (const record of rows) {
    const prior = conversations[record.id] || blankConversation(record.id, record.createdAt);
    conversations[record.id] = {
      ...prior,
      ...record,
      revoked: false,
      settings: normalizeSettings(record.settings || {}, prior.settings),
      
      
      
      ...(prior.snapshotCursor > cursor ? prior : {}),
      snapshotCursor: Math.max(prior.snapshotCursor, cursor),
      rev: prior.rev + 1
    };
  }
  return { ...state, conversations, rev: state.rev + 1 };
}

export function mergeConversations(state, records) {
  if (!records.length) return state;
  const conversations = { ...state.conversations };
  for (const record of records) {
    const prior = conversations[record.id] || blankConversation(record.id, record.createdAt);
    conversations[record.id] = {
      ...prior,
      ...record,
      revoked: false,
      settings: normalizeSettings(record.settings || {}, prior.settings),
      
      
      runState: record.runState ?? (prior.hydrated ? prior.runState : 'idle'),
      
      preview: prior.hydrated ? prior.preview : (record.preview ?? prior.preview),
      rev: prior.rev + 1
    };
  }
  return { ...state, conversations, rev: state.rev + 1 };
}

export const LIVE_RUN_STATES = new Set(['queued', 'starting', 'thinking', 'running']);

export function reconcileLiveness(state, liveIds, { only = null } = {}) {
  const live = new Set(liveIds || []);
  const scope = only
    ? (state.conversations[only] ? [state.conversations[only]] : [])
    : Object.values(state.conversations);
  let conversations = null;
  for (const conversation of scope) {
    if (!LIVE_RUN_STATES.has(conversation.runState) || live.has(conversation.id)) continue;
    conversations ||= { ...state.conversations };
    conversations[conversation.id] = { ...conversation, runState: 'idle', rev: conversation.rev + 1 };
  }
  return conversations ? { ...state, conversations, rev: state.rev + 1 } : state;
}

export function markHydrated(state, id) {
  const prior = state.conversations[id];
  if (!prior || prior.hydrated) return state;
  return {
    ...state,
    rev: state.rev + 1,
    conversations: { ...state.conversations, [id]: { ...prior, hydrated: true, rev: prior.rev + 1 } }
  };
}

export function markAllUnhydrated(state) {
  let conversations = null;
  for (const [id, conversation] of Object.entries(state.conversations)) {
    if (!conversation.hydrated) continue;
    conversations ||= { ...state.conversations };
    conversations[id] = { ...conversation, hydrated: false, rev: conversation.rev + 1 };
  }
  return conversations ? { ...state, conversations, rev: state.rev + 1 } : state;
}

export function conversationItems(state, id) {
  return state.items[id] || [];
}

export function topLevelItems(state, id) {
  const items = conversationItems(state, id);
  return items.some((item) => item.agentId) ? items.filter((item) => !item.agentId) : items;
}

export function agentItems(state, id, agentId) {
  return conversationItems(state, id).filter((item) => item.agentId === agentId);
}

export function sidechatsOf(state, id) {
  return Object.values(state.conversations)
    .filter((conversation) => conversation.parentId === id && conversation.sidechat)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function forksOf(state, id) {
  return Object.values(state.conversations)
    .filter((conversation) => conversation.parentId === id)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function applyOptimistic(state, action) {
  const id = action.conversation_id;
  const at = action.at || new Date().toISOString();
  if (action.op === 'conversation.create' || action.op === 'conversation.fork') {
    if (state.conversations[id]) return state;
    const created = {
      ...blankConversation(id, at),
      title: action.payload.title || derivedTitle('New chat', action.payload.text) || 'New chat',
      settings: normalizeSettings(action.payload.settings || {}),
      parentId: action.payload.parentId ?? null,
      forkedFromCursor: action.payload.forkedFromCursor ?? null,
      sidechat: action.payload.sidechat ?? null,
      scope: action.payload.scope ?? null,
      workspace: action.payload.workspace || null,
      hydrated: true,
      pending: true
    };
    const next = { ...state, rev: state.rev + 1, conversations: { ...state.conversations, [id]: created } };
    return action.payload.text ? queueUserItem(next, id, action, at) : next;
  }
  const existing = state.conversations[id];
  
  
  
  
  
  
  
  
  if (!existing) {
    if (action.op !== 'message.send') return state;
    const placeholder = { ...blankConversation(id, at), hydrated: true, pending: true };
    return queueUserItem(
      { ...state, rev: state.rev + 1, conversations: { ...state.conversations, [id]: placeholder } },
      id, action, at
    );
  }
  if (action.op === 'message.send') return queueUserItem(state, id, action, at);
  const patch =
    action.op === 'conversation.rename' ? { title: action.payload.title } :
    action.op === 'conversation.set_pinned' ? { pinned: Boolean(action.payload.pinned) } :
    action.op === 'conversation.set_archived' ? { archived: Boolean(action.payload.archived) } :
    action.op === 'conversation.set_aside' ? { aside: Boolean(action.payload.aside) } :
    action.op === 'conversation.set_workspace' ? { workspace: action.payload.workspace || null } :
    action.op === 'conversation.set_deferred' ? {
      deferUntil: action.payload.until || null,
      deferCondition: action.payload.condition || null,
      deferredAt: action.payload.until || action.payload.condition ? at : null
    } :
    action.op === 'conversation.move_scope' ? { scope: action.payload.to } :
    action.op === 'conversation.set_settings' ? { settings: normalizeSettings(action.payload.settings || {}, existing.settings) } :
    action.op === 'conversation.touch' ? { opens: existing.opens + 1, lastOpened: at } : 
    action.op === 'run.interrupt' ? { runState: 'cancelled' } :
    
    
    
    action.op === 'conversation.set_read' ? (action.payload.read === false
      ? { forcedUnread: true, mutedRun: false }
      : {
          // Read up to the cursor the action says was seen (clamped to this state's head, as the server clamps to its
          // own), so the local mark is the one the server records. The engine applies a tab's read one patch ahead of
          // the tab's paint; reading to its own cursor marked a run.completed the tab never showed, and the reload
          // that took the server's word showed the chat unread. Without one: the head.
          readCursor: Math.max(existing.readCursor || 0, Number.isSafeInteger(action.payload.seenCursor)
            ? Math.min(action.payload.seenCursor, state.cursor || 0) : (state.cursor || 0)),
          forcedUnread: false,
          mutedRun: action.payload.mute !== false && LIVE_RUN_STATES.has(existing.runState)
        }) : null;
  if (!patch) return state;
  return {
    ...state,
    rev: state.rev + 1,
    conversations: { ...state.conversations, [id]: { ...existing, ...patch, rev: existing.rev + 1 } }
  };
}

function queueUserItem(state, id, action, at) {
  const list = state.items[id] || [];
  if (list.some((item) => item.id === action.action_id)) return state;
  const existing = state.conversations[id];
  // The optimistic queue turns the row live before the server's own event lands, so it has to move the
  // clock anchor exactly as rowstate does; setting only `runState` left `runSince` on the stretch that
  // had already ended and the strip counted the whole previous turn. Only the anchor is taken from the
  // patch: the row is queued here whatever the state it came from, and `stretch` reads the same either
  // way.
  const anchor = runPatch(existing, { kind: 'message.user', content: {}, at }) || {};
  return {
    ...state,
    rev: state.rev + 1,
    conversations: {
      ...state.conversations,
      [id]: {
        ...existing,
        preview: previewOf(action.payload.text),
        title: derivedTitle(existing.title, action.payload.text),
        runState: 'queued',
        awaitingFirstToken: true,
        runSince: anchor.runSince ?? existing.runSince ?? at,
        restingSince: anchor.restingSince ?? null,
        rev: existing.rev + 1
      }
    },
    items: { ...state.items, [id]: [...list, { id: action.action_id, type: 'user', text: action.payload.text, at, queued: true, agentId: null, cursor: UNPLACED }] },
    itemIndex: { ...state.itemIndex, [id]: new Map([...(state.itemIndex[id] || []), [action.action_id, list.length]]) }
  };
}

/** Put a chat's scope back (a move the server refused). */
export function setConversationScope(state, id, scope) {
  const existing = state.conversations[id];
  if (!existing || existing.scope === scope) return state;
  return { ...state, rev: state.rev + 1, conversations: { ...state.conversations, [id]: { ...existing, scope, rev: existing.rev + 1 } } };
}
