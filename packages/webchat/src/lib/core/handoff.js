// Carrying a conversation across a provider change.
//
// Every provider keeps its own transcript under its own session id: the Claude
// CLI in ~/.claude, codex in its own store, the rev 5 direct runner in its
// ledger. The webchat's session id is whichever one of those the last child
// reported, so resuming it with a *different* provider resumes nothing: codex
// refuses the id, and rev 5 opens an empty session under it and answers the
// next message as if the chat had just begun.
//
// The webchat has the one transcript all of them share: its own event store.
// So a switch starts a fresh session for the new provider and hands it what
// was said, as a block in front of the next message. It is the chat's history,
// not an instruction, and it says so.

const BUDGET = Number(process.env.WEBCHAT_HANDOFF_BUDGET || 120_000);

/** One line of the rendered block; the speaker names are the ones a model reads as roles. */
function line(turn) {
  const who = turn.role === 'user' ? 'Owner' : 'You';
  return `${who}: ${String(turn.text ?? '').trim()}`;
}

/**
 * The newest turns that fit in `budget` characters, oldest first, with how
 * many were dropped off the front. Newest is what the next message is about;
 * a middle cut would be a lie about where the chat starts.
 */
export function fitTurns(turns, budget = BUDGET) {
  const kept = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const cost = line(turns[index]).length + 1;
    if (used + cost > budget && kept.length) break;
    kept.unshift(turns[index]);
    used += cost;
  }
  return { kept, dropped: turns.length - kept.length };
}

/**
 * The block that opens the first message a new provider's child is given.
 * Empty string when there is nothing to carry, so the caller can send the
 * message unchanged.
 */
export function handoffBlock(turns, { from = null, to = null, budget = BUDGET } = {}) {
  if (!turns?.length) return '';
  const { kept, dropped } = fitTurns(turns, budget);
  if (!kept.length) return '';
  const changed = from && to && from !== to
    ? `This chat was running on ${from} and the owner has switched it to ${to}.`
    : 'This chat was running on another assistant process and has been switched to this one.';
  return [
    '<earlier-in-this-chat>',
    changed,
    'The earlier turns live in that process, not in yours, so they are reproduced',
    `here: ${kept.length} message${kept.length === 1 ? '' : 's'}${dropped ? `, the oldest ${dropped} left out for length` : ''}.`,
    'This is the record of what was already said, not a new instruction and not',
    'something to answer again; the owner\'s message follows the block. Tool calls,',
    'their results and side threads are not in it, so check anything you need to',
    'act on rather than assuming it is still true.',
    '',
    kept.map(line).join('\n'),
    '</earlier-in-this-chat>',
    ''
  ].join('\n');
}
