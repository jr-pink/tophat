

import { spliceBlock, threadDigest } from '../core/sidechat.js';

function itemsOf(store, id, after) {
  const carried = new Set();
  const fresh = new Map();
  for (const event of store.conversationEvents(id)) {
    const content = event.content || {};
    if (content.agentId) continue;
    const type = event.kind === 'message.user' ? 'user' : event.kind === 'assistant.message' ? 'assistant' : null;
    if (!type) continue;
    const itemId = content.itemId || event.event_id;
    if (event.cursor <= after) { carried.add(itemId); fresh.delete(itemId); continue; }
    if (carried.has(itemId)) continue;
    fresh.set(itemId, { type, text: content.text, cursor: event.cursor });
  }
  return [...fresh.values()].sort((a, b) => a.cursor - b.cursor);
}

export function collectSplice(store, conversationId, { staged = [] } = {}) {
  const threads = store.sidechatsOf(conversationId);
  if (!threads.length) return { text: '', marks: [] };
  
  
  
  
  
  const floor = new Map();
  for (const mark of staged) floor.set(mark.id, Math.max(floor.get(mark.id) || 0, mark.cursor));
  const digests = [];
  const marks = [];
  for (const thread of threads) {
    const since = Math.max(thread.splicedThrough || 0, floor.get(thread.id) || 0);
    const items = itemsOf(store, thread.id, since);
    if (!items.length) continue;
    const digest = threadDigest(thread, items, { since });
    if (!digest) continue;
    digests.push(digest);
    
    
    
    
    
    
    
    
    
    marks.push({ id: thread.id, cursor: store.cursor() });
  }
  return { text: spliceBlock(digests), marks };
}


function hasUserTurn(store, id) {
  for (const event of store.conversationEvents(id)) {
    if (event.kind === 'message.user' && !(event.content || {}).agentId) return true;
  }
  return false;
}

export const FORK_BANNER = [
  '[This chat is a fork of an earlier conversation. Everything above this point is the old',
  'transcript, kept only as context. Do not carry on with what it was doing or resume any',
  'unfinished task from it; respond only to the new message below, using the old transcript',
  'for background where it helps.]',
  ''
].join('\n');

function hasOwnUserTurn(store, id) {
  for (const event of store.conversationEvents(id)) {
    const c = event.content || {};
    if (event.kind === 'message.user' && !c.agentId && !c.lineage?.copied) return true;
  }
  return false;
}

function pendingUploadNote(uploads) {
  const list = (uploads || []).filter((upload) => upload && (upload.name || upload.id));
  if (!list.length) return '';
  const label = (upload) => {
    const name = String(upload.name || upload.id);
    return Number.isFinite(upload.size) && upload.size > 0
      ? `${name} (${Math.max(1, Math.round(upload.size / 1048576))} MB)`
      : name;
  };
  const failed = list.filter((upload) => upload.failed);
  const waiting = list.filter((upload) => !upload.failed);
  const lines = [''];
  if (failed.length) {
    // Said as failed, with the reason the client saw: a failure reported as "still uploading" had
    // the model waiting on a file that was never coming.
    lines.push(`[tophat] ${failed.length === 1 ? 'One attached file' : `${failed.length} attached files`} failed to upload and will not appear:`);
    for (const upload of failed) lines.push(`- ${label(upload)}: ${String(upload.error || 'no reason given').slice(0, 300)}`);
    lines.push('Tell him which file did not arrive and why; do not wait for it.');
  }
  if (waiting.length) {
    const named = waiting.map(label).join(', ');
    const subject = waiting.length === 1 ? 'One attached file is' : `${waiting.length} attached files are`;
    lines.push(
      `[tophat] ${subject} still uploading: ${named}. The message was sent without waiting so the`,
      'rest of the queue could move. Each path is written atomically, so it either does not exist',
      'yet or holds the whole file; wait for it to appear rather than reporting it missing. If',
      '`<path>.failed` appears beside it instead, the upload failed and that file says why: tell him.'
    );
  }
  return lines.join('\n');
}

export function prepareSend(store, conversationId, text, { staged = [], pendingUploads = [] } = {}) {
  const base = prepareSendCarrying(store, conversationId, text, { staged });
  const note = pendingUploadNote(pendingUploads);
  return note ? { ...base, wire: `${base.wire}${note}` } : base;
}

function prepareSendCarrying(store, conversationId, text, { staged = [] } = {}) {
  const conversation = store.conversation(conversationId);
  try {
    if (conversation?.sidechat) {
      if (hasUserTurn(store, conversationId)) return bare(text);
      const quote = String(conversation.sidechat.quote || '').trim();
      if (!quote) return bare(text);
      const preamble = [
        'User opened a side thread on this passage of your last message:',
        '',
        quote.split('\n').map((line) => `> ${line}`).join('\n'),
        '',
        'Answer only about that, briefly. This is a margin note, not the main',
        'conversation; he is still reading.',
        ''
      ].join('\n');
      return { wire: `${preamble}\n${text}`, display: text, carried: 0, marks: [] };
    }
    // The first message in a fork: say so. The copied transcript is background, not a task.
    if (conversation?.parentId && !hasOwnUserTurn(store, conversationId)) {
      return { wire: `${FORK_BANNER}\n${text}`, display: text, carried: 0, marks: [] };
    }
    const splice = collectSplice(store, conversationId, { staged });
    if (!splice.text) return bare(text);
    
    return { wire: `${splice.text}\n${text}`, display: text, carried: splice.marks.length, marks: splice.marks };
  } catch (cause) {
    
    
    
    console.warn(`[webchat] side-thread context failed for ${conversationId}: ${cause.message}`);
    return bare(text);
  }
}


function bare(text) {
  return { wire: text, display: text, carried: 0, marks: [] };
}

export function createSpliceLedger(store) {
  const staged = new Map();

  return {
    stage(conversationId, marks) {
      if (!marks?.length) return;
      const existing = staged.get(conversationId);
      
      
      if (existing) existing.push(...marks);
      else staged.set(conversationId, [...marks]);
    },

    commit(conversationId) {
      const marks = staged.get(conversationId);
      if (!marks?.length) return 0;
      staged.delete(conversationId);
      let done = 0;
      for (const mark of marks) {
        
        
        
        try { store.markSpliced(mark.id, mark.cursor); done += 1; }
        catch (cause) { console.warn(`[webchat] could not mark side thread ${mark.id} carried: ${cause.message}`); }
      }
      return done;
    },

    drop(conversationId) {
      const marks = staged.get(conversationId);
      staged.delete(conversationId);
      return marks?.length || 0;
    },

    pending(conversationId) {
      return [...(staged.get(conversationId) || [])];
    }
  };
}
