// The runner's private ledger (runner.sqlite): sessions, messages in API order, the push hand-off queue,
// subagents and background jobs. The schema is rev5's, byte for byte, so either runner reads the other's file.
// Every owner message is written before inference; compaction marks rows, never deletes them.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { retryWhileBusy } from '../base/sqlite.mjs';

export const ledgerPath = (env = process.env) => env.TOPHAT_RUNNER_RUNNER_DB || join(env.TOPHAT_STATE_DIR || join(homedir(), '.local', 'state', 'tophat'), 'rev5', 'runner.sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, model TEXT, cwd TEXT, forked_from TEXT);
  CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
    content TEXT NOT NULL, created_at TEXT NOT NULL, compacted_at TEXT, redactions TEXT);
  CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
  CREATE TABLE IF NOT EXISTS push_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, done_at TEXT, receipt TEXT)`;
const AGENTS = `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, parent_session TEXT NOT NULL, session_id TEXT NOT NULL, spawn_call TEXT, description TEXT, prompt TEXT,
    model TEXT, status TEXT NOT NULL, result TEXT, usage TEXT, cost_usd REAL, calls INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, ended_at TEXT, delivered_at TEXT);
  CREATE INDEX IF NOT EXISTS agents_parent ON agents(parent_session, status)`;
const JOBS = `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
    status TEXT NOT NULL, pid INTEGER, exit_code INTEGER, output TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, ended_at TEXT, delivered_at TEXT);
  CREATE INDEX IF NOT EXISTS jobs_session ON jobs(session_id, status)`;
const ADDED = [['push_queue', 'receipt TEXT'], ['sessions', 'runner_pid INTEGER'], ['agents', 'stop_reason TEXT'], ['agents', 'resumes INTEGER NOT NULL DEFAULT 0'],
  ['agents', 'owner_pid INTEGER'], ['agents', 'checkin_ms INTEGER'], ['agents', 'checked_at TEXT'], ['agents', 'caller TEXT'],
  ['agents', 'expected_minutes REAL']];

/** The agents and jobs tables and the columns added since rev5 began; idempotent, so tools and agents can call it on any db. */
export function ensureTables(db) {
  retryWhileBusy(() => db.exec(`${AGENTS};\n${JOBS}`));
  for (const [table, column] of ADDED) {
    if (!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)) continue;
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`); } catch { /* already there */ }
  }
}

