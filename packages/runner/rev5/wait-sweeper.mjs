// One pass of the goal_wait sweeper, with delivery acknowledgement (rev5/waits.mjs; webchat/src/lib/server/retry-wakes.js
// runs it on a timer inside the webchat server).
//
// The chain this closes:
//  1. The idempotency key was `retry:<wait id>:<fires>`, and wait ids (w1, w2) repeat in every chat, so chat B's first fire
//     found chat A's "w1:0" already applied, returned without posting, and was still marked fired: 240 of 272 logged
//     wakes never reached a chat. The key now carries the session id and the attempt.
//  2. "Fired" meant "deliver() returned", i.e. a message was appended and a runner told; nothing checked a turn followed.
//     A delivery is now `pending` until the chat is seen running after it (probe), or re-armed itself (goal_wait);
//     unacked deliveries are redelivered after ACK_GRACE_MS, up to MAX_ATTEMPTS, then escalated, never silent.
//  3. An unknown chat was backed off as if fired; it is now logged and escalated.
//  4. The server log had no timestamps and nothing recorded due time vs fired time: fire-log.jsonl does.
//  6. a server whose build was pruned kept sweeping: each
//     wake was appended, refused by the runner (run.error notReady) and still counted as delivered, five times per fire.
//     Now only the listening server sweeps (retry-wakes.js mayRunWakes), deliver() asks the runner first and throws
//     'runner-not-ready' without appending, and a refusal seen by the probe redelivers at once instead of after the grace.
//  5. A hung deliver() left the sweeper's `busy` flag set forever; the pass now times out, and every pass writes sweeper.json
//     so `tophat-timer check` sees a dead sweeper from outside.
import { allWaitsAsync, beatSweeperAsync, logFire, openWaits, wakeText } from './waits.mjs';

export const ACK_GRACE_MS = Number(process.env.WEBCHAT_RETRY_ACK_GRACE_MS || 60_000);
export const ACTIVE_MAX_MS = 30 * 60e3; // a chat busy this long without ever producing a reply is escalated
export const MAX_ATTEMPTS = 5;

/**
 * deliver(text, { actionId, sessionId, attempt }) -> { cursor } ; rejects (code 'unknown-conversation' for a missing chat).
 * probe({ sessionId, cursor }) -> { acked, active } ; acked: a turn ran after the wake, active: the chat shows other activity.
 * escalate({ kind, sessionId, wait, detail }) surfaces a give-up (digest); never throws into the pass.
 */
export async function sweepWaits({ deliver, probe, escalate = async () => {}, env = process.env, nowMs = Date.now(), log = () => {} } = {}) {
  const out = [];
  const nowIso = new Date(nowMs).toISOString();
  const fl = (r) => logFire(r, { env, now: () => nowIso });
  const raise = async (kind, sessionId, wait, detail) => {
    openWaits({ sessionId, env, now: () => nowIso }).escalated(wait.id);
    fl({ event: 'escalated', kind, session_id: sessionId, wait: wait.id, goal: wait.goal_id, fire: wait.pending?.fire ?? wait.fires, detail });
    log(`[retry-wakes] ESCALATED ${sessionId} goal ${wait.goal_id}: ${detail}`);
    try { await escalate({ kind, sessionId, wait, detail }); } catch (e) { log(`[retry-wakes] escalation not posted: ${e.message}`); }
    out.push({ wait: wait.id, sessionId, escalated: true, detail });
  };
  // Read asynchronously: this runs on the webchat server's HTTP thread (allWaitsAsync says why).
  for (const { session_id: sessionId, wait } of await allWaitsAsync({ env })) {
    const p = wait.pending && !wait.pending.escalated ? wait.pending : null;
    if (p) {
      let seen = null;
      try { seen = await probe({ sessionId, cursor: p.cursor }); } catch (e) { log(`[retry-wakes] probe failed for ${sessionId}: ${e.message}`); }
      if (seen?.acked) {
        openWaits({ sessionId, env, now: () => nowIso }).acked(wait.id);
        fl({ event: 'acked', session_id: sessionId, wait: wait.id, goal: wait.goal_id, fire: p.fire, attempts: p.attempts, ack_after_s: Math.round((nowMs - Date.parse(p.first_delivered_at)) / 1000) });
        out.push({ wait: wait.id, sessionId, acked: true });
        continue;
      }
      // The process that took the wake said no turn could start there (run.error notReady): waiting out the grace
      // window only makes the reminder later, so the next attempt goes now.
      if (!seen || (!seen.refused && nowMs - Date.parse(p.delivered_at) < ACK_GRACE_MS)) continue;
      if (seen.active) {
        if (nowMs - Date.parse(p.first_delivered_at) >= ACTIVE_MAX_MS) await raise('busy-no-reply', sessionId, wait, `chat has been running ${Math.round((nowMs - Date.parse(p.first_delivered_at)) / 60e3)} min since fire ${p.fire} without replying`);
        continue; // mid-turn: the steering message is in, redelivering would only stack copies
      }
      if (p.attempts >= MAX_ATTEMPTS) { await raise('unacked', sessionId, wait, `fire ${p.fire} delivered ${p.attempts} times, no turn followed`); continue; }
      await attempt({ sessionId, wait, attempt: p.attempts + 1, dueAt: p.due_at });
      continue;
    }
    if (Date.parse(wait.retry_at) <= nowMs) await attempt({ sessionId, wait, attempt: 1, dueAt: wait.retry_at });
  }
  await beatSweeperAsync({ env, now: () => nowIso, extra: { delivered: out.filter((o) => o.delivered).length } });
  return out;

  async function attempt({ sessionId, wait, attempt: n, dueAt }) {
    const fire = n > 1 ? wait.fires : (wait.fires || 0) + 1;
    const actionId = `${sessionId}:${wait.id}:${fire}:${n}`;
    const base = { session_id: sessionId, wait: wait.id, goal: wait.goal_id, fire, attempt: n, due_at: dueAt, late_by_s: Math.round((nowMs - Date.parse(dueAt)) / 1000) };
    try {
      const sent = await deliver(wakeText(wait, nowIso, undefined, { attempt: n }), { actionId, sessionId, attempt: n });
      openWaits({ sessionId, env, now: () => nowIso }).delivered(wait.id, { cursor: sent?.cursor ?? null, dueAt });
      fl({ event: n > 1 ? 'redelivered' : 'delivered', ...base, cursor: sent?.cursor ?? null });
      log(`[retry-wakes] ${n > 1 ? 'redelivered' : 'delivered'} to ${sessionId} goal ${wait.goal_id} (fire ${fire}, attempt ${n}), awaiting a turn`);
      out.push({ wait: wait.id, sessionId, delivered: true, attempt: n });
    } catch (error) {
      if (base.late_by_s < 60 || base.late_by_s % 300 < 30) fl({ event: 'failed', ...base, error: String(error?.message ?? error), code: error?.code }); // throttled: a stuck wait is not 2880 lines a day
      out.push({ wait: wait.id, sessionId, delivered: false, error: String(error?.message ?? error) });
      if (error?.code === 'unknown-conversation') {
        // Re-arming it like a fire would hide a lost chat; surface it once, then back off so it is not logged every pass.
        openWaits({ sessionId, env, now: () => nowIso }).delivered(wait.id, { dueAt });
        await raise('unknown-chat', sessionId, openWaits({ sessionId, env }).read().find((w) => w.id === wait.id) || wait, `no chat resolves runner session ${sessionId}`);
      } else log(`[retry-wakes] ${sessionId} goal ${wait.goal_id}: wake not delivered, will retry: ${error?.message ?? error}`);
    }
  }
}
