// The timer behind goal_wait (rev5/waits.mjs): runs rev5/wait-sweeper.mjs inside the webchat server and supplies its two
// store-side hooks, deliver (post the wake into the owning chat) and probe (has that chat run a turn since).
import { beatSweeperAsync } from '../../../../runner/rev5/waits.mjs';
import { sweepWaits } from '../../../../runner/rev5/wait-sweeper.mjs';

export const RETRY_SWEEP_MS = Number(process.env.WEBCHAT_RETRY_SWEEP_MS || 30_000);
const PASS_TIMEOUT_MS = 120_000;

/** Events that prove a turn ran after a wake was appended: it started (idle chat) or answered/finished (steered into a live one). */
const ACK_KINDS = new Set(['assistant.message', 'run.completed', 'run.cancelled', 'run.failed']);
const isAck = (e) => ACK_KINDS.has(e.kind) || (e.kind === 'run.status' && e.content?.state === 'running');
const ACTIVITY_KINDS = new Set(['tool.started', 'tool.completed', 'thinking.delta', 'assistant.delta', 'agent.started']);

/** A run.error that says no turn could start in that process (pull runner or credential missing). */
const isRefusal = (e) => e.kind === 'run.error' && Boolean(e.content?.notReady);

/** probe for sweepWaits, over a webchat store: reads the conversation's events after the wake's cursor. */
export function storeProbe(store, resolveConversation) {
  return ({ sessionId, cursor }) => {
    const id = resolveConversation(store, sessionId);
    if (!id || cursor == null) return null;
    const events = store.conversationEvents(id, { after: cursor, limit: 2000 });
    const acked = events.some(isAck);
    return { acked, active: events.some((e) => isAck(e) || ACTIVITY_KINDS.has(e.kind)), ...(!acked && events.some(isRefusal) ? { refused: true } : {}) };
  };
}

/** deliver for sweepWaits, over a webchat app: post the wake into the owning chat through settle(), the path a push wake
 * takes.
 */
export function storeDeliver({ store, runner, resolveConversation, settle }) {
  return async (text, { actionId, sessionId }) => {
    const conversationId = resolveConversation(store, sessionId);
    if (!conversationId) throw Object.assign(new Error(`unknown conversation ${sessionId}`), { code: 'unknown-conversation' });
    // The key names the session: wait ids (w1, w2) repeat in every chat, and the old `retry:w1:0` made one chat's wake
    // look already applied for all the others, so 240 of 272 wakes were skipped silently while counted as fired.
    const key = `retry:${actionId}`;
    const done = store.appliedAction(key);
    if (done) return { cursor: done.cursor_before, duplicate: true };
    const ready = runner?.readiness ? runner.readiness(conversationId) : { ok: true };
    if (!ready.ok) throw Object.assign(new Error(`no turn can start for ${conversationId} in this process: ${ready.reason}`), { code: 'runner-not-ready' });
    const cursorBefore = store.cursor();
    const id = store.ffAccept(text);
    await settle(id, { text, conversationId });
    store.markApplied({ actionId: key, conversationId, op: 'retry.wake', cursorBefore, cursorAfter: store.cursor() });
    return { cursor: cursorBefore };
  };
}

/** Is this process the one serving the port? serve.mjs sets Symbol.for('tophat.webchat.listening') true once its
 * listener is up and false the moment it closes (SIGTERM, owner gone). A process booted by serve.mjs
 * (WEBCHAT_SERVER_BOOT names its pid) runs wakes only while that flag is true; anything else (unit tests, a
 * harness importing the module) has no listener to consult and runs them. A wake it skips is not lost: the wait
 * stays due in the shared store and the live server's next pass delivers it.
 */
export function mayRunWakes({ env = process.env, pid = process.pid, flag = globalThis[Symbol.for('tophat.webchat.listening')] } = {}) {
  if (String(env.WEBCHAT_SERVER_BOOT || '') !== String(pid)) return true;
  return flag === true;
}

/** The timer. Replaces its own, so a hot swap that adopts the app leaves one. */
export function startRetryWakes({ deliver, probe, escalate, interval = RETRY_SWEEP_MS, env = process.env, log = console.log, canRun = () => mayRunWakes({ env }) } = {}) {
  const key = Symbol.for('tophat.webchat.retrywakes');
  try { clearInterval(globalThis[key]); } catch { /* none yet */ }
  let busySince = 0;
  let quiet = false;
  const pass = () => {
    // Fail soft: not the listener, so do nothing (no run.error, no fire log, no sweeper beat); the due wait stays armed.
    if (!canRun()) { if (!quiet) { quiet = true; console.warn('[retry-wakes] this process is not the one serving the port; goal retry wakes paused here'); } return; }
    quiet = false;
    // A pass stuck on a hung deliver() used to hold `busy` forever and silently stop every wake in the server.
    if (busySince && Date.now() - busySince < PASS_TIMEOUT_MS) return;
    if (busySince) console.error(`[retry-wakes] previous pass hung ${Math.round((Date.now() - busySince) / 1000)}s, starting a new one`);
    const mine = busySince = Date.now();
    sweepWaits({ deliver, probe, escalate, env, log }).catch((error) => console.error(`[retry-wakes] sweep failed: ${error.message}`)).finally(() => { if (busySince === mine) busySince = 0; });
  };
  const timer = setInterval(pass, interval);
  timer.unref?.();
  globalThis[key] = timer;
  beatSweeperAsync({ env });
  setTimeout(pass, 2000).unref?.(); // a restart does not wait a whole interval before catching up
  return timer;
}
