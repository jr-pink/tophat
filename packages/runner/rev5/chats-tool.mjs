// `chats`: list and read the owner's tophat webchat conversations without guessing cursors or opening sqlite.
//
// `search` ranks turns by topic and its `open: chat:<id>#<cursor>` returns a window around one cursor, so "what was the
// result of last night's mem system chat" took about ten calls (cursor guesses, sqlite, chatlog files). This lists
// chats by last activity and reads a chat's last N turns, a time range, or only the final reply of each run.
//
// The store: events.sqlite beside the webchat, the chat log's derived index (conversations + events), the same file
// rev6/retrieval/webchat.mjs searches. Opened read-only; triggers refuse any write not from the chat log writer anyway.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { localStamp } from './clock.mjs';

export const chatsDbPath = (env = process.env) => env.WEBCHAT_DB || env.TOPHAT_WEBCHAT_DB || `${env.TOPHAT_STATE_DIR || `${env.HOME || ''}/.local/state/tophat`}/webchat/events.sqlite`;

const TURN_KINDS = ['message.user', 'assistant.message'];
const TOTAL_CHARS = 24_000;

export const CHATS_TOOL = {
  name: 'chats',
  description: 'List and read the owner\'s tophat webchat conversations (every past chat with you) straight from the chat store. list: chats by last activity with id, title, created, last turn, updated, owner turn count and the start of the last reply; query filters titles. read: one chat by id (or id prefix) or title fragment (newest match wins): its last N turns (tail), or turns between since and until, or role=final for only the last reply of each run (the result of each ask). Use this instead of search when you know which chat you want.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'list | read (default: read when id is given, or query with tail/role/chars; else list)' },
      id: { type: 'string', description: 'read: conversation id or its first 8+ characters (a runner session id also works)' },
      query: { type: 'string', description: 'list: words that must all appear in the title; read without id: a title fragment' },
      since: { type: 'string', description: 'ISO instant; list: last activity after it; read: turns after it' },
      until: { type: 'string', description: 'ISO instant; list: created before it; read: turns before it' },
      limit: { type: 'integer', description: 'list: chats to show, default 20, max 100' },
      tail: { type: 'integer', description: 'read: last N turns, default 12 (applied after since/until and role)' },
      role: { type: 'string', description: 'read: all (default) | owner | tophat | final (only the last assistant reply before each next owner message)' },
      chars: { type: 'integer', description: 'read: per-turn character cap, default 4000' },
      include_archived: { type: 'boolean', description: 'list: include archived chats (default true; they are marked)' },
    },
    required: [],
    additionalProperties: false,
  },
};

