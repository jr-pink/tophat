// The request the API will actually accept, built from the conversation we actually have.
//
// A Messages request is not just JSON: it has structural rules, and breaking one gets a 400 that
// every retry and every fallback model reproduces exactly, because the flaw is in the history being
// replayed rather than in the provider. Those are the failures that killed whole chats: the turn
// climbs the recovery ladder, fails identically four times, and ends.
//
// So the ledger is the record and this is the wire: everything here is a repair applied on the way
// out, never a rewrite of what was stored. The rules, from the API's own 400 texts:
//   - every message needs non-empty content, and a text block needs non-empty text
//   - every `tool_use` needs a `tool_result` with its id in the very next message; a restart, an
//     interrupt or a compaction that cut between the two leaves one hanging, and two turns sharing a
//     session interleave rows so a real result can sit a message or more late (it is moved, not lost)
//   - one message may not carry the same `tool_use` id twice
//   - a `tool_result` whose `tool_use_id` was never issued is rejected the same way
//   - a `tool_result` needs content; an empty string is not content
//   - the first message must be the user's
//   - the last message, if it is the assistant's, must not end in whitespace
// Anything this drops is named in the returned notes, so a turn can say what it had to leave out.

const isText = (block) => block?.type === 'text';
const textOf = (block) => (typeof block?.text === 'string' ? block.text : '');

/** The content of one message as an array of blocks, whatever shape it arrived in. */
function blocksOf(message) {
  const content = message?.content;
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === 'object');
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return [];
}

/** One tool_result standing in for a call whose answer never reached the ledger. It must not say "not
 * run": a call cut off by a restart or an interrupt may well have run (a commit, a deploy, a payment, a
 * message sent), so the model is told the outcome is unknown, in the runner's own restart wording
 * (rev5/pull.mjs buildMessages), and to check before repeating anything with a side effect.
 */
export const MISSING_RESULT_TEXT = 'No result was recorded for this tool call: the turn was cut off before it finished. Its outcome is unknown: check before repeating anything with a side effect.';
const missingResult = (id) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: MISSING_RESULT_TEXT });

/**
 * A structurally valid `messages` array, plus notes on what was changed. Pure: the input is not
 * mutated, and a conversation that is already valid comes back with the same blocks (new arrays).
 */
