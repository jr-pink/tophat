// What the legacy store (store.js) and the log-first store (log-store.js + chat-index.js) share: how a
// conversation row reads, what is searchable and how, and the search itself over any handle on the
// index tables. Moved out of store.js unchanged so that both read the same code.

import { normalizeSettings } from '../core/contract.js';
import { unreadOf } from '../core/rowstate.js';

export const RESUME_CAP = 10;

// A message.user that a maintenance script wrote through openStoreForScript (store.js) carries this writer mark. It is
// transcript, not an ask: no live runner of this server holds it, so a boot must not re-ask it as a run.
export const SCRIPT_WRITER = 'script';
export function owesAnswer(content) { return content?.writtenBy !== SCRIPT_WRITER; }

/** The store with every message.user it appends marked as script-written (an explicit writtenBy is kept). */
export function markScriptWrites(store) {
  const append = store.append;
  store.append = function appendMarked(id, kind, content = {}, options) {
    const marked = kind === 'message.user' && content && content.writtenBy === undefined ? { ...content, writtenBy: SCRIPT_WRITER } : content;
    return append.call(this, id, kind, marked, options);
  };
  return store;
}

export function discharges(kind, content) {
  if (kind === 'run.completed' || kind === 'run.error') return true;
  if (kind !== 'run.cancelled') return false;
  return !content?.reason;
}

export const ROW_BUDGET = 20_000;

export const LOOSE_ROW_BUDGET = 2_000;

export const INDEXED_KINDS = new Set(['message.user', 'assistant.message', 'tool.completed', 'agent.started']);

export const SUBSTRING_KINDS = new Set(['message.user', 'assistant.message', 'agent.started']);

export const MIN_SUBSTRING = 3;

export function indexableBody(kind, content) {
  if (kind === 'message.user' || kind === 'assistant.message') return String(content.text || '');
  if (kind === 'agent.started') return `${content.description || ''} ${content.prompt || ''}`;
  if (kind === 'tool.completed') return String(content.output || '').slice(0, 4000);
  return '';
}

export function decodeMove(record) {
  return {
    moveId: record.move_id,
    conversationId: record.conversation_id,
    from: record.from_scope,
    to: record.to_scope,
    actor: record.actor,
    account: record.account,
    state: record.state,
    steps: JSON.parse(record.steps || '[]'),
    count: record.events_count,
    digest: record.digest,
    reason: record.reason,
    startedAt: record.started_at,
    finishedAt: record.finished_at
  };
}

export function decodeConversation(record) {
  return {
    id: record.id,
    title: record.title,
    cwd: record.cwd,
    settings: normalizeSettings(JSON.parse(record.settings || '{}')),
    sessionId: record.session_id,
    sessionProvider: record.session_provider || null,
    parentId: record.parent_id,
    forkedFromCursor: record.forked_from,
    sidechat: record.sidechat ? JSON.parse(record.sidechat) : null,
    splicedThrough: record.spliced_through || 0,
    pinned: Boolean(record.pinned),
    archived: Boolean(record.archived),
    aside: Boolean(record.aside),
    workspace: record.workspace || null,
    deferUntil: record.defer_until || null,
    deferCondition: record.defer_condition || null,
    deferredAt: record.deferred_at || null,
    opens: record.opens,
    turns: record.turns,
    toolCalls: record.tool_calls,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    
    
    
    activeAt: record.active_at || record.created_at,
    lastOpened: record.last_opened,
    source: record.source,
    scope: record.scope || null,
    titleSource: record.title_source || 'provisional',
    automated: Boolean(record.automated),
    preview: record.preview || '',
    ...rowOf(record),
    unread: unreadOf(rowOf(record))
  };
}


export function rowOf(record) {
  return {
    runState: record.run_state || 'idle',
    awaitingFirstToken: Boolean(record.awaiting_first_token),
    note: record.note ?? null,
    noteAt: record.note_at ?? null,
    maintenance: Boolean(record.maintenance),
    notableCursor: record.notable_cursor || 0,
    readCursor: record.read_cursor || 0,
    forcedUnread: Boolean(record.forced_unread),
    mutedRun: Boolean(record.muted_run),
    runSince: record.run_since ?? null,
    restingSince: record.resting_since ?? null
  };
}

export function ftsQuery(query, joiner = 'AND', { prefix = false } = {}) {
  const terms = tokenizeForIndex(query).map((term) => (prefix ? `"${term}"*` : `"${term}"`));
  if (!terms.length) return null;
  return terms.join(` ${joiner} `);
}

export function longestTerm(query) {
  return tokenizeForIndex(query).sort((a, b) => b.length - a.length)[0] || '';
}