function open(path) {
  if (!existsSync(path)) throw Object.assign(new Error(`no webchat store at ${path}`), { code: 'ENOENT' });
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

const bodyText = (content) => { try { const j = JSON.parse(content); return typeof j.text === 'string' ? j.text : String(content); } catch { return String(content); } };
const oneLine = (s, n) => { const t = String(s || '').replace(/\s+/gu, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const stamp = (iso, env) => (iso ? localStamp(iso, env) || iso : '?');
const words = (q) => String(q || '').toLowerCase().split(/\s+/u).filter(Boolean);
const clampInt = (v, d, lo, hi) => { const n = Number.isFinite(Number(v)) && v !== null && v !== undefined ? Math.trunc(Number(v)) : d; return Math.min(hi, Math.max(lo, n)); };

/** list: newest-active first. Returns text. */
export function listChats(input = {}, { path, env = process.env } = {}) {
  const db = open(path);
  try {
    const limit = clampInt(input.limit, 20, 1, 100);
    const ws = words(input.query);
    const args = [];
    let sql = 'SELECT id, title, created_at, updated_at, turns, archived, automated, session_id FROM conversations WHERE 1=1';
    for (const w of ws) { sql += ' AND lower(title) LIKE ?'; args.push(`%${w.replace(/[%_]/gu, '')}%`); }
    if (input.since) { sql += ' AND updated_at >= ?'; args.push(String(input.since)); }
    if (input.until) { sql += ' AND created_at <= ?'; args.push(String(input.until)); }
    if (input.include_archived === false) sql += ' AND archived = 0';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...args).n;
    const rows = db.prepare(`${sql} ORDER BY updated_at DESC LIMIT ?`).all(...args, limit);
    const last = db.prepare('SELECT content, at FROM events WHERE conversation_id = ? AND kind = ? ORDER BY cursor DESC LIMIT 1');
    const lastTurn = db.prepare('SELECT at FROM events WHERE conversation_id = ? AND kind IN (?, ?) ORDER BY cursor DESC LIMIT 1');
    const out = [`${total} chat${total === 1 ? '' : 's'} match; showing ${rows.length}, newest activity first`];
    for (const r of rows) {
      const flags = [r.archived ? 'archived' : null, r.automated ? 'automated' : null].filter(Boolean).join(', ');
      const reply = last.get(r.id, 'assistant.message');
      out.push(`\n${r.id} | "${r.title}"${flags ? ` (${flags})` : ''}\n  created ${stamp(r.created_at, env)} | last turn ${stamp(lastTurn.get(r.id, ...TURN_KINDS)?.at, env)} | updated ${stamp(r.updated_at, env)} | ${r.turns} owner turn${r.turns === 1 ? '' : 's'}`
        + (reply ? `\n  last reply (${stamp(reply.at, env)}): ${oneLine(bodyText(reply.content), 200)}` : ''));
    }
    if (total > rows.length) out.push(`\nTRUNCATED: ${total - rows.length} more chats not shown; raise limit or narrow with query/since/until`);
    return out.join('\n');
  } finally { db.close(); }
}

function resolveChat(db, input) {
  const id = String(input.id || '').trim();
  const cols = 'id, title, created_at, updated_at, turns, archived, session_id';
  if (id) {
    const exact = db.prepare(`SELECT ${cols} FROM conversations WHERE id = ? OR session_id = ?`).get(id, id);
    if (exact) return { conv: exact };
    if (id.length < 8) return { error: `id "${id}" is too short; give 8 or more characters` };
    const pre = db.prepare(`SELECT ${cols} FROM conversations WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 5`).all(`${id.replace(/[%_]/gu, '')}%`);
    if (pre.length === 1) return { conv: pre[0] };
    if (pre.length > 1) return { error: `id prefix "${id}" matches ${pre.length} chats: ${pre.map((c) => `${c.id} "${c.title}"`).join('; ')}` };
    return { error: `no chat with id ${id}` };
  }
  const ws = words(input.query);
  if (!ws.length) return { error: 'read needs id or a title fragment in query' };
  const rows = db.prepare(`SELECT ${cols} FROM conversations WHERE ${ws.map(() => 'lower(title) LIKE ?').join(' AND ')} ORDER BY updated_at DESC LIMIT 6`).all(...ws.map((w) => `%${w.replace(/[%_]/gu, '')}%`));
  if (!rows.length) return { error: `no chat title contains "${input.query}"; try chats action=list` };
  return { conv: rows[0], others: rows.slice(1) };
}

/** read: one chat's turns. Returns text (or {error}). */
export function readChat(input = {}, { path, env = process.env } = {}) {
  const db = open(path);
  try {
    const found = resolveChat(db, input);
    if (found.error) return { error: found.error };
    const c = found.conv;
    const role = String(input.role || 'all').toLowerCase();
    if (!['all', 'owner', 'tophat', 'assistant', 'final'].includes(role)) return { error: `role must be all, owner, tophat or final, not ${role}` };
    const tail = clampInt(input.tail, 12, 1, 500);
    const per = clampInt(input.chars, 4000, 200, TOTAL_CHARS);
    const args = [c.id, ...TURN_KINDS];
    let sql = 'SELECT cursor, kind, at, content FROM events WHERE conversation_id = ? AND kind IN (?, ?)';
    if (input.since) { sql += ' AND at >= ?'; args.push(String(input.since)); }
    if (input.until) { sql += ' AND at <= ?'; args.push(String(input.until)); }
    let turns = db.prepare(`${sql} ORDER BY cursor`).all(...args).map((r) => ({ cursor: r.cursor, at: r.at, role: r.kind === 'message.user' ? 'owner' : 'tophat', text: bodyText(r.content) }));
    if (role === 'final') turns = turns.filter((t, i) => t.role === 'tophat' && (i === turns.length - 1 || turns[i + 1].role === 'owner'));
    else if (role === 'owner') turns = turns.filter((t) => t.role === 'owner');
    else if (role === 'tophat' || role === 'assistant') turns = turns.filter((t) => t.role === 'tophat');
    const matched = turns.length;
    turns = turns.slice(-tail);
    const range = [input.since ? `since ${stamp(input.since, env)}` : null, input.until ? `until ${stamp(input.until, env)}` : null].filter(Boolean).join(', ');
    const head = [`chat "${c.title}" (conversation ${c.id}${c.archived ? ', archived' : ''}; created ${stamp(c.created_at, env)}; last activity ${stamp(c.updated_at, env)}; ${c.turns} owner turns)`,
      `${matched} ${role === 'all' ? '' : `${role} `}turn${matched === 1 ? '' : 's'}${range ? ` ${range}` : ''}; showing the last ${turns.length}, oldest first`];
    if (found.others?.length) head.push(`other title matches: ${found.others.map((o) => `${o.id} "${o.title}"`).join('; ')}`);
    if (matched > turns.length) head.push(`TRUNCATED: ${matched - turns.length} earlier turns not shown; raise tail or narrow since/until`);
    const out = [head.join('\n')];
    let used = out[0].length, dropped = 0, cutTurns = 0;
    // Newest turns matter most: fill the budget from the end, then print oldest first.
    const shown = [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      let text = t.text;
      if (text.length > per) { text = `${text.slice(0, per)}\n[TRUNCATED: ${t.text.length - per} more characters of this turn; raise chars]`; cutTurns++; }
      const block = `\n--- ${t.role} | ${stamp(t.at, env)} | chat:${c.id}#${t.cursor}\n${text}`;
      if (used + block.length > TOTAL_CHARS && shown.length) { dropped = i + 1; break; }
      used += block.length; shown.unshift(block);
    }
    if (dropped) out.push(`TRUNCATED: ${dropped} older turns of the ${turns.length} selected left out to stay under ${TOTAL_CHARS} characters; lower tail or chars`);
    out.push(...shown);
    if (cutTurns) out.push(`\n(${cutTurns} turn${cutTurns === 1 ? '' : 's'} cut at ${per} characters)`);
    return out.join('\n');
  } finally { db.close(); }
}

/** The tool handler: list or read. */
export function chatsTool(input = {}, { path, env = process.env } = {}) {
  const where = path || chatsDbPath(env);
  const action = String(input.action || (input.id || (input.query && (input.tail || input.role || input.chars)) ? 'read' : 'list')).toLowerCase();
  try {
    if (action === 'list') return listChats(input, { path: where, env });
    if (action === 'read') return readChat(input, { path: where, env });
    return { error: `action must be list or read, not ${action}` };
  } catch (error) { return { error: `chats: ${error.message}` }; }
}
