// A live-run clock: no scheduler or idle wakeup. Call stop at every terminal edge.
import { owner, ownerPossessive } from '../../../../runner/owner.mjs';
export const PACE_CHECK = `<pace-check>Ten-minute checkpoint. Internal: not a new owner task, not a request to notify him, and never a reason to restart completed or paused work. Do not replace his goal with this timer instruction.

Recover ${ownerPossessive()} ORIGINAL goal in his own words, in full, with every correction he has made since and what would have to be true for him to call it done. Against that: what is finished and what shows it, what is in flight, what is delegated and to whom, what concrete progress the last ten minutes produced, and the bottleneck from your own timings.

Then be a new homunculus: arrive in this run for the first time, owing nothing to the sunk costs of whoever ran the last ten minutes. Am I tunnel-visioned on a subproblem or doing side work? Is this pace reasonable? Is this approach the one that finishes the recited goal? Change approach or stop costly ineffective work rather than pushing harder; send anything independent and longer than one tool call to a subagent now, re-delegate or split a step that is taking too long, and track every delegate you have out.

Keep the change minimal, do not overbuild. Do not go quiet: stay with him and say where you are.</pace-check>`;

export function createPaceClock({ now = Date.now, intervalMs = 600000,
  schedule = setTimeout, cancel = clearTimeout, active = () => true, remind = () => {} } = {}) {
  if (!(intervalMs > 0)) throw new Error('pace interval must be positive');
  let started = null, timer = null, generation = 0;
  const context = () => `<runtime-clock>UTC ${new Date(now()).toISOString()}; elapsed ${Math.max(0, now() - (started ?? now()))} ms. Check elapsed time against concrete progress.</runtime-clock>`;
  function arm() {
    const current = generation;
    timer = schedule(() => {
      timer = null;
      if (current !== generation || !active()) { stop(); return; }
      remind(`${context()}
${PACE_CHECK}`, { elapsedMs: Math.max(0, now() - (started ?? now())), at: now() });
      if (current === generation) arm();
    }, intervalMs);
    timer?.unref?.();
  }
  function start() { if (started !== null) return; started = now(); generation++; arm(); }
  function stop() { generation++; if (timer !== null) cancel(timer); timer = null; started = null; }
  return { start, stop, context };
}
