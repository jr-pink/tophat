#!/usr/bin/env node
// tophat-timer: the goal_wait retry timers (rev5/waits.mjs), seen from outside the webchat server.
//   tophat-timer list [--json]      every wait in every chat: chat, goal, due, last fired, ack state, late-by
//   tophat-timer check [--json]     prints and exits 1 on any wait overdue > 5 min, fired but unacknowledged, escalated, or a dead sweeper
//   tophat-timer fire ID            make a wait due now; the server's sweeper delivers it within one pass (30 s). ID = SESSION[:waitid|goalid]
//   tophat-timer log [N]            last N lines of fire-log.jsonl (every delivery, ack, escalation, failure)
//   tophat-timer prune [--dry-run]  remove waits whose goal is gone, closed, or owned by another chat (rev5/wait-sweeper.mjs)
// A wake counts as fired only once the chat has run a turn after it; see rev5/wait-sweeper.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allWaits, openWaits, problems, readSweeperBeat, waitsDir } from '../../runner/rev5/waits.mjs';
import { pruneOrphanWaits } from '../../runner/rev5/wait-sweeper.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const json = rest.includes('--json');
const args = rest.filter((a) => !a.startsWith('--'));
const nowMs = Date.now();
const mins = (ms) => `${Math.round(ms / 60e3)}m`;
const row = ({ session_id, wait }) => {
  const late = nowMs - Date.parse(wait.retry_at);
  const state = wait.pending ? (wait.pending.escalated ? 'ESCALATED' : `unacked(attempt ${wait.pending.attempts})`) : (wait.last_acked_fire ? `acked(fire ${wait.last_acked_fire})` : (wait.fires ? 'fired-before-acks' : 'never'));
  return { chat: session_id, wait: wait.id, goal: wait.goal_id, text: wait.text, due: wait.retry_at, fires: wait.fires || 0, last_fired: wait.last_fired_at || null, ack: state, late_by: late > 0 && !wait.pending ? mins(late) : '-' };
};

if (cmd === 'list') {
  const rows = allWaits().map(row).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  if (json) console.log(JSON.stringify({ sweeper: readSweeperBeat(), waits: rows }, null, 1));
  else {
    const beat = readSweeperBeat();
    console.log(`sweeper beat: ${beat ? `${beat.at} (${mins(nowMs - Date.parse(beat.at))} ago)` : 'none'}; ${rows.length} waits`);
    for (const r of rows) console.log([r.chat.slice(0, 8), r.wait, r.goal, `due ${r.due}`, `fires ${r.fires}`, `last ${r.last_fired || '-'}`, r.ack, `late ${r.late_by}`, JSON.stringify(String(r.text).slice(0, 50))].join('  '));
  }
} else if (cmd === 'check') {
  const bad = problems({ nowMs });
  if (json) console.log(JSON.stringify(bad.map((b) => ({ kind: b.kind, chat: b.session_id, wait: b.wait?.id, goal: b.wait?.goal_id, detail: b.detail })), null, 1));
  else for (const b of bad) console.log(`${b.kind}: ${b.session_id ? `${b.session_id.slice(0, 8)} ${b.wait.id} goal ${b.wait.goal_id} ` : ''}${b.detail}`);
  if (!bad.length && !json) console.log(`ok: ${allWaits().length} waits, none overdue or unacknowledged`);
  process.exitCode = bad.length ? 1 : 0;
} else if (cmd === 'fire') {
  const [sess, which] = String(args[0] || '').split(':');
  const hits = allWaits().filter(({ session_id, wait }) => sess && session_id.startsWith(sess) && (!which || wait.id === which || wait.goal_id === which));
  if (hits.length !== 1) { console.error(hits.length ? `ambiguous: ${hits.map((h) => `${h.session_id}:${h.wait.id}`).join(' ')}` : 'no such wait; tophat-timer list'); process.exit(2); }
  const { session_id, wait } = hits[0];
  const w = openWaits({ sessionId: session_id });
  // Due now and no pending delivery: the next sweeper pass posts it. Done through the same locked writer the runner uses.
  w.forceDue(wait.id);
  console.log(`${session_id} ${wait.id} (goal ${wait.goal_id}) is due now; the webchat sweeper delivers within 30s`);
} else if (cmd === 'prune') {
  const found = await pruneOrphanWaits({ dryRun: rest.includes('--dry-run'), log: (l) => console.log(l) });
  if (json) console.log(JSON.stringify(found, null, 1));
  else { for (const f of found) console.log(`${f.dry_run ? 'would remove' : 'removed'} ${f.session_id} ${f.wait} goal ${f.goal} work ${f.work || '-'}: ${f.reason}`); console.log(`${found.length} orphan wait(s)${rest.includes('--dry-run') ? ' (dry run)' : ''}`); }
} else if (cmd === 'log') {
  const lines = readFileSync(join(waitsDir(), 'fire-log.jsonl'), 'utf8').trim().split('\n');
  console.log(lines.slice(-(Number(args[0]) || 20)).join('\n'));
} else {
  console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exitCode = 2;
}