export function repairMessages(input = []) {
  const notes = [];
  const source = Array.isArray(input) ? input.filter((m) => m && typeof m === 'object') : [];

  // Pass 1, block by block: empty text goes, a call gets an id, an empty result gets content, and one
  // message never carries the same call id twice. Results are only collected here; where they go is
  // decided by the call they answer, below.
  const cleaned = [];
  for (const message of source) {
    const kept = [];
    const callIds = new Set();
    for (const block of blocksOf(message)) {
      if (isText(block)) {
        if (!textOf(block).trim()) { notes.push('dropped an empty text block'); continue; }
        kept.push(block);
        continue;
      }
      if (block.type === 'tool_result') {
        const content = block.content;
        const empty = content === undefined || content === null || content === ''
          || (Array.isArray(content) && !content.length);
        kept.push(empty ? { ...block, content: '[no output]' } : block);
        continue;
      }
      if (block.type === 'tool_use') {
        const withId = block.id ? block : { ...block, id: `toolu_repaired_${cleaned.length}_${kept.length}` };
        if (callIds.has(withId.id)) { notes.push(`dropped a second tool_use with the same id in one message (${withId.id})`); continue; }
        callIds.add(withId.id);
        kept.push(withId);
        continue;
      }
      kept.push(block);
    }
    cleaned.push({ message, kept });
  }

  // Pass 2, adjacency. The API reads a call's answer out of the message immediately after it and
  // nowhere else ("`tool_use` ids were found without `tool_result` blocks immediately after"). The
  // ledger does not always store it there: two turns running in one session interleave their rows,
  // so one turn's result can land behind the other turn's next call, two messages late. Pairing
  // "anywhere later" passed that through and every retry, compaction and fallback model got the same
  // 400. So each call's real result is moved into the message right after it, ahead of anything else
  // there; only a call with no recorded result anywhere gets the not-run stand-in. Results are taken
  // by position: the first unclaimed result with the id after the call, and never one from beyond a
  // later call that re-uses the id (that answer is its).
  const claimed = new Set(); // "message index:block index" of results already placed
  const answers = new Map(); // message index -> results that must open the message after it
  cleaned.forEach(({ kept }, i) => {
    const calls = kept.filter((block) => block.type === 'tool_use');
    if (!calls.length) return;
    const results = [];
    let moved = 0;
    let missing = 0;
    for (const call of calls) {
      let found = null;
      search: for (let j = i + 1; j < cleaned.length; j++) {
        const blocks = cleaned[j].kept;
        for (let k = 0; k < blocks.length; k++) {
          const block = blocks[k];
          if (block.type === 'tool_use' && block.id === call.id) break search;
          if (block.type !== 'tool_result' || block.tool_use_id !== call.id || claimed.has(`${j}:${k}`)) continue;
          claimed.add(`${j}:${k}`);
          found = { block, at: j };
          break search;
        }
      }
      if (found) {
        if (found.at !== i + 1 || cleaned[found.at].message.role !== 'user') moved += 1;
        results.push(found.block);
      } else {
        missing += 1;
        results.push(missingResult(call.id));
      }
    }
    answers.set(i, results);
    if (moved) notes.push(`moved ${moved} tool result${moved === 1 ? '' : 's'} into the message right after ${moved === 1 ? 'its call' : 'their calls'}`);
    if (missing) notes.push(`answered ${missing} tool call${missing === 1 ? '' : 's'} left hanging by an interrupted turn`);
  });

  const out = [];
  cleaned.forEach(({ message, kept }, i) => {
    const before = answers.get(i - 1);
    const own = kept.filter((block, k) => {
      if (block.type !== 'tool_result') return true;
      if (claimed.has(`${i}:${k}`)) return false; // placed after its call, from here or from wherever it was
      const id = block.tool_use_id;
      const issued = id && cleaned.slice(0, i).some((c) => c.kept.some((b) => b.type === 'tool_use' && b.id === id));
      notes.push(issued ? `dropped a tool_result for a call already answered (${id})` : `dropped a tool_result for a call that was never made (${id || 'no id'})`);
      return false;
    });
    // The message after a call is the user's, opening with every answer to that call.
    if (before && message.role === 'user') { out.push({ ...message, content: [...before, ...own] }); return; }
    if (before) out.push({ role: 'user', content: before });
    if (!own.length) { notes.push(`dropped an empty ${message.role || 'unknown'} message`); return; }
    out.push({ ...message, content: own });
  });
  const trailing = answers.get(cleaned.length - 1);
  if (trailing) out.push({ role: 'user', content: trailing });

  // The conversation has to open with the owner.
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '[the earlier part of this conversation is not in this request]' }] });
    notes.push('prefixed the request with a user message: it began on an assistant turn');
  }

  // A trailing assistant message is a prefill, and a prefill may not end in whitespace.
  const last = out[out.length - 1];
  if (last?.role === 'assistant') {
    const at = last.content.length - 1;
    const tail = last.content[at];
    if (isText(tail) && textOf(tail) !== textOf(tail).trimEnd()) {
      const trimmed = textOf(tail).trimEnd();
      const content = last.content.slice(0, at);
      if (trimmed) content.push({ ...tail, text: trimmed });
      if (content.length) { out[out.length - 1] = { ...last, content }; notes.push('trimmed trailing whitespace from the assistant prefill'); }
      else { out.pop(); notes.push('dropped a whitespace-only assistant prefill'); }
    }
  }

  return { messages: out, notes };
}

/** The same repair over a whole request body; `system` and `tools` are left as they are. */
export function repairRequest(request = {}) {
  const { messages, notes } = repairMessages(request.messages);
  return { request: { ...request, messages }, notes };
}