export function substringExcerpt(body, needle, radius = 40) {
  const text = String(body || '');
  if (!needle) return text.slice(0, radius * 2);
  const at = text.toLowerCase().indexOf(String(needle).toLowerCase());
  if (at === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = at + needle.length;
  return `${start ? '\u2026' : ''}${text.slice(start, at)}[${text.slice(at, end)}]${text.slice(end, end + radius)}\u2026`;
}

export function substringQuery(query, joiner = 'AND') {
  const terms = tokenizeForIndex(query).filter((term) => term.length >= MIN_SUBSTRING);
  if (!terms.length) return null;
  return terms.map((term) => `"${term}"`).join(` ${joiner} `);
}

export const INDEX_STOPWORDS = new Set(['the', 'and', 'that', 'this', 'with', 'for', 'you', 'are', 'was', 'not', 'but', 'have', 'from', 'they', 'what', 'can', 'all', 'has', 'its', 'were', 'been', 'would', 'there', 'when', 'which', 'how', 'why', 'get', 'got', 'one', 'out', 'into', 'them', 'then', 'than', 'some', 'just', 'like', 'want', 'need']);

export function tokenizeForIndex(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    
    
    
    
    
    
    
    
    
    .filter((term) => (term.length > 2 || /\d/u.test(term)) && !INDEX_STOPWORDS.has(term));
}


export function expandIndex(db, query, { depth = 12, terms = 6 } = {}) {
  const seed = ftsQuery(query);
  if (!seed) return [];
  const rows = db.prepare('SELECT body FROM event_fts WHERE event_fts MATCH ? ORDER BY bm25(event_fts) LIMIT ?').all(seed, depth);
  const asked = new Set(tokenizeForIndex(query));
  const counts = new Map();
  for (const record of rows) {
    for (const token of new Set(tokenizeForIndex(record.body))) {
      if (asked.has(token)) continue;
      
      
      
      
      
      
      if (/^\d+$/u.test(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, terms)
    .map(([token]) => token);
}

export function searchIndex(db, query, { limit = 50, mode = 'exact' } = {}) {
  const exact = ftsQuery(query);
  if (!exact) return [];
  const tiers = [{ table: 'event_fts', match: exact }];
  const prefixMatch = ftsQuery(query, 'AND', { prefix: true });
  if (prefixMatch && prefixMatch !== exact) tiers.push({ table: 'event_fts', match: prefixMatch });
  const subMatch = substringQuery(query);
  if (subMatch) tiers.push({ table: 'event_sub', match: subMatch });
  if (mode === 'smart') {
    const extra = expandIndex(db, query);
    const any = ftsQuery(query, 'OR');
    const loose = extra.length ? `${any} OR ${extra.map((t) => `"${t}"`).join(' OR ')}` : any;
    if (loose && loose !== exact) tiers.push({ table: 'event_fts', match: loose, budget: LOOSE_ROW_BUDGET });
  }

  
  
  
  
  
  
  
  
  const best = new Map();
  tiers.forEach(({ table, match, budget = ROW_BUDGET }, tier) => {
    const rows = db.prepare(`
      SELECT conversation_id, cursor, kind, bm25(${table}) AS rank
      FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`).all(match, budget);
    for (const record of rows) {
      const prior = best.get(record.conversation_id);
      if (prior && (prior.tier < tier || prior.rank <= record.rank)) continue;
      best.set(record.conversation_id, { ...record, tier, table, match });
    }
  });

  const winners = [...best.values()]
    .sort((a, b) => a.tier - b.tier || a.rank - b.rank)
    .slice(0, limit);
  if (!winners.length) return [];

  
  
  
  const detail = new Map();
  for (const tier of new Set(winners.map((record) => `${record.table}\u0000${record.match}`))) {
    const [table, match] = tier.split('\u0000');
    const rows = winners.filter((record) => record.table === table && record.match === match);
    const holes = rows.map(() => '?').join(',');
    
    
    
    
    const sub = table === 'event_sub';
    const found = db.prepare(`
      SELECT f.cursor AS cursor, c.title AS title,
             ${sub ? 'f.body AS body' : `snippet(${table}, 0, '[', ']', '\u2026', 18) AS excerpt`}
      FROM ${table} f JOIN conversations c ON c.id = f.conversation_id
      WHERE ${table} MATCH ? AND f.cursor IN (${holes})`)
      .all(match, ...rows.map((record) => record.cursor));
    for (const record of found) {
      detail.set(record.cursor, sub
        ? { ...record, excerpt: substringExcerpt(record.body, longestTerm(query)) }
        : record);
    }
  }

  return winners.map((record) => ({
    conversationId: record.conversation_id,
    title: detail.get(record.cursor)?.title ?? null,
    excerpt: detail.get(record.cursor)?.excerpt ?? '',
    cursor: record.cursor,
    kind: record.kind,
    score: -record.rank
  }));
}
