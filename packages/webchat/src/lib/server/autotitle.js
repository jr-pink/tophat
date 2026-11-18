

import { readSecret } from './auth.js';
import { reflowTitle, shouldTitle, NEW_CHAT } from '../core/title.js';

export const DEBOUNCE_MS = 45 * 1000;

const ENDPOINT = process.env.WEBCHAT_TITLE_ENDPOINT || '' + (process.env.TOPHAT_FAST_MODEL_ENDPOINT || '');
const MODEL = process.env.WEBCHAT_TITLE_MODEL || 'gpt-oss-120b';

const PROMPT = `You name chat threads for a sidebar.
Given a conversation and its current name, reply with ONLY the name it should have now:
one to four comma-separated subjects, oldest first, each 2 to 5 words.
The name is what User searches the sidebar by months later, so every subject must be
the most specific name the conversation itself used for that piece of work: a person, a
place, a project, a file, an organisation. Prefer "school teachers" over "social mentions",
"mercury statements" over "finance lookup". Never a generic activity word on its own.
Keep every subject that is still part of what this chat is about, worded as it already is.
Add a subject for each distinct piece of work the chat did, including one it finished and
moved on from; you are shown every message from User, oldest first, so a subject in the
middle of a long chat is still one of its subjects.
Lowercase unless a proper noun. No quotes, no trailing punctuation, no verbs like "discussing".
If the conversation is only greetings and has no subject yet, reply: none`;

export const USER_CHARS = 240;
export const TOTAL_CHARS = 9000;

export function transcriptFor(events, { limit = 12, userChars = USER_CHARS, totalChars = TOTAL_CHARS } = {}) {
  const prose = [];
  for (const event of events) {
    if (event.kind === 'message.user') prose.push({ user: true, line: `User: ${String(event.content.text || '').slice(0, userChars)}` });
    else if (event.kind === 'assistant.message') prose.push({ user: false, line: `Assistant: ${String(event.content.text || '').slice(0, 600)}` });
  }
  const cut = Math.max(0, prose.length - limit);
  const recent = prose.slice(cut).map((row) => row.line);
  const earlier = prose.slice(0, cut).filter((row) => row.user).map((row) => row.line);

  let budget = totalChars - recent.reduce((sum, line) => sum + line.length + 1, 0);
  const front = [];
  const back = [];
  let head = 0;
  let foot = earlier.length - 1;
  while (head <= foot) {
    const fromFront = front.length <= back.length;
    const take = fromFront ? earlier[head] : earlier[foot];
    if (budget - (take.length + 1) < 0) break;
    budget -= take.length + 1;
    if (fromFront) { front.push(take); head += 1; } else { back.unshift(take); foot -= 1; }
  }
  return [...front, ...back, ...recent].join('\n');
}

export async function askForTopic(transcript, currentTitle = '', { fetchImpl = fetch, apiKey = readSecret('fast-model-api-key', 'TOPHAT_FAST_MODEL_API_KEY') } = {}) {
  if (!apiKey || !transcript.trim()) return null;
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      
      
      max_completion_tokens: 1500,
      temperature: 0.2,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: `Current name: ${currentTitle || '(none yet)'}\n\nConversation:\n${transcript}` }
      ]
    })
  });
  if (!response.ok) return null;
  const body = await response.json();
  
  
  
  const content = String(body.choices?.[0]?.message?.content || '');
  const text = content.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const cleaned = text.replace(/^(?:name|title)\s*[:-]\s*/iu, '').replace(/^["'`]+|["'`.]+$/gu, '').trim();
  if (!cleaned || /^none$/iu.test(cleaned)) return null;
  return cleaned.slice(0, 90);
}

export function createTitler({ store, rename, ask = askForTopic, now = () => Date.now(), debounceMs = DEBOUNCE_MS, setTimeoutImpl = setTimeout }) {
  const state = new Map(); 

  function entry(id) {
    if (!state.has(id)) state.set(id, { titledAtTurn: 0, titledAt: 0, timer: null, running: false });
    return state.get(id);
  }

  async function title(conversationId) {
    const record = entry(conversationId);
    const conversation = store.conversation(conversationId);
    if (!conversation || record.running) return null;
    if (!shouldTitle({ turns: conversation.turns, titledAtTurn: record.titledAtTurn, titledAt: record.titledAt, now: now() })) return null;
    
    // An arrival chat's "Who: what" title is what he triages the sidebar by; its own agent refines it with
    // chat_rename, the titler never does.
    if (conversation.titleSource === 'manual' || conversation.titleSource === 'arrival') return null;
    let events = store.conversationProse(conversationId);
    // A fork carries the parent's transcript as copied rows; it is named from its own turns, the
    // first message he sent in it onward, or it would just inherit the parent's name.
    if (conversation.parentId && !conversation.sidechat) {
      const own = events.findIndex((event) => event.kind === 'message.user' && !event.content?.lineage?.copied);
      if (own < 0) return null;
      events = events.slice(own);
    }

    record.running = true;
    try {
      
      
      const shown = conversation.titleSource === 'auto' && conversation.title !== NEW_CHAT ? conversation.title : '';
      const proposed = await ask(transcriptFor(events), shown);
      record.titledAtTurn = conversation.turns;
      record.titledAt = now();
      if (!proposed) return null;
      const next = reflowTitle(shown, proposed);
      if (!next) return null;
      rename(conversationId, next);
      return next;
    } catch {
      return null;
    } finally {
      record.running = false;
    }
  }

  return {
    title,

    
    
    schedule(conversationId) {
      const record = entry(conversationId);
      clearTimeout(record.timer);
      record.timer = setTimeoutImpl(() => {
        record.timer = null;
        
        
        
        
        Promise.resolve(title(conversationId)).catch((cause) => console.error(`[autotitle] ${conversationId}:`, cause));
      }, debounceMs);
      record.timer?.unref?.();
    },

    cancelAll() { for (const record of state.values()) clearTimeout(record.timer); }
  };
}
