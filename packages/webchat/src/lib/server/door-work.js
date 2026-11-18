// What of one door grant still runs on this (team) host (docs/HOST-DESIGN.md item 5). The member's home host asks this after the grant's turn ended (GET /api/door) and keeps the
// door open while the answer is live. Read-only from the runner ledger, where rev6 tags each subagent, background turn and job with the
// grant of the turn that started it (rev6/base/door-tag.mjs):
//   turn    the chat's runner is busy and his latest message in it carries this grant (the turn itself, or a wake of it by a report)
//   agents  subagents and background turns tagged with the grant and still running
//   jobs    background jobs tagged with it and still running
// The same route also answers who a door caller is: `agent` (doorAgent) maps a subagent id the door tool presents (TOPHAT_AGENT_ID) to whether that
// subagent of this chat runs now and the grant it was started under; the home host decides on that, never the caller.
// A row from before the tag existed (door NULL) in this chat's session tree counts for every grant of the chat: kept open, never cut.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { DOOR_TOOL_PATTERN, doorOf } from '../../../../runner/rev6/base/door-tag.mjs';

export { DOOR_TOOL_PATTERN, doorOf };

const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

/**
 * The grant a row counts for. A row the runner tagged is that grant's. A row tagged '' (started under no door, or by a runner older than the
 * notice that names the grant in words, which could not read it) counts for the grant of the latest owner message that carried a door notice
 * before the row began: the door stays open a little longer for it, never shorter. Null when there is none.
 */
function inheritedGrant(db, sessionId, at) {
  if (!sessionId || !at) return null;
  const row = db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND kind = 'owner' AND created_at <= ? AND content LIKE '%tophat-doors%' ORDER BY seq DESC LIMIT 1").get(sessionId, at);
  return doorOf(row?.content)?.grant || null;
}

/** { live, turn, agents, jobs, why } for `grant` in the chat whose runner session is `sessionId`; `busy` is the runner's own answer. */
export function doorWork({ ledgerPath, sessionId, grant, busy = false, openGrants = null, holder = false, open = (path) => new DatabaseSync(path, { readOnly: true }) }) {
  const out = { grant, live: false, turn: false, agents: [], jobs: [], why: '' };
  if (!grant || !ledgerPath || !existsSync(ledgerPath)) return out;
  let db;
  try {
    db = open(ledgerPath);
    if (busy && sessionId) {
      const row = db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND kind = 'owner' ORDER BY seq DESC LIMIT 1").get(sessionId);
      out.turn = doorOf(row?.content)?.grant === grant;
    }
    const tree = sessionId ? `${sessionId}/agent/%` : '\u0000';
    const tagged = hasColumn(db, 'agents', 'door');
    out.agents = db.prepare(`SELECT id FROM agents WHERE status = 'running' AND (${tagged ? 'door = ? OR ' : ''}(${tagged ? 'door IS NULL AND ' : ''}(parent_session = ? OR parent_session LIKE ?)))`)
      .all(...(tagged ? [grant] : []), sessionId || '\u0000', tree).map((r) => r.id);
    if (tagged) for (const r of db.prepare("SELECT id, created_at FROM agents WHERE status = 'running' AND door = '' AND (parent_session = ? OR parent_session LIKE ?)").all(sessionId || '\u0000', tree)) {
      if (inheritedGrant(db, sessionId, r.created_at) === grant) out.agents.push(r.id);
    }
    const jobsTagged = hasColumn(db, 'jobs', 'door');
    out.jobs = db.prepare(`SELECT id FROM jobs WHERE status = 'running' AND (${jobsTagged ? 'door = ? OR ' : ''}(${jobsTagged ? 'door IS NULL AND ' : ''}(session_id = ? OR session_id LIKE ?)))`)
      .all(...(jobsTagged ? [grant] : []), sessionId || '\u0000', tree).map((r) => r.id);
    if (jobsTagged) for (const r of db.prepare("SELECT id, started_at FROM jobs WHERE status = 'running' AND door = '' AND (session_id = ? OR session_id LIKE ?)").all(sessionId || '\u0000', tree)) {
      if (inheritedGrant(db, sessionId, r.started_at) === grant) out.jobs.push(r.id);
    }
    // The holder (the chat's newest open grant at the home host) also keeps what runs under a grant the home host no longer has open (its door
    // closed by a restart of an older build, a cap, a failure): a running subagent or job is never left without a door while any grant of its chat is open.
    if (holder && Array.isArray(openGrants)) {
      const live = new Set(openGrants);
      const orphan = (door, at) => { const g = door || inheritedGrant(db, sessionId, at); return Boolean(g) && !live.has(g); };
      if (tagged) for (const r of db.prepare("SELECT id, created_at, door FROM agents WHERE status = 'running' AND (parent_session = ? OR parent_session LIKE ?)").all(sessionId || '\u0000', tree)) {
        if (!out.agents.includes(r.id) && orphan(r.door, r.created_at)) out.agents.push(r.id);
      }
      if (jobsTagged) for (const r of db.prepare("SELECT id, started_at, door FROM jobs WHERE status = 'running' AND (session_id = ? OR session_id LIKE ?)").all(sessionId || '\u0000', tree)) {
        if (!out.jobs.includes(r.id) && orphan(r.door, r.started_at)) out.jobs.push(r.id);
      }
    }
  } catch (cause) {
    // Unreadable: say live, so the home host keeps the door rather than cutting work off (its 2 h cap still ends it).
    return { ...out, live: true, why: `ledger unreadable (${cause.message})` };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
  out.live = out.turn || out.agents.length > 0 || out.jobs.length > 0;
  out.why = out.live ? [out.turn && 'turn', out.agents.length && `${out.agents.length} subagent(s)`, out.jobs.length && `${out.jobs.length} job(s)`].filter(Boolean).join(', ') : '';
  return out;
}

/**
 * { agent, known, live, grant } for subagent (or background turn) `agent` of the chat whose runner session is `sessionId`: `known` when the
 * ledger has it in this chat's tree, `live` while it runs, `grant` the door grant it was started under ('' none). Throws when the ledger is
 * unreadable (the home host then answers the caller "retry", never "allowed").
 */
export function doorAgent({ ledgerPath, sessionId, agent, open = (path) => new DatabaseSync(path, { readOnly: true }) }) {
  const out = { agent, known: false, live: false, grant: '' };
  if (!agent || !sessionId || !ledgerPath || !existsSync(ledgerPath)) return out;
  const db = open(ledgerPath);
  try {
    const tagged = hasColumn(db, 'agents', 'door');
    const row = db.prepare(`SELECT status, created_at${tagged ? ', door' : ''} FROM agents WHERE id = ? AND (parent_session = ? OR parent_session LIKE ?)`).get(agent, sessionId, `${sessionId}/agent/%`);
    if (!row) return out;
    return { agent, known: true, live: row.status === 'running', grant: row.door || inheritedGrant(db, sessionId, row.created_at) || '' };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}
