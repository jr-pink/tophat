// What the owner's typing does to a turn in flight. including the subagent launch which is often what i interrupt) and
// then that should go in background, hidden / ephemeral to user no like new chat or anything. then "its not about the
// stop/interrupt control, it's the typing interrupt". pull.mjs handle() moves the live turn onto a fork session
// `<session>/agent/bgturn_<8hex>` when a message is typed mid generation or mid tool call; agents.mjs adopt() registers it
// like a subagent. These are the words each side is given and the shape of the report that comes back. (The stop control
// is the other gesture: it cancels everything, background turns included.)
import { cut } from '../../src/core/unicode.mjs';

export const BACKGROUND_TURN_PREFIX = 'bgturn_';
export const isBackgroundTurn = (id) => String(id || '').startsWith(BACKGROUND_TURN_PREFIX);

export const BACKGROUND_MARK = (id) => `[the owner wrote here; the rest of this message and turn carry on in the background as ${id}]`;
export const BACKGROUND_CALL_NOTE = (id) => `still running: the owner wrote while this call was running, so the turn carries on in the background as ${id}; this call's result reaches you in that turn's report`;
export const BACKGROUND_NOTE = (id) => `The owner wrote while the turn above was still running. It was not cancelled: it carries on in the background as ${id}, on a copy of this context,`
  + ' with its model request and tool calls still running, and its result reaches you as a "Background turn report" (an automated event, not his words) when it finishes.'
  + ' His message follows: answer it now; do not redo what that turn is doing unless he asks. agent_cancel stops it if he wants it stopped.';
export const BACKGROUND_FORK_NOTE = 'The owner wrote a new message while this turn was running, so it moved to the background and the main conversation carries on without waiting for it.'
  + ' Finish the work it was doing, as you would have. Your final message is not shown to him directly: it is delivered to the main conversation as a report, so make it a complete account of what you found and did.';
export const BACKGROUND_CANCEL_MARK = '[the background turn was cancelled here]';

/** One line naming a background turn: what the turn was answering, cut short. */
export function backgroundGist(text) {
  const flat = String(text || '').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
  return flat.length > 80 ? `${cut(flat, 79)}…` : (flat || 'the earlier turn');
}

/** The report: the tool calls run after the interrupt (start of each result), then the final text, which keeps most of the room. */
export function backgroundResult({ status = 'done', finalText = '', failure = null, log = [] } = {}, cap = 12_000) {
  const head = status === 'failed' ? `[failed: ${failure || 'unknown'}]\n` : status === 'cancelled' ? '[cancelled before finishing]\n' : '';
  const said = finalText ? `Final text:\n${cut(finalText, Math.floor(cap * 0.7))}` : 'It wrote no final text.';
  let room = cap - head.length - said.length - 64;
  const lines = [];
  for (const e of log) {
    const line = `- ${e.name} ${cut(JSON.stringify(e.input ?? {}), 160)} -> ${e.isError ? 'error: ' : ''}${cut(String(e.content ?? '').replace(/\s+/gu, ' '), 400)}`;
    if (line.length > room) { lines.push(`- (${log.length - lines.length} more not shown)`); break; }
    lines.push(line);
    room -= line.length + 1;
  }
  const calls = log.length ? `Tool calls after the owner wrote (${log.length}):\n${lines.join('\n')}\n` : 'No tool calls after the owner wrote.\n';
  return `${head}${calls}${said}`;
}

/** The context block a delivered background turn arrives as in the main session. */
export function backgroundReportText(a) {
  return `The turn that was running when the owner wrote carried on in the background as ${a.agent_id} (${String(a.description || '').replace(/^Background turn: /u, '')}) and is now ${a.status}`
    + `${a.cost_usd != null ? `, cost ${a.cost_usd} USD` : ''}. He has not seen this yet: tell him what matters of it in a line or two, folded into whatever you are doing now.\n${a.result || ''}`;
}
