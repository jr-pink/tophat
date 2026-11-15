// What of one door grant still runs on this (team) host (docs/HOST-DESIGN.md item 5). The member's home host asks this after the grant's turn ended (GET /api/door) and keeps the
// door open while the answer is live. Read-only from the runner ledger, where rev6 tags each subagent, background turn and job with the
// grant of the turn that started it (rev6/base/door-tag.mjs):
//   turn    the chat's runner is busy and his latest message in it carries this grant (the turn itself, or a wake of it by a report)
//   agents  subagents and background turns tagged with the grant and still running
//   jobs    background jobs tagged with it and still running
// A row from before the tag existed (door NULL) in this chat's session tree counts for every grant of the chat: kept open, never cut.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { DOOR_TOOL_PATTERN, doorOf } from '../../../../runner/rev6/base/door-tag.mjs';

export { DOOR_TOOL_PATTERN, doorOf };

const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

/** { live, turn, agents, jobs, why } for `grant` in the chat whose runner session is `sessionId`; `busy` is the runner's own answer. */
export function doorWork({ ledgerPath, sessionId, grant, busy = false, open = (path) => new DatabaseSync(path, { readOnly: true }) }) {
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
    const jobsTagged = hasColumn(db, 'jobs', 'door');
    out.jobs = db.prepare(`SELECT id FROM jobs WHERE status = 'running' AND (${jobsTagged ? 'door = ? OR ' : ''}(${jobsTagged ? 'door IS NULL AND ' : ''}(session_id = ? OR session_id LIKE ?)))`)
      .all(...(jobsTagged ? [grant] : []), sessionId || '\u0000', tree).map((r) => r.id);
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