export function openLedger(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  retryWhileBusy(() => db.exec('PRAGMA journal_mode = WAL'), { tolerate: true });
  retryWhileBusy(() => db.exec(SCHEMA));
  ensureTables(db);
  const insert = db.prepare('INSERT INTO messages (session_id, role, kind, content, created_at, redactions) VALUES (?, ?, ?, ?, ?, ?)');
  const parse = (r) => ({ ...r, content: JSON.parse(r.content) });
  const q = (sql) => db.prepare(sql);
  return {
    db,
    close() { db.close(); },
    ensureSession(id, { model, cwd, forkedFrom = null, at }) { q('INSERT OR IGNORE INTO sessions (id, created_at, model, cwd, forked_from) VALUES (?, ?, ?, ?, ?)').run(id, at, model, cwd, forkedFrom); },
    fork(from, to) {
      const rows = q('SELECT role, kind, content, created_at, compacted_at, redactions FROM messages WHERE session_id = ? ORDER BY seq').all(from);
      const copy = q('INSERT INTO messages (session_id, role, kind, content, created_at, compacted_at, redactions) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const r of rows) copy.run(to, r.role, r.kind, r.content, r.created_at, r.compacted_at, r.redactions);
      return rows.length;
    },
    append(sessionId, role, kind, content, at, redactions = null) {
      return Number(insert.run(sessionId, role, kind, JSON.stringify(content), at, redactions ? JSON.stringify(redactions) : null).lastInsertRowid);
    },
    /** Uncompacted rows; a summary goes in front of the tail it summarises even though it was written after it. */
    active(sessionId) {
      return q("SELECT seq, role, kind, content FROM messages WHERE session_id = ? AND compacted_at IS NULL ORDER BY CASE WHEN kind = 'summary' THEN 0 ELSE 1 END, seq").all(sessionId).map(parse);
    },
    lastSeq(sessionId) { return q('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE session_id = ?').get(sessionId).seq; },
    lastOwnerSeq(sessionId) { return q("SELECT MAX(seq) AS seq FROM messages WHERE session_id=? AND kind='owner'").get(sessionId).seq; },
    /** The owner's message before the newest one (text blocks only, runtime clock dropped): the context a follow-up like "no, the new one" needs. */
    previousOwnerText(sessionId) {
      const row = q("SELECT content FROM messages WHERE session_id = ? AND kind = 'owner' ORDER BY seq DESC LIMIT 1 OFFSET 1").get(sessionId);
      if (!row) return '';
      try { return (JSON.parse(row.content) || []).filter((b) => b?.type === 'text' && !/^<runtime-clock>/u.test(b.text)).map((b) => b.text).join('\n').slice(0, 1200); } catch { return ''; }
    },
    lastPushedSeq(sessionId) { return q('SELECT COALESCE(MAX(to_seq), 0) AS seq FROM push_queue WHERE session_id = ?').get(sessionId).seq; },
    /** Marks exactly the summarised rows (not a seq range: an older summary has a higher seq than rows it covers). */
    compact(sessionId, seqs, at) {
      const mark = q('UPDATE messages SET compacted_at = ? WHERE session_id = ? AND seq = ? AND compacted_at IS NULL');
      let changed = 0;
      for (const seq of seqs) changed += mark.run(at, sessionId, seq).changes;
      return changed;
    },
    queuePush(sessionId, fromSeq, toSeq, at) { q("INSERT INTO push_queue (session_id, from_seq, to_seq, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(sessionId, fromSeq, toSeq, at); },
    pendingPushes(sessionId) { return q("SELECT * FROM push_queue WHERE session_id = ? AND status = 'pending' ORDER BY id").all(sessionId); },
    allPending() { return q("SELECT * FROM push_queue WHERE status = 'pending' ORDER BY id").all(); },
    reconcilePush(id, at, why, receipt) {
      q("UPDATE push_queue SET status = 'done', done_at = ?, last_error = ?, receipt = ? WHERE id = ? AND status = 'pending'")
        .run(at, `reconciled: ${why}`, JSON.stringify({ ...receipt, reconciled_at: at, reconciled_because: why }), id);
    },
    sessionsWithPending() { return q("SELECT DISTINCT session_id FROM push_queue WHERE status = 'pending' ORDER BY session_id").all().map((r) => r.session_id); },
    session(id) { return q('SELECT model, cwd, runner_pid FROM sessions WHERE id = ?').get(id); },
    claim(sessionId, pid) { q('UPDATE sessions SET runner_pid = ? WHERE id = ?').run(pid, sessionId); },
    holder(sessionId) { return q('SELECT runner_pid FROM sessions WHERE id = ?').get(sessionId)?.runner_pid ?? null; },
    settlePush(id, ok, error, at, receipt = null) {
      q('UPDATE push_queue SET status = ?, attempts = attempts + 1, last_error = ?, done_at = ?, receipt = ? WHERE id = ?').run(ok ? 'done' : 'pending', error, ok ? at : null, receipt ? JSON.stringify(receipt) : null, id);
    },
    lastRow(sessionId) {
      const row = q('SELECT seq, role, kind, content, compacted_at FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId);
      return row ? parse(row) : null;
    },
    rows(sessionId, fromSeq, toSeq) {
      return q('SELECT seq, role, kind, content, created_at FROM messages WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq').all(sessionId, fromSeq, toSeq).map(parse);
    },
  };
}

/**
 * Ledger rows to API messages: same-role rows merge (tool results first), an unanswered tool_use gets an
 * unknown-outcome result right after it, a result whose call was compacted away is dropped with a note, and the
 * request always starts and ends on a user message.
 */
export function buildMessages(rows) {
  const out = [], answered = new Set(), called = new Set(), openAt = new Map(), orphans = [];
  let dropped = 0;
  for (const row of rows) if (row.role === 'user') for (const p of row.content) if (p.type === 'tool_result') answered.add(p.tool_use_id);
  for (const row of rows) {
    let blocks = row.content.filter((p) => p.type !== 'thinking' || p.signature).map(({ input_error: _e, input_partial_json: _j, ...p }) => p);
    if (row.role === 'user') { const kept = blocks.filter((p) => p.type !== 'tool_result' || called.has(p.tool_use_id)); dropped += blocks.length - kept.length; blocks = kept; }
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === row.role) {
      const tr = (list, want) => list.filter((p) => (p.type === 'tool_result') === want);
      last.content = row.role === 'user' ? [...tr(last.content, true), ...tr(blocks, true), ...tr(last.content, false), ...tr(blocks, false)] : [...last.content, ...blocks];
    } else out.push({ role: row.role, content: blocks });
    if (row.role === 'assistant') for (const p of blocks) if (p.type === 'tool_use') {
      called.add(p.id);
      if (answered.has(p.id)) continue;
      orphans.push(p.id);
      openAt.set(out.length - 1, [...(openAt.get(out.length - 1) || []), p.id]);
    }
  }
  for (const at of [...openAt.keys()].sort((a, b) => b - a)) {
    const fills = openAt.get(at).map((id) => ({ type: 'tool_result', tool_use_id: id, is_error: true,
      content: 'The runner restarted before this tool call finished. Its outcome is unknown: check before repeating anything with a side effect.' }));
    if (out[at + 1]?.role === 'user') out[at + 1].content = [...fills, ...out[at + 1].content];
    else out.splice(at + 1, 0, { role: 'user', content: fills });
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '[earlier context was compacted]' }] });
  if (out.length && out[out.length - 1].role === 'assistant') out.push({ role: 'user', content: [{ type: 'text',
    text: '[This context ends with your own last message. Anything unanswered from the owner is in the history just above it: it arrived while that message was being written. Answer it now; do not repeat what you already said.]' }] });
  if (dropped) {
    const one = dropped === 1;
    if (!out.length) out.push({ role: 'user', content: [] });
    out[0].content.push({ type: 'text', text: `[${dropped} tool result${one ? '' : 's'} from before the compaction boundary ${one ? 'was' : 'were'} dropped: the tool call${one ? ' it answered is' : 's they answered are'} no longer in this context, so ${one ? 'its outcome is' : 'their outcomes are'} not stated here.]` });
  }
  return { messages: out, orphans };
}

/** Where compaction may cut: keep the last `keepRecent` rows and never split a tool call from its result. */
export function compactionCut(rows, keepRecent = 6) {
  if (rows.length <= keepRecent + 2) return 0;
  const answeredAt = new Map();
  rows.forEach((row, i) => { if (row.role === 'user') for (const p of row.content) if (p.type === 'tool_result') answeredAt.set(p.tool_use_id, i); });
  const reach = rows.map((row, i) => Math.max(i, ...row.content.filter((p) => p.type === 'tool_use').map((p) => answeredAt.get(p.id) ?? i)));
  let cut = rows.length - keepRecent;
  while (cut > 0 && reach.slice(0, cut).some((r) => r >= cut)) cut--;
  return cut;
}
