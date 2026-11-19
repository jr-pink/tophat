

const HAYSTACK = new WeakMap();

function haystackOf(item) {
  const cached = HAYSTACK.get(item);
  if (cached) return cached;
  const text = [item.text, item.output, item.tool, item.description, item.prompt]
    .filter((value) => typeof value === 'string')
    .join('\n');
  const entry = { text, lower: text.toLowerCase() };
  HAYSTACK.set(item, entry);
  return entry;
}

// What find reads with tool calls left out: the user's and the assistant's own messages, not the tool calls, their
// output, thinking, or anything a subagent said (tophat-md/tophat#5).
const isMessage = (item) => (item.type === 'user' || item.type === 'assistant') && !item.agentId;

export function searchWithinChat(items, query, { tools = true } = {}) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches = [];
  for (const item of items) {
    if (!tools && !isMessage(item)) continue;
    const { text: haystack, lower } = haystackOf(item);
    let at = lower.indexOf(needle);
    while (at !== -1) {
      matches.push({
        itemId: item.id,
        offset: at,
        excerpt: haystack.slice(Math.max(0, at - 48), at + needle.length + 48),
        type: item.type
      });
      at = lower.indexOf(needle, at + needle.length);
      if (matches.length > 500) return matches;
    }
  }
  return matches;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'that', 'with', 'we', 'i']);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/u)
    .filter((token) => token.length > 1 && !STOP.has(token));
}

const BODIES = new WeakMap();

function bodyOf(items) {
  const cached = BODIES.get(items);
  if (cached !== undefined) return cached;
  const body = items.map((item) => `${item.text || ''} ${item.output || ''}`).join('\n').toLowerCase();
  BODIES.set(items, body);
  return body;
}

export function searchCachedChats(state, query, { limit = 40 } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const results = [];
  for (const conversation of Object.values(state.conversations)) {
    const items = state.items[conversation.id] || [];
    const body = bodyOf(items);
    const title = String(conversation.title || '').toLowerCase();
    let score = 0;
    let missing = false;
    for (const token of tokens) {
      const inTitle = title.includes(token);
      const hits = countOf(body, token);
      if (!inTitle && !hits) { missing = true; break; }
      score += (inTitle ? 6 : 0) + hits;
    }
    if (missing) continue;
    
    
    
    
    
    let best = null;
    let bestHits = 0;
    for (const item of items) {
      const text = `${item.text || ''} ${item.output || ''}`.toLowerCase();
      let hits = 0;
      for (const token of tokens) if (text.includes(token)) hits += 1;
      if (hits > bestHits) { best = item; bestHits = hits; }
      if (hits === tokens.length) break;
    }
    
    
    
    const bestText = `${best?.text || best?.output || conversation.preview || ''}`;
    const lowered = bestText.toLowerCase();
    const around = [...tokens].reverse().find((token) => lowered.includes(token)) || tokens[0];
    results.push({
      conversationId: conversation.id,
      title: conversation.title,
      score,
      offline: true,
      itemId: best?.id || null,
      excerpt: excerptAround(bestText, around)
    });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function countOf(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1 && count < 12) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

export function excerptAround(text, token, radius = 60) {
  const lower = String(text).toLowerCase();
  const at = lower.indexOf(String(token).toLowerCase());
  if (at === -1) return String(text).slice(0, radius * 2);
  return `${at > radius ? '…' : ''}${String(text).slice(Math.max(0, at - radius), at + radius)}`;
}

export const SEARCH_STAGES = ['exact', 'smart'];

export const CACHED_LIMIT = 200;

export async function searchStages(session, query, onResults, { stages = SEARCH_STAGES } = {}) {
  for (const mode of stages) {
    const body = await session.search(query, { mode });
    
    
    if (onResults(body, mode) === false) return;
  }
}

export function mergeResults(serverResults, cachedResults) {
  const byId = new Map();
  for (const result of cachedResults) byId.set(result.conversationId, result);
  for (const result of serverResults) byId.set(result.conversationId, { ...byId.get(result.conversationId), ...result, offline: false });
  return [...byId.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
}

/** The rows a search matched, in the order the search ranked them rather than by recency (tophat-md/tophat#5). */
export function rankByHits(rows, hits) {
  if (!hits?.length) return rows;
  const place = new Map(hits.map((hit, index) => [hit.conversationId, index]));
  return [...rows].sort((a, b) => (place.get(a.id) ?? hits.length) - (place.get(b.id) ?? hits.length));
}

function rowOf(conversation, kind) {
  return {
    conversationId: conversation.id,
    title: conversation.title,
    excerpt: conversation.preview || '',
    score: conversation.score ?? 0,
    archived: Boolean(conversation.archived),
    kind,
    offline: true
  };
}

// What an empty query shows: the chats he was last in, newest activity first. Three rules, each from the data.
//  - Pins do not lead. The sidebar already shows them; the shared sidebar order (pinned, then recency) let a handful of pins
//    take slots 1..n of nine.
//  - Archived chats are IN, and the row says "archived". He archives a chat the moment it is done, including the ones he was
//    just working in: on 2026-11-18 2,308 of 2,368 chats were archived and 15 of the 22 most recently active were, so leaving
//    them out kept the unarchived automated-event chats and dropped everything he had actually been in.
//  - Set aside, deferred and side threads stay out: those are chats he put down or that are not rows of the list.
// A running chat counts as active now: its last user message can be an hour old while it is working for him.
export function recentChats(conversations, { now = Date.now(), limit = 9, rank } = {}) {
  const at = (c) => {
    const user = Date.parse(c.activeAt || c.updatedAt || '') || 0;
    return c.live ? Math.max(user, Date.parse(c.updatedAt || '') || 0) : user;
  };
  return rank(conversations, { now, includeArchived: true })
    .filter((conversation) => !conversation.aside && !conversation.sidechat)
    .sort((a, b) => at(b) - at(a) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((conversation) => rowOf(conversation, 'recent'));
}

export function titleMatches(conversations, query, { now = Date.now(), limit = 20, rank } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  // Typing a name is how he gets back to a chat he archived, so the title search sees archived
  // chats; the recents list above it does not.
  return rank(conversations, { now, query: needle, includeArchived: true })
    .slice(0, limit)
    .map((conversation) => rowOf(conversation, 'title'));
}

export function quickswitchResults(titles, deeper) {
  const seen = new Set();
  const out = [];
  for (const row of titles) {
    if (seen.has(row.conversationId)) continue;
    seen.add(row.conversationId);
    out.push(row);
  }
  for (const row of deeper || []) {
    if (seen.has(row.conversationId)) continue;
    seen.add(row.conversationId);
    out.push({ ...row, kind: row.kind || 'text' });
  }
  return out;
}


export function quickIndexFor(event) {
  if (!event || event.altKey || !(event.metaKey || event.ctrlKey)) return null;
  
  
  
  const match = /^Digit([1-9])$/u.exec(event.code || '');
  if (!match) return null;
  return Number(match[1]) - 1;
}
