// What the owner's typing does to a turn in flight. including the subagent launch which is often what i interrupt) and
// then that should go in background, hidden / ephemeral to user no like new chat or anything. then "its not about the
// stop/interrupt control, it's the typing interrupt". pull.mjs handle() moves the live turn onto a fork session
// `<session>/agent/bgturn_<8hex>` when a message is typed mid generation or mid tool call; agents.mjs adopt() registers it
// like a subagent. These are the words each side is given and the shape of the report that comes back. (The stop control
// is the other gesture: it cancels everything, background turns included.)
import { cut } from '../../src/core/unicode.mjs';
import { loadConfig } from '../base/config.mjs';

export const BACKGROUND_TURN_PREFIX = 'bgturn_';
export const isBackgroundTurn = (id) => String(id || '').startsWith(BACKGROUND_TURN_PREFIX);

export const BACKGROUND_MARK = (id) => `[the owner wrote here; the rest of this message and turn carry on in the background as ${id}]`;
export const BACKGROUND_CALL_NOTE = (id) => `still running: the owner wrote while this call was running, so the turn carries on in the background as ${id}; this call's result reaches you in that turn's report`;
export const PARTIAL_INPUT_CAP = 8000, CALL_INPUT_CAP = 3000;
export const BACKGROUND_NOTE = (id, view = null) => {
  const seen = view ? backgroundProgressText(view) : '';
  return `The owner wrote while the turn above was still running. It was not cancelled: it is a background turn, ${id}, STILL RUNNING on a copy of this context,`
    + ' with its model request and tool calls going on; its result reaches you as a "Background turn report" (an automated event, not his words) when it finishes.'
    + `${seen ? `\nWhat ${id} has produced so far and is still doing:\n${seen}` : ''}`
    + `\nDo not duplicate it: whatever ${id} is writing or calling above, it will finish by itself, so do not write that text again or make that call (launch that subagent, run that command) yourself.`
    + ` You decide, from what you can see above: (a) skip that step and carry on with his message, or just wait: end your turn and its report arrives on its own; (b) if what ${id} is doing is no longer what he wants, cancel it now with agent_cancel agent_id=${id}, and only then do the work yourself.`
    + ' His message follows: answer it now.';
};

/** The seconds a turn's current generation segment has been streaming, written the way the note says it. */
const secs = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

/** What a background turn is doing beyond the text already in the history: a tool call still being written (a subagent brief), calls running. */
export function backgroundProgressText({ generatingMs = 0, streaming = false, blocks = [], calls = [] } = {}) {
  const lines = [];
  for (const b of blocks) {
    if (b.type === 'tool_use' && streaming) lines.push(`- tool call ${b.name || '(name not yet written)'} still being written, input so far (${b.json.length} characters, cut off mid-write, not valid JSON yet): ${b.json.length > PARTIAL_INPUT_CAP ? `${b.json.slice(0, PARTIAL_INPUT_CAP)}…` : b.json}`);
  }
  for (const c of calls) {
    const input = JSON.stringify(c.input ?? {});
    lines.push(`- tool call already issued and running (its result is in the report): ${c.name} ${input.length > CALL_INPUT_CAP ? `${input.slice(0, CALL_INPUT_CAP)}…` : input}`);
  }
  if (!lines.length && !streaming) return '';
  return `${streaming ? `(its model request had been streaming for ${secs(generatingMs)} when he wrote and carries on; whatever text it had written is the message just above)` : `(its last request streamed for ${secs(generatingMs)} before the calls below)`}${lines.length ? `\n${lines.join('\n')}` : ''}`;
}

/** A turn's model stream as it is written: text and tool-call input so far, per content block, fed every stream event. */
export function createLiveView() {
  let blocks = [];
  return {
    reset() { blocks = []; },
    take(event) {
      if (event?.type === 'content_block_start') {
        const b = event.content_block || {};
        blocks[event.index] = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, json: '' } : b.type === 'text' ? { type: 'text', text: b.text || '' } : { type: b.type };
      } else if (event?.type === 'content_block_delta') {
        const b = blocks[event.index], d = event.delta || {};
        if (!b) return;
        if (d.type === 'text_delta' && b.type === 'text') b.text += d.text || '';
        else if (d.type === 'input_json_delta' && b.type === 'tool_use') b.json += d.partial_json || '';
      }
    },
    blocks: () => blocks.filter(Boolean).map((b) => ({ ...b })),
  };
}

/** The number is config.json `rev5.backgroundTurnMinGeneratingMs` (rev6/base/config.mjs), read here and nowhere else; it
 * throws when unset.
 */
export function backgroundMinGeneratingMs({ env = process.env, config } = {}) {
  const ms = (config || loadConfig({ env })).rev5.backgroundTurnMinGeneratingMs;
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('config.json rev5.backgroundTurnMinGeneratingMs is not set (integer milliseconds >= 0): a typed message cannot be told from a long-running turn without it');
  return ms;
}

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
