// What a conversation is still owed by work that outlives its turns: subagents running inside its runner process,
// and subagent reports not yet delivered to it. Read straight from the runner ledger (rev6/pull/ledger.mjs, the
// `agents` table), read-only, because the runner that owned them is gone by the time a boot asks.
//
// Why a boot asks: a deploy ended the runner of the owner's own chat while a subagent was working in it. The
// chat's last run had "completed" (it was waiting for the subagent), so bootPlan held it ("its last run ended
// completed, which no restart cut off"), nothing reopened it, the subagent's row was marked uncertain by a
// neighbour's sweep, and the chat stayed dead for 80 minutes. A turn that ended is not a conversation with
// nothing to do.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

export const OWED_WITHIN_MS = 60 * 60_000;

/**
 * The subagents owed to `sessionId`: still marked running, or finished/failed/uncertain within `within` ms with
 * no report delivered. Never throws: a ledger that cannot be read owes nothing here, and the caller says so.
 */
export function agentsOwed({ ledgerPath, sessionId, now = Date.now(), within = OWED_WITHIN_MS, open = (path) => new DatabaseSync(path, { readOnly: true }) } = {}) {
  if (!ledgerPath || !sessionId || !existsSync(ledgerPath)) return [];
  let db;
  try {
    db = open(ledgerPath);
    const since = new Date(now - within).toISOString();
    return db.prepare("SELECT id, status FROM agents WHERE parent_session = ? AND (status = 'running' OR (delivered_at IS NULL AND ended_at >= ?)) ORDER BY created_at")
      .all(sessionId, since).map((row) => ({ id: row.id, status: row.status }));
  } catch (cause) {
    console.error(`[app] could not read the subagents owed to ${sessionId} (${cause.message}); treating it as none`);
    return [];
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
